import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthAdapter, SignInResult, SupabaseSession } from './session.js';

/**
 * The production auth adapter.
 *
 * Only the public Supabase URL and the publishable (anon) key are used here; both are public
 * configuration by design. Session persistence and refresh are the SDK's own supported
 * behaviour — this file does not hand-roll token storage, and nothing here ever logs a token.
 */

export interface SupabasePublicConfig {
  url: string;
  anonKey: string;
}

function mapSession(
  session: {
    access_token: string;
    user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
    expires_at?: number;
  } | null,
): SupabaseSession | null {
  if (session === null) return null;
  const displayName = session.user.user_metadata?.['display_name'];
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    displayName: typeof displayName === 'string' ? displayName : null,
    accessToken: session.access_token,
    expiresAt: session.expires_at ?? null,
  };
}

/** Plain-language copy for the auth failures a person can actually act on. */
function describeAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('invalid login credentials')) return 'That email and password do not match.';
  if (lower.includes('email not confirmed')) {
    return 'This account still needs its email confirmed before it can sign in.';
  }
  if (lower.includes('user already registered'))
    return 'An account with that email already exists.';
  if (lower.includes('password should be at least')) return 'Choose a longer password.';
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts. Wait a moment and try again.';
  }
  if (lower.includes('failed to fetch') || lower.includes('network')) {
    return 'The auth service could not be reached.';
  }
  return message;
}

export function createSupabaseAdapter(config: SupabasePublicConfig): AuthAdapter {
  // The SDK is imported on first use rather than at module load: it is by far the largest
  // dependency in the app, and a signed-out splash should not pay for it.
  let clientPromise: Promise<SupabaseClient> | null = null;
  const client = (): Promise<SupabaseClient> => {
    clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      }),
    );
    return clientPromise;
  };

  return {
    async getSession() {
      const { data, error } = await (await client()).auth.getSession();
      if (error !== null) return null;
      return mapSession(data.session);
    },
    async signIn(email, password): Promise<SignInResult> {
      const { error } = await (await client()).auth.signInWithPassword({ email, password });
      if (error !== null) return { ok: false, error: describeAuthError(error.message) };
      return { ok: true };
    },
    async signUp(email, password): Promise<SignInResult> {
      const { data, error } = await (await client()).auth.signUp({ email, password });
      if (error !== null) return { ok: false, error: describeAuthError(error.message) };
      return { ok: true, needsEmailConfirmation: data.session === null };
    },
    async signOut() {
      await (await client()).auth.signOut();
    },
    async refresh() {
      const { data, error } = await (await client()).auth.refreshSession();
      if (error !== null) return null;
      return mapSession(data.session)?.accessToken ?? null;
    },
    onChange(listener) {
      let unsubscribe: (() => void) | null = null;
      let cancelled = false;
      void (async () => {
        const current = await client();
        if (cancelled) return;
        const { data } = current.auth.onAuthStateChange((_event, session) => {
          listener(mapSession(session));
        });
        unsubscribe = () => {
          data.subscription.unsubscribe();
        };
      })();
      return () => {
        cancelled = true;
        unsubscribe?.();
      };
    },
  };
}
