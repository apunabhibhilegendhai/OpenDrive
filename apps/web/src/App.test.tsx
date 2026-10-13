/** @vitest-environment jsdom */
import { API_PREFIX } from '@opendrive/shared';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defaultRoutes, fileFixture, problem, type FakeRoute } from './test/fakeServer.js';
import { renderApp, sessionFixture } from './test/harness.js';

/**
 * Session and route protection.
 *
 * The rule this file defends: an unauthenticated or expired visitor never sees a screen built for
 * somebody else, and a credential change never leaves the previous account's rows on screen.
 */

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

describe('route protection', () => {
  it('sends a visitor with no session to sign-in and never asks the API for files', async () => {
    const { server } = renderApp({ session: null, initialEntries: ['/drive'] });

    expect(await screen.findByText('Private cloud storage. Chart your own course.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
    expect(server.calls.filter((call) => call.path === `${API_PREFIX}/files`)).toHaveLength(0);
  });

  it('says plainly that sign-in is unavailable when no auth service is configured', async () => {
    renderApp({ session: null, authConfigured: false, initialEntries: ['/signin'] });

    expect(await screen.findByText(/no account service configured/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull();
  });

  it("states the auth service's own reason when a sign-in is refused", async () => {
    renderApp({
      session: null,
      initialEntries: ['/signin'],
      adapterOptions: { failSignIn: 'Invalid login credentials' },
    });

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'sailor@opendrive.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-horse' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Invalid login credentials',
    );
  });

  it("lands on the drive after a real sign-in and reads that account's files", async () => {
    const { adapter } = renderApp({ session: null, initialEntries: ['/signin'] });

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'sailor@opendrive.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByText('chart.png')).toBeTruthy();
    expect(adapter.signInCalls).toEqual([
      { email: 'sailor@opendrive.test', password: 'correct-horse' },
    ]);
  });

  it('treats a 401 that survives the refresh as an expired session and returns to sign-in', async () => {
    // The 401 route is registered first: routes are matched in order, and it must win over the
    // healthy listing the default set provides.
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: () => problem(401, 'UNAUTHORIZED', 'token expired'),
      },
      ...defaultRoutes(),
    ];
    const { adapter } = renderApp({
      session: sessionFixture(),
      initialEntries: ['/drive'],
      routes,
    });

    expect(
      await screen.findByText('Your session expired. Sign in again to continue.'),
    ).toBeTruthy();
    expect(adapter.signedOut).toBe(true);
    expect(screen.queryByText('chart.png')).toBeNull();
  });

  it("signing out leaves the drive and clears the previous account's rows", async () => {
    const { adapter } = renderApp({ session: sessionFixture(), initialEntries: ['/drive'] });

    await screen.findByText('chart.png');
    fireEvent.click(screen.getByRole('button', { name: /^sign out$/i }));

    expect(await screen.findByText('Signed out.')).toBeTruthy();
    expect(adapter.signedOut).toBe(true);
    expect(screen.queryByText('chart.png')).toBeNull();
  });
});

describe('account switching', () => {
  it("never leaves the previous account's files on screen", async () => {
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: (request) =>
          request.headers.authorization === 'Bearer token-b'
            ? {
                status: 200,
                body: { items: [fileFixture({ filename: 'beta.txt' })], nextCursor: null },
              }
            : {
                status: 200,
                body: { items: [fileFixture({ filename: 'alpha.txt' })], nextCursor: null },
              },
      },
      ...defaultRoutes(),
    ];
    const { adapter } = renderApp({
      session: sessionFixture({ userId: USER_A, accessToken: 'token-a' }),
      initialEntries: ['/drive'],
      routes,
    });

    await screen.findByText('alpha.txt');

    await act(async () => {
      adapter.emit(
        sessionFixture({ userId: USER_B, accessToken: 'token-b', email: 'other@opendrive.test' }),
      );
    });

    expect(screen.queryByText('alpha.txt')).toBeNull();
    expect(await screen.findByText('beta.txt')).toBeTruthy();
  });
});
