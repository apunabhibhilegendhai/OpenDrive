/** @vitest-environment jsdom */
import { API_PREFIX, type FileRecord } from '@opendrive/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defaultRoutes, fileFixture, type FakeResponse, type FakeRoute } from './fakeServer.js';
import { renderApp, sessionFixture } from './harness.js';

/**
 * Account isolation in the interface.
 *
 * A listing request belongs to the principal that made it. If that principal changes — a sign-in,
 * a sign-out, a different account in the same tab — an answer still in flight must be dropped
 * rather than rendered, or one account's file names end up on another account's screen.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('account isolation', () => {
  it('never appends a page that arrived after the account changed', async () => {
    const otherAccountFileId = `file_${'9'.repeat(26)}`;
    const staleFileId = `file_${'8'.repeat(26)}`;
    // What the API answers for the first page. Swapped when the other account signs in, so the
    // screen itself proves which principal is being served.
    let currentAccountFiles: FileRecord[] = [fileFixture({ filename: 'first-account.png' })];
    const gate = deferred<FakeResponse>();
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: (request) =>
          request.query.get('cursor') === null
            ? {
                status: 200,
                body: { items: currentAccountFiles, nextCursor: 'cursor-1' },
              }
            : gate.promise,
      },
      ...defaultRoutes(),
    ];
    const { adapter, server } = renderApp({ session: sessionFixture(), routes });

    expect(await screen.findByText('first-account.png')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /load more files/i }));
    await waitFor(() =>
      expect(server.calls.some((call) => call.query.get('cursor') === 'cursor-1')).toBe(true),
    );

    // A different account signs in on this tab while that page is still in flight. Waiting for its
    // own listing to appear is what makes the ordering certain: the switch has landed.
    currentAccountFiles = [fileFixture({ id: otherAccountFileId, filename: 'second-account.png' })];
    adapter.emit(
      sessionFixture({
        userId: '22222222-2222-4222-8222-222222222222',
        email: 'other@opendrive.test',
      }),
    );
    expect(await screen.findByText('second-account.png')).toBeTruthy();
    expect(screen.queryByText('first-account.png')).toBeNull();

    gate.resolve({
      status: 200,
      body: {
        items: [fileFixture({ id: staleFileId, filename: 'first-account-stale.png' })],
        nextCursor: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The answer belonged to the previous listing; it must not appear among the new account's rows.
    expect(screen.queryByText('first-account-stale.png')).toBeNull();
  });
});
