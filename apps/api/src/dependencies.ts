import type { ApiConfig } from './config.js';
import type { DatabaseClient } from './db/client.js';
import { inspectDatabaseRole } from './db/role-safety.js';
import type { StorageResolution } from './storage/registry.js';

/**
 * Readiness probes.
 *
 * A dependency is only reported `ok` when it has actually been verified. That rule is why the
 * Postgres probe runs a query rather than trusting that a URL was set, and why the authentication
 * probe fetches the JWKS endpoint when one is configured instead of assuming it answers.
 *
 * Postgres has a second, subtler dimension: a successful connection is not the same as a *useful*
 * connection. Connecting as a superuser or as the table owner silently disables Row Level Security
 * (see `db/role-safety.ts`), so the probe reports that as `degraded` with the specific hazard named,
 * and readiness goes non-ready with it. The API keeps working — the database half of the defence is
 * simply no longer there, and an operator needs to know before it matters.
 */

export type DependencyName = 'postgres' | 'redis' | 'storage' | 'auth';

export type DependencyStatus = 'ok' | 'degraded' | 'unavailable' | 'not_configured';

export interface DependencyProbeResult {
  status: DependencyStatus;
  detail: string;
}

export interface DependencyProbe {
  name: DependencyName;
  /** When true, this dependency must be `ok` for the process to report readiness. */
  required: boolean;
  probe: () => Promise<DependencyProbeResult>;
}

export interface ReadinessReport {
  status: 'ready' | 'degraded';
  checkedAt: string;
  dependencies: {
    name: DependencyName;
    status: DependencyStatus;
    required: boolean;
    detail: string;
  }[];
}

function unconfigured(what: string, missing: readonly string[]): DependencyProbeResult {
  return {
    status: 'not_configured',
    detail: `${what} is not configured. Missing: ${missing.join(', ')}.`,
  };
}

/** Kept short: a readiness probe must not become the slowest endpoint in the system. */
const PROBE_TIMEOUT_MS = 3000;

async function probeAuth(config: ApiConfig): Promise<DependencyProbeResult> {
  if (!config.auth.configured) {
    return unconfigured(
      'Access-token verification (Supabase Auth)',
      config.dependencies.auth.missingVariables,
    );
  }
  if (config.auth.jwtSecret !== null) {
    return {
      status: 'ok',
      detail: 'Access tokens are verified with the configured HS256 secret.',
    };
  }

  const jwksUrl = config.auth.jwksUrl;
  if (jwksUrl === null) {
    return { status: 'not_configured', detail: 'No token verification key is configured.' };
  }

  try {
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) {
      return {
        status: 'unavailable',
        detail: `The JWKS endpoint answered ${response.status}.`,
      };
    }
    const body: unknown = await response.json();
    const keys =
      typeof body === 'object' && body !== null ? (body as { keys?: unknown }).keys : undefined;
    if (!Array.isArray(keys) || keys.length === 0) {
      return { status: 'unavailable', detail: 'The JWKS endpoint returned no signing keys.' };
    }
    return {
      status: 'ok',
      detail: `Access tokens are verified against the JWKS endpoint (${keys.length} key(s)).`,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      detail: `The JWKS endpoint could not be reached: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
}

async function probePostgres(
  config: ApiConfig,
  db: DatabaseClient | undefined,
): Promise<DependencyProbeResult> {
  if (!config.dependencies.postgres.configured) {
    return unconfigured('The metadata database', config.dependencies.postgres.missingVariables);
  }
  if (db === undefined || db.sql === null) {
    return { status: 'unavailable', detail: 'The database client is not available.' };
  }

  const sql = db.sql;
  const started = Date.now();
  try {
    await sql`select 1`;
  } catch (error) {
    return {
      status: 'unavailable',
      detail: `The metadata database could not be queried: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
  const roundTripMs = Date.now() - started;

  const role = await inspectDatabaseRole(sql);
  if (role.status === 'ok') {
    return {
      status: 'ok',
      detail: `Queried in ${roundTripMs} ms. ${role.detail}`,
    };
  }
  return { status: 'degraded', detail: `Queried in ${roundTripMs} ms. ${role.detail}` };
}

export function createDependencyProbes(
  config: ApiConfig,
  storage: StorageResolution,
  db?: DatabaseClient,
): DependencyProbe[] {
  return [
    { name: 'postgres', required: true, probe: () => probePostgres(config, db) },
    {
      name: 'auth',
      required: true,
      probe: () => probeAuth(config),
    },
    {
      name: 'redis',
      required: false,
      probe: async () => {
        if (!config.dependencies.redis.configured) {
          return unconfigured(
            'Redis (rate limiting and short-lived jobs)',
            config.dependencies.redis.missingVariables,
          );
        }
        return {
          status: 'degraded',
          detail:
            'Redis credentials are present, but no Redis client is wired into this build: rate ' +
            'limiting runs in-process. Redis-backed limits arrive with the upload engine.',
        };
      },
    },
    {
      name: 'storage',
      required: false,
      probe: async () => {
        if (storage.provider === null) {
          return { status: 'not_configured', detail: storage.detail };
        }
        const health = await storage.provider.health();
        return { status: health.status, detail: health.detail };
      },
    },
  ];
}

export async function evaluateReadiness(
  probes: readonly DependencyProbe[],
): Promise<ReadinessReport> {
  const dependencies = await Promise.all(
    probes.map(async (probe) => {
      let result: DependencyProbeResult;
      try {
        result = await probe.probe();
      } catch (error) {
        result = {
          status: 'unavailable',
          detail: `Probe failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        };
      }
      return {
        name: probe.name,
        status: result.status,
        required: probe.required,
        detail: result.detail,
      };
    }),
  );

  const requiredHealthy = dependencies.every(
    (dependency) => !dependency.required || dependency.status === 'ok',
  );
  return {
    status: requiredHealthy ? 'ready' : 'degraded',
    checkedAt: new Date().toISOString(),
    dependencies,
  };
}
