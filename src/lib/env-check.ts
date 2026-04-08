// Environment variable validation — runs on app startup in development
const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

if (process.env.NODE_ENV === 'development') {
  const missing = REQUIRED_ENV_VARS.filter(
    (key) => !process.env[key] || process.env[key]!.trim() === ''
  );

  if (missing.length > 0) {
    throw new Error(
      `\n\n🚨 ChocoFlow: Missing required environment variables:\n${missing.map((v) => `   - ${v}`).join('\n')}\n\nPlease add them to your .env.local file and restart the server.\n`
    );
  }
}
