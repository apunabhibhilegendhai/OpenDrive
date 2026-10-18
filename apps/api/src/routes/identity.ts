import { API_PREFIX, meResponseSchema, problemDetailsResponseSchema } from '@opendrive/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ownerKeyOf, requireIdentity } from '../authz.js';
import { toAuthContext } from '../auth/payload.js';
import { toQuotaSummary } from '../db/mappers.js';
import { quotaArgsFor, readQuotaSummary } from '../db/repositories/quota.js';
import { requestIdentity } from '../plugins/identity.js';
import { quotaRefusalProblem } from '../problems.js';
import type { AppServices } from '../services.js';

/**
 * The caller's own identity and quota.
 *
 * There is no route that returns another principal's identity, and no request body field that
 * could ask for one: the answer is derived from the credential the request was authenticated with.
 */
export const identityRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.get(
    `${API_PREFIX}/me`,
    {
      schema: {
        tags: ['identity'],
        summary: 'Current identity and quota',
        description:
          'Resolves the presented credential and reports the resulting identity, its scopes and ' +
          'the quota that applies to it. Works for a registered user, an API key and an anonymous ' +
          'session alike — the identity is never taken from the request body.',
        response: {
          200: meResponseSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request) => {
      const identity = requireIdentity(requestIdentity(request));
      const sql = services.db.requireSql();

      // Identity is per-credential — two API keys on one account carry different scopes — so only
      // the quota is cached, under the principal the credential resolves to. The generation that
      // keys this entry is advanced by every upload, delete and folder write, so a change to the
      // numbers a person just made is reflected on their very next read.
      const quota = await services.userCache.readThrough({
        principalKey: ownerKeyOf(identity),
        tag: 'quota',
        load: async () => {
          const outcome = await readQuotaSummary(sql, quotaArgsFor(identity.principal));
          if (!outcome.ok) throw quotaRefusalProblem(outcome.reason);
          return toQuotaSummary(outcome.summary);
        },
      });

      return {
        identity: toAuthContext(identity),
        quota,
      };
    },
  );
};
