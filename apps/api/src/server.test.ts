import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import {
  healthResponseSchema,
  limitsResponseSchema,
  problemDetailsSchema,
  readinessResponseSchema,
} from '@opendrive/shared';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const openServers: FastifyInstance[] = [];

async function startServer(env: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  const server = await buildServer({
    config: loadConfig({ NODE_ENV: 'test', ...env }),
    logger: false,
  });
  openServers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe('system endpoints', () => {
  it('answers liveness with a valid, versioned payload', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body.service).toBe('opendrive-api');
    expect(body.apiVersion).toBe('v1');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers readiness with 503 while required dependencies are unverified', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.status).toBe('degraded');
    expect(body.dependencies).toHaveLength(4);

    const postgres = body.dependencies.find((dependency) => dependency.name === 'postgres');
    expect(postgres?.status).toBe('not_configured');
    expect(postgres?.detail).toContain('DATABASE_URL');

    // Without a key source the API cannot establish identity at all, and says so.
    const auth = body.dependencies.find((dependency) => dependency.name === 'auth');
    expect(auth?.status).toBe('not_configured');
    expect(auth?.required).toBe(true);
  });

  it('publishes effective limits without claiming the target size is verified', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/v1/limits' });
    expect(response.statusCode).toBe(200);
    const body = limitsResponseSchema.parse(response.json());
    expect(body.maxFileSizeBytes).toBe(2 * 1024 ** 3);
    expect(body.maxFileSizeVerified).toBe(false);
    expect(body.chunkSizeBytes).toBe(8 * 1024 ** 2);
    expect(body.malwareScanEnabled).toBe(false);
  });
});

describe('unimplemented capabilities', () => {
  const stubs: InjectOptions[] = [
    {
      method: 'POST',
      url: '/api/v1/abuse-reports',
      payload: { fileId: 'file_0123456789012345678901234a', reason: 'malware' },
    },
  ];

  it.each(stubs)('$method $url fails loudly with 501 and a problem document', async (stub) => {
    const server = await startServer();
    const response = await server.inject(stub);
    expect(response.statusCode).toBe(501);
    expect(response.headers['content-type']).toContain('application/json');
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('NOT_IMPLEMENTED');
    expect(problem.status).toBe(501);
    expect(problem.detail).toMatch(/Phase \d/);
    expect(problem.detail).not.toMatch(/success/i);
  });

  it('never returns fabricated identifiers in a 501 body', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/abuse-reports',
      payload: { fileId: 'file_0123456789012345678901234a', reason: 'malware' },
    });
    const raw = response.body;
    // No report id or file id may appear: the endpoint created nothing.
    expect(raw).not.toMatch(/rpt_/);
    expect(raw).not.toContain('"reportId"');
  });
});

describe('authentication boundary', () => {
  it('refuses an identity-dependent route without a credential, and says which kind it wants', async () => {
    const server = await startServer();
    for (const url of ['/api/v1/me', '/api/v1/files', '/api/v1/api-keys', '/api/v1/folders']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      const problem = problemDetailsSchema.parse(response.json());
      expect(problem.code, url).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a credential it cannot classify instead of treating the caller as anonymous', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: { authorization: 'Bearer not-a-credential' },
    });
    expect(response.statusCode).toBe(401);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('UNAUTHENTICATED');
    expect(problem.detail).toContain('ods_');
  });

  it('refuses a non-Bearer authorization scheme', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Basic dXNlcjpwYXNzd29yZA==' },
    });
    expect(response.statusCode).toBe(401);
    expect(problemDetailsSchema.parse(response.json()).detail).toContain('Bearer');
  });

  it('treats two credentials as a conflict rather than choosing one', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/files',
      headers: {
        authorization: 'Bearer ods_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'x-api-key': 'odk_4zrp37hg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(response.statusCode).toBe(400);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('INVALID_REQUEST');
    expect(problem.detail).toContain('exactly one credential');
  });

  it('fails closed with 503 when the database is not configured, even for a well-formed credential', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: 'Bearer ods_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(response.statusCode).toBe(503);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('applies the credential policy to public API routes but not to system endpoints', async () => {
    const server = await startServer();
    // A bad credential on a public API route is an error, not something to ignore.
    const limits = await server.inject({
      method: 'GET',
      url: '/api/v1/limits',
      headers: { authorization: 'Bearer not-a-credential' },
    });
    expect(limits.statusCode).toBe(401);

    // Liveness must stay answerable even when authentication is misconfigured or a probe sends
    // junk: it is the endpoint an operator reaches for in exactly that situation.
    const health = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { authorization: 'Bearer not-a-credential' },
    });
    expect(health.statusCode).toBe(200);
  });
});

describe('request validation', () => {
  it('rejects an invalid upload declaration with a field-level 400', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      payload: { filename: 'a.bin', sizeBytes: 0, mimeType: 'application/octet-stream' },
    });
    expect(response.statusCode).toBe(400);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.length).toBeGreaterThan(0);
  });

  it('rejects a malformed identifier before the capability check', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/v1/files/not-a-file-id' });
    expect(response.statusCode).toBe(400);
    expect(problemDetailsSchema.parse(response.json()).code).toBe('VALIDATION_FAILED');
  });
});

describe('cross-cutting behaviour', () => {
  it('returns a problem document for unknown routes without leaking internals', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    const problem = problemDetailsSchema.parse(response.json());
    expect(problem.code).toBe('NOT_FOUND');
    expect(JSON.stringify(problem)).not.toContain('node_modules');
  });

  it('sets defensive headers and forbids caching of API responses', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/api/v1/limits' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('generates its own request id instead of trusting a client-supplied one', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'attacker-chosen-id' },
    });
    expect(response.headers['x-request-id']).not.toBe('attacker-chosen-id');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rate limits clients while keeping liveness answerable', async () => {
    const server = await startServer({ RATE_LIMIT_REQUESTS_PER_MINUTE: '3' });
    const results: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await server.inject({ method: 'GET', url: '/api/v1/limits' });
      results.push(response.statusCode);
    }
    expect(results).toEqual([200, 200, 200, 429]);

    const limited = await server.inject({ method: 'GET', url: '/api/v1/limits' });
    expect(limited.statusCode).toBe(429);
    expect(problemDetailsSchema.parse(limited.json()).code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();

    const liveness = await server.inject({ method: 'GET', url: '/healthz' });
    expect(liveness.statusCode).toBe(200);
  });

  it('allows only configured origins and never sends credentials', async () => {
    const server = await startServer({ CORS_ORIGINS: 'http://localhost:5173' });
    const allowed = await server.inject({
      method: 'GET',
      url: '/api/v1/limits',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const denied = await server.inject({
      method: 'GET',
      url: '/api/v1/limits',
      headers: { origin: 'http://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('omits CORS headers entirely when no origins are configured', async () => {
    const server = await startServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/limits',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
