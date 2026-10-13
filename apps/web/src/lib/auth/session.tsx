import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiClient, type CredentialSource } from '../api/client.js';

/**
 * Session layer.
 *
 * Three credential kinds exist in this product and they are kept distinct here:
 *
 *   * A Supabase Auth session (`Authorization: Bearer <access token>`) for a registered user.
 *   * An anonymous session credential (`ods_…`) issued by the API itself, held in memory only:
 *     it is never written to storage, so closing the tab ends the session.
 *   * Signed out.
 *
 * The adapter indirection is what makes the signed-in paths testable without a live Supabase:
 * tests inject a stub adapter, production injects the Supabase client.
 */

export interface SupabaseSession {
  userId: string;
  email: string | null;
  displayName: string | null;
  accessToken: string;
  expiresAt: number | null;
}

export interface SignInResult {
  ok: boolean;
  error?: string;
  needsEmailConfirmation?: boolean;
}

/** The narrow surface of Supabase Auth this app uses. */
export interface AuthAdapter {
  getSession(): Promise<SupabaseSession | null>;
  signIn(email: string, password: string): Promise<SignInResult>;
  signUp(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  refresh(): Promise<string | null>;
  onChange(listener: (session: SupabaseSession | null) => void): () => void;
}

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'signed-out'; notice?: string }
  | { kind: 'signed-in'; session: SupabaseSession }
  | {
      kind: 'anonymous';
      sessionId: string;
      credential: string;
      expiresAt: string;
      deletionTokens: Record<string, string>;
    };

export interface SessionContextValue {
  state: SessionState;
  /** The authenticated principal changed (sign-in, sign-out, account switch). */
  epoch: number;
  api: ApiClient;
  authConfigured: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signUp: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  startAnonymousSession: () => Promise<{ ok: boolean; error?: string }>;
  /** Record the one-time deletion token the API issued for an anonymous upload. */
  rememberDeletionToken: (fileId: string, token: string) => void;
  /** Forget user-specific state after a credential failure. */
  handleAuthFailure: (notice: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}

export function useApi(): ApiClient {
  return useSession().api;
}

export function SessionProvider({
  adapter,
  authConfigured,
  children,
  apiBaseUrl,
  fetchImpl,
  xhrFactory,
}: {
  adapter: AuthAdapter | null;
  authConfigured: boolean;
  children: ReactNode;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Transport seam for part uploads; production uses the browser's own XMLHttpRequest. */
  xhrFactory?: () => XMLHttpRequest;
}) {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [epoch, setEpoch] = useState(0);
  const stateRef = useRef<SessionState>(state);
  stateRef.current = state;

  // Set below, once `handleAuthFailure` exists. The API client holds a stable callback that
  // dereferences it, so a dead credential is handled the same way from every screen.
  const authFailureRef = useRef<() => void>(() => undefined);

  const credential = useMemo<CredentialSource>(
    () => ({
      token: () => {
        const current = stateRef.current;
        if (current.kind === 'signed-in') return current.session.accessToken;
        if (current.kind === 'anonymous') return current.credential;
        return null;
      },
      refresh: async () => {
        if (stateRef.current.kind !== 'signed-in' || adapter === null) return null;
        return await adapter.refresh();
      },
    }),
    [adapter],
  );

  const api = useMemo(
    () =>
      new ApiClient({
        credential,
        ...(apiBaseUrl === undefined ? {} : { baseUrl: apiBaseUrl }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(xhrFactory === undefined ? {} : { xhrFactory }),
        onAuthFailure: () => authFailureRef.current(),
      }),
    [credential, apiBaseUrl, fetchImpl, xhrFactory],
  );

  // Initial session load, then live updates from the auth provider.
  useEffect(() => {
    if (adapter === null) {
      setState({ kind: 'signed-out' });
      return;
    }
    let cancelled = false;
    void (async () => {
      const session = await adapter.getSession();
      if (cancelled) return;
      setState(session === null ? { kind: 'signed-out' } : { kind: 'signed-in', session });
    })();
    const unsubscribe = adapter.onChange((session) => {
      if (cancelled) return;
      setState((previous) => {
        if (session !== null) return { kind: 'signed-in', session };
        // An anonymous session is not affected by the Supabase client's state.
        if (previous.kind === 'anonymous') return previous;
        return { kind: 'signed-out' };
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [adapter]);

  // Any change of principal invalidates cached user data.
  const lastPrincipal = useRef<string | null>(null);
  useEffect(() => {
    const key =
      state.kind === 'signed-in'
        ? `user:${state.session.userId}`
        : state.kind === 'anonymous'
          ? `anon:${state.sessionId}`
          : null;
    if (key === null) {
      if (lastPrincipal.current !== null) {
        lastPrincipal.current = null;
        setEpoch((value) => value + 1);
      }
      return;
    }
    if (lastPrincipal.current !== key) {
      lastPrincipal.current = key;
      setEpoch((value) => value + 1);
    }
  }, [state]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      if (adapter === null)
        return { ok: false, error: 'This deployment has no auth service configured.' };
      return await adapter.signIn(email, password);
    },
    [adapter],
  );

  const signUp = useCallback(
    async (email: string, password: string): Promise<SignInResult> => {
      if (adapter === null)
        return { ok: false, error: 'This deployment has no auth service configured.' };
      return await adapter.signUp(email, password);
    },
    [adapter],
  );

  const signOut = useCallback(async () => {
    if (adapter !== null) await adapter.signOut();
    setState({ kind: 'signed-out', notice: 'Signed out.' });
  }, [adapter]);

  const startAnonymousSession = useCallback(async () => {
    try {
      const created = await api.createAnonymousSession();
      setState({
        kind: 'anonymous',
        sessionId: created.sessionId,
        credential: created.credential,
        expiresAt: created.expiresAt,
        deletionTokens: {},
      });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'The API refused to open an anonymous session.',
      };
    }
  }, [api]);

  const rememberDeletionToken = useCallback((fileId: string, token: string) => {
    setState((previous) => {
      if (previous.kind !== 'anonymous') return previous;
      return {
        ...previous,
        deletionTokens: { ...previous.deletionTokens, [fileId]: token },
      };
    });
  }, []);

  const handleAuthFailure = useCallback(
    async (notice: string) => {
      if (stateRef.current.kind === 'signed-out') return;
      if (adapter !== null) {
        try {
          await adapter.signOut();
        } catch {
          // The credential is being discarded either way.
        }
      }
      setState({ kind: 'signed-out', notice });
    },
    [adapter],
  );

  // A 401 that survived the refresh means the credential is gone, not stale: drop it and let the
  // route guard send the person back to sign-in, rather than showing a drive that cannot load.
  authFailureRef.current = () => {
    void handleAuthFailure('Your session expired. Sign in again to continue.');
  };

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      epoch,
      api,
      authConfigured,
      signIn,
      signUp,
      signOut,
      startAnonymousSession,
      rememberDeletionToken,
      handleAuthFailure,
    }),
    [
      state,
      epoch,
      api,
      authConfigured,
      signIn,
      signUp,
      signOut,
      startAnonymousSession,
      rememberDeletionToken,
      handleAuthFailure,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
