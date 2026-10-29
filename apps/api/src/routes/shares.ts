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
import type { ShareRefusalReason } from '@opendrive/shared';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { REQUIRED_SCOPES, assertFileOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { contentDisposition } from '../content-disposition.js';
import { effectiveMimeTypeForFile, isInlinePreviewable } from '../mime.js';
import { toFileRecord, toShareRecord } from '../db/mappers.js';
import type { FileEntity, ShareEntity } from '../db/entities.js';
import { findFileById, findFileByIdForAccessCheck } from '../db/repositories/files.js';
import { findActiveStorageObjectByFileId } from '../db/repositories/storage-objects.js';
import {
  countShareOpen,
  insertShare,
  findShareByTokenHash,
  revokeShare,
} from '../db/repositories/shares.js';
import {
  AUDIT_ACTIONS,
  recordAuditEvent,
  recordAuditEventBestEffort,
} from '../db/repositories/audit.js';
import { requestIdentity } from '../plugins/identity.js';
import { INLINE_PREVIEW_CSP } from '../security.js';
import type { AppServices } from '../services.js';
import {
  SHARE_PAGE_CSP,
  previewKindFor,
  renderSharePage,
  renderShareUnavailablePage,
} from '../share-page.js';
import { requireStorageProvider } from '../storage/registry.js';
import { parseRangeHeader } from './range.js';

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
 *
 * The same token also has a *public* face, for a browser rather than an API client:
 * `GET /s/:token` renders a landing page and `GET /s/:token/download` streams the bytes with range
 * support. Opening the page is what consumes the link's download allowance, so one open plus one
 * download counts once; the byte route never increments, which is also why a shared video can fetch
 * its ranges without the allowance evaporating mid-playback.
 */

const shareParamsSchema = z.object({
  shareId: z
    .string()
    .regex(/^shr_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected a share id with the "shr_" prefix'),
});

/**
 * The token in a public link. Deliberately permissive: a malformed or invented token must fall
 * through to the same "not available" answer as a real-but-dead one, never to a validation error
 * that would tell a prober something.
 */
const publicShareParamsSchema = z.object({
  token: z.string().min(1).max(512),
});

type ShareLookup =
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly share: ShareEntity; readonly reason: ShareRefusalReason }
  | { readonly kind: 'resolved'; readonly share: ShareEntity; readonly file: FileEntity };

/**
 * The one place a share token becomes a decision, shared by the JSON resolve route and the public
 * landing/download routes so they cannot drift apart.
 *
 * `enforceAllowance` exists because the allowance is spent at the landing page: the bytes that open
 * then asks for must not be refused because of the very open that requested them. Passing a fresh
 * count for the byte route expresses "ignore the counter", not "the link is unlimited".
 */
async function lookUpShare(
  services: AppServices,
  token: string,
  options: { readonly enforceAllowance: boolean },
): Promise<ShareLookup> {
  const sql = services.db.requireSql();
  const share = await findShareByTokenHash(sql, await credentialDigest(token));
  if (share === null) return { kind: 'missing' };

  const file = await findFileByIdForAccessCheck(sql, share.fileId);
  // A link whose file row is gone is indistinguishable from a token that never existed.
  if (file === null) return { kind: 'missing' };

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
    {
      now: new Date(),
      scanningEnabled: services.config.limits.malwareScanEnabled,
      ...(options.enforceAllowance ? {} : { downloadCount: 0 }),
    },
  );

  if (!resolution.ok) return { kind: 'refused', share, reason: resolution.reason };
  return { kind: 'resolved', share, file };
}

/** Records a refusal without ever disclosing which rule produced it. */
async function recordShareRefusal(
  services: AppServices,
  request: FastifyRequest,
  shareId: string,
  reason: ShareRefusalReason,
): Promise<void> {
  await recordAuditEventBestEffort(
    services.db.requireSql(),
    {
      actorKind: 'anonymous',
      actorUserId: null,
      action: AUDIT_ACTIONS.authorizationDenied,
      subjectType: 'share',
      subjectId: shareId,
      requestId: request.id,
      actorIpHash: request.clientIpHash,
      metadata: { reason },
    },
    request.log,
  );
}

/** The HTML answer for a link that will not be served, with the page's own tighter CSP. */
function sendShareUnavailablePage(
  reply: FastifyReply,
  status: number,
  heading: string,
  message: string,
): FastifyReply {
  void reply.header('content-security-policy', SHARE_PAGE_CSP);
  void reply.header('x-robots-tag', 'noindex, nofollow');
  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .send(renderShareUnavailablePage({ heading, message }));
}

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

      const lookup = await lookUpShare(services, token, { enforceAllowance: true });
      if (lookup.kind === 'missing') {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }
      if (lookup.kind === 'refused') {
        // Recorded, but never disclosed here: the caller sees the same 404 for every reason,
        // including an exhausted download allowance.
        await recordShareRefusal(services, request, lookup.share.id, lookup.reason);
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      return { share: toShareRecord(lookup.share), file: toFileRecord(lookup.file) };
    },
  );

  /**
   * The recipient's view of a link: a page a browser renders.
   *
   * Hidden from OpenAPI on purpose — it answers HTML, not JSON, so it is not part of the API
   * contract. Opening the page is what consumes the link's allowance.
   */
  app.get(
    '/s/:token',
    { schema: { hide: true, params: publicShareParamsSchema } },
    async (request, reply) => {
      const lookup = await lookUpShare(services, request.params.token, { enforceAllowance: true });

      if (lookup.kind === 'refused' && lookup.reason === 'download_limit_reached') {
        // The one refusal the design allows disclosing: it describes the caller's own usage,
        // and a recipient who hits it deserves to be told why rather than told "not found".
        return sendShareUnavailablePage(
          reply,
          410,
          'Download limit reached',
          'This link has reached its download limit and can no longer be opened.',
        );
      }
      if (lookup.kind !== 'resolved') {
        if (lookup.kind === 'refused') {
          await recordShareRefusal(services, request, lookup.share.id, lookup.reason);
        }
        return sendShareUnavailablePage(
          reply,
          404,
          'Link not available',
          'This link is not available. It may have been revoked or expired, or it may never have existed.',
        );
      }

      // Count the open atomically before rendering. A `null` means the link was revoked or spent
      // between resolution and this write; the same refusal is the honest answer.
      const downloadCount = await countShareOpen(services.db.requireSql(), lookup.share.id);
      if (downloadCount === null) {
        return sendShareUnavailablePage(
          reply,
          404,
          'Link not available',
          'This link is not available. It may have been revoked or expired, or it may never have existed.',
        );
      }

      const { file } = lookup;
      void reply.header('content-security-policy', SHARE_PAGE_CSP);
      void reply.header('x-robots-tag', 'noindex, nofollow');
      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .send(
          renderSharePage({
            token: request.params.token,
            filename: file.originalFilename,
            sizeBytes: file.sizeBytes,
            mimeType: file.mimeType,
            previewKind: previewKindFor(file.mimeType, file.originalFilename),
            expiresAt: lookup.share.expiresAt,
            maxDownloads: lookup.share.maxDownloads,
            downloadCount,
          }),
        );
    },
  );

  /**
   * The bytes behind the page, and the target of the download button.
   *
   * Range-capable for the same reason the owner route is (D40): a shared video must be seekable
   * without downloading it whole. The allowance is deliberately *not* re-checked here — the open
   * already spent it, and re-checking would refuse the bytes that open just asked for. The
   * consequence, recorded in D44, is that the byte route cannot be used to *raise* the count.
   */
  app.get(
    '/s/:token/download',
    { schema: { hide: true, params: publicShareParamsSchema } },
    async (request, reply) => {
      const provider = requireStorageProvider(services.storage);
      const sql = services.db.requireSql();
      const lookup = await lookUpShare(services, request.params.token, { enforceAllowance: false });

      if (lookup.kind !== 'resolved') {
        if (lookup.kind === 'refused') {
          await recordShareRefusal(services, request, lookup.share.id, lookup.reason);
        }
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      const { file } = lookup;
      const object = await findActiveStorageObjectByFileId(sql, file.id);
      if (object === null) {
        // Resolvable but no object: a state this build should never produce. Report it as absent
        // rather than streaming nothing with a 200.
        throw new AppError('NOT_FOUND', { detail: 'The file has no stored content.' });
      }

      const totalSize = object.ref.sizeBytes;
      const rangedRead = provider.capabilities.rangedRead;
      void reply.header('accept-ranges', rangedRead ? 'bytes' : 'none');
      const requested = rangedRead ? parseRangeHeader(request.headers.range, totalSize) : null;

      if (requested === 'unsatisfiable') {
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
      if (isInlinePreviewable(file.mimeType, file.originalFilename)) {
        // The share page embeds this URL in its own <img>/<video>. Navigating to it directly
        // produces the same generated media document, so it needs the media-safe policy too.
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
