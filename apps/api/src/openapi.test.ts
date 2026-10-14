import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
}

describe('OpenAPI document', () => {
  it('is served and declares OpenAPI 3.1', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<OpenApiDocument>();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('OpenDrive API');
    expect(document.info.version).toBe('0.1.0');
  });

  it('documents every implemented and published endpoint', async () => {
    const server = await startServer();
    const document = (
      await server.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();
    const paths = Object.keys(document.paths);
    for (const expected of [
      '/healthz',
      '/readyz',
      '/api/v1/limits',
      '/api/v1/me',
      '/api/v1/anonymous-sessions',
      '/api/v1/api-keys',
      '/api/v1/api-keys/{keyId}',
      '/api/v1/files',
      '/api/v1/files/{fileId}',
      '/api/v1/files/{fileId}/content',
      '/api/v1/files/{fileId}/preview',
      '/api/v1/folders',
      '/api/v1/folders/{folderId}',
      '/api/v1/shares',
      '/api/v1/shares/resolve',
      '/api/v1/shares/{shareId}',
      '/api/v1/uploads',
      '/api/v1/uploads/{uploadId}',
      '/api/v1/uploads/{uploadId}/parts/{partNumber}',
      '/api/v1/uploads/{uploadId}/complete',
      '/api/v1/abuse-reports',
    ]) {
      expect(paths, `missing ${expected}`).toContain(expected);
    }
  });

  /**
   * The operations this build actually implements. Everything else under the API prefix is a
   * published contract that must still answer 501 — the OpenAPI document is what tells a client
   * which is which, so it has to stay accurate in both directions.
   */
  const IMPLEMENTED_OPERATIONS = new Set([
    'get /healthz',
    'get /readyz',
    'get /api/v1/limits',
    'get /api/v1/me',
    'post /api/v1/anonymous-sessions',
    'get /api/v1/api-keys',
    'post /api/v1/api-keys',
    'delete /api/v1/api-keys/{keyId}',
    'get /api/v1/files',
    'get /api/v1/files/{fileId}',
    'get /api/v1/files/{fileId}/content',
    'post /api/v1/files/{fileId}/preview',
    'delete /api/v1/files/{fileId}',
    'post /api/v1/uploads',
    'put /api/v1/uploads/{uploadId}/parts/{partNumber}',
    'get /api/v1/uploads/{uploadId}',
    'post /api/v1/uploads/{uploadId}/complete',
    'delete /api/v1/uploads/{uploadId}',
    'get /api/v1/folders',
    'post /api/v1/folders',
    'patch /api/v1/folders/{folderId}',
    'delete /api/v1/folders/{folderId}',
    'post /api/v1/shares',
    'post /api/v1/shares/resolve',
    'delete /api/v1/shares/{shareId}',
  ]);

  it('marks every published-but-unimplemented operation as answering 501', async () => {
    const server = await startServer();
    const document = (
      await server.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    let stubs = 0;
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (IMPLEMENTED_OPERATIONS.has(`${method} ${path}`)) {
          expect(
            Object.keys(operation.responses),
            `${method.toUpperCase()} ${path} is implemented and must not advertise 501`,
          ).not.toContain('501');
          continue;
        }
        stubs += 1;
        expect(
          Object.keys(operation.responses),
          `${method.toUpperCase()} ${path} must document a 501 response`,
        ).toContain('501');
      }
    }
    expect(stubs).toBeGreaterThan(0);
  });

  it('documents the security-relevant failure modes of implemented operations', async () => {
    const server = await startServer();
    const document = (
      await server.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    // Identity-dependent reads must publish 401 and 503: an unimplemented credential path must be
    // visible from the contract, not discovered in production.
    for (const path of ['/api/v1/me', '/api/v1/files', '/api/v1/files/{fileId}']) {
      const responses = Object.keys(document.paths[path]?.['get']?.responses ?? {});
      expect(responses, path).toContain('401');
      expect(responses, path).toContain('503');
    }
    // Cross-owner reads are reported as absent, so 404 is part of the contract.
    expect(
      Object.keys(document.paths['/api/v1/files/{fileId}']?.['get']?.responses ?? {}),
    ).toContain('404');
    expect(
      Object.keys(document.paths['/api/v1/shares/resolve']?.['post']?.responses ?? {}),
    ).toContain('404');
  });

  it('serves the interactive documentation UI when enabled', async () => {
    const server = await startServer();
    const response = await server.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('does not expose the documentation when disabled', async () => {
    const server = await startServer({ DOCS_ENABLED: 'false' });
    expect((await server.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
  });
});
