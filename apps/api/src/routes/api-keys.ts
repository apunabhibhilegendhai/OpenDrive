import {
  API_PREFIX,
  AppError,
  apiKeyPageSchema,
  createdApiKeyRecordSchema,
  credentialDigest,
  createApiKeyRequestSchema,
  newApiKeyMaterial,
  newId,
  normalizeScopes,
  problemDetailsResponseSchema,
  validationFailed,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireSessionCredential } from '../authz.js';
import { toApiKeyRecord } from '../db/mappers.js';
import { insertApiKey, listApiKeys, revokeApiKey } from '../db/repositories/api-keys.js';
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/repositories/audit.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';

/**
 * API key administration.
 *
 * These three routes are the only way a key comes into existence or stops working, and they share
 * one rule: **an API key cannot manage API keys.** They require a full session credential
 * (`requireSessionCredential`), because a key that could mint keys would be able to grant itself a
 * scope it was never issued, and would survive its own revocation by creating a successor. An
 * anonymous session is refused for the same reason: it has no account to attach a key to.
 *
 * The secret is returned exactly once, by the creation response. Nothing else in the system can
 * reproduce it: the listing response is the same record shape minus the secret, and the database
 * holds only a digest and the public prefix.
 */

const keyParamsSchema = z.object({
  keyId: z
    .string()
    .regex(/^key_[0-9a-hjkmnp-tv-z]{26}$/, 'Expected a key id with the "key_" prefix'),
});

export const apiKeyRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.get(
    `${API_PREFIX}/api-keys`,
    {
      schema: {
        tags: ['identity'],
        summary: 'List your API keys',
        description:
          'Lists the API keys belonging to the signed-in account. Revoked and expired keys are ' +
          'included so the history is visible; the secret half is not part of any response.',
        response: {
          200: apiKeyPageSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const user = requireSessionCredential(requestIdentity(request), 'api-keys:manage');
      const keys = await listApiKeys(services.db.requireSql(), user.principal.userId);
      return { items: keys.map(toApiKeyRecord), nextCursor: null };
    },
  );

  app.post(
    `${API_PREFIX}/api-keys`,
    {
      schema: {
        tags: ['identity'],
        summary: 'Create an API key',
        description:
          'Creates a scoped API key for the signed-in account. Scopes are mandatory to be useful ' +
          'and an empty list is accepted deliberately: a key with no scope can do nothing, which ' +
          'is the safe default. The key itself is returned once and cannot be retrieved again.',
        body: createApiKeyRequestSchema,
        response: {
          201: createdApiKeyRecordSchema,
          400: problemDetailsResponseSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireSessionCredential(requestIdentity(request), 'api-keys:manage');
      const ownerUserId = user.principal.userId;
      const { name, scopes, expiresAt } = request.body;

      const { accepted, rejected } = normalizeScopes(scopes);
      if (rejected.length > 0) {
        throw validationFailed('One or more scopes are not recognised.', [
          { path: 'scopes', message: `unknown scopes: ${rejected.join(', ')}` },
        ]);
      }

      const material = newApiKeyMaterial();
      const keyHash = await credentialDigest(material.key);
      const sql = services.db.requireSql();

      const created = await sql.begin(async (tx) => {
        const key = await insertApiKey(tx, {
          id: newId('apiKey'),
          ownerUserId,
          name,
          keyPrefix: material.keyPrefix,
          keyHash,
          scopes: accepted,
          expiresAt: expiresAt === null ? null : new Date(expiresAt),
        });
        await recordAuditEvent(tx, {
          actorKind: 'user',
          actorUserId: ownerUserId,
          action: AUDIT_ACTIONS.apiKeyCreated,
          subjectType: 'api_key',
          subjectId: key.id,
          requestId: request.id,
          actorIpHash: request.clientIpHash,
          metadata: { scopeCount: accepted.length, keyPrefix: key.keyPrefix },
        });
        return key;
      });

      reply.code(201);
      return { ...toApiKeyRecord(created), key: material.key };
    },
  );

  app.delete(
    `${API_PREFIX}/api-keys/:keyId`,
    {
      schema: {
        tags: ['identity'],
        summary: 'Revoke an API key',
        description:
          "Revokes one of the account's keys. Authorization reads the key row on every request, " +
          'so revocation takes effect immediately — there is no token cache to wait out.',
        params: keyParamsSchema,
        response: {
          204: z.null().describe('The key was revoked.'),
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          404: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = requireSessionCredential(requestIdentity(request), 'api-keys:manage');
      const ownerUserId = user.principal.userId;
      const sql = services.db.requireSql();

      const revoked = await sql.begin(async (tx) => {
        const key = await revokeApiKey(tx, { keyId: request.params.keyId, ownerUserId });
        if (key === null) return null;
        await recordAuditEvent(tx, {
          actorKind: 'user',
          actorUserId: ownerUserId,
          action: AUDIT_ACTIONS.apiKeyRevoked,
          subjectType: 'api_key',
          subjectId: key.id,
          requestId: request.id,
          actorIpHash: request.clientIpHash,
          metadata: { keyPrefix: key.keyPrefix },
        });
        return key;
      });

      if (revoked === null) {
        throw new AppError('NOT_FOUND', { detail: 'The resource does not exist.' });
      }

      reply.code(204);
      return null;
    },
  );
};
