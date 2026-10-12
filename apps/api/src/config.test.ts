import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('starts with documented defaults when nothing is configured', () => {
    const config = loadConfig({});
    expect(config.nodeEnv).toBe('development');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.storageProvider).toBe('none');
    expect(config.rateLimit).toEqual({
      enabled: true,
      requestsPerMinute: 120,
      uploadPartsPerMinute: 600,
    });
    expect(config.corsOrigins).toEqual([]);
    expect(config.trustProxy).toBe(false);
    expect(config.uploads).toEqual({ sessionTtlHours: 24, maxActiveSessionsPerPrincipal: 3 });
    expect(config.limits.maxFileSizeVerified).toBe(false);
  });

  it('does not require secrets to start, but reports which are missing', () => {
    const config = loadConfig({});
    // The metadata store is reached through DATABASE_URL. A PostgREST URL and a service-role key
    // are not enough to open a Postgres connection, so they do not make this dependency ready.
    expect(config.dependencies.postgres.configured).toBe(false);
    expect(config.dependencies.postgres.missingVariables).toEqual(['DATABASE_URL']);
    expect(config.dependencies.redis.missingVariables).toEqual(['REDIS_URL']);
    expect(config.dependencies.telegram.configured).toBe(false);
    // Token verification needs a key source, and either one counts.
    expect(config.dependencies.auth.configured).toBe(false);
    expect(config.dependencies.auth.missingVariables).toEqual([
      'SUPABASE_JWKS_URL',
      'SUPABASE_JWT_SECRET',
    ]);
    expect(config.auth.configured).toBe(false);
    expect(config.auth.audience).toBe('authenticated');
  });

  it('reports a dependency as configured once its variables are present', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
      REDIS_URL: 'redis://localhost:6379/0',
      SUPABASE_JWT_SECRET: 'placeholder-not-a-real-key',
      SUPABASE_URL: 'https://supabase.example.com',
    });
    expect(config.dependencies.postgres.configured).toBe(true);
    expect(config.dependencies.postgres.missingVariables).toEqual([]);
    expect(config.dependencies.redis.configured).toBe(true);
    expect(config.dependencies.auth.configured).toBe(true);
    expect(config.auth.configured).toBe(true);
  });

  it('accepts a JWKS URL as the alternative to a shared secret', () => {
    const config = loadConfig({
      SUPABASE_JWKS_URL: 'https://supabase.example.com/auth/v1/.well-known/jwks.json',
    });
    expect(config.auth.configured).toBe(true);
    expect(config.auth.jwtSecret).toBeNull();
    expect(config.auth.jwksUrl).toBe('https://supabase.example.com/auth/v1/.well-known/jwks.json');
    expect(config.dependencies.auth.missingVariables).toEqual([]);
  });

  it('treats empty values as unset rather than as invalid configuration', () => {
    const config = loadConfig({
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '   ',
      SUPABASE_JWT_SECRET: '',
      REDIS_URL: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_MAX_PART_SIZE_BYTES: '',
      CORS_ORIGINS: '',
      DOCS_ENABLED: '',
    });
    expect(config.dependencies.postgres.configured).toBe(false);
    expect(config.dependencies.postgres.missingVariables).toEqual(['DATABASE_URL']);
    expect(config.dependencies.auth.configured).toBe(false);
    expect(config.dependencies.redis.configured).toBe(false);
    expect(config.corsOrigins).toEqual([]);
    // Falls back to the environment default rather than becoming "false".
    expect(config.docsEnabled).toBe(true);
  });

  it('derives a share origin from the bind address unless one is configured', () => {
    // Never from the request: a Host header is attacker-controlled, and echoing it back would let
    // a caller mint share links that point somewhere else.
    expect(loadConfig({}).publicBaseUrl).toBe('http://127.0.0.1:3000');
    expect(
      loadConfig({
        API_HOST: '0.0.0.0',
        API_PORT: '8080',
        PUBLIC_BASE_URL: 'https://drive.example.com',
      }).publicBaseUrl,
    ).toBe('https://drive.example.com');
    expect(loadConfig({ API_HOST: '0.0.0.0' }).publicBaseUrl).toBe('http://127.0.0.1:3000');
  });

  it('rejects invalid configuration instead of falling back to a default', () => {
    expect(() => loadConfig({ API_PORT: 'not-a-port' })).toThrow(
      /Invalid OpenDrive API configuration/,
    );
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(
      /Invalid OpenDrive API configuration/,
    );
    expect(() => loadConfig({ STORAGE_PROVIDER: 's3' })).toThrow(
      /Invalid OpenDrive API configuration/,
    );
    expect(() => loadConfig({ SUPABASE_URL: 'not-a-url' })).toThrow(/SUPABASE_URL/);
    expect(() => loadConfig({ RATE_LIMIT_ENABLED: 'yes' })).toThrow(/true/);
    expect(() => loadConfig({ STORAGE_CHUNK_SIZE_BYTES: '-5' })).toThrow(/positive integer/);
  });

  it('parses the --local Bot API server file-serving settings', () => {
    const config = loadConfig({
      TELEGRAM_WORK_DIR: '/var/lib/telegram-bot-api',
      TELEGRAM_FILES_BASE_URL: 'https://files.example/telegram',
    });
    expect(config.telegram.workDir).toBe('/var/lib/telegram-bot-api');
    expect(config.telegram.filesBaseUrl).toBe('https://files.example/telegram');
    const unset = loadConfig({});
    expect(unset.telegram.workDir).toBeNull();
    expect(unset.telegram.filesBaseUrl).toBeNull();
    expect(() => loadConfig({ TELEGRAM_FILES_BASE_URL: 'not-a-url' })).toThrow(
      /TELEGRAM_FILES_BASE_URL/,
    );
  });

  it('enables API docs outside production and keeps them opt-in inside it', () => {
    expect(loadConfig({}).docsEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test' }).docsEnabled).toBe(true);
    expect(
      loadConfig({ NODE_ENV: 'production', SUPABASE_URL: 'https://x.example.com' }).docsEnabled,
    ).toBe(false);
    expect(
      loadConfig({
        NODE_ENV: 'production',
        DOCS_ENABLED: 'true',
        SUPABASE_URL: 'https://x.example.com',
      }).docsEnabled,
    ).toBe(true);
  });

  it('parses an explicit CORS allowlist and refuses the wildcard in production', () => {
    const config = loadConfig({
      CORS_ORIGINS: 'http://localhost:5173, https://opendrive.example ',
    });
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'https://opendrive.example']);
    expect(() => loadConfig({ NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /refused in production/,
    );
  });

  it('keeps third-party secrets out of the resolved configuration surface', () => {
    const config = loadConfig({
      SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value',
      TELEGRAM_BOT_TOKEN: 'bot-secret-value',
    });
    expect(JSON.stringify(config)).not.toContain('super-secret-value');
    expect(JSON.stringify(config)).not.toContain('bot-secret-value');

    // Two credentials ARE part of the surface, because the database client and the token verifier
    // read them from here: the connection string and the verification key. They are never rendered
    // into a response or a log — this assertion is the reminder that config is not a response body.
    const sensitive = loadConfig({
      DATABASE_URL: 'postgres://opendrive:db-password@localhost:5432/opendrive',
      SUPABASE_JWT_SECRET: 'jwt-secret-value',
    });
    expect(sensitive.databaseUrl).toContain('db-password');
    expect(sensitive.auth.jwtSecret).toBe('jwt-secret-value');
  });
});
