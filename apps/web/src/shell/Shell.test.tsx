/** @vitest-environment jsdom */
import { API_PREFIX } from '@opendrive/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loadPrefs, PREFS_KEY } from '../lib/prefs.js';
import { defaultRoutes, fileFixture, problem, type FakeRoute } from '../test/fakeServer.js';
import { renderApp, sessionFixture, settle } from '../test/harness.js';

/**
 * The interaction layer: command palette, view preferences, multi-select and dialogs.
 *
 * What is asserted here is behaviour a keyboard user depends on, and the honesty rule that runs
 * through the whole app: a command exists only when the capability behind it does.
 */

const ALPHA = fileFixture({ filename: 'alpha.txt' });
const BETA = fileFixture({ id: `file_${'5'.repeat(26)}`, filename: 'beta.txt' });

function twoFiles(extra: FakeRoute[] = []): FakeRoute[] {
  return [...defaultRoutes({ files: [ALPHA, BETA] }), ...extra];
}

function openPalette() {
  const opener = screen.getByRole('button', { name: 'Open command palette' });
  opener.focus();
  fireEvent.click(opener);
  return { opener };
}

describe('command palette', () => {
  it('opens with Ctrl+K, keeps focus inside, and closes on Escape back to where it started', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(document.activeElement).toBe(within(palette).getByRole('combobox'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
  });

  it('returns focus to the control that opened it', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    const { opener } = openPalette();
    await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('filters, moves the active option with the arrow keys, and runs it with Enter', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    openPalette();
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const input = within(palette).getByRole('combobox');

    fireEvent.change(input, { target: { value: 'night' } });
    const options = within(palette).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain('Switch to Night Voyage (dark)');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('offers no command for a capability this product does not have', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    openPalette();
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    const labels = within(palette)
      .getAllByRole('option')
      .map((option) => option.textContent ?? '');

    expect(labels.join(' | ')).not.toMatch(/trash|recents|starred|restore|empty trash|preview/i);
    expect(labels.join(' | ')).toMatch(/Go to My Drive/);
  });

  it('states that upload is blocked instead of opening a picker that cannot work', async () => {
    renderApp({
      session: sessionFixture(),
      routes: defaultRoutes({ storage: 'not_configured' }),
      initialEntries: ['/drive'],
    });
    await screen.findByText('chart.png');

    openPalette();
    const palette = await screen.findByRole('dialog', { name: 'Command palette' });
    fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'upload' } });

    const option = within(palette).getAllByRole('option')[0];
    expect(option?.textContent).toContain('storage unavailable');
  });
});

describe('view preferences', () => {
  it('stores the theme choice, and stores nothing else about the person', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));

    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));

    // One key, holding the three harmless view preferences and nothing about the person.
    expect(window.localStorage.length).toBe(1);
    const raw = window.localStorage.getItem(PREFS_KEY) ?? '';
    expect(loadPrefs(window.localStorage)).toEqual({
      theme: 'dark',
      view: 'list',
      density: 'comfortable',
    });
    expect(raw).not.toMatch(/token|credential|email|password/i);
  });

  it('switches between list and grid, and between densities, with real classes', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    expect(document.querySelector('.filetable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));
    await waitFor(() => expect(document.querySelector('.filegrid')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(document.querySelector('.filetable')).toBeNull();

    // Tiles are printed plates: the frame carries the file's own state as its stamp, and the
    // stamp is decorative so that state is announced once, by the row's own tag.
    expect(document.querySelectorAll('.tile--stamp .plate')).toHaveLength(2);
    const stamps = [...document.querySelectorAll('.plate__stamp')];
    expect(stamps.map((node) => node.textContent)).toEqual(['ready', 'ready']);
    for (const stamp of stamps) expect(stamp.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Comfortable' }));
    await waitFor(() => expect(document.querySelector('.browser--compact')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'List view' }));
    await waitFor(() => expect(document.querySelector('.filetable')).toBeTruthy());
  });
});

describe('multi-select and bulk actions', () => {
  it("reports each file's own outcome rather than one summary that hides a failure", async () => {
    const routes = twoFiles([
      {
        method: 'DELETE',
        path: `${API_PREFIX}/files/${ALPHA.id}`,
        respond: () => ({ status: 200, body: {} }),
      },
      {
        method: 'DELETE',
        path: `${API_PREFIX}/files/${BETA.id}`,
        respond: () => problem(403, 'FORBIDDEN', 'This credential is not allowed to do that.'),
      },
    ]);
    const { server } = renderApp({ session: sessionFixture(), routes, initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    fireEvent.click(screen.getByLabelText('Select all files on this page'));
    expect(await screen.findByText('2 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /delete selected/i }));

    expect(await screen.findByText(/1 of 2 deleted/)).toBeTruthy();
    expect(screen.getByText(/beta\.txt: This credential is not allowed to do that\./)).toBeTruthy();
    const deletes = server.calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toHaveLength(2);
  });

  it('selects a single row from its checkbox and clears the selection on request', async () => {
    renderApp({ session: sessionFixture(), routes: twoFiles(), initialEntries: ['/drive'] });
    await settle(() => screen.findByText('alpha.txt'));

    fireEvent.click(screen.getByLabelText('Select alpha.txt'));
    expect(await screen.findByText('1 selected')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
  });
});

describe('dialog keyboard behaviour', () => {
  it('closes the delete dialog on Escape without deleting anything', async () => {
    const { server } = renderApp({
      session: sessionFixture(),
      routes: twoFiles(),
      initialEntries: ['/drive'],
    });
    await settle(() => screen.findByText('alpha.txt'));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha.txt' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
