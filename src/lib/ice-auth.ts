import type { NextRequest } from 'next/server';
import { requireAuthContext, type AuthResult } from '@/lib/auth-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

/**
 * Authorizes an ice cream module API call.
 *
 * The chocolate side has `requireRoles`, which checks profiles.role. That is
 * the wrong check here: the ice cream manager deliberately has no role at all,
 * and holding a chocolate role grants nothing in this module. Membership of
 * ice_members is the only thing that counts.
 *
 * The lookup uses the service-role client on purpose. Reading it through the
 * caller's session would depend on the "Members can read own membership" RLS
 * policy staying in place, which would make an authorization decision hinge on
 * a policy that exists for the convenience of the sidebar.
 */
export async function requireIceMember(request: NextRequest): Promise<AuthResult> {
  const auth = await requireAuthContext(request);

  if (!auth.ok) {
    return auth;
  }

  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const { data: membership, error } = await supabaseAdmin
      .from('ice_members')
      .select('profile_id')
      .eq('profile_id', auth.context.user.id)
      .eq('active', true)
      .maybeSingle();

    if (error) throw error;

    if (!membership) {
      return {
        ok: false,
        status: 403,
        error: 'Insufficient permissions',
        actor: auth.actor,
      };
    }

    return auth;
  } catch (err) {
    console.error('Ice membership check failed:', err);
    return {
      ok: false,
      status: 500,
      error: 'Could not verify permissions',
      actor: auth.actor,
    };
  }
}
