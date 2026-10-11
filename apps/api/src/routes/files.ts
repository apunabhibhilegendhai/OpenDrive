import {
  API_PREFIX,
  filePageSchema,
  fileRecordSchema,
  paginationQuerySchema,
  problemDetailsResponseSchema,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, assertFileOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { toFileRecord } from '../db/mappers.js';
import { listFiles, findFileById } from '../db/repositories/files.js';
import { decodeCursor, toPage } from '../pagination.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';
import { notImplementedHandler } from './stubs.js';

/**
 * File metadata.
 *
 * Two routes are implemented in Phase 1 — listing the caller's own files and reading one file's
 * metadata — and they are the entire read surface for files. Content and deletion are still
 * contract-only: they need the storage layer and the download accounting that Phase 2 brings, and
 * they answer 501 rather than pretending.
 *
 * Every query here is scoped by the owner key derived from the credential, so a file belonging to
 * somebody else is indistinguishable from a file that does not exist.
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
      const rows = await listFiles(services.db.requireSql(), ownerKeyOf(identity), {
        scope,
        ...(scope === 'folder' && typeof folder === 'string' ? { folderId: folder } : {}),
        limit: limit + 1,
        before: cursor === undefined ? undefined : decodeCursor(cursor),
      });

      const page = toPage(rows, limit);
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
        summary: '[Phase 2] Download file content',
        description:
          'Publishes the download contract. The implementation must stream with bounded memory, ' +
          'refuse to serve anything that is not in a servable state, and set safe download ' +
          'headers. NOT IMPLEMENTED in this build: always answers 501.',
        params: fileParamsSchema,
        response: { 501: problemDetailsResponseSchema },
      },
    },
    notImplementedHandler('files.download'),
  );

  app.delete(
    `${API_PREFIX}/files/:fileId`,
    {
      schema: {
        tags: ['files'],
        summary: '[Phase 2] Delete a file',
        description:
          'Publishes the deletion contract: the owner, or an anonymous uploader holding the ' +
          'deletion token issued at upload time. NOT IMPLEMENTED in this build: always answers 501.',
        params: fileParamsSchema,
        headers: z.object({
          'x-deletion-token': z
            .string()
            .min(20)
            .optional()
            .describe('Bearer token issued at upload time for anonymous uploads.'),
        }),
        response: { 501: problemDetailsResponseSchema },
      },
    },
    notImplementedHandler('files.delete'),
  );
};
