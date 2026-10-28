import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, ownerKeyOf, principalOf, requireScope } from '../authz.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';
import { requireStorageProvider } from '../storage/registry.js';
import { createFile, applyFileTransition } from '../db/repositories/files.js';
import { insertActiveStorageObject } from '../db/repositories/storage-objects.js';
import {
  reserveStorage,
  commitReservation,
  releaseReservation,
  quotaArgsFor,
} from '../db/repositories/quota.js';
import { newId, assertTransition } from '@opendrive/shared';

export const importRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.post(
    '/api/v1/files/import-url',
    {
      schema: {
        body: z.object({ url: z.string().url() }),
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const ownerKey = ownerKeyOf(identity);
      const principal = principalOf(identity);

      let parsed: URL;
      try {
        parsed = new URL(request.body.url);
      } catch {
        throw new Error('invalid url');
      }
      if (parsed.protocol !== 'https:') throw new Error('https required');
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
        throw new Error('private host');

      const maxBytes = services.config.limits.maxFileSizeBytes;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let response: Response;
      try {
        response = await fetch(request.body.url, { signal: controller.signal, redirect: 'error' });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok || response.body === null) throw new Error('fetch failed');
      const size = Number(response.headers.get('content-length') ?? '0');
      if (size <= 0 || size > maxBytes) throw new Error('bad size');

      const fileId = newId('file');
      const reservationId = newId('quotaReservation');
      const reservation = await reserveStorage(sql, {
        reservationId,
        principal: quotaArgsFor(principal),
        fileId,
        bytes: size,
        ttlSeconds: 3600,
      });
      if (!reservation.ok) throw new Error('quota refused');

      const filename = parsed.pathname.split('/').pop() || 'imported';
      const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';

      await createFile(sql, {
        id: fileId,
        owner: {
          ownerKey,
          ownerUserId: principal.kind === 'user' ? principal.userId : null,
          ownerSessionId: principal.kind === 'anonymous' ? principal.sessionId : null,
        },
        folderId: null,
        originalFilename: filename,
        sizeBytes: size,
        mimeType,
        visibility: 'private',
        checksumSha256: null,
        expiresAt: null,
      });

      try {
        const session = await provider.initiateUpload({
          uploadId: newId('upload'),
          fileId,
          filename,
          sizeBytes: size,
          mimeType,
          chunkSizeBytes: size,
        });

        const stream = (async function* () {
          const reader = response.body!.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield value;
          }
        })();

        const stored = await provider.uploadWholeObject({
          session,
          source: stream,
          sizeBytes: size,
        });

        await insertActiveStorageObject(sql, {
          id: newId('storageObject'),
          fileId,
          ref: stored.ref,
        });

        await commitReservation(sql, reservationId);
        assertTransition('pending_upload', 'uploaded', {
          scanningEnabled: services.config.limits.malwareScanEnabled,
        });
        await applyFileTransition(sql, {
          fileId,
          ownerKey,
          from: 'pending_upload',
          to: 'uploaded',
        });
        const target = services.config.limits.malwareScanEnabled ? 'scanning' : 'ready';
        assertTransition('uploaded', target, {
          scanningEnabled: services.config.limits.malwareScanEnabled,
        });
        await applyFileTransition(sql, { fileId, ownerKey, from: 'uploaded', to: target });
      } catch (error) {
        await releaseReservation(sql, reservationId);
        throw error;
      }

      return reply.status(201).send({ fileId });
    },
  );
};
