import type { SupabasePublicConfig } from './supabase.js';

/**
 * Public auth configuration.
 *
 * `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are publishable values: the anon key is
 * designed to be shipped to browsers and is limited by row-level security on the Supabase side.
 * Server credentials (service-role key, database URL, Telegram token) must never be given a
 * `VITE_` prefix, because every `VITE_*` value ends up in the bundle.
 */
function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readSupabaseConfig(env: Record<string, unknown> = import.meta.env): {
  configured: boolean;
  config: SupabasePublicConfig;
} {
  const url = readString(env['VITE_SUPABASE_URL']).replace(/\/+$/, '');
  const anonKey = readString(env['VITE_SUPABASE_ANON_KEY']);
  return {
    configured: url !== '' && anonKey !== '',
    config: { url, anonKey },
  };
}
