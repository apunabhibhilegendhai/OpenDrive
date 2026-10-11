import {
  API_PREFIX,
  initiateUploadRequestSchema,
  initiateUploadResponseSchema,
  problemDetailsResponseSchema,
  uploadPartResponseSchema,
  completeUploadResponseSchema,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notImplementedHandler, stubResponses } from './stubs.js';

/**
 * Upload workflow — CONTRACT ONLY (not implemented).
 *
 * These routes describe the resumable, chunked upload protocol the platform will
 * implement in Phase 1 and always answer 501 in this build. They exist so the client,
 * CLI and OpenAPI consumers can be written against the real shape, and so nobody
 * mistakes a missing feature for a working one.
 *
 * Intended protocol (Phase 1):
 * 1. POST   /uploads                     – declare size/mime/visibility, receive an upload id,
 *                                          the effective chunk size and, for anonymous uploads,
 *                                          a one-time deletion token.
 * 2. PUT    /uploads/:id/parts/:number   – send one bounded part as a raw byte stream.
 * 3. GET    /uploads/:id                 – inspect session state to resume after a failure.
 * 4. POST   /uploads/:id/complete        – finalize; the file becomes readable when available.
 * 5. DELETE /uploads/:id                 – abort and release staged bytes.
 */

const uploadParamsSchema = z.object({
  uploadId: z.string().regex(/^upl_/, 'Expected an upload id with the "upl_" prefix'),
});

const partParamsSchema = uploadParamsSchema.extend({
  partNumber: z.coerce.number().int().positive().max(10_000),
});

export const uploadRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    `${API_PREFIX}/uploads`,
    {
      schema: {
        tags: ['uploads'],
        summary: '[Phase 2] Initiate an upload session',
        description:
          'Publishes the Phase 2 contract. NOT IMPLEMENTED in this build: always answers ' +
          '501 NOT_IMPLEMENTED and stores nothing.',
        body: initiateUploadRequestSchema,
        response: { ...stubResponses, 201: initiateUploadResponseSchema },
      },
    },
    notImplementedHandler('uploads.initiate'),
  );

  app.put(
    `${API_PREFIX}/uploads/:uploadId/parts/:partNumber`,
    {
      schema: {
        tags: ['uploads'],
        summary: '[Phase 2] Upload one part',
        description:
          'Publishes the Phase 2 contract: the request body is the raw part bytes ' +
          '(application/octet-stream), and the part checksum is supplied via a header. ' +
          'NOT IMPLEMENTED in this build: always answers 501 and consumes no body.',
        params: partParamsSchema,
        response: { ...stubResponses, 200: uploadPartResponseSchema },
      },
    },
    notImplementedHandler('uploads.part'),
  );

  app.get(
    `${API_PREFIX}/uploads/:uploadId`,
    {
      schema: {
        tags: ['uploads'],
        summary: '[Phase 2] Inspect an upload session',
        description:
          'Publishes the Phase 2 contract for resuming an interrupted upload. ' +
          'NOT IMPLEMENTED in this build: always answers 501.',
        params: uploadParamsSchema,
        response: { 501: problemDetailsResponseSchema },
      },
    },
    notImplementedHandler('uploads.status'),
  );

  app.post(
    `${API_PREFIX}/uploads/:uploadId/complete`,
    {
      schema: {
        tags: ['uploads'],
        summary: '[Phase 2] Finalize an upload',
        description:
          'Publishes the Phase 2 contract. NOT IMPLEMENTED in this build: always answers 501.',
        params: uploadParamsSchema,
        response: { ...stubResponses, 200: completeUploadResponseSchema },
      },
    },
    notImplementedHandler('uploads.complete'),
  );

  app.delete(
    `${API_PREFIX}/uploads/:uploadId`,
    {
      schema: {
        tags: ['uploads'],
        summary: '[Phase 2] Abort an upload session',
        description:
          'Publishes the Phase 2 contract for releasing staged bytes. ' +
          'NOT IMPLEMENTED in this build: always answers 501.',
        params: uploadParamsSchema,
        response: { 501: problemDetailsResponseSchema },
      },
    },
    notImplementedHandler('uploads.abort'),
  );
};
