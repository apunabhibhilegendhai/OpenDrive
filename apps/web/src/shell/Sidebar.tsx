import { NavLink } from 'react-router';
import { WaveBand } from '../assets/WaveBand.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Mark } from '../components/Mark.js';

/**
 * The navigation rail.
 *
 * Only destinations that exist are listed. There is deliberately no Trash, Starred, Recents or
 * Search entry, because the API has no such resource yet — an empty promise in a sidebar is
 * still a lie.
 */
const DESTINATIONS: { to: string; label: string; icon: IconName }[] = [
  { to: '/drive', label: 'My Drive', icon: 'folder' },
  { to: '/shares', label: 'Shares', icon: 'link' },
  { to: '/account', label: 'Account', icon: 'key' },
  { to: '/status', label: 'System status', icon: 'graph' },
];

export function Sidebar({ onSignOut }: { onSignOut: () => void }) {
  return (
    <aside className="rail" id="app-nav" aria-label="Primary">
      <div className="rail__brand">
        <Mark size={34} />
        <span className="rail__wordmark">
          Open<span className="rail__wordmark-accent">Drive</span>
        </span>
      </div>

      <WaveBand height={14} className="rail__edge" />

      <nav className="rail__nav">
        <ul className="rail__list">
          {DESTINATIONS.map((destination) => (
            <li key={destination.to}>
              <NavLink
                to={destination.to}
                className={({ isActive }) => `rail__link${isActive ? ' rail__link--active' : ''}`}
              >
                <Icon name={destination.icon} size={17} />
                <span className="rail__label">{destination.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="rail__foot">
        <p className="rail__note">
          Files are private by default. A link shares exactly one file, for as long as you allow it.
        </p>
        <button type="button" className="btn btn--ghost rail__signout" onClick={onSignOut}>
          <Icon name="sign-out" size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
