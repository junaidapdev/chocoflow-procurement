import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { DASHBOARD_ROUTE_ROLES, ICE_DASHBOARD_PREFIX, USER_PROFILE_HEADER } from '@/lib/constants'
import { hasActiveIceMembership } from '@/lib/icecream'

export async function middleware(request: NextRequest) {
  // Start from a clean copy of the incoming headers and drop any profile
  // header a client might have sent — we only ever trust the value we set
  // ourselves below, after verifying the session.
  const requestHeaders = new Headers(request.headers)
  requestHeaders.delete(USER_PROFILE_HEADER)

  // Collect any cookies Supabase wants to refresh during getUser(), so we can
  // apply them to whichever response we ultimately return (redirect or next).
  const cookiesToSet: { name: string; value: string; options: CookieOptions }[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          cookiesToSet.push({ name, value, options })
        },
        remove(name: string, options: CookieOptions) {
          cookiesToSet.push({ name, value: '', options })
        },
      },
    }
  )

  const finalize = (response: NextResponse) => {
    for (const { name, value, options } of cookiesToSet) {
      response.cookies.set({ name, value, ...options })
    }
    return response
  }

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return finalize(NextResponse.redirect(new URL('/login', request.url)))
  }

  // Ice cream membership rides along on the profile lookup as an embedded
  // select, so gating the second module costs no extra round-trip. RLS on
  // ice_members only ever exposes the caller's own row, so this returns either
  // their membership or nothing.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, full_name, email, ice_members(active)')
    .eq('id', user.id)
    .single()

  if (!profile) {
    return finalize(NextResponse.redirect(new URL('/unauthorized', request.url)))
  }

  const { ice_members: iceMembership, ...profileFields } = profile as Record<string, unknown>
  const isIceMember = hasActiveIceMembership(iceMembership)

  if (request.nextUrl.pathname.startsWith(ICE_DASHBOARD_PREFIX)) {
    // Checked before the role table, and independently of it: the ice cream
    // manager has no chocolate role, and a chocolate role grants nothing here.
    if (!isIceMember) {
      return finalize(NextResponse.redirect(new URL('/unauthorized', request.url)))
    }
  } else {
    const rule = DASHBOARD_ROUTE_ROLES.find((r) =>
      request.nextUrl.pathname.startsWith(r.prefix)
    )

    if (rule && !rule.roles.includes(profileFields.role as never)) {
      return finalize(NextResponse.redirect(new URL('/unauthorized', request.url)))
    }
  }

  // Pass the verified profile to the dashboard layout so it doesn't have to
  // query the database again for the same information on every navigation.
  requestHeaders.set(
    USER_PROFILE_HEADER,
    JSON.stringify({ ...profileFields, is_ice_member: isIceMember })
  )

  return finalize(NextResponse.next({ request: { headers: requestHeaders } }))
}

export const config = {
  // Only run auth checks on the protected dashboard. Public pages (login, the
  // vendor form) and API routes (which authorize themselves) skip the
  // middleware entirely, so they no longer pay for an auth network round-trip.
  matcher: ['/dashboard/:path*'],
}
