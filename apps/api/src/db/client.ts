import { AppError } from '@opendrive/shared';
import postgres from 'postgres';
import type { ApiConfig } from '../config.js';

/**
 * The metadata database connection.
 *
 * The API talks to Postgres directly as a server-side component; it does not go through
 * PostgREST. Row Level Security is still enabled on every exposed table (see
 * docs/SECURITY.md) but it is a second line of defence here, not the first: the application
 * decides authorization explicitly, and the role-safety check in `role-safety.ts` reports
 * loudly when the connected role bypasses RLS by accident — as a superuser or as the table
 * owner — rather than as the provisioned backend role (D20).
 *
 * Absent `DATABASE_URL` is not a startup failure — the process must still be able to start and
 * report itself unready. It is `requireSql()` that converts "not configured" into a 503 at the
 * point where a route genuinely needs the database, so a missing dependency can never be
 * mistaken for an empty result set.
 */

export type Sql = postgres.Sql;

/**
 * Anything that can run a query: the pool, or a transaction started from it.
 *
 * Repositories accept this rather than `Sql` so the same function works inside `sql.begin(...)`. A
 * creation flow that also writes an audit row can then be one transaction, instead of relying on a
 * best-effort second write.
 */
export type SqlExecutor = postgres.ISql;

export interface DatabaseClient {
  /** Null when the deployment is not configured. Never use directly in a route; call requireSql(). */
  readonly sql: Sql | null;
  readonly configured: boolean;
  close: () => Promise<void>;
  /** The connection, or a 503 SERVICE_UNAVAILABLE problem when there is none. */
  requireSql: () => Sql;
}

export interface DatabaseClientOptions {
  /** Overrides `config.databaseUrl` (tests connect to a scratch database). */
  connectionString?: string;
  maxConnections?: number;
  /** Value reported in `pg_stat_activity.application_name`. */
  applicationName?: string;
  /** Receives PostgreSQL NOTICE/WARNING messages. Defaults to dropping them. */
  onNotice?: (notice: postgres.Notice) => void;
}

/** Connections per process. Sized for a small API; a pooler handles the rest. */
const DEFAULT_MAX_CONNECTIONS = 10;

function unavailable(cause?: unknown): AppError {
  return new AppError('SERVICE_UNAVAILABLE', {
    detail: 'The metadata database is not configured for this deployment.',
    expose: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

export function createDatabaseClient(
  config: Pick<ApiConfig, 'databaseUrl'>,
  options: DatabaseClientOptions = {},
): DatabaseClient {
  const connectionString = options.connectionString ?? config.databaseUrl;

  if (
    connectionString === null ||
    connectionString === undefined ||
    connectionString.trim() === ''
  ) {
    return {
      sql: null,
      configured: false,
      close: async () => {},
      requireSql: () => {
        throw unavailable();
      },
    };
  }

  const sql = postgres(connectionString, {
    max: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    // A connection that has been idle for a minute is closed, so a restart of the database does
    // not leave the pool full of dead sockets.
    idle_timeout: 60,
    connect_timeout: 10,
    // Recycle connections after half an hour: it bounds the impact of a leaked server-side
    // prepared statement or a long-lived snapshot.
    max_lifetime: 60 * 30,
    connection: { application_name: options.applicationName ?? 'opendrive-api' },
    onnotice: options.onNotice ?? (() => {}),
    // Postgres notices and errors are surfaced as Error objects the caller can inspect; the
    // default transformer would leave column names in snake_case, which is what the catalog
    // queries and the repositories expect since every SELECT aliases explicitly.
    transform: undefined,
  });

  return {
    sql,
    configured: true,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    requireSql: () => sql,
  };
}
