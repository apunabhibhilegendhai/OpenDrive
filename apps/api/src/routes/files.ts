import {
  API_PREFIX,
  AppError,
  filePageSchema,
  fileRecordSchema,
  isServable,
  paginationQuerySchema,
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
import { isInlinePreviewable } from '../mime.js';
import { decodeCursor } from '../pagination.js';
import { requestIdentity } from '../plugins/identity.js';
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
      const page = await listFiles(services.db.requireSql(), ownerKeyOf(identity), {
        scope,
        ...(scope === 'folder' && typeof folder === 'string' ? { folderId: folder } : {}),
        limit,
        before: cursor === undefined ? undefined : decodeCursor(cursor),
      });

      return { items: page.items.map(toFileRecord), nextCursor: page.nextCursor };
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
          'response is the raw bytes; error responses use the standard problem shape.',
        params: fileParamsSchema,
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();

      const file = assertFileOwnership(
        identity,
        await findFileById(sql, request.params.fileId, ownerKeyOf(identity)),
      );

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
      void reply.header('content-type', file.mimeType);
      void reply.header('content-length', String(read.length));
      void reply.header(
        'content-disposition',
        contentDisposition(file.originalFilename, file.mimeType),
      );
      void reply.header('cache-control', 'private, no-store');
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

      return reply.status(204).send(null);
    },
  );
};

/**
 * A conservative `Content-Disposition` that never lets a filename break out of the header. A
 * safe-to-render image/audio/video is served `inline` so the browser shows it rather than saving
 * it; everything else — HTML and SVG included, which could execute — keeps downloading. The
 * `Content-Type` is already the sanitised effective type, and `x-content-type-options: nosniff` is
 * set globally, so the browser will not reinterpret a served body.
 */
function contentDisposition(filename: string, mimeType: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition = isInlinePreviewable(mimeType) ? 'inline' : 'attachment';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
