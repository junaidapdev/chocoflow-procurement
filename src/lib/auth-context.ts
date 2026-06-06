import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import type { AuditActor } from '@/lib/audit-log';

export type ProfileRole = 'amin' | 'salam' | 'accountant' | 'payer';

export type AuthProfile = {
  id: string;
  role: ProfileRole | null;
  full_name: string | null;
  email: string | null;
};

export type AuthContext = {
  user: User;
  profile: AuthProfile;
  actor: AuditActor;
};

type AuthFailure = {
  ok: false;
  status: 401 | 403 | 500;
  error: string;
  actor: AuditActor;
};

type AuthSuccess = {
  ok: true;
  context: AuthContext;
  actor: AuditActor;
};

export type AuthResult = AuthSuccess | AuthFailure;

function createRequestSupabaseClient(request: NextRequest) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            request.cookies.set({ name, value, ...options });
          } catch {
            // Route handlers may not be able to persist refreshed cookies here.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            request.cookies.set({ name, value: '', ...options });
          } catch {
            // Route handlers may not be able to persist refreshed cookies here.
          }
        },
      },
    }
  );
}

function actorFromProfile(user: User, profile: AuthProfile): AuditActor {
  return {
    userId: user.id,
    role: profile.role,
    email: user.email || profile.email,
    name: profile.full_name,
    type: 'authenticated',
  };
}

function actorFromUser(user: User): AuditActor {
  return {
    userId: user.id,
    email: user.email,
    type: 'authenticated',
  };
}

async function loadAuthResult(request: NextRequest): Promise<AuthResult> {
  try {
    const supabase = createRequestSupabaseClient(request);
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return {
        ok: false,
        status: 401,
        error: 'Authentication required',
        actor: { type: 'public' },
      };
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role, full_name, email')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      return {
        ok: false,
        status: 403,
        error: 'User profile is missing or incomplete',
        actor: actorFromUser(user),
      };
    }

    const typedProfile = profile as AuthProfile;
    const context = {
      user,
      profile: typedProfile,
      actor: actorFromProfile(user, typedProfile),
    };

    return {
      ok: true,
      context,
      actor: context.actor,
    };
  } catch (err) {
    console.error('Failed to load auth context:', err);
    return {
      ok: false,
      status: 500,
      error: 'Could not verify authentication',
      actor: { type: 'system' },
    };
  }
}

export async function getAuthContext(request: NextRequest): Promise<AuthContext | null> {
  const auth = await loadAuthResult(request);
  return auth.ok ? auth.context : null;
}

export async function requireAuthContext(request: NextRequest): Promise<AuthResult> {
  return loadAuthResult(request);
}

export async function requireRoles(
  request: NextRequest,
  allowedRoles: ProfileRole[]
): Promise<AuthResult> {
  const auth = await requireAuthContext(request);

  if (!auth.ok) {
    return auth;
  }

  const role = auth.context.profile.role;

  if (!role || !allowedRoles.includes(role)) {
    return {
      ok: false,
      status: 403,
      error: 'Insufficient permissions',
      actor: auth.actor,
    };
  }

  return auth;
}
