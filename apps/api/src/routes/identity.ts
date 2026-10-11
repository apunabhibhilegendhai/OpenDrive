import { API_PREFIX, meResponseSchema, problemDetailsResponseSchema } from '@opendrive/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireIdentity } from '../authz.js';
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

      const outcome = await readQuotaSummary(sql, quotaArgsFor(identity.principal));
      if (!outcome.ok) throw quotaRefusalProblem(outcome.reason);

      return {
        identity: toAuthContext(identity),
        quota: toQuotaSummary(outcome.summary),
      };
    },
  );
};
