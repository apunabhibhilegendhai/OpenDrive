import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { createDependencyProbes, evaluateReadiness } from './dependencies.js';
import type { DependencyProbe } from './dependencies.js';
import type { DatabaseClient, Sql } from './db/client.js';
import { resolveStorageProvider } from './storage/registry.js';

/**
 * A database handle that answers the probe's queries from memory and counts how often the role
 * inspection ran. The inspection is the expensive half through a tunnel (two extra catalog queries),
 * so the tests below pin down how often it is allowed to run.
 */
function stubDatabase(options: { failInspection?: boolean } = {}): {
  db: DatabaseClient;
  inspectionQueries: () => number;
  setFailLiveness: (fail: boolean) => void;
} {
  let inspectionQueries = 0;
  let failLiveness = false;
  const query = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const text = strings.join(' ');
    if (!text.includes('current_user') && !text.includes('relrowsecurity')) {
      return failLiveness
        ? Promise.reject(new Error('connection terminated'))
        : Promise.resolve([]);
    }
    inspectionQueries += 1;
    if (options.failInspection === true) return Promise.reject(new Error('connection reset'));
    if (text.includes('current_user')) {
      return Promise.resolve([
        { currentUser: 'opendrive_app', isSuperuser: false, bypassesRls: true, ownsFiles: false },
      ]);
    }
    return Promise.resolve([]);
  };
  const sql = query as unknown as Sql;
  return {
    db: { sql, configured: true, close: async () => {}, requireSql: () => sql },
    inspectionQueries: () => inspectionQueries,
    setFailLiveness: (fail: boolean) => {
      failLiveness = fail;
    },
  };
}

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

  it('reuses one role inspection across polls while still querying liveness each time', async () => {
    const stub = stubDatabase();
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
    });
    const probes = createDependencyProbes(config, resolveStorageProvider(config), stub.db);

    const first = await evaluateReadiness(probes);
    const firstPostgres = first.dependencies.find((dependency) => dependency.name === 'postgres');
    expect(firstPostgres?.status).toBe('ok');
    expect(stub.inspectionQueries()).toBe(2);
    expect(firstPostgres?.detail).toContain('Queried in');
    expect(firstPostgres?.detail).not.toContain('reused from a check');

    const second = await evaluateReadiness(probes);
    const secondPostgres = second.dependencies.find((dependency) => dependency.name === 'postgres');
    expect(secondPostgres?.status).toBe('ok');
    // Still two, not four: the catalog was read once and the liveness query ran twice.
    expect(stub.inspectionQueries()).toBe(2);
    expect(secondPostgres?.detail).toContain('reused from a check taken within the last 300 s');
  });

  it('re-inspects once the reuse window has passed', async () => {
    vi.useFakeTimers();
    try {
      const stub = stubDatabase();
      const config = loadConfig({
        DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
      });
      const probes = createDependencyProbes(config, resolveStorageProvider(config), stub.db);

      await evaluateReadiness(probes);
      expect(stub.inspectionQueries()).toBe(2);

      vi.advanceTimersByTime(5 * 60_000 + 1000);
      const later = await evaluateReadiness(probes);
      expect(stub.inspectionQueries()).toBe(4);
      expect(
        later.dependencies.find((dependency) => dependency.name === 'postgres')?.detail,
      ).not.toContain('reused from a check');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reuses an inspection that could not read the catalog', async () => {
    const stub = stubDatabase({ failInspection: true });
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
    });
    const probes = createDependencyProbes(config, resolveStorageProvider(config), stub.db);

    const first = await evaluateReadiness(probes);
    expect(first.dependencies.find((dependency) => dependency.name === 'postgres')?.status).toBe(
      'degraded',
    );
    expect(first.dependencies[0]?.detail).toContain('connection reset');

    // A transient failure is retried on the very next poll instead of being cached for the TTL.
    await evaluateReadiness(probes);
    expect(stub.inspectionQueries()).toBe(2);
  });

  it('re-inspects after the connection itself fails, instead of keeping a borrowed role', async () => {
    const stub = stubDatabase();
    const config = loadConfig({
      DATABASE_URL: 'postgres://opendrive:placeholder@localhost:5432/opendrive',
    });
    const probes = createDependencyProbes(config, resolveStorageProvider(config), stub.db);

    await evaluateReadiness(probes);
    expect(stub.inspectionQueries()).toBe(2);

    stub.setFailLiveness(true);
    const broken = await evaluateReadiness(probes);
    expect(broken.dependencies.find((dependency) => dependency.name === 'postgres')?.status).toBe(
      'unavailable',
    );

    // Once the connection is back, the role must be read again rather than reused from a
    // connection that no longer exists.
    stub.setFailLiveness(false);
    const recovered = await evaluateReadiness(probes);
    expect(
      recovered.dependencies.find((dependency) => dependency.name === 'postgres')?.status,
    ).toBe('ok');
    expect(recovered.dependencies[0]?.detail).not.toContain('reused from a check');
    expect(stub.inspectionQueries()).toBe(4);
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
