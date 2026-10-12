import {
  API_PREFIX,
  API_VERSION,
  MAX_CHUNK_SIZE_BYTES,
  MAX_PARTS_PER_UPLOAD,
  MIN_CHUNK_SIZE_BYTES,
  healthResponseSchema,
  limitsResponseSchema,
  readinessResponseSchema,
} from '@opendrive/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { createDependencyProbes, evaluateReadiness } from '../dependencies.js';
import type { AppServices } from '../services.js';
import { SERVICE_VERSION } from '../version.js';

export const systemRoutes: FastifyPluginAsyncZod<AppServices> = async (app, options) => {
  const probes = createDependencyProbes(options.config, options.storage, options.db, options.redis);

  app.get(
    '/healthz',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        description:
          'Answers whether the process is up and serving. Deliberately does not touch ' +
          'Postgres, Redis or storage: it must stay fast and must never be rate limited.',
        response: { 200: healthResponseSchema },
      },
    },
    () => ({
      status: 'ok' as const,
      service: 'opendrive-api' as const,
      version: SERVICE_VERSION,
      apiVersion: API_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness probe',
        description:
          'Reports each dependency and answers 503 while a required one is not verified. A ' +
          'dependency is only `ok` once it has actually been checked: Postgres is queried (and its ' +
          'role inspected, since a superuser or table owner silently disables Row Level ' +
          'Security), and token verification is confirmed against the configured key source.',
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
    },
    async (_request, reply) => {
      const report = await evaluateReadiness(probes);
      reply.code(report.status === 'ready' ? 200 : 503);
      return report;
    },
  );

  app.get(
    `${API_PREFIX}/limits`,
    {
      schema: {
        tags: ['system'],
        summary: 'Effective upload limits',
        description:
          'The limits this deployment actually enforces. `maxFileSizeVerified` stays false until a ' +
          'storage provider has passed capability verification for that size (docs/STORAGE-PROVIDERS.md).',
        response: { 200: limitsResponseSchema },
      },
    },
    () => ({
      maxFileSizeBytes: options.config.limits.maxFileSizeBytes,
      maxFileSizeVerified: options.config.limits.maxFileSizeVerified,
      chunkSizeBytes: options.config.limits.chunkSizeBytes,
      minChunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
      maxChunkSizeBytes: MAX_CHUNK_SIZE_BYTES,
      maxPartsPerUpload: MAX_PARTS_PER_UPLOAD,
      anonymousUploadsPerDay: options.config.limits.anonymousUploadsPerDay,
      registeredUploadsPerDay: options.config.limits.registeredUploadsPerDay,
      malwareScanEnabled: options.config.limits.malwareScanEnabled,
    }),
  );
};
