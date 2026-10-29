import {
  API_PREFIX,
  AppError,
  filePageSchema,
  fileRecordSchema,
  isServable,
  paginationQuerySchema,
  previewGrantSchema,
  problemDetailsResponseSchema,
  sha256Hex,
  tokensEqual,
} from '@opendrive/shared';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, assertFileOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { toFileRecord } from '../db/mappers.js';
import {
  listFiles,
  findFileById,
  findFileByIdForAccessCheck,
  findDeletionTokenHash,
  applyFileTransition,
} from '../db/repositories/files.js';
import {
  findActiveStorageObjectByFileId,
  markStorageObjectDeleted,
} from '../db/repositories/storage-objects.js';
import { contentDisposition } from '../content-disposition.js';
import { effectiveMimeTypeForFile, isInlinePreviewable } from '../mime.js';
import { decodeCursor } from '../pagination.js';
import { requestIdentity } from '../plugins/identity.js';
import { INLINE_PREVIEW_CSP } from '../security.js';
import type { AppServices } from '../services.js';
import { requireStorageProvider } from '../storage/registry.js';
import { parseRangeHeader } from './range.js';

/**
 * File metadata and content.
 *
 * Listing and reading metadata are scoped by the owner key derived from the credential, so a file
 * belonging to somebody else is indistinguishable from a file that does not exist. Download streams
 * the stored object with bounded memory and serves only a file in a servable state; deletion is a
 * soft delete that verifies the object is gone before the row reaches `deleted` (D29).
 */

const fileParamsSchema = z.object({
  fileId: z
    .string()
    .regex(/^file_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected a file id with the "file_" prefix'),
});

const listFilesQuerySchema = paginationQuerySchema.extend({
  folder: z
    .union([z.literal('root'), z.string().regex(/^fold_[0-9a-hjkmnp-tv-z]{26}$/)])
    .optional()
    .describe('Restrict to the root, or to the contents of one folder.'),
});

const contentQuerySchema = z.object({
  preview: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'Short-lived signed token minted by `POST /files/:fileId/preview`, authorizing an inline ' +
        'read without an Authorization header so a browser element can embed the file.',
    ),
});

export const fileRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.get(
    `${API_PREFIX}/files`,
    {
      schema: {
        tags: ['files'],
        summary: 'List your own files',
        description:
          'Keyset-paginated list of the files owned by the presented credential. `nextCursor` is ' +
          'opaque; pass it back to continue. Files belonging to another owner are never included, ' +
          'and a private file is never listed to anyone but its owner.',
        querystring: listFilesQuerySchema,
        response: {
          200: filePageSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const { limit, cursor, folder } = request.query;

      const scope = folder === undefined ? 'any' : folder === 'root' ? 'root' : 'folder';
      const ownerKey = ownerKeyOf(identity);

      // A page is cached per principal and per query (scope, folder, limit, cursor), so scrolling a
      // long listing does not re-query each page that was already seen. Every write that changes
      // what this listing would contain advances the principal's generation, which is why a file
      // that was just uploaded or deleted appears (or disappears) on the next read.
      return services.userCache.readThrough({
        principalKey: ownerKey,
        tag: 'files',
        parts: [scope, typeof folder === 'string' ? folder : '', limit, cursor ?? ''],
        load: async () => {
          const page = await listFiles(services.db.requireSql(), ownerKey, {
            scope,
            ...(scope === 'folder' && typeof folder === 'string' ? { folderId: folder } : {}),
            limit,
            before: cursor === undefined ? undefined : decodeCursor(cursor),
          });
          return { items: page.items.map(toFileRecord), nextCursor: page.nextCursor };
        },
      });
    },
  );

  app.get(
    `${API_PREFIX}/files/:fileId`,
    {
      schema: {
        tags: ['files'],
        summary: 'File metadata',
        description:
          'Metadata for one file the caller owns. Provider identifiers and storage locators are ' +
          'never part of this response, and a file owned by somebody else answers 404 exactly as ' +
          'an unknown id does.',
        params: fileParamsSchema,
        response: {
          200: fileRecordSchema,
          401: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const file = await findFileById(
        services.db.requireSql(),
        request.params.fileId,
        ownerKeyOf(identity),
      );
      return toFileRecord(assertFileOwnership(identity, file));
    },
  );

  app.get(
    `${API_PREFIX}/files/:fileId/content`,
    {
      schema: {
        tags: ['files'],
        summary: 'Download file content',
        description:
          'Streams the stored object with bounded memory. Only a file in a servable state is ' +
          'served; a file still uploading, failed, quarantined or deleted answers 409 even to its ' +
          'owner, because owning an id is not the same as having a readable object. The success ' +
          'response is the raw bytes; error responses use the standard problem shape. A valid ' +
          '`preview` token, minted by `POST /files/:fileId/preview`, authorizes the same read ' +
          'without an Authorization header so a browser element can embed the file inline.',
        params: fileParamsSchema,
        querystring: contentQuerySchema,
      },
    },
    async (request, reply) => {
      const identity = requestIdentity(request);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const previewToken = request.query.preview;

      // A bearer credential takes the owner path. Otherwise a valid preview token may grant an
      // inline read of exactly one file: that is what lets an <img>/<video>/<audio> embed it,
      // because a browser element cannot attach an Authorization header.
      let file;
      let embedded = false;
      if (identity.kind === 'none' && previewToken !== undefined) {
        const signer = services.preview;
        if (signer === null || !signer.verify(previewToken, request.params.fileId, new Date())) {
          throw new AppError('UNAUTHENTICATED', {
            detail: 'The preview link is invalid or has expired.',
          });
        }
        file = await findFileByIdForAccessCheck(sql, request.params.fileId);
        // A preview token only ever authorizes the inline-safe types it is minted for; a
        // non-previewable type answers the same 404 an unknown id does, revealing nothing.
        if (file === null || !isInlinePreviewable(file.mimeType, file.originalFilename)) {
          throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
        }
        embedded = true;
      } else {
        const resolved = requireScope(identity, REQUIRED_SCOPES.filesRead);
        file = assertFileOwnership(
          resolved,
          await findFileById(sql, request.params.fileId, ownerKeyOf(resolved)),
        );
      }

      if (file === null)
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });

      if (!isServable(file.state, { scanningEnabled: services.config.limits.malwareScanEnabled })) {
        throw new AppError('CONFLICT', {
          detail: `A file in state "${file.state}" is not available for download.`,
          context: { state: file.state },
        });
      }

      const object = await findActiveStorageObjectByFileId(sql, file.id);
      if (object === null) {
        // Servable but no object: a state this build should never produce. Report it as absent
        // rather than streaming nothing with a 200.
        throw new AppError('NOT_FOUND', { detail: 'The file has no stored content.' });
      }

      const totalSize = object.ref.sizeBytes;
      const rangedRead = provider.capabilities.rangedRead;
      // Advertise range support only when the provider can actually serve a partial object; a
      // `Range` header from a client is ignored (whole object, 200) everywhere else.
      void reply.header('accept-ranges', rangedRead ? 'bytes' : 'none');
      const requested = rangedRead ? parseRangeHeader(request.headers.range, totalSize) : null;

      if (requested === 'unsatisfiable') {
        // RFC 9110 §14.4: an unsatisfiable range is answered 416 with the current extent. The
        // headers set above survive the error handler, so this reply already carries them.
        void reply.header('content-range', `bytes */${totalSize}`);
        throw new AppError('RANGE_NOT_SATISFIABLE', {
          detail: `The requested range is outside the object (0-${totalSize - 1}).`,
        });
      }

      const read = await provider.openReadStream(object.ref, requested ?? undefined);
      const servedType = effectiveMimeTypeForFile(file.mimeType, file.originalFilename);
      void reply.header('content-type', servedType);
      void reply.header('content-length', String(read.length));
      void reply.header(
        'content-disposition',
        contentDisposition(file.originalFilename, servedType),
      );
      void reply.header('cache-control', 'private, no-store');
      if (embedded) {
        // Only now that the response is certain to be bytes rather than a problem document, mark
        // the resource embeddable from another origin. An error keeps the default same-origin.
        void reply.header('cross-origin-resource-policy', 'cross-origin');
      }
      if (isInlinePreviewable(file.mimeType, file.originalFilename)) {
        // A preview token is meant to be opened directly, too. Chrome wraps a top-level media
        // response in a generated document whose own <img>/<video> load is a subresource; the
        // strict default policy would block it. See INLINE_PREVIEW_CSP.
        void reply.header('content-security-policy', INLINE_PREVIEW_CSP);
      }
      if (read.range !== null) {
        void reply.header(
          'content-range',
          `bytes ${read.range.start}-${read.range.endInclusive}/${totalSize}`,
        );
        void reply.status(206);
      }
      return reply.send(Readable.from(read.stream));
    },
  );

  app.post(
    `${API_PREFIX}/files/:fileId/preview`,
    {
      schema: {
        tags: ['files'],
        summary: 'Mint a short-lived inline preview link',
        description:
          'Returns a path (relative to the API origin) that streams this file inline for a short ' +
          'while, so a browser element can display it without an Authorization header. Only a ' +
          'servable file whose type is safe to render inline (raster image, audio or video) can ' +
          'be previewed; any other file answers 409, and a deployment with no signing secret ' +
          'answers 503.',
        params: fileParamsSchema,
        response: {
          200: previewGrantSchema,
          401: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const sql = services.db.requireSql();
      const file = assertFileOwnership(
        identity,
        await findFileById(sql, request.params.fileId, ownerKeyOf(identity)),
      );

      if (!isServable(file.state, { scanningEnabled: services.config.limits.malwareScanEnabled })) {
        throw new AppError('CONFLICT', {
          detail: `A file in state "${file.state}" has no content to preview.`,
          context: { state: file.state },
        });
      }
      if (!isInlinePreviewable(file.mimeType)) {
        throw new AppError('CONFLICT', {
          detail: 'This file type is not rendered inline, so it cannot be previewed.',
          context: { mimeType: file.mimeType },
        });
      }
      const signer = services.preview;
      if (signer === null) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          detail: 'Preview links are not configured in this deployment.',
        });
      }

      const grant = signer.mint(file.id, new Date());
      return {
        path: `${API_PREFIX}/files/${file.id}/content?preview=${encodeURIComponent(grant.token)}`,
        expiresAt: grant.expiresAt.toISOString(),
      };
    },
  );

  app.delete(
    `${API_PREFIX}/files/:fileId`,
    {
      schema: {
        tags: ['files'],
        summary: 'Delete a file',
        description:
          'Soft-deletes a file the caller owns, or one an anonymous uploader still holds the ' +
          'deletion token for. The stored object is deleted first and only then is the row marked ' +
          'deleted, so a file is never reported gone while its bytes remain.',
        params: fileParamsSchema,
        headers: z.object({
          'x-deletion-token': z
            .string()
            .min(20)
            .optional()
            .describe('Bearer token issued at upload time for anonymous uploads.'),
        }),
        response: {
          204: z.null().describe('The file was deleted.'),
          401: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = requestIdentity(request);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const fileId = request.params.fileId;

      let file;
      if (identity.kind !== 'none') {
        const resolved = requireScope(identity, REQUIRED_SCOPES.filesWrite);
        file = assertFileOwnership(resolved, await findFileById(sql, fileId, ownerKeyOf(resolved)));
      } else {
        const token = request.headers['x-deletion-token'];
        if (token === undefined) {
          throw new AppError('UNAUTHENTICATED', {
            detail:
              'Deleting a file requires a credential or the deletion token it was issued with.',
          });
        }
        const candidate = await findFileByIdForAccessCheck(sql, fileId);
        const storedHash = candidate === null ? null : await findDeletionTokenHash(sql, fileId);
        const provided = await sha256Hex(token);
        if (storedHash === null || !tokensEqual(storedHash, provided)) {
          // A wrong token and a nonexistent file are the same answer: the token is a secret, and
          // confirming one would turn this route into an oracle.
          throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
        }
        file = candidate;
      }

      if (file === null)
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });

      const object = await findActiveStorageObjectByFileId(sql, file.id);
      if (object !== null) {
        await provider.deleteObject(object.ref);
        await markStorageObjectDeleted(sql, object.id);
      }

      if (file.state !== 'deleted') {
        const deleted = await applyFileTransition(sql, {
          fileId: file.id,
          ownerKey: file.ownerKey,
          from: file.state,
          to: 'deleted',
        });
        if (deleted === null) {
          throw new AppError('CONFLICT', {
            detail: `A file in state "${file.state}" cannot be deleted.`,
            context: { state: file.state },
          });
        }
      }

      // Before answering, drop every cached reading of this principal's files: a listing fetched
      // right after a delete must not resurrect the row from cache.
      await services.userCache.invalidateReads(file.ownerKey);

      return reply.status(204).send(null);
    },
  );
};
