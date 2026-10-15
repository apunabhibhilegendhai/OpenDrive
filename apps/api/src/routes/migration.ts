import {
  ANONYMOUS_CREDENTIAL_HEADER,
  API_PREFIX,
  migrateAnonymousSessionResponseSchema,
  problemDetailsResponseSchema,
} from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { migrateAnonymousSessionIntoAccount } from '../identity/migrate.js';
import { planMigrationRequest } from '../identity/migration.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';

/**
 * Bringing an anonymous session's files and folders into an account.
 *
 * The request carries **two** credentials, and they are different things:
 *
 *   * `Authorization: Bearer <Supabase access token>` — who the caller is, as everywhere else. The
 *     account the resources end up in is this identity and nothing else; there is no request field
 *     that could name another.
 *   * `X-Anonymous-Credential: ods_…` — the session being migrated. Presenting it is the proof of
 *     ownership: it is the same bearer credential the session's own routes accept, so whoever holds
 *     it is already able to read and delete that data.
 *
 * A **session credential is required** (not an API key): moving data between principals is an
 * account change, and an API key must never be able to absorb an anonymous session's files.
 * Anonymous callers are refused for the obvious reason — they would be migrating into themselves.
 *
 * Every refusal is either a `401` (the session credential itself is no longer usable), a `403` (the
 * caller's credential type may not do this) or a `409` (the session was already migrated, or there
 * is nothing to migrate). A session that already belongs to a *different* account answers `409`
 * without naming that account.
 *
 * This handler does no deciding of its own: `planMigrationRequest` performs the authorization and
 * reads the one header, and the transaction in `identity/migrate.ts` decides the rest against the
 * row it locks. Both are tested directly, and the route is deliberately too thin to contain a rule
 * that could differ from the ones written down.
 */
export const migrationRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.post(
    `${API_PREFIX}/identity/migrations`,
    {
      schema: {
        tags: ['identity'],
        summary: 'Bring an anonymous session into this account',
        description:
          'Transfers ownership of every file and folder the presented anonymous session holds to ' +
          'the signed-in account, then revokes the session. Files with no retrievable bytes (an ' +
          'abandoned or failed upload) are closed rather than transferred, and root folders whose ' +
          'name the account already uses are renamed — both are reported in the response. The ' +
          'operation is idempotent for the account it already went to, and refused for any other.',
        headers: z.object({
          [ANONYMOUS_CREDENTIAL_HEADER]: z
            .string()
            .min(1)
            .max(512)
            .optional()
            .describe('The anonymous session credential (`ods_…`) whose resources should move.'),
        }),
        response: {
          200: migrateAnonymousSessionResponseSchema,
          201: migrateAnonymousSessionResponseSchema,
          400: problemDetailsResponseSchema,
          401: problemDetailsResponseSchema,
          403: problemDetailsResponseSchema,
          409: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const presented = request.headers[ANONYMOUS_CREDENTIAL_HEADER];
      const plan = planMigrationRequest({
        identity: requestIdentity(request),
        // The only value this route reads from the request beyond the credential: a header Fastify
        // has already normalised, which may hold several values and is then refused as malformed.
        presentedCredential: typeof presented === 'string' ? presented : undefined,
      });

      const outcome = await migrateAnonymousSessionIntoAccount(services.db.requireSql(), {
        anonymousCredential: plan.anonymousCredential,
        // From the verified identity, never from the request.
        targetUserId: plan.targetUserId,
        requestId: request.id,
        actorIpHash: request.clientIpHash,
      });

      reply.code(outcome.alreadyMigrated ? 200 : 201);
      // Copied into a mutable array: the response schema is the contract, and the service returns
      // its renames as a readonly list.
      return { ...outcome, folderRenames: [...outcome.folderRenames] };
    },
  );
};
