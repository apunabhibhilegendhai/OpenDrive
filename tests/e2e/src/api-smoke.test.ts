import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  healthResponseSchema,
  limitsResponseSchema,
  problemDetailsSchema,
  readinessResponseSchema,
} from '@opendrive/shared';

/**
 * End-to-end tests.
 *
 * Unlike the API's own tests (which use in-process `inject`), these run the COMPILED
 * server as a separate process over a real socket. That is the artefact a deployment
 * will run, and it is the only way to catch problems that in-process tests cannot see:
 * a bad build output, a missing runtime dependency, module-resolution mistakes under
 * Node's ESM resolver, startup ordering, and shutdown behaviour.
 *
 * Requires `pnpm build` first — the root `test:e2e` script does that.
 */

const serverEntry = fileURLToPath(new URL('../../../apps/api/dist/index.js', import.meta.url));

let child: ChildProcess | undefined;
let baseUrl = '';
let serverLog = '';

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a port');
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastError = `healthz answered ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API did not become healthy within ${timeoutMs} ms (${lastError})\n${serverLog}`);
}

beforeAll(async () => {
  if (!existsSync(serverEntry)) {
    throw new Error(
      `The compiled API was not found at ${serverEntry}.\n` +
        'These tests exercise the built artefact, so run "pnpm build" first ' +
        '(the root script "pnpm test:e2e" does that for you).',
    );
  }

  const port = await findFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      DOCS_ENABLED: 'true',
      // Rate limiting off: this suite asserts contract behaviour, not limits.
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'warn',
      // Force the unconfigured state so readiness is deterministic regardless of the
      // developer's shell environment. DATABASE_URL is cleared explicitly: a developer or CI
      // runner with a scratch database exported must not silently change what this asserts.
      DATABASE_URL: '',
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      REDIS_URL: '',
      STORAGE_PROVIDER: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    serverLog += chunk.toString();
  });

  await waitForHealth(baseUrl);
});

afterAll(async () => {
  if (child === undefined || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000)).then(() => {
      child?.kill('SIGKILL');
    }),
  ]);
});

describe('compiled API process', () => {
  it('answers liveness on a real socket', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const body = healthResponseSchema.parse(await response.json());
    expect(body.service).toBe('opendrive-api');
    expect(body.apiVersion).toBe('v1');
  });

  it('reports readiness honestly with 503 while dependencies are unverified', async () => {
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    const body = readinessResponseSchema.parse(await response.json());
    expect(body.status).toBe('degraded');
    const postgres = body.dependencies.find((dependency) => dependency.name === 'postgres');
    expect(postgres?.status).toBe('not_configured');
    // The metadata store is reached directly, so DATABASE_URL is what it must name as missing.
    expect(postgres?.detail).toContain('DATABASE_URL');
    const storage = body.dependencies.find((dependency) => dependency.name === 'storage');
    expect(storage?.status).toBe('not_configured');
  });

  it('publishes limits that match the documented defaults', async () => {
    const response = await fetch(`${baseUrl}/api/v1/limits`);
    expect(response.status).toBe(200);
    const body = limitsResponseSchema.parse(await response.json());
    expect(body.maxFileSizeBytes).toBe(2147483648);
    expect(body.maxFileSizeVerified).toBe(false);
    expect(body.chunkSizeBytes).toBe(8388608);
  });

  it('refuses an upload with 501 and a problem document, over the wire', async () => {
    const response = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'report.pdf',
        sizeBytes: 1024,
        mimeType: 'application/pdf',
      }),
    });
    expect(response.status).toBe(501);
    expect(response.headers.get('content-type')).toContain('application/json');
    const problem = problemDetailsSchema.parse(await response.json());
    expect(problem.code).toBe('NOT_IMPLEMENTED');
    // Phase 1 implemented identity and metadata; the upload engine is Phase 2. The detail has to
    // name the phase that actually owns it, or a client cannot tell delay from breakage.
    expect(problem.detail).toContain('Phase 2');
  });

  it('reports validation failures for a malformed request body', async () => {
    const response = await fetch(`${baseUrl}/api/v1/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: '', sizeBytes: -1 }),
    });
    expect(response.status).toBe(400);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe('VALIDATION_FAILED');
  });

  it('serves an OpenAPI 3.1 document describing every published route', async () => {
    const response = await fetch(`${baseUrl}/openapi.json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/api/v1/uploads');
    expect(Object.keys(document.paths)).toContain('/api/v1/files/{fileId}');
    expect(Object.keys(document.paths)).toContain('/api/v1/shares');
  });

  it('sends defensive headers and never caches API responses', async () => {
    const response = await fetch(`${baseUrl}/api/v1/limits`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers unknown routes with a 404 problem document', async () => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(response.status).toBe(404);
    expect(problemDetailsSchema.parse(await response.json()).code).toBe('NOT_FOUND');
  });

  it('shuts down gracefully on SIGTERM', async () => {
    const target = child;
    expect(target).toBeDefined();
    if (target === undefined) return;

    type ExitResult = { exited: true; code: number | null; signal: NodeJS.Signals | null };
    // `child_process` types the exit event's arguments loosely, so narrow them explicitly.
    const exited = once(target, 'exit').then((args): ExitResult => {
      const code = args[0] as number | null;
      const signal = args[1] as NodeJS.Signals | null;
      return { exited: true, code, signal };
    });
    const timedOut = new Promise<{ exited: false }>((resolve) =>
      setTimeout(() => resolve({ exited: false }), 8000),
    );

    target.kill('SIGTERM');
    const result = await Promise.race([exited, timedOut]);
    expect(result.exited, 'the process should exit within 8 seconds of SIGTERM').toBe(true);
    if (!result.exited) return;

    if (process.platform === 'win32') {
      // Windows has no catchable SIGTERM: Node emulates it by terminating the process, so
      // the exit code carries no information about graceful shutdown here. The behaviour
      // is asserted on POSIX platforms (and in CI, which runs Linux).
      expect(result.code).not.toBeUndefined();
      return;
    }
    expect(result.code).toBe(0);
  });
});
