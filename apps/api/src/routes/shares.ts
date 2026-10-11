import {
  API_PREFIX,
  AppError,
  SHARE_TOKEN_HEADER,
  createShareRequestSchema,
  createdShareRecordSchema,
  credentialDigest,
  isServable,
  newId,
  newOpaqueToken,
  problemDetailsResponseSchema,
  resolveShareRequestSchema,
  resolveShareResponseSchema,
  resolveShareLink,
  validationFailed,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, assertFileOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { toFileRecord, toShareRecord } from '../db/mappers.js';
import { findFileById, findFileByIdForAccessCheck } from '../db/repositories/files.js';
import { insertShare, findShareByTokenHash, revokeShare } from '../db/repositories/shares.js';
import {
  AUDIT_ACTIONS,
  recordAuditEvent,
  recordAuditEventBestEffort,
} from '../db/repositories/audit.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';

/**
 * Share links.
 *
 * A share link is a bearer credential: whoever holds the token is the audience, which is why the
 * token is generated from 256 bits of CSPRNG output, stored only as a digest, and returned exactly
 * once.
 *
 * Resolution re-derives every part of the decision on every request — link status, expiry, download
 * allowance, and the file's current state — through `resolveShareLink` from the shared package. The
 * two consequences that matter:
 *
 *   * Revoking a link takes effect on the very next request, because nothing about a resolution is
 *     cached;
 *   * Every refusal is answered as 404 with the same body as a token that never existed, so the
 *     endpoint cannot be used to probe which tokens are real. (A download cap is the one exception:
 *     it is the caller's own usage, and telling them is not a disclosure.)
 *
 * Share creation goes through the *owner's* credential and the file's ownership check, so a share
 * can never be minted for someone else's file, and never for a file that is not servable.
 */

const shareParamsSchema = z.object({
  shareId: z
    .string()
    .regex(/^shr_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected a share id with the "shr_" prefix'),
});

export const shareRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.post(
    `${API_PREFIX}/shares`,
    {
      schema: {
        tags: ['shares'],
        summary: 'Create a share link',
        description:
          'Creates a public or unlisted link to one of your own files. The file must be in a ' +
          'servable state. The token is returned once, in this response, and is never stored or ' +
          'retrievable afterwards.',
        body: createShareRequestSchema,
        response: {
          201: createdShareRecordSchema,
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
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.sharesWrite);
      const sql = services.db.requireSql();
      const ownerKey = ownerKeyOf(identity);
      const { fileId, kind, expiresAt, maxDownloads } = request.body;

      const file = assertFileOwnership(identity, await findFileById(sql, fileId, ownerKey));

      // Serving an unready file through a link is the single most likely way a quarantine or a
      // failed upload would leak, so the share cannot exist until the file is servable.
      if (!isServable(file.state, { scanningEnabled: services.config.limits.malwareScanEnabled })) {
        throw new AppError('CONFLICT', {
          detail: 'This file is not ready to be shared yet.',
          context: { status: file.state },
        });
      }

      const token = newOpaqueToken();
      const tokenHash = await credentialDigest(token);
      const shareId = newId('share');

      const share = await sql.begin(async (tx) => {
        const inserted = await insertShare(tx, {
          id: shareId,
          fileId,
          kind,
          tokenHash,
          createdBy: file.ownerUserId,
          maxDownloads,
          expiresAt: expiresAt === null ? null : new Date(expiresAt),
        });
        await recordAuditEvent(tx, {
          actorKind: identity.principal.kind === 'user' ? 'user' : 'anonymous',
          actorUserId: file.ownerUserId,
          action: 'share.created',
          subjectType: 'share',
          subjectId: inserted.id,
          requestId: request.id,
          actorIpHash: request.clientIpHash,
          metadata: { kind, fileId },
        });
        return inserted;
      });

      reply.code(201);
      return {
        ...toShareRecord(share),
        token,
        url: `${services.config.publicBaseUrl}/s/${token}`,
      };
    },
  );

  app.post(
    `${API_PREFIX}/shares/resolve`,
    {
      schema: {
        tags: ['shares'],
        summary: 'Resolve a share link',
        description:
          'Resolves a share token and returns the file it points at. Requires no account: the ' +
          'token is the credential. Send it in the body or in the `X-Share-Token` header, never ' +
          'both. Every refusal — revoked, expired, over its download cap, or pointing at a file ' +
          'that is no longer servable — answers 404 exactly as an unknown token does.',
        headers: z.object({
          [SHARE_TOKEN_HEADER]: z.string().min(32).max(256).optional(),
        }),
        // Nullable rather than optional: a request with no body at all arrives as `null`, not as
        // `undefined`, and a client sending the token in the header is allowed to omit it. A
        // client that sends neither gets the 400 the handler produces below.
        body: resolveShareRequestSchema.nullable(),
        response: {
          200: resolveShareResponseSchema,
          400: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const sql = services.db.requireSql();
      const bodyToken = request.body?.token ?? null;
      const headerToken = request.headers[SHARE_TOKEN_HEADER] ?? null;

      if (bodyToken !== null && headerToken !== null) {
        throw validationFailed('Provide the share token in the body or in the header, not both.', [
          { path: 'token', message: 'duplicated between the body and the X-Share-Token header' },
        ]);
      }

      const token = bodyToken ?? headerToken;
      if (token === null) {
        throw validationFailed('A share token is required.', [
          { path: 'token', message: 'missing from both the body and the X-Share-Token header' },
        ]);
      }

      const tokenHash = await credentialDigest(token);
      const share = await findShareByTokenHash(sql, tokenHash);
      if (share === null) {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      const file = await findFileByIdForAccessCheck(sql, share.fileId);
      if (file === null) {
        // A link whose file row is gone is indistinguishable from a token that never existed.
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      const resolution = resolveShareLink(
        {
          status: share.status,
          expiresAt: share.expiresAt,
          revokedAt: share.revokedAt,
          maxDownloads: share.maxDownloads,
          downloadCount: share.downloadCount,
        },
        {
          state: file.state,
          visibility: file.visibility,
          deletedAt: file.deletedAt,
          scanState: file.scanState,
        },
        { now: new Date(), scanningEnabled: services.config.limits.malwareScanEnabled },
      );

      if (!resolution.ok) {
        // Recorded, but never disclosed: the caller sees the same 404 for every reason.
        await recordAuditEventBestEffort(
          sql,
          {
            actorKind: 'anonymous',
            actorUserId: null,
            action: AUDIT_ACTIONS.authorizationDenied,
            subjectType: 'share',
            subjectId: share.id,
            requestId: request.id,
            actorIpHash: request.clientIpHash,
            metadata: { reason: resolution.reason },
          },
          request.log,
        );
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      return { share: toShareRecord(share), file: toFileRecord(file) };
    },
  );

  app.delete(
    `${API_PREFIX}/shares/:shareId`,
    {
      schema: {
        tags: ['shares'],
        summary: 'Revoke a share link',
        description:
          'Revokes a link to one of your own files. Revocation is a status change, not a deletion: ' +
          'the row stays so the history is auditable, and the next resolution of that token fails.',
        params: shareParamsSchema,
        response: {
          204: z.null().describe('The link was revoked.'),
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.sharesWrite);
      const revoked = await revokeShare(services.db.requireSql(), {
        shareId: request.params.shareId,
        ownerUserId: identity.principal.kind === 'user' ? identity.principal.userId : null,
        ownerSessionId:
          identity.principal.kind === 'anonymous' ? identity.principal.sessionId : null,
      });

      if (revoked === null) {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      reply.code(204);
      return null;
    },
  );
};
