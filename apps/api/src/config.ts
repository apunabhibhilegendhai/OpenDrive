import { z } from 'zod';
import { resolveLimits } from '@opendrive/shared';
import type { LimitsConfig } from '@opendrive/shared';

/**
 * Configuration is read once at startup, validated, and then treated as immutable.
 *
 * Rules:
 * - Missing secrets are NOT startup failures: the process must be able to start and
 *   report which integrations are unconfigured (see GET /readyz).
 * - Invalid values ARE startup failures: a typo in a limit or a bad URL must never be
 *   silently replaced by a default.
 * - Nothing in this module may log or serialise secret values.
 */

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value.trim() === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`expected "true" or "false", received "${value}"`);
  });

/**
 * An empty value is treated as "not set".
 *
 * `.env` files copied from `.env.example` routinely contain `KEY=` placeholders, and a
 * deployment platform may inject an empty string for an unset secret. Neither is a
 * configuration error, and neither may stop the process from starting.
 */
function emptyAsUnset<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema,
  );
}

const optionalUrl = emptyAsUnset(z.string().url().optional());
const optionalString = emptyAsUnset(z.string().min(1).optional());
const optionalPositiveInt = emptyAsUnset(z.coerce.number().int().positive().optional());

export const STORAGE_PROVIDER_NAMES = ['none', 'memory-test', 'telegram-experimental'] as const;
export type StorageProviderName = (typeof STORAGE_PROVIDER_NAMES)[number];

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DOCS_ENABLED: booleanFromEnv,
  CORS_ORIGINS: optionalString,
  RATE_LIMIT_ENABLED: booleanFromEnv,
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().max(100_000).default(120),
  // Part traffic is a different shape from ordinary requests: one legitimate multipart upload
  // issues hundreds of `PUT .../parts` calls, so it gets its own, higher per-principal ceiling.
  RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE: z.coerce.number().int().positive().max(100_000).default(600),
  TRUST_PROXY: booleanFromEnv,

  // How long an incomplete upload may stay staged before it is garbage collected, and how many
  // concurrent sessions one principal may hold. Both bound a single caller's blast radius.
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(168).default(24),
  UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL: z.coerce.number().int().positive().max(100).default(3),

  STORAGE_PROVIDER: z.enum(STORAGE_PROVIDER_NAMES).default('none'),

  SUPABASE_URL: optionalUrl,
  SUPABASE_ANON_KEY: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  REDIS_URL: optionalString,

  //
  // Metadata database. The API connects directly (the service role's Postgres role or a
  // dedicated application role); PostgREST is not used for server-side work.
  //
  DATABASE_URL: optionalString,

  //
  // Access-token verification. One of the two key sources must be configured; a deployment
  // that has neither cannot establish identity and reports the `auth` dependency as
  // not_configured instead of guessing.
  //   SUPABASE_JWT_SECRET - the HS256 shared secret of a self-hosted instance.
  //   SUPABASE_JWKS_URL   - the JWKS endpoint of an instance using asymmetric keys.
  //
  SUPABASE_JWT_SECRET: optionalString,
  SUPABASE_JWKS_URL: optionalUrl,
  SUPABASE_JWT_ISSUER: optionalString,
  SUPABASE_JWT_AUDIENCE: optionalString,

  // Keyed hash of the client address recorded with an anonymous session. Absent means the
  // hash is simply not recorded: a raw address is never stored as a fallback.
  IP_HASH_SECRET: optionalString,
  //
  // Inline preview grants. A browser element cannot send an Authorization header, so a preview
  // URL carries a short-lived signed token; `PREVIEW_SIGNING_SECRET` is the HMAC key and falls
  // back to `IP_HASH_SECRET`. Absent means previews are disabled and the mint route answers 503.
  //
  PREVIEW_SIGNING_SECRET: optionalString,
  PREVIEW_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(3600),
  //
  // Edge cache. A local, non-authoritative copy of object bytes in front of the storage provider.
  // It is derived state on the API host's own disk — never Postgres, never Redis — so losing it
  // loses only speed. `EDGE_CACHE_MAX_BYTES` is an LRU budget, not a per-file gate: every size is
  // cacheable, the least-recently-used entries are simply evicted to stay within the budget.
  // See docs/EDGE-CACHE.md.
  //
  EDGE_CACHE_ENABLED: booleanFromEnv,
  EDGE_CACHE_DIR: optionalString,
  EDGE_CACHE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(5 * 1024 ** 3),
  EDGE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().max(31_536_000).default(604_800),
  //
  // Cacheable delivery URLs. Like previews, a browser element cannot send an Authorization header,
  // so a `/cdn` URL carries its own short-lived signed token; `EDGE_DELIVERY_SIGNING_SECRET` is the
  // HMAC key and falls back to `PREVIEW_SIGNING_SECRET`, then `IP_HASH_SECRET`. Absent means the
  // mint route answers `503` rather than signing under a default key.
  //
  EDGE_DELIVERY_SIGNING_SECRET: optionalString,
  EDGE_DELIVERY_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(3600),
  // `Cache-Control: max-age` advertised on `/cdn` responses. Safe to be long because the URL is
  // version-bound: new bytes are a new version and therefore a new URL.
  EDGE_PUBLIC_MAX_AGE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(31_536_000)
    .default(31_536_000),
  // Lifetime of a newly created anonymous session, in hours.
  ANONYMOUS_SESSION_TTL_HOURS: z.coerce.number().int().positive().max(8760).default(168),
  //
  // Origin that share links are built from. Not derived from the request: a Host header is
  // attacker-controlled, and echoing it back would let a caller mint links that point elsewhere.
  //
  PUBLIC_BASE_URL: optionalUrl,

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_STORAGE_CHAT_ID: optionalString,
  TELEGRAM_API_BASE_URL: optionalUrl,
  TELEGRAM_MAX_PART_SIZE_BYTES: optionalPositiveInt,
  // `--local` mode of a self-hosted Bot API server. getFile then returns absolute on-disk
  // paths; the API reads them from disk (same host) or serves them through FILES_BASE_URL.
  TELEGRAM_WORK_DIR: optionalString,
  TELEGRAM_FILES_BASE_URL: optionalUrl,

  MALWARE_SCAN_ENABLED: booleanFromEnv,
});

export interface DependencyConfiguration {
  /** Every environment variable this dependency needs is present. */
  readonly configured: boolean;
  /** Names of the variables that are missing. Never their values. */
  readonly missingVariables: readonly string[];
}

export interface ApiConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly docsEnabled: boolean;
  readonly corsOrigins: readonly string[];
  readonly rateLimit: {
    readonly enabled: boolean;
    readonly requestsPerMinute: number;
    /** Per-principal ceiling for upload-part requests, which are far more numerous. */
    readonly uploadPartsPerMinute: number;
  };
  readonly trustProxy: boolean;
  readonly storageProvider: StorageProviderName;
  readonly limits: LimitsConfig;
  readonly dependencies: {
    readonly postgres: DependencyConfiguration;
    readonly redis: DependencyConfiguration;
    readonly auth: DependencyConfiguration;
    readonly telegram: DependencyConfiguration;
  };
  /** Telegram storage settings. The bot token itself is NOT part of this surface
   *  (third-party secrets stay out of the resolved configuration — see config.test.ts);
   *  the registry reads the token from the runtime environment when attaching the provider. */
  readonly telegram: {
    readonly configured: boolean;
    readonly apiBaseUrl: string | null;
    readonly maxPartSizeBytes: number | null;
    /** `--dir` of a `--local` Bot API server; used to relativise its absolute file paths. */
    readonly workDir: string | null;
    /** Base URL of a file server serving that `--dir`, for when the API cannot read its disk. */
    readonly filesBaseUrl: string | null;
  };
  /** Metadata-database connection string, or null when the deployment is not configured. */
  readonly databaseUrl: string | null;
  /** Redis connection string, or null when rate-limit counters stay in-process. */
  readonly redisUrl: string | null;
  /**
   * How the API verifies Supabase access tokens. `configured` is false when neither key source
   * is present; protected routes then fail closed with 503 rather than trusting anything.
   */
  readonly auth: {
    readonly configured: boolean;
    readonly jwtSecret: string | null;
    readonly jwksUrl: string | null;
    readonly issuer: string | null;
    readonly audience: string;
  };
  readonly anonymousSessions: { readonly ttlHours: number };
  /** Upload-session limits. Sessions are process-local; these bound one principal's footprint. */
  readonly uploads: {
    readonly sessionTtlHours: number;
    readonly maxActiveSessionsPerPrincipal: number;
  };
  /** Secret for hashing client addresses; null means addresses are not recorded at all. */
  readonly ipHashSecret: string | null;
  /**
   * Inline preview grants. `signingSecret` is the effective HMAC key — the dedicated
   * `PREVIEW_SIGNING_SECRET`, or `IP_HASH_SECRET` as its fallback; null disables previews, and the
   * mint route then answers `503` rather than signing under a default key.
   */
  readonly preview: {
    readonly signingSecret: string | null;
    readonly tokenTtlSeconds: number;
  };
  /**
   * The local edge cache that fronts the storage provider. `enabled` false (or no provider) means
   * reads go straight to the provider. `dir` is a filesystem path; `maxBytes` is an LRU budget, not
   * a per-file limit — every object size is cacheable.
   */
  readonly edgeCache: {
    readonly enabled: boolean;
    readonly dir: string;
    readonly maxBytes: number;
    readonly ttlSeconds: number;
  };
  /**
   * Cacheable delivery URLs. `signingSecret` is the effective HMAC key — the dedicated
   * `EDGE_DELIVERY_SIGNING_SECRET`, or `PREVIEW_SIGNING_SECRET`, or `IP_HASH_SECRET`; null disables
   * delivery URLs. `publicMaxAgeSeconds` is the `Cache-Control: max-age` advertised on `/cdn`.
   */
  readonly delivery: {
    readonly signingSecret: string | null;
    readonly tokenTtlSeconds: number;
    readonly publicMaxAgeSeconds: number;
  };
  /** Origin used to build share URLs. Falls back to the configured bind address in development. */
  readonly publicBaseUrl: string;
}

function dependency(
  env: Record<string, string | undefined>,
  variables: readonly string[],
): DependencyConfiguration {
  const missingVariables = variables.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
  return { configured: missingVariables.length === 0, missingVariables };
}

/**
 * A dependency satisfied by ANY one of several alternatives (for example a JWKS URL *or* a shared
 * secret). When none is present, every alternative is reported as missing, so an operator sees the
 * whole choice rather than one arbitrary half of it.
 */
function dependencyAnyOf(
  env: Record<string, string | undefined>,
  alternatives: readonly (readonly string[])[],
): DependencyConfiguration {
  const present = alternatives.some((variables) =>
    variables.every((name) => {
      const value = env[name];
      return value !== undefined && value.trim() !== '';
    }),
  );
  if (present) return { configured: true, missingVariables: [] };
  return { configured: false, missingVariables: alternatives.flat() };
}

function readValue(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid OpenDrive API configuration — ${firstIssueMessage(parsed.error)}`);
  }
  const values = parsed.data;

  const nodeEnv = values.NODE_ENV;
  // Docs are developer tooling: on by default outside production, opt-in inside it.
  const docsEnabled = values.DOCS_ENABLED ?? nodeEnv !== 'production';
  // Rate limiting protects the API from abuse in every environment; tests disable it explicitly.
  const rateLimitEnabled = values.RATE_LIMIT_ENABLED ?? true;
  // Only trust X-Forwarded-* when a reverse proxy is actually in front of the process.
  const trustProxy = values.TRUST_PROXY ?? false;

  const corsOrigins = (values.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  for (const origin of corsOrigins) {
    if (nodeEnv === 'production' && origin === '*') {
      throw new Error(
        'Invalid OpenDrive API configuration — CORS_ORIGINS="*" is refused in production; list explicit origins.',
      );
    }
  }

  return {
    nodeEnv,
    host: values.API_HOST,
    port: values.API_PORT,
    logLevel: values.LOG_LEVEL,
    docsEnabled,
    corsOrigins,
    rateLimit: {
      enabled: rateLimitEnabled,
      requestsPerMinute: values.RATE_LIMIT_REQUESTS_PER_MINUTE,
      uploadPartsPerMinute: values.RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE,
    },
    trustProxy,
    storageProvider: values.STORAGE_PROVIDER,
    limits: resolveLimits(env),
    dependencies: {
      // The metadata store is reached directly, so DATABASE_URL — not the PostgREST URL — is
      // what makes it configured. SUPABASE_URL alone is not enough to talk to Postgres.
      postgres: dependency(env, ['DATABASE_URL']),
      redis: dependency(env, ['REDIS_URL']),
      auth: dependencyAnyOf(env, [['SUPABASE_JWKS_URL'], ['SUPABASE_JWT_SECRET']]),
      telegram: dependency(env, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_STORAGE_CHAT_ID']),
    },
    telegram: {
      configured: dependency(env, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_STORAGE_CHAT_ID']).configured,
      apiBaseUrl: values.TELEGRAM_API_BASE_URL ?? null,
      maxPartSizeBytes: values.TELEGRAM_MAX_PART_SIZE_BYTES ?? null,
      workDir: values.TELEGRAM_WORK_DIR ?? null,
      filesBaseUrl: values.TELEGRAM_FILES_BASE_URL ?? null,
    },
    databaseUrl: readValue(env, 'DATABASE_URL'),
    redisUrl: readValue(env, 'REDIS_URL'),
    auth: {
      configured:
        values.SUPABASE_JWKS_URL !== undefined || values.SUPABASE_JWT_SECRET !== undefined,
      jwtSecret: values.SUPABASE_JWT_SECRET ?? null,
      jwksUrl: values.SUPABASE_JWKS_URL ?? null,
      issuer: values.SUPABASE_JWT_ISSUER ?? null,
      audience: values.SUPABASE_JWT_AUDIENCE ?? 'authenticated',
    },
    anonymousSessions: { ttlHours: values.ANONYMOUS_SESSION_TTL_HOURS },
    uploads: {
      sessionTtlHours: values.UPLOAD_SESSION_TTL_HOURS,
      maxActiveSessionsPerPrincipal: values.UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL,
    },
    ipHashSecret: readValue(env, 'IP_HASH_SECRET'),
    preview: {
      signingSecret: readValue(env, 'PREVIEW_SIGNING_SECRET') ?? readValue(env, 'IP_HASH_SECRET'),
      tokenTtlSeconds: values.PREVIEW_TOKEN_TTL_SECONDS,
    },
    edgeCache: {
      enabled: values.EDGE_CACHE_ENABLED ?? true,
      dir: values.EDGE_CACHE_DIR ?? '.edge-cache',
      maxBytes: values.EDGE_CACHE_MAX_BYTES,
      ttlSeconds: values.EDGE_CACHE_TTL_SECONDS,
    },
    delivery: {
      signingSecret:
        readValue(env, 'EDGE_DELIVERY_SIGNING_SECRET') ??
        readValue(env, 'PREVIEW_SIGNING_SECRET') ??
        readValue(env, 'IP_HASH_SECRET'),
      tokenTtlSeconds: values.EDGE_DELIVERY_TTL_SECONDS,
      publicMaxAgeSeconds: values.EDGE_PUBLIC_MAX_AGE_SECONDS,
    },
    publicBaseUrl:
      values.PUBLIC_BASE_URL ??
      `http://${values.API_HOST === '0.0.0.0' ? '127.0.0.1' : values.API_HOST}:${values.API_PORT}`,
  };
}
