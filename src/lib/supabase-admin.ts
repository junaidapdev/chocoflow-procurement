import { createClient } from '@supabase/supabase-js';

type SupabaseAdminClient = ReturnType<typeof createClient<any, 'public'>>;

let supabaseAdminClient: SupabaseAdminClient | null = null;

export function getSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase admin environment variables are required');
  }

  if (!supabaseAdminClient) {
    supabaseAdminClient = createClient<any, 'public'>(supabaseUrl, serviceRoleKey);
  }

  return supabaseAdminClient;
}
