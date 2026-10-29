/** @vitest-environment jsdom */
import { API_PREFIX } from '@opendrive/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultRoutes,
  fileFixture,
  problem,
  type FakeResponse,
  type FakeRoute,
} from '../test/fakeServer.js';
import { renderApp, sessionFixture, settle } from '../test/harness.js';

/**
 * My Drive, driven through the same components a person uses.
 *
 * These tests speak to a fake API over the real HTTP layer, so what they prove is the thing that
 * matters: the interface tells the truth about what the API said. Nothing here asserts on
 * internal state — it reads the screen.
 */

const UPLOAD_ID = `upl_${'1'.repeat(26)}`;
const NEW_FILE_ID = `file_${'3'.repeat(26)}`;
const NOW = '2026-10-12T12:00:00.000Z';
const PART_PATH = /^\/api\/v1\/uploads\/upl_[0-9a-z]+\/parts\/\d+$/;
const COMPLETE_PATH = /^\/api\/v1\/uploads\/upl_[0-9a-z]+\/complete$/;
const CONTENT_PATH = /^\/api\/v1\/files\/file_[0-9a-z]+\/content$/;
const DELIVERY_PATH = /^\/api\/v1\/files\/file_[0-9a-z]+\/delivery-url$/;

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function initiateRoute(): FakeRoute {
  return {
    method: 'POST',
    path: `${API_PREFIX}/uploads`,
    respond: () => ({
      status: 201,
      body: {
        uploadId: UPLOAD_ID,
        fileId: NEW_FILE_ID,
        chunkSizeBytes: 8 * 1024 ** 2,
        expiresAt: NOW,
      },
    }),
  };
}

function partRoute(respond: FakeRoute['respond']): FakeRoute {
  return { method: 'PUT', path: PART_PATH, respond };
}

function completeRoute(): FakeRoute {
  return {
    method: 'POST',
    path: COMPLETE_PATH,
    respond: () => ({
      status: 200,
      body: { file: fileFixture({ id: NEW_FILE_ID, filename: 'holiday.png' }) },
    }),
  };
}

function abortRoute(respond: FakeRoute['respond'] = () => ({ status: 204 })): FakeRoute {
  return { method: 'DELETE', path: /^\/api\/v1\/uploads\/upl_[0-9a-z]+$/, respond };
}

function chooseFiles(name: string, bytes: number, type = 'image/png'): void {
  const file = new File([new Uint8Array(bytes)], name, { type });
  fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files: [file] } });
}

describe('listing and navigation', () => {
  it('lists the files the API returns, with the count it can actually stand behind', async () => {
    renderApp({
      session: sessionFixture(),
      routes: defaultRoutes({ files: [fileFixture({ filename: 'chart.png' })] }),
    });

    expect(await screen.findByText('chart.png')).toBeTruthy();
    expect(screen.getByText(/1 file/)).toBeTruthy();
    expect(screen.queryByText('Your drive is empty')).toBeNull();
  });

  it('tells an empty drive apart from an empty folder and offers the real next action', async () => {
    renderApp({ session: sessionFixture(), routes: defaultRoutes({ files: [] }) });

    expect(await screen.findByText('Your drive is empty')).toBeTruthy();
    const uploads = screen.getAllByRole('button', { name: /upload files/i });
    expect(uploads.length).toBeGreaterThan(0);
    for (const button of uploads) expect(button.hasAttribute('disabled')).toBe(false);
  });

  it("shows a load failure with the API's reason and re-reads the folder when asked", async () => {
    let attempt = 0;
    const routes: FakeRoute[] = [
      {
        method: 'GET',
        path: `${API_PREFIX}/files`,
        respond: () => {
          attempt += 1;
          return attempt === 1
            ? problem(503, 'STORAGE_UNAVAILABLE', 'The storage provider did not answer.')
            : {
                status: 200,
                body: { items: [fileFixture({ filename: 'later.png' })], nextCursor: null },
              };
        },
      },
      ...defaultRoutes(),
    ];
    renderApp({ session: sessionFixture(), routes });

    expect(await screen.findByText('This folder could not be loaded')).toBeTruthy();
    expect(screen.getByText('The storage provider did not answer.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('later.png')).toBeTruthy();
  });

  it('narrows only what is loaded, and says so when nothing matches', async () => {
    renderApp({
      session: sessionFixture(),
      routes: defaultRoutes({
        files: [
          fileFixture({ filename: 'chart.png' }),
          fileFixture({ id: `file_${'4'.repeat(26)}`, filename: 'log.txt' }),
        ],
      }),
    });

    await screen.findByText('chart.png');
    fireEvent.change(screen.getByPlaceholderText('Filter this page…'), {
      target: { value: 'log' },
    });

    expect(screen.queryByText('chart.png')).toBeNull();
    await screen.findByText('log.txt');
    expect(screen.getByText(/1 of 2/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Filter this page…'), {
      target: { value: 'nothing' },
    });
    expect(screen.getByText('Nothing on this page matches that filter')).toBeTruthy();
    expect(screen.getByText(/searches only the 2 files loaded here/)).toBeTruthy();
  });
});

describe('capability gating', () => {
  it('disables upload, with the reason, when no storage provider is attached', async () => {
    renderApp({ session: sessionFixture(), routes: defaultRoutes({ storage: 'not_configured' }) });

    await screen.findByText('chart.png');
    const uploads = screen.getAllByRole('button', { name: /upload files/i });
    expect(uploads.length).toBeGreaterThan(0);
    for (const button of uploads) expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByTitle(/no provider configured/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/accepts files up to/)).toBeNull();
  });

  it('refuses a file above the published ceiling before a byte moves', async () => {
    const { server } = renderApp({
      session: sessionFixture(),
      routes: [
        ...defaultRoutes({ limits: { maxFileSizeBytes: 1024 } }),
        initiateRoute(),
        partRoute(() => ({ status: 200, body: { partNumber: 1, receivedBytes: 2048 } })),
      ],
    });

    await screen.findByText('chart.png');
    chooseFiles('huge.bin', 2048);

    expect(
      await screen.findByText(/huge\.bin: This deployment accepts files up to 1\.00 KiB\./),
    ).toBeTruthy();
    expect(
      server.calls.some((call) => call.method === 'POST' && call.path === `${API_PREFIX}/uploads`),
    ).toBe(false);
  });
});

describe('uploading', () => {
  it('sends a part with its checksum, and says ready only after the API confirms completion', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes(),
      initiateRoute(),
      partRoute((request) => ({
        status: 200,
        body: {
          partNumber: Number(request.path.split('/').pop()),
          receivedBytes: (request.body as Blob).size,
        },
      })),
      completeRoute(),
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await screen.findByText('chart.png');
    chooseFiles('holiday.png', 200);

    // The tray reports the phase the server is in, so "ready" is only reachable through /complete.
    expect(await screen.findByText('holiday.png')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());

    const part = server.calls.find((call) => call.method === 'PUT');
    expect(part?.path).toBe(`${API_PREFIX}/uploads/${UPLOAD_ID}/parts/1`);
    expect(part?.headers['x-part-checksum-sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect((part?.body as Blob).size).toBe(200);

    // The dial reports transmitted bytes, so a completed transfer reads exactly 100 — and it is
    // driven by the same figure the row's labelled progress bar announces.
    expect(document.querySelector('.dial__value')?.textContent).toBe('100');

    const initiatedAt = server.calls.findIndex((call) => call.path === `${API_PREFIX}/uploads`);
    const completedAt = server.calls.findIndex(
      (call) => call.method === 'POST' && call.path.endsWith('/complete'),
    );
    expect(initiatedAt).toBeGreaterThanOrEqual(0);
    expect(completedAt).toBeGreaterThan(initiatedAt);
  });

  it("reports a refused part with the API's own reason and never claims success", async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes(),
      initiateRoute(),
      partRoute(() =>
        problem(413, 'PAYLOAD_TOO_LARGE', 'That part is larger than this deployment accepts.'),
      ),
      completeRoute(),
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await screen.findByText('chart.png');
    chooseFiles('holiday.png', 200);

    expect(
      await screen.findByText(/That part is larger than this deployment accepts\./),
    ).toBeTruthy();
    expect(screen.queryByText('Ready')).toBeNull();
    expect(
      server.calls.some((call) => call.method === 'POST' && call.path.endsWith('/complete')),
    ).toBe(false);
  });

  it('gives the failed session back, so the next upload is not refused', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes(),
      initiateRoute(),
      partRoute(() =>
        problem(413, 'PAYLOAD_TOO_LARGE', 'That part is larger than this deployment accepts.'),
      ),
      completeRoute(),
      abortRoute(),
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await screen.findByText('chart.png');
    chooseFiles('holiday.png', 200);

    expect(
      await screen.findByText(/That part is larger than this deployment accepts\./),
    ).toBeTruthy();

    // The attempt ended without finalizing, so its session is still open on the API. Open sessions
    // count against the per-principal cap; leaving it behind is what makes a retry answer "at most
    // N uploads may be open at once". The client must release it.
    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.method === 'DELETE' && call.path === `${API_PREFIX}/uploads/${UPLOAD_ID}`,
        ),
      ).toBe(true),
    );
  });

  it("cancels through the API and reports the API's answer, not the intention", async () => {
    const gate = deferred<FakeResponse>();
    const routes: FakeRoute[] = [
      ...defaultRoutes(),
      initiateRoute(),
      partRoute(() => gate.promise),
      abortRoute(),
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await screen.findByText('chart.png');
    chooseFiles('holiday.png', 200);
    await waitFor(() => expect(server.calls.some((call) => call.method === 'PUT')).toBe(true));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(
        server.calls.some(
          (call) => call.method === 'DELETE' && call.path === `${API_PREFIX}/uploads/${UPLOAD_ID}`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Cancelled')).toBeTruthy();

    // A part answer that arrives after the abort must not resurrect the transfer.
    gate.resolve({ status: 200, body: { partNumber: 1, receivedBytes: 200 } });
    await waitFor(() => expect(screen.queryByText('Ready')).toBeNull());
  });

  it('admits when the cancel never reached the API', async () => {
    const gate = deferred<FakeResponse>();
    const routes: FakeRoute[] = [
      ...defaultRoutes(),
      initiateRoute(),
      partRoute(() => gate.promise),
      abortRoute(() => problem(503, 'UNAVAILABLE', 'Try again later.')),
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await screen.findByText('chart.png');
    chooseFiles('holiday.png', 200);
    await waitFor(() => expect(server.calls.some((call) => call.method === 'PUT')).toBe(true));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(/Cancelling did not reach the API/)).toBeTruthy();
    expect(screen.getByText('Cancel requested (not confirmed)')).toBeTruthy();
  });
});

describe('downloading', () => {
  it('saves through the content endpoint and is honest about the browser buffering it', async () => {
    // jsdom does not implement navigation, so the click that would hand the file to the browser
    // is observed rather than performed.
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [fileFixture({ filename: 'chart.png' })] }),
      {
        method: 'GET',
        path: CONTENT_PATH,
        respond: () => ({ status: 200, text: 'PNGDATA', contentType: 'image/png' }),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('chart.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for chart.png' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /download/i }));

    expect(
      await screen.findByText(/Downloaded chart\.png \(buffered in memory by this browser\)\./),
    ).toBeTruthy();
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a[download="chart.png"]')).toBeNull();
  });

  it('reports a file the API will not serve instead of pretending it downloaded', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [fileFixture({ filename: 'chart.png' })] }),
      {
        method: 'GET',
        path: CONTENT_PATH,
        respond: () =>
          problem(409, 'FILE_NOT_SERVABLE', 'This file is quarantined and cannot be served.'),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('chart.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for chart.png' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /download/i }));

    expect(await screen.findByText(/This file is quarantined and cannot be served\./)).toBeTruthy();
    expect(screen.queryByText(/Downloaded chart\.png/)).toBeNull();
  });
});

describe('deleting', () => {
  it('asks first, states the Telegram caveat, and deletes through the API', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [fileFixture({ filename: 'chart.png' })] }),
      {
        method: 'DELETE',
        path: /^\/api\/v1\/files\/file_[0-9a-z]+$/,
        respond: () => ({ status: 200, body: {} }),
      },
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('chart.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for chart.png' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^delete$/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/Telegram/);
    expect(dialog.textContent).toMatch(/not guarantee/i);
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await screen.findByText(/chart\.png deleted\./)).toBeTruthy();
    await waitFor(() => expect(server.calls.some((call) => call.method === 'DELETE')).toBe(true));
  });

  it('keeps the row and reports the reason when the API refuses the deletion', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [fileFixture({ filename: 'chart.png' })] }),
      {
        method: 'DELETE',
        path: /^\/api\/v1\/files\/file_[0-9a-z]+$/,
        respond: () => problem(403, 'FORBIDDEN', 'This credential is not allowed to do that.'),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('chart.png'));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for chart.png' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete file' }),
    );

    expect(await screen.findByText(/not allowed to do that/)).toBeTruthy();
    expect(screen.getByText('chart.png')).toBeTruthy();
    expect(screen.queryByText(/chart\.png deleted\./)).toBeNull();
  });
});

describe('preview', () => {
  it('shows an image through a signed delivery URL the API minted', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [fileFixture({ filename: 'chart.png' })] }),
      {
        method: 'POST',
        path: DELIVERY_PATH,
        respond: () => ({
          status: 200,
          body: {
            path: '/cdn/file_00000000000000000000000001/sobj_00000000000000000000000001?token=abc.def',
            url: 'http://localhost/cdn/file_00000000000000000000000001/sobj_00000000000000000000000001?token=abc.def',
            expiresAt: '2026-10-12T13:00:00.000Z',
          },
        }),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('chart.png'));
    fireEvent.click(screen.getByRole('button', { name: 'chart.png' }));

    const image = await screen.findByRole('img', { name: 'chart.png' });
    expect(image.getAttribute('src')).toBe(
      '/cdn/file_00000000000000000000000001/sobj_00000000000000000000000001?token=abc.def',
    );
    expect(await screen.findByRole('link', { name: /open in a new tab/i })).toBeTruthy();
  });

  it('opens a video in the watch player instead of a raw media tab', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [fileFixture({ filename: 'clip.mp4', mimeType: 'video/mp4' })] }),
      {
        method: 'POST',
        path: DELIVERY_PATH,
        respond: () => ({
          status: 200,
          body: {
            path: '/cdn/file_00000000000000000000000001/sobj_00000000000000000000000001?token=abc.def',
            url: 'http://localhost/cdn/file_00000000000000000000000001/sobj_00000000000000000000000001?token=abc.def',
            expiresAt: '2026-10-12T13:00:00.000Z',
          },
        }),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('clip.mp4'));
    fireEvent.click(screen.getByRole('button', { name: 'clip.mp4' }));

    const link = await screen.findByRole('link', { name: /open in a new tab/i });
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('/watch?')).toBe(true);

    const query = new URLSearchParams(href.split('?')[1] ?? '');
    // The client composes the delivery URL against its own base: same-origin in the test harness,
    // the absolute API origin in a split deployment.
    expect(query.get('src')).toBe(
      '/cdn/file_00000000000000000000000001/sobj_00000000000000000000000001?token=abc.def',
    );
    expect(query.get('title')).toBe('clip.mp4');
    expect(query.get('mpegts')).toBeNull();
  });

  it('shows a small text file read through the authenticated client', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({
        files: [fileFixture({ filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 11 })],
      }),
      {
        method: 'GET',
        path: CONTENT_PATH,
        respond: () => ({ status: 200, text: 'hello world', contentType: 'text/plain' }),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('notes.txt'));
    fireEvent.click(screen.getByRole('button', { name: 'notes.txt' }));

    expect(await screen.findByText('hello world')).toBeTruthy();
  });

  it('says plainly that a type with no inline preview cannot be previewed, and never asks', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({
        files: [fileFixture({ filename: 'bundle.zip', mimeType: 'application/zip' })],
      }),
    ];
    const { server } = renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('bundle.zip'));
    fireEvent.click(screen.getByRole('button', { name: 'bundle.zip' }));

    expect(await screen.findByText(/no inline preview/i)).toBeTruthy();
    // The client never asks the API to preview a family it cannot render.
    expect(server.calls.some((call) => call.path.endsWith('/preview'))).toBe(false);
  });

  it('reports a refused delivery instead of showing a broken element', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({
        files: [fileFixture({ filename: 'vector.svg', mimeType: 'image/svg+xml' })],
      }),
      {
        method: 'POST',
        path: DELIVERY_PATH,
        respond: () =>
          problem(
            409,
            'CONFLICT',
            'This file type is not rendered inline, so it cannot be previewed.',
          ),
      },
    ];
    renderApp({ session: sessionFixture(), routes });

    await settle(() => screen.findByText('vector.svg'));
    fireEvent.click(screen.getByRole('button', { name: 'vector.svg' }));

    expect(await screen.findByText(/not rendered inline/i)).toBeTruthy();
    // No element was pointed at a URL the API refused: the logo is the only remaining image.
    expect(screen.queryByRole('img', { name: 'vector.svg' })).toBeNull();
  });
});

describe('anonymous sessions', () => {
  it('shows the one-time deletion token where the API issued it, and cannot delete without it', async () => {
    const routes: FakeRoute[] = [
      ...defaultRoutes({ files: [] }),
      {
        method: 'POST',
        path: `${API_PREFIX}/uploads`,
        respond: () => ({
          status: 201,
          body: {
            uploadId: UPLOAD_ID,
            fileId: NEW_FILE_ID,
            chunkSizeBytes: 8 * 1024 ** 2,
            deletionToken: 'dt_' + 'a'.repeat(40),
            expiresAt: NOW,
          },
        }),
      },
      partRoute(() => ({ status: 200, body: { partNumber: 1, receivedBytes: 200 } })),
      completeRoute(),
    ];
    const { server } = renderApp({ session: null, initialEntries: ['/signin'], routes });

    fireEvent.click(await screen.findByRole('button', { name: /start an anonymous session/i }));

    await waitFor(() =>
      expect(server.calls.some((call) => call.path === `${API_PREFIX}/anonymous-sessions`)).toBe(
        true,
      ),
    );
    await screen.findByLabelText('Choose files to upload');
    chooseFiles('holiday.png', 200);

    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy());
    expect(screen.getByRole('button', { name: /copy deletion token/i })).toBeTruthy();
    expect(screen.getByText(/only credential that can remove this file/)).toBeTruthy();
  });
});

describe('quota copy', () => {
  it('describes the ceiling as configured rather than verified until a provider has proved it', async () => {
    renderApp({
      session: sessionFixture(),
      routes: defaultRoutes({
        limits: { maxFileSizeBytes: 5 * 1024 ** 3, maxFileSizeVerified: false },
      }),
    });

    expect(await screen.findByText(/accepts files up to 5\.00 GiB per file/)).toBeTruthy();
    expect(screen.getByText(/configured, not yet verified against the provider/)).toBeTruthy();
  });
});
