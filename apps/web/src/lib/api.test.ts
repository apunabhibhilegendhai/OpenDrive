import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBuildStatus } from './api.js';

/**
 * The client's contract with the API is "parse before you render". These tests drive the
 * three failure modes that matter: a healthy server, a server that answers off-contract,
 * and a server that is not there at all.
 */

const HEALTH = {
  status: 'ok',
  service: 'opendrive-api',
  version: '0.1.0',
  apiVersion: 'v1',
  uptimeSeconds: 42,
  timestamp: '2026-10-10T00:00:00.000Z',
};

const READINESS = {
  status: 'degraded',
  checkedAt: '2026-10-10T00:00:00.000Z',
  dependencies: [
    { name: 'postgres', status: 'not_configured', required: true, detail: 'not configured' },
  ],
};

const LIMITS = {
  maxFileSizeBytes: 2147483648,
  maxFileSizeVerified: false,
  chunkSizeBytes: 8388608,
  minChunkSizeBytes: 1048576,
  maxChunkSizeBytes: 67108864,
  maxPartsPerUpload: 10000,
  anonymousUploadsPerDay: 20,
  registeredUploadsPerDay: 500,
  malwareScanEnabled: false,
};

function stubFetch(map: Record<string, { status: number; body: unknown } | 'network-error'>): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const entry = map[path];
    if (entry === undefined || entry === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchBuildStatus', () => {
  it('returns validated data for every endpoint', async () => {
    stubFetch({
      '/healthz': { status: 200, body: HEALTH },
      '/readyz': { status: 503, body: READINESS },
      '/api/v1/limits': { status: 200, body: LIMITS },
    });

    const status = await fetchBuildStatus();
    expect(status.health.state).toBe('ok');
    expect(status.readiness.state).toBe('ok');
    expect(status.limits.state).toBe('ok');
    if (status.readiness.state === 'ok') {
      // A 503 with a valid body is data, not an error: readiness is expected to be degraded.
      expect(status.readiness.data.status).toBe('degraded');
      expect(status.readiness.data.dependencies[0]?.name).toBe('postgres');
    }
    if (status.limits.state === 'ok') {
      expect(status.limits.data.maxFileSizeVerified).toBe(false);
    }
  });

  it('flags an off-contract response instead of rendering it', async () => {
    stubFetch({
      '/healthz': { status: 200, body: { status: 'fine', uptime: 'hours' } },
      '/readyz': { status: 200, body: READINESS },
      '/api/v1/limits': { status: 200, body: LIMITS },
    });

    const status = await fetchBuildStatus();
    expect(status.health.state).toBe('unexpected');
    if (status.health.state === 'unexpected') {
      expect(status.health.status).toBe(200);
      expect(status.health.detail.length).toBeGreaterThan(0);
    }
    expect(status.readiness.state).toBe('ok');
  });

  it('reports an unreachable API per endpoint without throwing', async () => {
    stubFetch({
      '/healthz': 'network-error',
      '/readyz': { status: 200, body: READINESS },
      '/api/v1/limits': 'network-error',
    });

    const status = await fetchBuildStatus();
    expect(status.health.state).toBe('unreachable');
    expect(status.limits.state).toBe('unreachable');
    expect(status.readiness.state).toBe('ok');
  });

  it('treats a non-JSON body as off-contract', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>gateway</html>', { status: 502 }));
    const status = await fetchBuildStatus();
    expect(status.health.state).toBe('unexpected');
    if (status.health.state === 'unexpected') {
      expect(status.health.detail).toContain('not JSON');
    }
  });
});
