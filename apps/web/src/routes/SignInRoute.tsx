import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ChartTexture } from '../assets/ChartTexture.js';
import { CompassRose } from '../assets/CompassRose.js';
import { WaveBand } from '../assets/WaveBand.js';
import { Icon } from '../components/Icon.js';
import { Mark } from '../components/Mark.js';
import { useSession } from '../lib/auth/session.js';
import { API_BASE_URL } from '../lib/api/client.js';

/**
 * Sign in.
 *
 * Two real paths, both supported by this deployment:
 *
 *   * A Supabase account. The session is managed by the Supabase SDK, which is the only place
 *     the access token lives; it is sent to the OpenDrive API as a bearer header and nowhere
 *     else — not in a URL, not in storage written by this app, not in a log line.
 *   * An anonymous session, issued by the API itself, for uploading without an account. The
 *     credential is held in memory for this tab only, and each upload hands back a one-time
 *     deletion token.
 *
 * When the deployment has no auth service configured, the screen says so instead of offering a
 * form that cannot work.
 */
export function SignInRoute() {
  const { state, authConfigured, signIn, signUp, startAnonymousSession } = useSession();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'sign-in' | 'create'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (state.kind === 'signed-in' || state.kind === 'anonymous') {
    return <Navigate to="/drive" replace />;
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const result =
      mode === 'sign-in' ? await signIn(email, password) : await signUp(email, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That did not work.');
      return;
    }
    if (result.needsEmailConfirmation === true) {
      setNotice(
        'Account created. This deployment requires the email address to be confirmed before signing in.',
      );
      return;
    }
    void navigate('/drive', { replace: true });
  };

  const startAnonymous = async () => {
    setBusy(true);
    setError(null);
    const result = await startAnonymousSession();
    setBusy(false);
    if (result.ok) void navigate('/drive', { replace: true });
    else setError(result.error ?? 'The API refused to open an anonymous session.');
  };

  return (
    <main className="auth">
      <ChartTexture />

      <div className="auth__hero" aria-hidden="true">
        <CompassRose size={112} variant="hero" bearing={38} title={null} />
        <WaveBand height={22} className="auth__hero-waves" />
      </div>

      <div className="auth__card">
        <header className="auth__head">
          <Mark size={38} />
          <div>
            <h1 className="auth__title">
              Open<span className="auth__title-accent">Drive</span>
            </h1>
            <p className="auth__tagline">Private cloud storage. Chart your own course.</p>
          </div>
        </header>

        {state.kind === 'signed-out' && state.notice !== undefined && (
          <p className="auth__notice" role="status">
            <Icon name="info" size={15} />
            {state.notice}
          </p>
        )}

        {authConfigured ? (
          <form className="auth__form" onSubmit={(event) => void submit(event)}>
            <div className="auth__tabs" role="tablist" aria-label="Sign in or create an account">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'sign-in'}
                className={`auth__tab${mode === 'sign-in' ? ' auth__tab--active' : ''}`}
                onClick={() => setMode('sign-in')}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'create'}
                className={`auth__tab${mode === 'create' ? ' auth__tab--active' : ''}`}
                onClick={() => setMode('create')}
              >
                Create account
              </button>
            </div>

            <label className="field">
              <span className="field__label">Email</span>
              <input
                className="input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="input"
                type="password"
                autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                required
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error !== null && (
              <p className="auth__error" role="alert">
                <Icon name="alert" size={15} />
                {error}
              </p>
            )}
            {notice !== null && (
              <p className="auth__notice" role="status">
                <Icon name="info" size={15} />
                {notice}
              </p>
            )}

            <button type="submit" className="btn btn--primary auth__submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
          </form>
        ) : (
          <p className="auth__unconfigured">
            <Icon name="alert" size={15} />
            This build has no account service configured, so signing in is not available here. The
            API verifies Supabase tokens; without `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
            there is nothing to sign in against.
          </p>
        )}

        <div className="auth__divider" role="separator">
          or
        </div>

        <div className="auth__anon">
          <h2 className="auth__anon-title">Upload without an account</h2>
          <p className="auth__anon-copy">
            The API issues an anonymous session credential for this tab. Each upload returns a
            one-time deletion token — the only credential that can remove that file later — so keep
            it if you want the file gone.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => void startAnonymous()}
            disabled={busy}
          >
            <Icon name="upload" size={16} />
            Start an anonymous session
          </button>
        </div>

        <footer className="auth__foot">
          <p>
            API: <span className="mono">{API_BASE_URL === '' ? 'same origin' : API_BASE_URL}</span>
          </p>
          {error !== null && !authConfigured && (
            <p className="auth__error" role="alert">
              {error}
            </p>
          )}
        </footer>
      </div>
    </main>
  );
}
