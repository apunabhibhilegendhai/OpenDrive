import {
  API_PREFIX,
  AppError,
  createFolderRequestSchema,
  folderPageSchema,
  folderRecordSchema,
  newId,
  paginationQuerySchema,
  problemDetailsResponseSchema,
  updateFolderRequestSchema,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, assertFolderOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { toFolderRecord } from '../db/mappers.js';
import {
  createFolder,
  findFolderById,
  listFolders,
  moveFolder,
  renameFolder,
  softDeleteFolder,
} from '../db/repositories/folders.js';
import { decodeCursor } from '../pagination.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';

/**
 * Folders.
 *
 * The tree invariants live in the database — a composite foreign key rejects a parent owned by
 * someone else, and a trigger rejects a cycle, a self-parent and a hierarchy deeper than 32 levels.
 * This module's job is to turn those refusals into answers, and to make sure that no request can
 * reach a folder its credential does not own.
 *
 * Two behaviours are worth calling out because they are choices rather than consequences:
 *
 *   * A parent folder that does not belong to the caller answers 404, which is what a parent that
 *     does not exist answers too. Otherwise the API would confirm the existence of other users'
 *     folders to anyone who can guess an id.
 *   * Deleting a folder never cascades. A folder with live children or files is refused with 409
 *     and the caller has to deal with the contents explicitly, so a delete can never remove files
 *     the caller did not name.
 */

const folderParamsSchema = z.object({
  folderId: z
    .string()
    .regex(/^fold_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected a folder id with the "fold_" prefix'),
});

const listFoldersQuerySchema = paginationQuerySchema.extend({
  parent: z
    .union([z.literal('root'), z.string().regex(/^fold_[0-9a-hjkmnp-tv-z]{26}$/)])
    .optional()
    .describe('List the root level, or the children of one folder. Omit for the whole tree.'),
});

export const folderRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.get(
    `${API_PREFIX}/folders`,
    {
      schema: {
        tags: ['files'],
        summary: 'List your own folders',
        description:
          'Keyset-paginated list of the folders owned by the presented credential. Folders are ' +
          "private to their owner: there is no listing that includes somebody else's tree.",
        querystring: listFoldersQuerySchema,
        response: {
          200: folderPageSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const { limit, cursor, parent } = request.query;
      const scope = parent === undefined ? 'any' : parent === 'root' ? 'root' : 'folder';

      const page = await listFolders(services.db.requireSql(), ownerKeyOf(identity), {
        scope,
        ...(scope === 'folder' && typeof parent === 'string' ? { folderId: parent } : {}),
        limit,
        before: cursor === undefined ? undefined : decodeCursor(cursor),
      });

      return { items: page.items.map(toFolderRecord), nextCursor: page.nextCursor };
    },
  );

  app.post(
    `${API_PREFIX}/folders`,
    {
      schema: {
        tags: ['files'],
        summary: 'Create a folder',
        description:
          'Creates a folder at the root (omit `parentId`) or inside one of your own folders. A ' +
          'parent folder you do not own is reported as not found, and a duplicate name in the ' +
          'same parent is a conflict.',
        body: createFolderRequestSchema,
        response: {
          201: folderRecordSchema,
          400: problemDetailsResponseSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const ownerKey = ownerKeyOf(identity);
      const sql = services.db.requireSql();
      const { name, parentId } = request.body;

      if (parentId !== null) {
        // Confirms ownership before the insert so the database's foreign key is a backstop, not
        // the mechanism that reports the error.
        assertFolderOwnership(identity, await findFolderById(sql, parentId, ownerKey));
      }

      const folder = await createFolder(sql, {
        id: newId('folder'),
        owner: {
          ownerKey,
          ownerUserId: identity.principal.kind === 'user' ? identity.principal.userId : null,
          ownerSessionId:
            identity.principal.kind === 'anonymous' ? identity.principal.sessionId : null,
        },
        parentId,
        name,
      });

      reply.code(201);
      return toFolderRecord(folder);
    },
  );

  app.patch(
    `${API_PREFIX}/folders/:folderId`,
    {
      schema: {
        tags: ['files'],
        summary: 'Rename or move a folder',
        description:
          'Renames a folder, re-parents it (send `parentId`, or `null` for the root), or both. A ' +
          'move that would create a cycle, or that would nest deeper than the supported limit, is ' +
          'refused; a move into a folder you do not own is reported as not found.',
        params: folderParamsSchema,
        body: updateFolderRequestSchema,
        response: {
          200: folderRecordSchema,
          400: problemDetailsResponseSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const ownerKey = ownerKeyOf(identity);
      const sql = services.db.requireSql();
      const { folderId } = request.params;
      const { name, parentId } = request.body;

      assertFolderOwnership(identity, await findFolderById(sql, folderId, ownerKey));

      if (parentId !== undefined) {
        if (parentId !== null) {
          assertFolderOwnership(identity, await findFolderById(sql, parentId, ownerKey));
          if (parentId === folderId) {
            throw new AppError('CONFLICT', { detail: 'A folder cannot be its own parent.' });
          }
        }
        const moved = await moveFolder(sql, { folderId, ownerKey, parentId });
        assertFolderOwnership(identity, moved);
      }

      if (name !== undefined) {
        const renamed = await renameFolder(sql, { folderId, ownerKey, name });
        assertFolderOwnership(identity, renamed);
      }

      const updated = await findFolderById(sql, folderId, ownerKey);
      return toFolderRecord(assertFolderOwnership(identity, updated));
    },
  );

  app.delete(
    `${API_PREFIX}/folders/:folderId`,
    {
      schema: {
        tags: ['files'],
        summary: 'Delete an empty folder',
        description:
          'Soft-deletes a folder that has no live children and no live files. A non-empty folder ' +
          'is refused with 409: deletion never cascades, because a delete that removes files the ' +
          'caller did not name is how data disappears.',
        params: folderParamsSchema,
        response: {
          204: z.null().describe('The folder was deleted.'),
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const outcome = await softDeleteFolder(services.db.requireSql(), {
        folderId: request.params.folderId,
        ownerKey: ownerKeyOf(identity),
      });

      if (outcome === 'not_found') {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }
      if (outcome === 'not_empty') {
        throw new AppError('CONFLICT', {
          detail: 'This folder still contains folders or files. Empty it first.',
        });
      }

      reply.code(204);
      return null;
    },
  );
};
