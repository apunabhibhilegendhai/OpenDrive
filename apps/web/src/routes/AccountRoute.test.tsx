/** @vitest-environment jsdom */
import { API_PREFIX, ANONYMOUS_CREDENTIAL_HEADER } from '@opendrive/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  defaultRoutes,
  fileFixture,
  migrationFixture,
  problem,
  type FakeRoute,
} from '../test/fakeServer.js';
import { renderApp, sessionFixture, settle } from '../test/harness.js';

/**
 * The two multi-user flows, exercised through the interface a person actually uses.
 *
 * What these defend is not "a button exists" but the contract the button keeps:
 *
 *   * **The destination account is the credential on the wire.** A migration request carries the
 *     signed-in session in `Authorization` and the anonymous session's credential in its own
 *     header; no request field names an account. Checking those two headers exactly means the test
 *     fails if the wiring starts trusting anything the client chose.
 *   * **Switching changes which credential is sent, and nothing else.** The other principal stays
 *     held — switching back is possible — while every subsequent request belongs to whoever is
 *     active. That is what stops one account's rows from lingering under another's.
 *   * **A refusal from the API is shown, not swallowed**, and leaves the held credential intact.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const SESSION_CREDENTIAL = `ods_${'a'.repeat(43)}`;

/** A file list that answers differently per credential, so the wire is observable from the screen. */
function filesByCredential(): FakeRoute {
  return {
    method: 'GET',
    path: `${API_PREFIX}/files`,
    respond: (request) => {
      const bearer = request.headers['authorization'] ?? '';
      const name =
        bearer === 'Bearer token-b'
          ? 'beta.txt'
          : bearer === `Bearer ${SESSION_CREDENTIAL}`
            ? 'guest.txt'
            : 'alpha.txt';
      return { status: 200, body: { items: [fileFixture({ filename: name })], nextCursor: null } };
    },
  };
}

/** Signs in as the second account from the "add another account" screen and lands on Account. */
async function signInAsB(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/^email$/i), {
    target: { value: 'b@opendrive.test' },
  });
  fireEvent.change(screen.getByLabelText(/^password$/i), {
    target: { value: 'correct-horse-battery' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
  });
}

async function startAnonymousSession(): Promise<void> {
  await settle(() => screen.findByRole('button', { name: /start an anonymous session/i }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /start an anonymous session/i }));
  });
}

function migrationCalls(calls: { method: string; path: string }[]) {
  return calls.filter(
    (call) => call.method === 'POST' && call.path === `${API_PREFIX}/identity/migrations`,
  );
}

describe('bringing an anonymous session into an account', () => {
  it('sends the account as the destination and the session credential as the proof, then reports what moved', async () => {
    let seenAuthorization: string | null = null;
    let seenSessionCredential: string | null = null;
    const routes: FakeRoute[] = [
      filesByCredential(),
      {
        method: 'POST',
        path: `${API_PREFIX}/identity/migrations`,
        respond: (request) => {
          seenAuthorization = request.headers['authorization'] ?? null;
          seenSessionCredential = request.headers[ANONYMOUS_CREDENTIAL_HEADER] ?? null;
          return { status: 201, body: migrationFixture() };
        },
      },
      ...defaultRoutes({ meKind: 'anonymous' }),
    ];
    const harness = renderApp({ session: null, initialEntries: ['/signin'], routes });

    await startAnonymousSession();
    expect(await screen.findByText('guest.txt')).toBeTruthy();

    // The account panel, as an anonymous visitor, explains the rule instead of offering a button
    // that could not work — and links to the sign-in screen that keeps this session held.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /^account$/i }));
    });
    expect(await screen.findByText(/only an account can receive/i)).toBeTruthy();
    expect(migrationCalls(harness.calls())).toHaveLength(0);
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /move its files into this account/i,
      }).disabled,
    ).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /sign in/i }));
    });
    expect(await screen.findByRole('tab', { name: /^sign in$/i })).toBeTruthy();
    await signInAsB();

    // Signing in lands on Account, where both principals are now listed.
    expect(await screen.findByText(/sessions on this device/i)).toBeTruthy();
    expect(screen.getByText('Anonymous session')).toBeTruthy();

    await settle(() => screen.findByRole('button', { name: /move its files into this account/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /move its files into this account/i }));
    });

    // Both credentials, exactly as the endpoint documents them: the account is the destination and
    // is taken from the token that authenticated the request, never from anything in the body.
    await waitFor(() => expect(seenAuthorization).toBe('Bearer test-access-token'));
    expect(seenSessionCredential).toBe(SESSION_CREDENTIAL);

    // The panel repeats the server's own counts, not a client-side tally.
    expect(await screen.findByText(/Moved into this account: 2 files, 1 folder\./)).toBeTruthy();

    // The session credential is revoked by the migration, so its principal is dropped rather than
    // kept around to answer 401 for the rest of the tab's life.
    await waitFor(() => expect(screen.queryByText('Anonymous session')).toBeNull());
  });

  it('shows the API refusal verbatim and keeps the session when the migration is refused', async () => {
    const routes: FakeRoute[] = [
      filesByCredential(),
      {
        method: 'POST',
        path: `${API_PREFIX}/identity/migrations`,
        respond: () =>
          problem(409, 'CONFLICT', 'That session has already been migrated to another account.'),
      },
      ...defaultRoutes({ meKind: 'anonymous' }),
    ];
    const harness = renderApp({ session: null, initialEntries: ['/signin'], routes });

    await startAnonymousSession();
    expect(await screen.findByText('guest.txt')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /^account$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /sign in/i }));
    });
    await settle(() => screen.findByRole('tab', { name: /^sign in$/i }));
    await signInAsB();

    await settle(() => screen.findByRole('button', { name: /move its files into this account/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /move its files into this account/i }));
    });

    // The refusal is the server's, shown as-is, and the session the person still holds survives it.
    expect(await screen.findByText(/already been migrated to another account/i)).toBeTruthy();
    expect(screen.getByText('Anonymous session')).toBeTruthy();
    expect(screen.getByText('b@opendrive.test')).toBeTruthy();
    expect(harness.calls().length).toBeGreaterThan(0);
  });

  it('describes a transport failure in plain language instead of the browser’s own string', async () => {
    const routes: FakeRoute[] = [
      filesByCredential(),
      {
        method: 'POST',
        path: `${API_PREFIX}/identity/migrations`,
        // What a blocked or offline call really does: `fetch` rejects with the browser's own
        // message and no response ever exists. This is the exact string Chromium produces when a
        // preflight is refused — observed on the deployed origin, where the panel said
        // "Failed to fetch" and nothing else.
        respond: () => {
          throw new TypeError('Failed to fetch');
        },
      },
      ...defaultRoutes({ meKind: 'anonymous' }),
    ];
    renderApp({ session: null, initialEntries: ['/signin'], routes });

    await startAnonymousSession();
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /^account$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /sign in/i }));
    });
    await settle(() => screen.findByRole('tab', { name: /^sign in$/i }));
    await signInAsB();

    await settle(() => screen.findByRole('button', { name: /move its files into this account/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /move its files into this account/i }));
    });

    // A browser-specific string is not an answer: the person is told what happened in words that
    // hold for every engine, and the session they still hold survives the attempt.
    expect(await screen.findByText(/could not be reached/i)).toBeTruthy();
    expect(screen.queryByText(/failed to fetch/i)).toBeNull();
    expect(screen.getByText('Anonymous session')).toBeTruthy();
  });

  it('never issues a migration request when the only principal is an anonymous session', async () => {
    const routes: FakeRoute[] = [
      filesByCredential(),
      {
        method: 'POST',
        path: `${API_PREFIX}/identity/migrations`,
        respond: () => ({ status: 201, body: migrationFixture() }),
      },
      ...defaultRoutes({ meKind: 'anonymous' }),
    ];
    const harness = renderApp({ session: null, initialEntries: ['/signin'], routes });

    await startAnonymousSession();
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /^account$/i }));
    });
    await settle(() => screen.findByRole('button', { name: /move its files into this account/i }));

    // The control is disabled rather than hidden: a person can see that the operation exists and
    // why it is unavailable, and the click that follows changes nothing on the wire.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /move its files into this account/i }));
    });
    expect(migrationCalls(harness.calls())).toHaveLength(0);
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: /move its files into this account/i,
      }).disabled,
    ).toBe(true);
  });
});

describe('switching accounts', () => {
  it('sends the active principal’s credential on every request and keeps the other one held', async () => {
    const routes: FakeRoute[] = [filesByCredential(), ...defaultRoutes()];
    renderApp({
      session: sessionFixture({
        userId: USER_A,
        accessToken: 'token-a',
        email: 'a@opendrive.test',
      }),
      initialEntries: ['/signin?add=1'],
      routes,
      adapterOptions: {
        signInSession: sessionFixture({
          userId: USER_B,
          accessToken: 'token-b',
          email: 'b@opendrive.test',
        }),
      },
    });

    // The account already held is still shown while adding another one.
    expect(await screen.findByRole('tab', { name: /^sign in$/i })).toBeTruthy();
    await signInAsB();

    // B is active: the drive lists B's file, so the request carried B's token.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /my drive$/i }));
    });
    expect(await screen.findByText('beta.txt')).toBeTruthy();
    expect(screen.queryByText('alpha.txt')).toBeNull();

    // Switch back to A from the account menu.
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /^account$/i }));
    });
    await settle(() => screen.findByRole('button', { name: /account:/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /account:/i }));
    });
    await settle(() => screen.findByRole('menuitem', { name: /switch to a@opendrive\.test/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /switch to a@opendrive\.test/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: /my drive$/i }));
    });

    expect(await screen.findByText('alpha.txt')).toBeTruthy();
    expect(screen.queryByText('beta.txt')).toBeNull();

    // Switching never destroys the other principal: it is still offered, so the flow is reversible
    // without signing in again.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /account:/i }));
    });
    expect(
      await screen.findByRole('menuitem', { name: /switch to b@opendrive\.test/i }),
    ).toBeTruthy();
  });
});
