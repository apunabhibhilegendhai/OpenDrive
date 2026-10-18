import type { ApiConfig } from './config.js';
import type { DatabaseClient, Sql } from './db/client.js';
import { inspectDatabaseRole } from './db/role-safety.js';
import type { RoleSafetyReport } from './db/role-safety.js';
import type { RedisConnection } from './redis.js';
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
 *
 * The two halves are checked on different schedules. The liveness query runs on every poll; the
 * role inspection is two catalog queries whose answer only changes when a migration or a deployment
 * changes it, and whose round trips dominate the probe on a tunnelled connection, so one completed
 * inspection is reused for {@link ROLE_INSPECTION_TTL_MS} and the detail says the state is reused.
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

/**
 * How long one completed role inspection is reused, in milliseconds.
 *
 * The inspection reads the connected role and the public tables with RLS switched off. Both change
 * only when a migration or a deployment changes them, while the cost is two round trips on every
 * readiness poll — measured at roughly 1.1 s of a 1.4 s warm `/readyz` through a Cloudflare tunnel,
 * against 0.3 s for the liveness query the probe genuinely needs each time. Five minutes bounds how
 * long a role that was widened by a change can go unnoticed, which is short compared with the
 * review that should accompany such a change in the first place.
 */
const ROLE_INSPECTION_TTL_MS = 5 * 60_000;

/**
 * Last completed inspection, per connection. A WeakMap so a pool that has been replaced is
 * inspected afresh and a closed pool is not kept alive by its own cached report.
 */
const roleInspections = new WeakMap<
  Sql,
  { readonly checkedAt: number; readonly report: RoleSafetyReport }
>();

interface CachedRoleInspection {
  readonly report: RoleSafetyReport;
  /** True when this poll reused an earlier inspection rather than reading the catalog itself. */
  readonly reused: boolean;
}

/**
 * The role inspection, reused for the TTL above. A report of `unavailable` means the catalog could
 * not be read at all — a transient failure, not a fact about the role — so it is never cached and
 * the next poll retries it, rather than leaving readiness stuck on a blip.
 */
async function inspectRoleOnce(sql: Sql): Promise<CachedRoleInspection> {
  const cached = roleInspections.get(sql);
  if (cached !== undefined && Date.now() - cached.checkedAt < ROLE_INSPECTION_TTL_MS) {
    return { report: cached.report, reused: true };
  }

  const report = await inspectDatabaseRole(sql);
  if (report.status === 'unavailable') {
    roleInspections.delete(sql);
    return { report, reused: false };
  }
  roleInspections.set(sql, { checkedAt: Date.now(), report });
  return { report, reused: false };
}

function roleDetail(inspection: CachedRoleInspection): string {
  if (!inspection.reused) return inspection.report.detail;
  return (
    `${inspection.report.detail} Role and RLS state is reused from a check taken within the ` +
    `last ${ROLE_INSPECTION_TTL_MS / 1000} s.`
  );
}

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
    // The connection is unusable. What was known about the role came from a connection that no
    // longer exists — after a failover it could even be a different database — so the cached report
    // is dropped rather than reported as this deployment's own state; the next successful poll reads
    // the catalog again.
    roleInspections.delete(sql);
    return {
      status: 'unavailable',
      detail: `The metadata database could not be queried: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
  const roundTripMs = Date.now() - started;

  const inspection = await inspectRoleOnce(sql);
  const detail = `Queried in ${roundTripMs} ms. ${roleDetail(inspection)}`;
  if (inspection.report.status === 'ok') {
    return { status: 'ok', detail };
  }
  return { status: 'degraded', detail };
}

export function createDependencyProbes(
  config: ApiConfig,
  storage: StorageResolution,
  db?: DatabaseClient,
  redis?: Pick<RedisConnection, 'ping'> | null,
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
        if (redis === undefined || redis === null) {
          return {
            status: 'degraded',
            detail:
              'Redis credentials are present, but no Redis client is wired into this build: rate ' +
              'limiting runs in-process.',
          };
        }
        const started = Date.now();
        try {
          await redis.ping();
        } catch (error) {
          return {
            status: 'unavailable',
            detail: `Redis could not be reached: ${error instanceof Error ? error.message : 'unknown error'}.`,
          };
        }
        return {
          status: 'ok',
          detail: `PING answered in ${Date.now() - started} ms. Rate limits are shared across instances.`,
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
