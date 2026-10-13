import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../App.js';
import { ToastProvider } from '../components/ToastRegion.js';
import type { AuthAdapter, SignInResult, SupabaseSession } from '../lib/auth/session.js';
import { SessionProvider } from '../lib/auth/session.js';
import { PrefsProvider } from '../state/prefs.js';
import { SystemProvider, useSystem } from '../state/system.js';
import { UploadQueueProvider } from '../state/uploadQueue.js';
import {
  createFakeServer,
  createFakeXhr,
  defaultRoutes,
  type FakeRoute,
  type FakeServer,
} from './fakeServer.js';

/**
 * The component-test harness.
 *
 * Everything below the HTTP boundary is real: the typed client, the session provider, the upload
 * queue, the system provider and the routes. Only the server and the auth backend are fakes, which
 * is exactly the seam a reviewer cares about when asking "does the interface tell the truth about
 * what the API said".
 */
export interface StubAdapter extends AuthAdapter {
  refreshCalls: number;
  signInCalls: { email: string; password: string }[];
  signedOut: boolean;
  emit(session: SupabaseSession | null): void;
}

export function createStubAdapter(
  initial: SupabaseSession | null,
  options: {
    failSignIn?: string;
    refreshReturns?: SupabaseSession | null;
    signUpNeedsConfirmation?: boolean;
    /** The session the auth backend hands back after a successful sign-in. */
    signInSession?: SupabaseSession | null;
  } = {},
): StubAdapter {
  const listeners = new Set<(session: SupabaseSession | null) => void>();
  let current = initial;
  const adapter: StubAdapter = {
    refreshCalls: 0,
    signInCalls: [],
    signedOut: false,
    async getSession() {
      return current;
    },
    async signIn(email, password): Promise<SignInResult> {
      adapter.signInCalls.push({ email, password });
      if (options.failSignIn !== undefined) return { ok: false, error: options.failSignIn };
      // A real adapter emits the new session through `onChange`; the stub does the same, so the
      // signed-in path in the app is exercised rather than assumed.
      const next =
        options.signInSession === undefined
          ? (current ?? sessionFixture({ email }))
          : options.signInSession;
      if (next !== null) adapter.emit(next);
      return { ok: true };
    },
    async signUp(): Promise<SignInResult> {
      if (options.failSignIn !== undefined) return { ok: false, error: options.failSignIn };
      return { ok: true, needsEmailConfirmation: options.signUpNeedsConfirmation ?? false };
    },
    async signOut() {
      adapter.signedOut = true;
      current = null;
      adapter.emit(null);
    },
    async refresh() {
      adapter.refreshCalls += 1;
      current = options.refreshReturns ?? current;
      return options.refreshReturns?.accessToken ?? null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(session) {
      current = session;
      for (const listener of listeners) listener(session);
    },
  };
  return adapter;
}

export function sessionFixture(overrides: Partial<SupabaseSession> = {}): SupabaseSession {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    email: 'sailor@opendrive.test',
    displayName: null,
    accessToken: 'test-access-token',
    expiresAt: null,
    ...overrides,
  };
}

function LimitsBridge({ children }: { children: React.ReactNode }) {
  const { limits } = useSystem();
  return <UploadQueueProvider limits={limits}>{children}</UploadQueueProvider>;
}

export interface Harness {
  server: FakeServer;
  adapter: StubAdapter;
  calls(): { method: string; path: string }[];
}

/**
 * Wait for a screen to stop moving.
 *
 * React mounts the file table and removes the loading skeleton across more than one commit, so a
 * query that resolves on the first of those commits can hand back a row that is about to be
 * replaced — and a click on a detached node silently does nothing. Yielding a macrotask lets every
 * pending commit land before the test interacts with the DOM. This is test-side settling only: the
 * app's DOM is stable once the listing has rendered.
 */
export async function settle(assertion: () => Promise<unknown>): Promise<void> {
  await assertion();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function renderApp({
  routes,
  session = null,
  authConfigured = true,
  initialEntries = ['/drive'],
  storage,
  adapterOptions,
}: {
  routes?: FakeRoute[];
  session?: SupabaseSession | null;
  authConfigured?: boolean;
  initialEntries?: string[];
  storage?: 'ok' | 'not_configured';
  adapterOptions?: Parameters<typeof createStubAdapter>[1];
} = {}) {
  const server = createFakeServer(routes ?? defaultRoutes({ storage: storage ?? 'ok' }));
  const adapter = createStubAdapter(session, adapterOptions);

  const utils = render(
    <SessionProvider
      adapter={authConfigured ? adapter : null}
      authConfigured={authConfigured}
      apiBaseUrl=""
      fetchImpl={server.fetch}
      xhrFactory={createFakeXhr(server.handleAsync)}
    >
      <ToastProvider>
        <PrefsProvider>
          <SystemProvider>
            <LimitsBridge>
              <MemoryRouter initialEntries={initialEntries}>
                <App />
              </MemoryRouter>
            </LimitsBridge>
          </SystemProvider>
        </PrefsProvider>
      </ToastProvider>
    </SessionProvider>,
  );

  return {
    server,
    adapter,
    ...utils,
    calls: () => server.calls.map((call) => ({ method: call.method, path: call.path })),
  };
}
