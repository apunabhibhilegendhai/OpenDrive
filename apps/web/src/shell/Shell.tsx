import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ChartTexture } from '../assets/ChartTexture.js';
import { CommandPalette, type Command } from '../components/CommandPalette.js';
import { Icon } from '../components/Icon.js';
import { Menu } from '../components/Menu.js';
import { usePrefs } from '../state/prefs.js';
import { useSystem } from '../state/system.js';
import { useUploadQueue } from '../state/uploadQueue.js';
import { useSession } from '../lib/auth/session.js';
import { UploadTray } from '../upload/UploadTray.js';
import { Sidebar } from './Sidebar.js';
import { StorageMeter } from './StorageMeter.js';

/**
 * The app shell: navigation rail, command bar, global keyboard entry points and the upload tray.
 *
 * The palette is built from what is real: navigation that exists, plus whatever commands the
 * current page can honestly offer. Nothing here can reach a capability the API does not have.
 */
export interface Crumb {
  label: string;
  to?: string;
}

export function Shell({
  title,
  crumbs,
  actions,
  extraCommands = [],
  children,
}: {
  title: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  extraCommands?: Command[];
  children: ReactNode;
}) {
  const { prefs, toggleTheme } = usePrefs();
  const { me } = useSystem();
  const { state, signOut } = useSession();
  const queue = useUploadQueue();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const principalLabel =
    state.kind === 'signed-in'
      ? (state.session.email ?? state.session.displayName ?? 'Signed in')
      : state.kind === 'anonymous'
        ? 'Anonymous session'
        : 'Signed out';

  useEffect(() => {
    document.title = `${title} · OpenDrive`;
  }, [title]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const closeNav = useCallback(() => setNavOpen(false), []);

  const commands = useMemo<Command[]>(() => {
    const global: Command[] = [
      {
        id: 'nav.drive',
        label: 'Go to My Drive',
        icon: 'folder',
        keywords: 'files home',
        run: () => void navigate('/drive'),
      },
      {
        id: 'nav.shares',
        label: 'Go to Shares',
        icon: 'link',
        keywords: 'links',
        run: () => void navigate('/shares'),
      },
      {
        id: 'nav.account',
        label: 'Go to Account',
        icon: 'key',
        keywords: 'api keys identity',
        run: () => void navigate('/account'),
      },
      {
        id: 'nav.status',
        label: 'Go to System status',
        icon: 'graph',
        keywords: 'readiness limits health',
        run: () => void navigate('/status'),
      },
      {
        id: 'view.theme',
        label:
          prefs.theme === 'dark'
            ? 'Switch to Chart Paper (light)'
            : 'Switch to Night Voyage (dark)',
        icon: prefs.theme === 'dark' ? 'sun' : 'moon',
        keywords: 'theme dark light appearance',
        run: toggleTheme,
      },
      {
        id: 'session.signout',
        label: 'Sign out',
        icon: 'sign-out',
        keywords: 'logout leave',
        run: () => void signOut(),
      },
    ];
    return [...global, ...extraCommands];
  }, [navigate, prefs.theme, toggleTheme, signOut, extraCommands]);

  return (
    <div className={`shell${navOpen ? ' shell--nav-open' : ''}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      {/* The chart the workspace is pinned to. Decorative, fixed, and never under text. */}
      <ChartTexture />

      <Sidebar onSignOut={() => void signOut()} />

      <div className="shell__main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn--ghost btn--icon topbar__nav-toggle"
            aria-expanded={navOpen}
            aria-controls="app-nav"
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name={navOpen ? 'close' : 'list'} />
            <span className="visually-hidden">
              {navOpen ? 'Close navigation' : 'Open navigation'}
            </span>
          </button>

          <nav className="crumbs" aria-label="Breadcrumb">
            <ol className="crumbs__list">
              {(crumbs ?? [{ label: title }]).map((crumb, index, all) => (
                <li key={`${crumb.label}-${index}`} className="crumbs__item">
                  {crumb.to !== undefined && index < all.length - 1 ? (
                    <Link to={crumb.to} className="crumbs__link" onClick={closeNav}>
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className="crumbs__current" aria-current="page">
                      {crumb.label}
                    </span>
                  )}
                  {index < all.length - 1 && (
                    <Icon name="chevron-right" size={13} className="crumbs__sep" />
                  )}
                </li>
              ))}
            </ol>
          </nav>

          <div className="topbar__tools">
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              title="Command palette (Ctrl+K)"
            >
              <Icon name="search" />
            </button>
            <StorageMeter me={me} />
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={toggleTheme}
              aria-label={prefs.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              <Icon name={prefs.theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <Menu
              label={`Account: ${principalLabel}`}
              icon="user"
              items={[
                {
                  id: 'account.open',
                  label: 'Account',
                  icon: 'key',
                  onSelect: () => void navigate('/account'),
                },
                {
                  id: 'session.signout',
                  label: 'Sign out',
                  icon: 'sign-out',
                  danger: true,
                  onSelect: () => void signOut(),
                },
              ]}
            />
          </div>
        </header>

        <main className="content" id="main" tabIndex={-1}>
          <div className="content__inner">{children}</div>
        </main>

        {actions !== undefined && (
          <div className="pagebar" role="group" aria-label="Page actions">
            {actions}
          </div>
        )}

        {queue.items.length > 0 && <UploadTray />}
      </div>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
