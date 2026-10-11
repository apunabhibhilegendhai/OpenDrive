import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL, fetchBuildStatus } from './lib/api.js';
import type { BuildStatus } from './lib/api.js';
import { formatBytes, formatClockTime } from './lib/format.js';
import { CapacityRuler } from './components/CapacityRuler.js';
import { LedgerSection } from './components/LedgerSection.js';
import { StatusChip } from './components/StatusChip.js';

const UNIMPLEMENTED_ENDPOINTS: { method: string; path: string; does: string }[] = [
  { method: 'POST', path: '/api/v1/uploads', does: 'declare an upload' },
  { method: 'PUT', path: '/api/v1/uploads/{id}/parts/{n}', does: 'send a part' },
  { method: 'POST', path: '/api/v1/uploads/{id}/complete', does: 'finish an upload' },
  { method: 'GET', path: '/api/v1/files/{id}', does: 'read metadata' },
  { method: 'GET', path: '/api/v1/files/{id}/content', does: 'download bytes' },
  { method: 'POST', path: '/api/v1/shares', does: 'create a share link' },
  { method: 'POST', path: '/api/v1/abuse-reports', does: 'report a file' },
];

function healthTone(status: BuildStatus | null): 'live' | 'down' | 'idle' {
  if (status === null) return 'idle';
  return status.health.state === 'ok' ? 'live' : 'down';
}

export function App() {
  const [status, setStatus] = useState<BuildStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const check = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setChecking(true);
    try {
      setStatus(await fetchBuildStatus(next.signal));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    return () => controller.current?.abort();
  }, [check]);

  const limits = status?.limits.state === 'ok' ? status.limits.data : null;
  const readiness = status?.readiness.state === 'ok' ? status.readiness.data : null;
  const health = status?.health.state === 'ok' ? status.health.data : null;

  const readyState =
    readiness === null
      ? { tone: 'idle' as const, word: 'unknown', label: 'no answer from /readyz' }
      : readiness.status === 'ready'
        ? { tone: 'live' as const, word: 'ready', label: 'all required dependencies verified' }
        : {
            tone: 'warn' as const,
            word: 'degraded',
            label: `${readiness.dependencies.filter((d) => d.status !== 'ok').length} dependency issue(s)`,
          };

  return (
    <main className="page">
      <header className="masthead">
        <p className="masthead__word">OpenDrive</p>
        <p className="masthead__meta">
          Phase 0 build
          <span className="masthead__sep" aria-hidden="true">
            /
          </span>
          {API_BASE_URL === '' ? 'same origin' : API_BASE_URL}
        </p>
      </header>

      <div className="hero">
        <h1 className="hero__headline">
          Nothing is being stored yet, and this page will not pretend otherwise.
        </h1>
        <p className="hero__lede">
          The repository, the API contracts, the limits and the storage interface exist and are
          tested. Uploads, downloads and share links are published as contracts and answer{' '}
          <code>501 Not Implemented</code> until a storage provider is verified and the database is
          wired in.
        </p>
      </div>

      <div className="statusbar" aria-live="polite">
        <StatusChip
          tone={healthTone(status)}
          state={health?.status ?? (status === null ? 'checking' : 'unreachable')}
          label={health === null ? 'GET /healthz' : `opendrive-api ${health.version}`}
        />
        <StatusChip tone={readyState.tone} state={readyState.word} label={readyState.label} />
        <button
          className="statusbar__refresh"
          type="button"
          onClick={() => void check()}
          disabled={checking}
        >
          {checking ? 'Checking…' : 'Check again'}
        </button>
        <span className="statusbar__time">
          {status === null ? 'no reading yet' : `read at ${formatClockTime(status.checkedAt)}`}
        </span>
      </div>

      <LedgerSection title="Answering right now" note="Live endpoints, checked on every page load.">
        <ul className="facts">
          <li className="facts__row">
            <code className="facts__path">GET /healthz</code>
            <span className="facts__value">
              {health === null
                ? 'no answer'
                : `up ${Math.floor(health.uptimeSeconds / 60)}m ${health.uptimeSeconds % 60}s, api ${health.apiVersion}`}
            </span>
          </li>
          <li className="facts__row">
            <code className="facts__path">GET /readyz</code>
            <span className="facts__value">
              {status?.readiness.state === 'unexpected' || status?.readiness.state === 'unreachable'
                ? status.readiness.detail
                : 'reports every dependency below'}
            </span>
          </li>
          <li className="facts__row">
            <code className="facts__path">GET /api/v1/limits</code>
            <span className="facts__value">
              {limits === null
                ? 'no answer'
                : `max ${formatBytes(limits.maxFileSizeBytes)} per file`}
            </span>
          </li>
        </ul>

        {readiness !== null && (
          <ul className="deps">
            {readiness.dependencies.map((dependency) => (
              <li key={dependency.name} className="deps__row">
                <span className={`deps__status deps__status--${dependency.status}`}>
                  {dependency.status.replaceAll('_', ' ')}
                </span>
                <span className="deps__name">
                  {dependency.name}
                  {dependency.required ? ' (required)' : ' (optional)'}
                </span>
                <span className="deps__detail">{dependency.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </LedgerSection>

      <LedgerSection
        title="Size this build could accept"
        note="A target is not a capability until a provider proves it."
      >
        <CapacityRuler
          maxFileSizeBytes={limits?.maxFileSizeBytes ?? 2 * 1024 ** 3}
          verified={limits?.maxFileSizeVerified ?? false}
        />
      </LedgerSection>

      <LedgerSection
        title="Limits it reports"
        note="Read from the environment on startup; invalid values stop the API instead of defaulting."
      >
        {limits === null ? (
          <p className="empty">
            No limits came back from <code>/api/v1/limits</code>. Start the API, then check again.
          </p>
        ) : (
          <dl className="limits">
            <div className="limits__row">
              <dt>Per file</dt>
              <dd>{formatBytes(limits.maxFileSizeBytes)}</dd>
            </div>
            <div className="limits__row">
              <dt>Part size</dt>
              <dd>
                {formatBytes(limits.chunkSizeBytes)} (allowed{' '}
                {formatBytes(limits.minChunkSizeBytes)} – {formatBytes(limits.maxChunkSizeBytes)})
              </dd>
            </div>
            <div className="limits__row">
              <dt>Parts per upload</dt>
              <dd>{limits.maxPartsPerUpload.toLocaleString()}</dd>
            </div>
            <div className="limits__row">
              <dt>Uploads per day</dt>
              <dd>
                {limits.anonymousUploadsPerDay} anonymous, {limits.registeredUploadsPerDay} with an
                account
              </dd>
            </div>
            <div className="limits__row">
              <dt>Malware scanning</dt>
              <dd>{limits.malwareScanEnabled ? 'enabled before download' : 'not enabled'}</dd>
            </div>
          </dl>
        )}
      </LedgerSection>

      <LedgerSection
        title="Not built yet"
        note="These routes exist and answer 501. They create nothing."
      >
        <ul className="todo">
          {UNIMPLEMENTED_ENDPOINTS.map((endpoint) => (
            <li key={`${endpoint.method} ${endpoint.path}`} className="todo__row">
              <span className="todo__method">{endpoint.method}</span>
              <code className="todo__path">{endpoint.path}</code>
              <span className="todo__does">{endpoint.does}</span>
            </li>
          ))}
        </ul>
        <p className="todo__note">
          Before any of these can work: a verified storage provider, Postgres migrations applied,
          Redis connected for rate limits and quotas, and an authorization layer for private files.
        </p>
      </LedgerSection>

      <LedgerSection
        title="Run it yourself"
        note="Everything below runs locally with no paid services."
      >
        <pre className="commands">
          <code>
            {
              'pnpm install\npnpm --filter @opendrive/api dev\npnpm --filter @opendrive/web dev\npnpm verify'
            }
          </code>
        </pre>
      </LedgerSection>

      <footer className="footer">
        <p>
          If this page ever shows a file, a share link or a progress bar for a real upload before
          those systems exist, that is a bug — the platform refuses writes it cannot complete.
        </p>
      </footer>
    </main>
  );
}
