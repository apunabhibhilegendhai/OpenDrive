import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createDependencyProbes, evaluateReadiness } from './dependencies.js';
import type { DependencyProbe } from './dependencies.js';
import { resolveStorageProvider } from './storage/registry.js';

describe('readiness', () => {
  it('reports unconfigured dependencies as not_configured', async () => {
    const config = loadConfig({});
    const report = await evaluateReadiness(
      createDependencyProbes(config, resolveStorageProvider(config)),
    );
    expect(report.status).toBe('degraded');
    expect(report.dependencies.map((dependency) => dependency.name)).toEqual([
      'postgres',
      'auth',
      'redis',
      'storage',
    ]);

    const postgres = report.dependencies.find((dependency) => dependency.name === 'postgres');
    expect(postgres?.status).toBe('not_configured');
    expect(postgres?.detail).toContain('DATABASE_URL');
    expect(postgres?.required).toBe(true);

    const auth = report.dependencies.find((dependency) => dependency.name === 'auth');
    expect(auth?.status).toBe('not_configured');
    expect(auth?.detail).toContain('SUPABASE_JWKS_URL');
    expect(auth?.required).toBe(true);
  });

  it('never reports a configured dependency as ok without having checked it', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
      REDIS_URL: 'redis://localhost:6379/0',
    });
    // No database handle is passed: the probe cannot claim it verified anything.
    const report = await evaluateReadiness(
      createDependencyProbes(config, resolveStorageProvider(config)),
    );
    expect(report.status).toBe('degraded');

    const postgres = report.dependencies.find((dependency) => dependency.name === 'postgres');
    expect(postgres?.status).toBe('unavailable');
    expect(postgres?.detail).toContain('client');

    const redis = report.dependencies.find((dependency) => dependency.name === 'redis');
    expect(redis?.status).toBe('degraded');
    expect(redis?.detail).toMatch(/no Redis client/i);
    // Redis is not required in this build, so it does not by itself make readiness fail.
    expect(redis?.required).toBe(false);
  });

  it('verifies Redis with a PING once a client is wired', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
      REDIS_URL: 'redis://localhost:6379/0',
    });
    const report = await evaluateReadiness(
      createDependencyProbes(config, resolveStorageProvider(config), undefined, {
        ping: async () => 'PONG',
      }),
    );
    const redis = report.dependencies.find((dependency) => dependency.name === 'redis');
    expect(redis?.status).toBe('ok');
    expect(redis?.detail).toMatch(/PING answered/i);
  });

  it('reports an unreachable Redis as unavailable without failing readiness', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
      REDIS_URL: 'redis://localhost:6379/0',
    });
    const report = await evaluateReadiness(
      createDependencyProbes(config, resolveStorageProvider(config), undefined, {
        ping: async () => {
          throw new Error('connection refused');
        },
      }),
    );
    const redis = report.dependencies.find((dependency) => dependency.name === 'redis');
    expect(redis?.status).toBe('unavailable');
    expect(redis?.detail).toContain('connection refused');
    // Non-required: an unreachable cache degrades the report but does not refuse traffic.
    expect(redis?.required).toBe(false);
  });

  it('verifies HS256 token verification from the secret alone', async () => {
    const config = loadConfig({ SUPABASE_JWT_SECRET: 'a-complete-placeholder-secret' });
    const report = await evaluateReadiness(
      createDependencyProbes(config, resolveStorageProvider(config)),
    );
    const auth = report.dependencies.find((dependency) => dependency.name === 'auth');
    expect(auth?.status).toBe('ok');
    expect(auth?.detail).toContain('HS256');
  });

  it('actually fetches the JWKS endpoint instead of assuming it answers', async () => {
    const key = { kty: 'RSA', kid: 'test-key', n: 'abc', e: 'AQAB' };
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [key] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    try {
      const config = loadConfig({ SUPABASE_JWKS_URL: `http://127.0.0.1:${port}/jwks.json` });
      const report = await evaluateReadiness(
        createDependencyProbes(config, resolveStorageProvider(config)),
      );
      const auth = report.dependencies.find((dependency) => dependency.name === 'auth');
      expect(auth?.status).toBe('ok');
      expect(auth?.detail).toContain('1 key');
    } finally {
      server.close();
    }
  });

  it('reports a reachable-but-empty JWKS endpoint and an unreachable one as unavailable', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    try {
      const empty = await evaluateReadiness(
        createDependencyProbes(
          loadConfig({ SUPABASE_JWKS_URL: `http://127.0.0.1:${port}/jwks.json` }),
          resolveStorageProvider(loadConfig({})),
        ),
      );
      expect(empty.dependencies.find((item) => item.name === 'auth')?.status).toBe('unavailable');
    } finally {
      server.close();
    }

    // Port 1 on loopback refuses connections: the probe must say so rather than time out or guess.
    const refused = await evaluateReadiness(
      createDependencyProbes(
        loadConfig({ SUPABASE_JWKS_URL: 'http://127.0.0.1:1/jwks.json' }),
        resolveStorageProvider(loadConfig({})),
      ),
    );
    expect(refused.dependencies.find((item) => item.name === 'auth')?.status).toBe('unavailable');
  });

  it('is ready only when every required probe is genuinely ok', async () => {
    const probes: DependencyProbe[] = [
      {
        name: 'postgres',
        required: true,
        probe: async () => ({ status: 'ok', detail: 'verified' }),
      },
      { name: 'auth', required: true, probe: async () => ({ status: 'ok', detail: 'verified' }) },
      { name: 'redis', required: false, probe: async () => ({ status: 'ok', detail: 'verified' }) },
      {
        name: 'storage',
        required: false,
        probe: async () => ({ status: 'not_configured', detail: 'none' }),
      },
    ];
    const report = await evaluateReadiness(probes);
    expect(report.status).toBe('ready');
  });

  it('is degraded when a required dependency is degraded or unavailable', async () => {
    for (const status of ['degraded', 'unavailable'] as const) {
      const probes: DependencyProbe[] = [
        {
          name: 'postgres',
          required: true,
          probe: async () => ({ status, detail: 'not enforced' }),
        },
        { name: 'auth', required: true, probe: async () => ({ status: 'ok', detail: 'verified' }) },
      ];
      const report = await evaluateReadiness(probes);
      expect(report.status, status).toBe('degraded');
    }
  });

  it('treats a throwing probe as unavailable instead of crashing the endpoint', async () => {
    const probes: DependencyProbe[] = [
      {
        name: 'postgres',
        required: true,
        probe: async () => {
          throw new Error('connection refused');
        },
      },
    ];
    const report = await evaluateReadiness(probes);
    expect(report.status).toBe('degraded');
    expect(report.dependencies[0]?.status).toBe('unavailable');
    expect(report.dependencies[0]?.detail).toContain('connection refused');
  });
});
