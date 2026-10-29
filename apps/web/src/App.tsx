import { Navigate, Route, Routes } from 'react-router';
import { EmptyState } from './files/EmptyState.js';
import { useSession } from './lib/auth/session.js';
import { AccountRoute } from './routes/AccountRoute.js';
import { DriveRoute } from './routes/DriveRoute.js';
import { SharesRoute } from './routes/SharesRoute.js';
import { SignInRoute } from './routes/SignInRoute.js';
import { StatusRoute } from './routes/StatusRoute.js';
import { WatchRoute } from './routes/WatchRoute.js';

/**
 * Route table.
 *
 * `/drive`, `/shares`, `/account` and `/status` need a principal, and everything else is either
 * the sign-in screen or a not-found. A signed-out visitor is redirected rather than shown an
 * empty shell, so no screen ever renders a blank version of somebody else's drive.
 */
function RequireSession({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  if (state.kind === 'loading') {
    return (
      <main className="boot" role="status" aria-live="polite">
        <p className="boot__word">OpenDrive</p>
        <p className="boot__note">Restoring the session…</p>
      </main>
    );
  }
  if (state.kind === 'signed-out') {
    return <Navigate to="/signin" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/drive" replace />} />
      <Route path="/signin" element={<SignInRoute />} />
      {/* Public: a delivery URL is its own short-lived credential, so a watch link works without
          asking a signed-out visitor for a session. */}
      <Route path="/watch" element={<WatchRoute />} />
      <Route
        path="/drive"
        element={
          <RequireSession>
            <DriveRoute />
          </RequireSession>
        }
      />
      <Route
        path="/shares"
        element={
          <RequireSession>
            <SharesRoute />
          </RequireSession>
        }
      />
      <Route
        path="/account"
        element={
          <RequireSession>
            <AccountRoute />
          </RequireSession>
        }
      />
      <Route
        path="/status"
        element={
          <RequireSession>
            <StatusRoute />
          </RequireSession>
        }
      />
      <Route
        path="*"
        element={
          <main className="boot">
            <EmptyState
              kind="empty"
              title="No such page"
              detail="That address does not exist in this build."
              action={
                <a className="btn" href="/drive">
                  Go to My Drive
                </a>
              }
            />
          </main>
        }
      />
    </Routes>
  );
}
