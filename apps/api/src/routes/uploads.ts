import {
  API_PREFIX,
  AppError,
  UPLOAD_PART_CHECKSUM_HEADER,
  assertTransition,
  checkFileSize,
  completeUploadResponseSchema,
  initiateUploadRequestSchema,
  initiateUploadResponseSchema,
  problemDetailsResponseSchema,
  newId,
  newOpaqueToken,
  sha256Hex,
  uploadPartResponseSchema,
  uploadStatusResponseSchema,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  REQUIRED_SCOPES,
  assertFolderOwnership,
  ownerKeyOf,
  principalOf,
  requireScope,
} from '../authz.js';
import { toFileRecord } from '../db/mappers.js';
import {
  applyFileTransition,
  countFilesCreatedSince,
  createFile,
  setDeletionTokenHash,
} from '../db/repositories/files.js';
import { findFolderById } from '../db/repositories/folders.js';
import {
  commitReservation,
  quotaArgsFor,
  releaseReservation,
  reserveStorage,
} from '../db/repositories/quota.js';
import { insertActiveStorageObject } from '../db/repositories/storage-objects.js';
import { requestIdentity } from '../plugins/identity.js';
import { quotaRefusalProblem } from '../problems.js';
import type { AppServices } from '../services.js';
import { requireStorageProvider } from '../storage/registry.js';
import type { UploadSessionRecord } from '../storage/upload-sessions.js';

/**
 * The chunked upload workflow — IMPLEMENTED.
 *
 * Protocol:
 *   1. POST   /uploads                     declare size/mime/visibility; receive an upload id,
 *                                          the effective chunk size, and (anonymous only) a
 *                                          one-time deletion token.
 *   2. PUT    /uploads/:id/parts/:number   send one part as raw bytes; parts may arrive in any
 *                                          order and a repeat overwrites the staged copy.
 *   3. GET    /uploads/:id                 progress, so an interrupted client can resume.
 *   4. POST   /uploads/:id/complete        finalize: verify the whole object, persist its locator.
 *   5. DELETE /uploads/:id                 abort: release the staged bytes and the quota hold.
 *
 * The shape of the workflow is fixed by the fact that the bytes never touch PostgreSQL and never
 * all sit in application memory: the API holds one bounded part at a time and the provider holds
 * the staged object. What this module owns is the *bookkeeping* around that — the file row, the
 * quota hold reserved before any byte moves (D23), the deletion token, and the session registry.
 *
 * Every lookup is scoped to the caller's owner key: an upload belonging to somebody else is
 * reported as absent, exactly like one that never existed.
 */

const uploadParamsSchema = z.object({
  uploadId: z
    .string()
    .regex(/^upl_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected an upload id with the "upl_" prefix'),
});

const partParamsSchema = uploadParamsSchema.extend({
  partNumber: z.coerce.number().int().positive().max(1_000_000),
});

/** Midnight UTC on the day `now` falls in — the reset point for the daily upload cap. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function notFoundUpload(): AppError {
  return new AppError('NOT_FOUND', { detail: 'The upload session does not exist.' });
}

function conflictUpload(state: string): AppError {
  return new AppError('CONFLICT', {
    detail: `The upload session is "${state}" and cannot accept this operation.`,
  });
}

/** A row whose state disagrees with the session is a server-side inconsistency, not a client error. */
function inconsistentUploadState(): AppError {
  return new AppError('INTERNAL', {
    detail: 'The upload session and its file record disagreed about their state.',
    expose: false,
  });
}

export const uploadRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  const { config } = services;

  app.post(
    `${API_PREFIX}/uploads`,
    {
      schema: {
        tags: ['uploads'],
        summary: 'Begin an upload',
        description:
          'Declares a file and opens an upload session. A quota hold for the declared size is ' +
          'taken before any bytes are accepted, so an over-quota upload is refused here rather ' +
          'than after the bytes have moved. The response carries the effective chunk size the ' +
          'client must use; for anonymous uploads it also carries the one-time deletion token.',
        body: initiateUploadRequestSchema,
        response: {
          201: initiateUploadResponseSchema,
          400: problemDetailsResponseSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          413: problemDetailsResponseSchema,
          429: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const ownerKey = ownerKeyOf(identity);
      const principal = principalOf(identity);

      const { filename, sizeBytes, mimeType, visibility, folderId } = request.body;

      // 1. The declared size must fit the deployment's limits before anything is written.
      const sizeCheck = checkFileSize(sizeBytes, config.limits);
      if (!sizeCheck.ok) {
        throw new AppError('PAYLOAD_TOO_LARGE', {
          detail: sizeCheck.reason ?? 'The declared file size exceeds the configured maximum.',
        });
      }

      // 2. One principal may only hold so many open sessions at once.
      services.uploadSessions.assertCapacity(ownerKey);

      // 3. A daily cap per principal bounds how often an upload may be *started*, independent of
      //    how many bytes are stored. It is intentionally separate from the storage-quota hold.
      const uploadsPerDay =
        identity.kind === 'user'
          ? config.limits.registeredUploadsPerDay
          : config.limits.anonymousUploadsPerDay;
      const startedToday = await countFilesCreatedSince(sql, ownerKey, startOfUtcDay(new Date()));
      if (startedToday >= uploadsPerDay) {
        throw new AppError('QUOTA_EXCEEDED', {
          detail: `This account may start at most ${uploadsPerDay} uploads per day.`,
        });
      }

      // 4. A folder, if named, must belong to the caller.
      if (folderId !== null) {
        assertFolderOwnership(identity, await findFolderById(sql, folderId, ownerKey));
      }

      const uploadId = newId('upload');
      const fileId = newId('file');
      const ttlSeconds = config.uploads.sessionTtlHours * 3600;
      const now = new Date();
      const sessionExpiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      const owner =
        identity.kind === 'user'
          ? { ownerKey, ownerUserId: identity.principal.userId, ownerSessionId: null }
          : { ownerKey, ownerUserId: null, ownerSessionId: identity.principal.sessionId };

      await createFile(sql, {
        id: fileId,
        owner,
        folderId,
        originalFilename: filename,
        sizeBytes,
        mimeType,
        visibility,
        checksumSha256: request.body.checksumSha256 ?? null,
        expiresAt: null,
      });

      // 5. Reserve the storage the upload will occupy. A refusal is a normal outcome whose reason
      //    decides the status; the just-created metadata row is retired so it cannot linger.
      const reservation = await reserveStorage(sql, {
        reservationId: newId('quotaReservation'),
        principal: quotaArgsFor(principal),
        fileId,
        bytes: sizeBytes,
        ttlSeconds,
      });
      if (!reservation.ok) {
        await applyFileTransition(sql, {
          fileId,
          ownerKey,
          from: 'pending_upload',
          to: 'deleted',
        });
        throw quotaRefusalProblem(reservation.reason, reservation.message);
      }

      // 6. Open the provider session. On failure the hold and the row are rolled back.
      let providerSession;
      try {
        providerSession = await provider.initiateUpload({
          uploadId,
          fileId,
          filename,
          sizeBytes,
          mimeType,
          chunkSizeBytes: config.limits.chunkSizeBytes,
          checksumSha256: request.body.checksumSha256 ?? null,
          sessionTtlSeconds: ttlSeconds,
        });
      } catch (error) {
        await releaseReservation(sql, reservation.reservationId);
        await applyFileTransition(sql, { fileId, ownerKey, from: 'pending_upload', to: 'failed' });
        throw error;
      }

      // 7. The row now moves to `uploading`; bytes are on their way.
      assertTransition('pending_upload', 'uploading', {
        scanningEnabled: config.limits.malwareScanEnabled,
      });
      await applyFileTransition(sql, { fileId, ownerKey, from: 'pending_upload', to: 'uploading' });

      // 8. An anonymous uploader's only way to manage the file later is a one-time token whose
      //    digest — never the token — is stored.
      let deletionToken: string | undefined;
      let deletionTokenHash: string | null = null;
      if (identity.kind === 'anonymous') {
        deletionToken = newOpaqueToken();
        deletionTokenHash = await sha256Hex(deletionToken);
        await setDeletionTokenHash(sql, fileId, ownerKey, deletionTokenHash);
      }

      const record: UploadSessionRecord = {
        uploadId,
        fileId,
        ownerKey,
        principal,
        reservationId: reservation.reservationId,
        providerSession,
        declaredSizeBytes: sizeBytes,
        partSizeBytes: providerSession.partSizeBytes,
        deletionTokenHash,
        createdAt: now,
        expiresAt: sessionExpiresAt,
      };
      services.uploadSessions.create(record);

      return reply.status(201).send({
        uploadId,
        fileId,
        chunkSizeBytes: providerSession.partSizeBytes,
        ...(deletionToken === undefined ? {} : { deletionToken }),
        expiresAt: record.expiresAt.toISOString(),
      });
    },
  );

  app.put(
    `${API_PREFIX}/uploads/:uploadId/parts/:partNumber`,
    {
      // Part traffic is far more numerous than ordinary requests: one upload issues one call per
      // part. The route therefore carries its own, higher per-principal ceiling (the global
      // limiter still applies to every other route).
      config: {
        rateLimit: {
          max: config.rateLimit.uploadPartsPerMinute,
          timeWindow: '1 minute',
        },
      },
      schema: {
        tags: ['uploads'],
        summary: 'Upload one part',
        description:
          'Sends one part of the object as raw bytes (`application/octet-stream`). The part size ' +
          'must not exceed the chunk size returned by `POST /uploads`. Parts may be sent in any ' +
          'order; re-sending a part number replaces the staged copy, which is what makes a failed ' +
          'part safely retryable.',
        params: partParamsSchema,
        headers: z.object({
          [UPLOAD_PART_CHECKSUM_HEADER]: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional()
            .describe('Optional SHA-256 of this part, in lower-case hex.'),
        }),
        response: {
          200: uploadPartResponseSchema,
          400: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          413: problemDetailsResponseSchema,
          422: problemDetailsResponseSchema,
          429: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const provider = requireStorageProvider(services.storage);
      const ownerKey = ownerKeyOf(identity);
      const { uploadId, partNumber } = request.params;

      const view = services.uploadSessions.get(uploadId, ownerKey);
      if (view === null) throw notFoundUpload();
      if (view.state !== 'initiated' && view.state !== 'in_progress') {
        throw conflictUpload(view.state);
      }
      if (view.record.providerSession.expectedParts !== null) {
        if (partNumber > view.record.providerSession.expectedParts) {
          throw new AppError('INVALID_REQUEST', {
            detail: `Part ${partNumber} is past the last expected part (${view.record.providerSession.expectedParts}).`,
          });
        }
      }

      const contentLength = request.headers['content-length'];
      const declaredBytes =
        typeof contentLength === 'string' ? Number.parseInt(contentLength, 10) : Number.NaN;
      if (!Number.isInteger(declaredBytes) || declaredBytes <= 0) {
        throw new AppError('INVALID_REQUEST', {
          detail: 'A positive Content-Length header is required for a part upload.',
        });
      }
      if (declaredBytes > view.record.partSizeBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', {
          detail: `Part size ${declaredBytes} exceeds the chunk size ${view.record.partSizeBytes}.`,
        });
      }

      const checksum = request.headers[UPLOAD_PART_CHECKSUM_HEADER];
      const result = await provider.uploadPart(view.record.providerSession, {
        partNumber,
        source: request.body as AsyncIterable<Uint8Array>,
        sizeBytes: declaredBytes,
        checksumSha256: typeof checksum === 'string' ? checksum : null,
      });

      services.uploadSessions.markPartReceived(uploadId, partNumber);

      return {
        partNumber: result.partNumber,
        receivedBytes: result.receivedBytes,
        ...(result.checksumSha256 === null ? {} : { checksumSha256: result.checksumSha256 }),
      };
    },
  );

  app.get(
    `${API_PREFIX}/uploads/:uploadId`,
    {
      schema: {
        tags: ['uploads'],
        summary: 'Upload progress',
        description:
          'Reports how far an upload has got, so a client that lost its connection can see which ' +
          'parts still need sending. A session belonging to another principal answers 404.',
        params: uploadParamsSchema,
        response: {
          200: uploadStatusResponseSchema,
          401: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const view = services.uploadSessions.get(request.params.uploadId, ownerKeyOf(identity));
      if (view === null) throw notFoundUpload();
      return {
        uploadId: view.record.uploadId,
        fileId: view.record.fileId,
        state: view.state,
        chunkSizeBytes: view.record.partSizeBytes,
        expectedParts: view.record.providerSession.expectedParts,
        partsReceived: view.partsReceived.length,
        expiresAt: view.record.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    `${API_PREFIX}/uploads/:uploadId/complete`,
    {
      schema: {
        tags: ['uploads'],
        summary: 'Complete an upload',
        description:
          'Finalizes the object: the provider assembles and verifies the staged parts, the locator ' +
          'is persisted, the quota hold is committed, and the file becomes servable. Idempotent — ' +
          'a retried completion returns the same file.',
        params: uploadParamsSchema,
        response: {
          200: completeUploadResponseSchema,
          401: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          422: problemDetailsResponseSchema,
          429: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const ownerKey = ownerKeyOf(identity);

      const view = services.uploadSessions.get(request.params.uploadId, ownerKey);
      if (view === null) throw notFoundUpload();
      if (view.state !== 'initiated' && view.state !== 'in_progress') {
        throw conflictUpload(view.state);
      }

      // A finalize that fails — missing parts, a checksum mismatch — is deliberately NOT terminal.
      // The provider keeps the staged parts, so the client may send what is missing and retry, or
      // abort to release the hold. Only an explicit abort ends the session, because only the client
      // knows whether the upload is worth recovering; a hold left behind by a crash expires on its
      // own. `finalizeUpload` is idempotent, so a retry after a partial failure is safe.
      const stored = await provider.finalizeUpload(view.record.providerSession);

      await insertActiveStorageObject(sql, {
        id: newId('storageObject'),
        fileId: view.record.fileId,
        ref: stored.ref,
      });
      await commitReservation(sql, view.record.reservationId);

      const scanningEnabled = config.limits.malwareScanEnabled;
      const uploaded = await applyFileTransition(sql, {
        fileId: view.record.fileId,
        ownerKey,
        from: 'uploading',
        to: 'uploaded',
      });
      if (uploaded === null) throw inconsistentUploadState();

      const target = scanningEnabled ? 'scanning' : 'ready';
      assertTransition('uploaded', target, { scanningEnabled });
      const finalized = await applyFileTransition(sql, {
        fileId: view.record.fileId,
        ownerKey,
        from: 'uploaded',
        to: target,
        ...(scanningEnabled ? { scanState: 'pending' as const } : {}),
      });
      if (finalized === null) throw inconsistentUploadState();

      services.uploadSessions.finish(view.record.uploadId, 'finalized');
      return { file: toFileRecord(finalized) };
    },
  );

  app.delete(
    `${API_PREFIX}/uploads/:uploadId`,
    {
      schema: {
        tags: ['uploads'],
        summary: 'Abort an upload',
        description:
          'Releases the staged bytes and the quota hold and marks the file failed. Idempotent ' +
          'enough for a retried abort: a session already gone answers 404, which a client may ' +
          'treat as success.',
        params: uploadParamsSchema,
        response: {
          204: z.null().describe('The upload was aborted.'),
          401: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const ownerKey = ownerKeyOf(identity);

      const view = services.uploadSessions.get(request.params.uploadId, ownerKey);
      if (view === null) throw notFoundUpload();

      if (view.state === 'initiated' || view.state === 'in_progress') {
        await provider.abortUpload(view.record.providerSession, 'client_cancelled');
        await releaseReservation(sql, view.record.reservationId);
        await applyFileTransition(sql, {
          fileId: view.record.fileId,
          ownerKey,
          from: 'uploading',
          to: 'failed',
        });
        services.uploadSessions.finish(view.record.uploadId, 'aborted');
      }

      return reply.status(204).send(null);
    },
  );
};
