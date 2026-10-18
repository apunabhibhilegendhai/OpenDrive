import {
  API_PREFIX,
  AppError,
  isServable,
  problemDetailsResponseSchema,
  deliveryGrantSchema,
} from '@opendrive/shared';
import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, assertFileOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { contentDisposition } from '../content-disposition.js';
import { findFileById, findFileByIdForAccessCheck } from '../db/repositories/files.js';
import { findActiveStorageObjectByFileId } from '../db/repositories/storage-objects.js';
import { effectiveMimeTypeForFile, isInlinePreviewable } from '../mime.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';
import { requireStorageProvider } from '../storage/registry.js';
import { parseRangeHeader } from './range.js';

/**
 * Cacheable delivery.
 *
 * Owner content (`GET /files/:id/content`) is private and uncacheable by design. This surface is
 * the opposite: a *delivery* URL that a browser element or a caching proxy may hold, fetch and
 * re-serve. The distinction is carried entirely by the credential — the owner route authenticates
 * with a bearer token; a delivery URL proves itself with a short-lived token signed into the URL,
 * bound to one file and one object version.
 *
 * Two rules make caching safe:
 *
 *   * The URL names the object **version** (`storage_objects.id`), not just the file. A re-upload
 *     yields a new version and therefore a new URL, so `immutable` can never serve stale bytes.
 *   * The token expires. A leaked URL is a time-boxed grant, and the mint route is the only place a
 *     caller with `files:read` can obtain one for a file they own.
 *
 * See docs/EDGE-CACHE.md and docs/DECISIONS.md (D45, D46).
 */

const fileParamsSchema = z.object({
  fileId: z
    .string()
    .regex(/^file_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected a file id with the "file_" prefix'),
});

const cdnParamsSchema = z.object({
  fileId: z.string().regex(/^file_[0-9a-hjkmnp-tv-z]{26}$/),
  version: z.string().regex(/^sobj_[0-9a-hjkmnp-tv-z]{26}$/),
});

const cdnQuerySchema = z.object({
  token: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Signed, expiring token minted by `POST /files/:fileId/delivery-url`.'),
});

/**
 * Whether an `If-None-Match` value matches our ETag. Handles the `*` wildcard and a comma-separated
 * list, because a proxy or browser may send either. Weak validators (`W/"..."`) compare equal here:
 * the ETag is a checksum of immutable bytes, so a weak/strong distinction is meaningless.
 */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === bare);
}

/**
 * How much of a delivery token's life is never cached.
 *
 * A cached grant keeps the *same* URL across repeated opens, which is what lets a browser or proxy
 * reuse the bytes it already holds: a fresh token on every open would make every URL unique and
 * every cache entry unreachable. The cost is that a cached URL is served until it is within this
 * margin of expiry, so a caller never receives a link that dies mid-request.
 */
const DELIVERY_GRANT_CACHE_SLACK_SECONDS = 60;

/** The cached lifetime of one delivery grant: its token TTL less the safety margin. */
function deliveryGrantCacheTtl(tokenTtlSeconds: number): number {
  return Math.max(
    1,
    tokenTtlSeconds - Math.min(DELIVERY_GRANT_CACHE_SLACK_SECONDS, tokenTtlSeconds >> 1),
  );
}

export const deliveryRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.post(
    `${API_PREFIX}/files/:fileId/delivery-url`,
    {
      schema: {
        tags: ['files'],
        summary: 'Mint a cacheable delivery URL',
        description:
          'Returns a short-lived URL that streams this file with `Cache-Control: public, ' +
          'immutable`, so a browser element or a caching proxy may store and re-serve it without an ' +
          'Authorization header. The URL is bound to the current object version, so re-uploading ' +
          'the file invalidates every previously issued URL. Only the owner (scope `files:read`) may ' +
          'mint one; a deployment with no signing secret answers 503.',
        params: fileParamsSchema,
        response: {
          200: deliveryGrantSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const signer = services.delivery;
      if (signer === null) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          detail: 'Cacheable delivery URLs are not configured in this deployment.',
        });
      }
      // Presence is what matters: without a provider there is nothing to deliver, so an
      // unconfigured deployment answers 503 here rather than minting a URL that will 503 later.
      requireStorageProvider(services.storage);

      const sql = services.db.requireSql();
      const ownerKey = ownerKeyOf(identity);
      const file = assertFileOwnership(
        identity,
        await findFileById(sql, request.params.fileId, ownerKey),
      );

      const scanningEnabled = services.config.limits.malwareScanEnabled;
      if (!isServable(file.state, { scanningEnabled })) {
        throw new AppError('CONFLICT', {
          detail: `A file in state "${file.state}" has no content to deliver.`,
          context: { state: file.state },
        });
      }

      const object = await findActiveStorageObjectByFileId(sql, file.id);
      if (object === null) {
        throw new AppError('NOT_FOUND', { detail: 'The file has no stored content.' });
      }

      // The token is deterministic for one (file, version, expiry second), so caching the grant is
      // what keeps the URL stable across opens: the browser (and the edge) then key their caches on
      // one URL instead of one per page view. Ownership and servability were checked above, so the
      // cache never becomes an authorization bypass — it only avoids re-signing the same grant.
      const cached = await services.userCache.getJson<{
        url: string;
        path: string;
        expiresAt: string;
      }>(ownerKey, 'delivery', [file.id, object.id]);
      if (cached !== null) return cached;

      const grant = signer.mint(file.id, object.id, new Date());
      const path = `/cdn/${file.id}/${object.id}?token=${encodeURIComponent(grant.token)}`;
      const value = {
        url: `${services.config.publicBaseUrl}${path}`,
        path,
        expiresAt: grant.expiresAt.toISOString(),
      };
      await services.userCache.setJson(
        ownerKey,
        'delivery',
        [file.id, object.id],
        value,
        deliveryGrantCacheTtl(services.config.delivery.tokenTtlSeconds),
      );
      return value;
    },
  );

  /**
   * The byte surface. Registered outside the API prefix, like a share page, so a cache treats a
   * stable path rather than an API-shaped one. `hide: true` keeps it out of the OpenAPI document:
   * it is not part of the programmatic contract, it is a URL handed out by the mint route.
   */
  app.get(
    '/cdn/:fileId/:version',
    {
      schema: {
        hide: true,
        params: cdnParamsSchema,
        querystring: cdnQuerySchema,
      },
    },
    async (request, reply) => {
      const provider = requireStorageProvider(services.storage);
      const signer = services.delivery;
      const token = request.query.token;

      if (signer === null || token === undefined) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'A valid delivery token is required.',
        });
      }

      const claims = signer.verify(token, new Date());
      // The token must name exactly the file and version in the path. Comparing both binds the
      // byte identity to the URL a cache is keyed on.
      if (
        claims === null ||
        claims.fileId !== request.params.fileId ||
        claims.version !== request.params.version
      ) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'The delivery link is invalid or has expired.',
        });
      }

      const sql = services.db.requireSql();
      const file = await findFileByIdForAccessCheck(sql, claims.fileId);
      if (file === null) {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      if (!isServable(file.state, { scanningEnabled: services.config.limits.malwareScanEnabled })) {
        throw new AppError('CONFLICT', {
          detail: `A file in state "${file.state}" is not available for download.`,
          context: { state: file.state },
        });
      }

      const object = await findActiveStorageObjectByFileId(sql, file.id);
      // `object.id !== version` means the bytes changed since the URL was minted. Answer as absent:
      // the old URL's bytes are genuinely gone, and a stale cache entry must not be revalidated.
      if (object === null || object.id !== claims.version) {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      const totalSize = object.ref.sizeBytes;
      const rangedRead = provider.capabilities.rangedRead;
      void reply.header('accept-ranges', rangedRead ? 'bytes' : 'none');
      // Content-addressed: the checksum identifies these exact bytes. The object id is the fallback
      // when a provider reports no checksum, and changes with every new version all the same.
      const etag = `"${object.ref.checksumSha256 ?? object.id}"`;

      // Parse the range *before* advertising cacheability: a `416` must not be a publicly cacheable
      // response, so the route sets no `cache-control` on that path and `security.ts` fills in
      // `no-store`, exactly as it does for every other error.
      const requested = rangedRead ? parseRangeHeader(request.headers.range, totalSize) : null;
      if (requested === 'unsatisfiable') {
        void reply.header('content-range', `bytes */${totalSize}`);
        throw new AppError('RANGE_NOT_SATISFIABLE', {
          detail: `The requested range is outside the object (0-${totalSize - 1}).`,
        });
      }

      void reply.header('etag', etag);
      void reply.header(
        'cache-control',
        `public, max-age=${services.config.delivery.publicMaxAgeSeconds}, immutable`,
      );

      if (request.method === 'GET' && etagMatches(request.headers['if-none-match'], etag)) {
        void reply.status(304);
        return reply.send();
      }

      const read = await provider.openReadStream(object.ref, requested ?? undefined);
      const servedType = effectiveMimeTypeForFile(file.mimeType, file.originalFilename);
      void reply.header('content-type', servedType);
      void reply.header('content-length', String(read.length));
      void reply.header(
        'content-disposition',
        contentDisposition(file.originalFilename, servedType),
      );
      if (isInlinePreviewable(file.mimeType, file.originalFilename)) {
        // Only now that the response is certain to be bytes: an inline-safe type may be embedded
        // from another origin, everything else keeps the default same-origin policy.
        void reply.header('cross-origin-resource-policy', 'cross-origin');
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
};
