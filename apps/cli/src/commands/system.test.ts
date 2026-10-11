import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_UNHEALTHY, DEFAULT_TIMEOUT_MS } from '../args.js';
import type { CliOptions } from '../args.js';
import { CliNetworkError } from '../http.js';
import { run } from '../index.js';
import type { Io } from './context.js';
import { runHealth, runLimits, runReadiness } from './system.js';

/**
 * These tests talk to a real HTTP server over a real socket: the CLI's job is network
 * I/O, so a mocked fetch would not exercise the part that can break.
 */

interface StubServer {
  url: string;
  close: () => Promise<void>;
}

const servers: StubServer[] = [];

async function startStubServer(
  handlers: Record<string, { status: number; body: string; contentType?: string }>,
): Promise<StubServer> {
  const server: Server = createServer((request, response) => {
    const handler = handlers[request.url ?? ''];
    if (handler === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'NOT_FOUND' }));
      return;
    }
    response.writeHead(handler.status, {
      'content-type': handler.contentType ?? 'application/json',
    });
    response.end(handler.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no port');
  const stub: StubServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
  servers.push(stub);
  return stub;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function collect(): { io: Io; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { out: (text) => stdout.push(text), err: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

function optionsFor(apiUrl: string, overrides: Partial<CliOptions> = {}): CliOptions {
  return { command: 'health', apiUrl, json: false, timeoutMs: DEFAULT_TIMEOUT_MS, ...overrides };
}

const HEALTH_BODY = JSON.stringify({
  status: 'ok',
  service: 'opendrive-api',
  version: '0.1.0',
  apiVersion: 'v1',
  uptimeSeconds: 12,
  timestamp: '2026-10-10T00:00:00.000Z',
});

const READINESS_BODY = JSON.stringify({
  status: 'degraded',
  checkedAt: '2026-10-10T00:00:00.000Z',
  dependencies: [
    {
      name: 'postgres',
      status: 'not_configured',
      required: true,
      detail: 'POSTGRES not configured',
    },
  ],
});

const LIMITS_BODY = JSON.stringify({
  maxFileSizeBytes: 2147483648,
  maxFileSizeVerified: false,
  chunkSizeBytes: 8388608,
  minChunkSizeBytes: 1048576,
  maxChunkSizeBytes: 67108864,
  maxPartsPerUpload: 10000,
  anonymousUploadsPerDay: 20,
  registeredUploadsPerDay: 500,
  malwareScanEnabled: false,
});

describe('runHealth', () => {
  it('reports a healthy API and exits 0', async () => {
    const stub = await startStubServer({ '/healthz': { status: 200, body: HEALTH_BODY } });
    const { io, stdout } = collect();
    const code = await runHealth({ options: optionsFor(stub.url), io });
    expect(code).toBe(EXIT_OK);
    expect(stdout.join('\n')).toContain('opendrive-api');
  });

  it('emits strict JSON when asked, without diagnostics on stdout', async () => {
    const stub = await startStubServer({ '/healthz': { status: 200, body: HEALTH_BODY } });
    const { io, stdout, stderr } = collect();
    const code = await runHealth({ options: optionsFor(stub.url, { json: true }), io });
    expect(code).toBe(EXIT_OK);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      service: 'opendrive-api',
      apiVersion: 'v1',
    });
  });

  it('fails when the API answers with an unexpected body', async () => {
    const stub = await startStubServer({
      '/healthz': { status: 200, body: JSON.stringify({ unexpected: true }) },
    });
    const { io, stderr } = collect();
    const code = await runHealth({ options: optionsFor(stub.url), io });
    expect(code).toBe(EXIT_UNHEALTHY);
    expect(stderr.join('\n')).toContain('unexpected body');
  });

  it('raises a network error when nothing is listening', async () => {
    const { io } = collect();
    // Port 1 is reserved and never served.
    await expect(
      runHealth({ options: optionsFor('http://127.0.0.1:1'), io }),
    ).rejects.toBeInstanceOf(CliNetworkError);
  });
});

describe('runReadiness', () => {
  it('reports dependencies and exits 2 while degraded', async () => {
    const stub = await startStubServer({ '/readyz': { status: 503, body: READINESS_BODY } });
    const { io, stdout, stderr } = collect();
    const code = await runReadiness({ options: optionsFor(stub.url), io });
    expect(code).toBe(EXIT_UNHEALTHY);
    expect(stdout.join('\n')).toContain('postgres');
    expect(stdout.join('\n')).toContain('not_configured');
    expect(stderr.join('\n')).toContain('not ready');
  });
});

describe('runLimits', () => {
  it('prints effective limits and warns that the target size is unverified', async () => {
    const stub = await startStubServer({ '/api/v1/limits': { status: 200, body: LIMITS_BODY } });
    const { io, stdout, stderr } = collect();
    const code = await runLimits({ options: optionsFor(stub.url), io });
    expect(code).toBe(EXIT_OK);
    expect(stdout.join('\n')).toContain('2.00 GiB');
    expect(stderr.join('\n')).toContain('NOT verified');
  });
});

describe('run (command dispatch)', () => {
  it('answers --version without touching the network', async () => {
    const { io, stdout } = collect();
    const code = await run(['--version'], io);
    expect(code).toBe(EXIT_OK);
    expect(stdout.join('\n')).toContain('0.1.0');
  });

  it('prints usage for --help', async () => {
    const { io, stdout } = collect();
    expect(await run(['--help'], io)).toBe(EXIT_OK);
    expect(stdout.join('\n')).toContain('Exit codes');
  });

  it('propagates a usage error to the caller', async () => {
    const { io } = collect();
    await expect(run(['not-a-command'], io)).rejects.toThrow(/unknown command/);
  });

  it('runs a real command against a real server', async () => {
    const stub = await startStubServer({ '/healthz': { status: 200, body: HEALTH_BODY } });
    const { io, stdout } = collect();
    expect(await run(['health', '--url', stub.url, '--json'], io)).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout.join('\n')) as { status: string };
    expect(parsed.status).toBe('ok');
  });
});
