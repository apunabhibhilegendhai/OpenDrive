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
import type { MigrateAnonymousSessionResponse } from '@opendrive/shared';
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
 * A tab can hold **several principals at once** and switch between them — which is what makes both
 * "sign in as somebody else" and "upload anonymously, then move the files into my account" real
 * flows rather than a sign-out and a lost session. The rules that keep that safe:
 *
 *   * The list is **in memory only**. Nothing here writes a credential to storage; the Supabase SDK
 *     persists its own session exactly as before, and this file adds nothing to that.
 *   * **Every request carries exactly one credential**, the active principal's, and the server
 *     re-derives identity from it. Switching is a client-side choice of which credential to send —
 *     it confers nothing, because no endpoint accepts an account or session id from a request.
 *   * Switching bumps `epoch`, which every data hook depends on, so the previous principal's rows,
 *     selection and in-flight responses are dropped rather than left on screen.
 *   * Only the SDK's own session can be **refreshed**. A second account is held by its access token
 *     alone, so when that token expires the principal is dropped with a notice instead of being
 *     silently retried — the honest outcome, and the reason switching back to a long-idle second
 *     account may require signing in again.
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

/**
 * One credential the tab is holding.
 *
 * `refreshable` is true only for the session the auth SDK itself owns. Everything else is a token
 * this app was handed and cannot renew.
 */
export interface HeldPrincipal {
  readonly key: string;
  readonly kind: 'user' | 'anonymous';
  readonly label: string;
  readonly credential: string;
  readonly refreshable: boolean;
  readonly expiresAt: string | null;
  /** The full session for a user principal, so nothing about it is reconstructed from the label. */
  readonly session?: SupabaseSession;
  /** Files this anonymous principal uploaded and still holds the one-time deletion token for. */
  readonly deletionTokens: Record<string, string>;
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

export type MigrationResult =
  | { readonly ok: true; readonly outcome: MigrateAnonymousSessionResponse }
  | { readonly ok: false; readonly error: string };

export interface SessionContextValue {
  state: SessionState;
  /** The authenticated principal changed (sign-in, sign-out, account switch). */
  epoch: number;
  api: ApiClient;
  authConfigured: boolean;
  /** Every principal this tab holds, in the order they were added. */
  principals: readonly HeldPrincipal[];
  /** Key of the active principal, or null when signed out. */
  activeKey: string | null;
  /** Move the tab to another held principal. Unknown keys are ignored. */
  switchPrincipal: (key: string) => void;
  /** Drop a held principal. Dropping the active one falls back to the next. */
  forgetPrincipal: (key: string) => void;
  /** True when the active principal is an account, which is what can receive a session. */
  canMigrate: boolean;
  /** Bring a held anonymous principal's files and folders into the active account. */
  migrateAnonymousPrincipal: (key: string) => Promise<MigrationResult>;
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

export function principalKeyForUser(userId: string): string {
  return `user:${userId}`;
}

export function principalKeyForSession(sessionId: string): string {
  return `anon:${sessionId}`;
}

/** A one-line description of a principal for the switcher and for notices. */
export function describePrincipal(principal: HeldPrincipal): string {
  return principal.kind === 'user' ? principal.label : 'Anonymous session';
}

function sessionToPrincipal(session: SupabaseSession, refreshable: boolean): HeldPrincipal {
  return {
    key: principalKeyForUser(session.userId),
    kind: 'user',
    label: session.email ?? session.displayName ?? session.userId,
    credential: session.accessToken,
    refreshable,
    expiresAt: session.expiresAt === null ? null : new Date(session.expiresAt * 1000).toISOString(),
    session,
    deletionTokens: {},
  };
}

/** Replaces a principal, preserving its `deletionTokens`, and appends it when it is new. */
function withPrincipal(
  principals: readonly HeldPrincipal[],
  next: HeldPrincipal,
  options: { readonly refreshable?: boolean } = {},
): HeldPrincipal[] {
  const index = principals.findIndex((principal) => principal.key === next.key);
  if (index === -1) return [...principals, next];
  const existing = principals[index]!;
  const merged: HeldPrincipal = {
    ...next,
    // The one-time deletion tokens belong to the principal and are never carried by a token refresh.
    deletionTokens: existing.deletionTokens,
    // A principal that the SDK owns stays refreshable; one it does not never becomes so.
    refreshable: options.refreshable ?? existing.refreshable,
  };
  const copy = [...principals];
  copy[index] = merged;
  return copy;
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
  const [principals, setPrincipals] = useState<readonly HeldPrincipal[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [epoch, setEpoch] = useState(0);

  /** Read by the credential source, which must stay referentially stable across renders. */
  const principalsRef = useRef<readonly HeldPrincipal[]>(principals);
  const activeKeyRef = useRef<string | null>(activeKey);
  principalsRef.current = principals;
  activeKeyRef.current = activeKey;

  const active = useMemo(
    () => principals.find((principal) => principal.key === activeKey) ?? null,
    [principals, activeKey],
  );

  // Set below, once `handleAuthFailure` exists. The API client holds a stable callback that
  // dereferences it, so a dead credential is handled the same way from every screen.
  const authFailureRef = useRef<() => void>(() => undefined);

  const credential = useMemo<CredentialSource>(
    () => ({
      token: () => {
        const principal = principalsRef.current.find(
          (candidate) => candidate.key === activeKeyRef.current,
        );
        return principal?.credential ?? null;
      },
      refresh: async () => {
        const principal = principalsRef.current.find(
          (candidate) => candidate.key === activeKeyRef.current,
        );
        // Only the SDK's own session can be renewed. A held second account answers null, which the
        // client treats as "no retry", and the follow-up 401 drops it with a notice.
        if (principal === undefined || !principal.refreshable || adapter === null) return null;
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
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const session = await adapter.getSession();
      if (cancelled) return;
      setLoading(false);
      if (session !== null) {
        setPrincipals((current) => withPrincipal(current, sessionToPrincipal(session, true)));
        setActiveKey(principalKeyForUser(session.userId));
      }
    })();
    const unsubscribe = adapter.onChange((session) => {
      if (cancelled) return;
      setLoading(false);
      if (session !== null) {
        // A sign-in (including a second account signing in while another is active) adds the new
        // principal and makes it active. The previous one stays held, so the tab can switch back.
        setPrincipals((current) => withPrincipal(current, sessionToPrincipal(session, true)));
        setActiveKey(principalKeyForUser(session.userId));
        setNotice(undefined);
        return;
      }
      // The SDK's session ended. Only that principal goes away: a held second account is not the
      // SDK's business, and dropping it here would lose a session the person still holds.
      setPrincipals((current) => {
        const remaining = current.filter(
          (principal) => !(principal.kind === 'user' && principal.refreshable),
        );
        setActiveKey((currentActive) =>
          remaining.some((principal) => principal.key === currentActive)
            ? currentActive
            : (remaining[remaining.length - 1]?.key ?? null),
        );
        return remaining;
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
    if (activeKey === null) {
      if (lastPrincipal.current !== null) {
        lastPrincipal.current = null;
        setEpoch((value) => value + 1);
      }
      return;
    }
    if (lastPrincipal.current !== activeKey) {
      lastPrincipal.current = activeKey;
      setEpoch((value) => value + 1);
    }
  }, [activeKey]);

  const switchPrincipal = useCallback((key: string) => {
    setActiveKey((current) =>
      principalsRef.current.some((principal) => principal.key === key) ? key : current,
    );
  }, []);

  const forgetPrincipal = useCallback((key: string) => {
    setPrincipals((current) => {
      const remaining = current.filter((principal) => principal.key !== key);
      setActiveKey((currentActive) =>
        currentActive === key ? (remaining[remaining.length - 1]?.key ?? null) : currentActive,
      );
      return remaining;
    });
  }, []);

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

  /**
   * Ends the *active* principal's session.
   *
   * An anonymous principal is dropped locally: it has no server-side logout, and forgetting the
   * credential is what ends it. A signed-in account is signed out through the SDK, which also
   * clears the persisted session. Any other held principal is untouched.
   */
  const signOut = useCallback(async () => {
    const current = activeKeyRef.current;
    const principal = principalsRef.current.find((candidate) => candidate.key === current);
    if (principal !== undefined && principal.kind === 'user' && principal.refreshable) {
      if (adapter !== null) await adapter.signOut();
    } else if (current !== null) {
      forgetPrincipal(current);
      setNotice('Signed out.');
      return;
    }
    setNotice('Signed out.');
  }, [adapter, forgetPrincipal]);

  const startAnonymousSession = useCallback(async () => {
    try {
      const created = await api.createAnonymousSession();
      const principal: HeldPrincipal = {
        key: principalKeyForSession(created.sessionId),
        kind: 'anonymous',
        label: 'Anonymous session',
        credential: created.credential,
        refreshable: false,
        expiresAt: created.expiresAt,
        deletionTokens: {},
      };
      setPrincipals((current) => withPrincipal(current, principal));
      setActiveKey(principal.key);
      setNotice(undefined);
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
    setPrincipals((current) =>
      current.map((principal) =>
        principal.key === activeKeyRef.current && principal.kind === 'anonymous'
          ? { ...principal, deletionTokens: { ...principal.deletionTokens, [fileId]: token } }
          : principal,
      ),
    );
  }, []);

  const migrateAnonymousPrincipal = useCallback(
    async (key: string): Promise<MigrationResult> => {
      const target = principalsRef.current.find((principal) => principal.key === key);
      if (target === undefined || target.kind !== 'anonymous') {
        return { ok: false, error: 'That principal is not an anonymous session.' };
      }
      const account = principalsRef.current.find(
        (principal) => principal.key === activeKeyRef.current,
      );
      if (account === undefined || account.kind !== 'user') {
        return {
          ok: false,
          error: 'Sign in to an account first: only an account can receive a session’s files.',
        };
      }
      try {
        const outcome = await api.migrateAnonymousSession(target.credential);
        // The session's credential is revoked by the migration, so holding it would only produce
        // 401s later. The files are the account's now, and its deletion tokens are gone with it.
        forgetPrincipal(key);
        return { ok: true, outcome };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'The migration did not complete.',
        };
      }
    },
    [api, forgetPrincipal],
  );

  const handleAuthFailure = useCallback(
    async (message: string) => {
      const current = activeKeyRef.current;
      if (current === null) return;
      const principal = principalsRef.current.find((candidate) => candidate.key === current);
      if (principal !== undefined && !principal.refreshable) {
        // A held credential that the SDK cannot renew: it is gone, and the only honest answer is to
        // drop it and fall back rather than to loop on a token that will never work again.
        forgetPrincipal(current);
        setNotice(message);
        return;
      }
      if (adapter !== null) {
        try {
          await adapter.signOut();
        } catch {
          // The credential is being discarded either way.
        }
      }
      setNotice(message);
    },
    [adapter, forgetPrincipal],
  );

  // A 401 that survived the refresh means the credential is gone, not stale: drop it and let the
  // route guard send the person back to sign-in, rather than showing a drive that cannot load.
  authFailureRef.current = () => {
    void handleAuthFailure('Your session expired. Sign in again to continue.');
  };

  const state = useMemo<SessionState>(() => {
    if (loading) return { kind: 'loading' };
    if (active === null) return { kind: 'signed-out', ...(notice === undefined ? {} : { notice }) };
    if (active.kind === 'user') {
      // The principal always carries the session it was created from; the fallback only guards a
      // hand-built value that should never exist.
      return {
        kind: 'signed-in',
        session: active.session ?? {
          userId: active.key.slice('user:'.length),
          email: active.label,
          displayName: null,
          accessToken: active.credential,
          expiresAt: null,
        },
      };
    }
    return {
      kind: 'anonymous',
      sessionId: active.key.slice('anon:'.length),
      credential: active.credential,
      expiresAt: active.expiresAt ?? new Date().toISOString(),
      deletionTokens: active.deletionTokens,
    };
  }, [active, loading, notice]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      epoch,
      api,
      authConfigured,
      principals,
      activeKey,
      switchPrincipal,
      forgetPrincipal,
      canMigrate: active?.kind === 'user',
      migrateAnonymousPrincipal,
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
      principals,
      activeKey,
      switchPrincipal,
      forgetPrincipal,
      active,
      migrateAnonymousPrincipal,
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
