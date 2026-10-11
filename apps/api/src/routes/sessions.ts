import {
  anonymousSessionResponseSchema,
  API_PREFIX,
  credentialDigest,
  newAnonymousSessionCredential,
  newId,
  problemDetailsResponseSchema,
} from '@opendrive/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AUDIT_ACTIONS, recordAuditEvent } from '../db/repositories/audit.js';
import { insertAnonymousSession } from '../db/repositories/identity.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';

/**
 * Anonymous sessions.
 *
 * This is how an unregistered client gets an identity. It is deliberately narrow: the caller
 * receives a credential, and that is the only time the plaintext exists — the database holds a
 * SHA-256 digest, so a session cannot be recovered, only replaced.
 *
 * What it deliberately does NOT do:
 *
 *   * It does not create a Supabase user. An anonymous uploader is a row in `anonymous_sessions`,
 *     not a shadow account that could sign in, hold a password or be mistaken for a person.
 *   * It does not record a raw address. The keyed hash is written when a hashing secret is
 *     configured, and nothing at all is written when it is not (see `auth/ip-hash.ts`).
 *   * It does not accept a caller-supplied expiry: the lifetime is the deployment's policy.
 *
 * The session row and its audit event are one transaction. An identity that exists without a record
 * of having been issued would be exactly the kind of gap that is impossible to reason about later.
 */
export const sessionRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  app.post(
    `${API_PREFIX}/anonymous-sessions`,
    {
      schema: {
        tags: ['identity'],
        summary: 'Create an anonymous session',
        description:
          'Issues an anonymous session credential for an unregistered uploader. The credential is ' +
          'returned once and stored only as a hash; use it as `Authorization: Bearer ods_…`. The ' +
          'session expires on the schedule this deployment configures and can be revoked, after ' +
          'which it grants nothing.',
        response: {
          201: anonymousSessionResponseSchema,
          429: problemDetailsResponseSchema,
          503: problemDetailsResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const sql = services.db.requireSql();
      // Resolving identity here is not required (the hook already refuses a bad credential), but
      // reading it makes the intent explicit: this route issues a *new* identity, so it is the one
      // place where an unauthenticated caller is expected.
      void requestIdentity(request);

      const credential = newAnonymousSessionCredential();
      const credentialHash = await credentialDigest(credential);
      const ttlHours = services.config.anonymousSessions.ttlHours;
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      const sessionId = newId('anonymousSession');

      const session = await sql.begin(async (tx) => {
        const inserted = await insertAnonymousSession(tx, {
          id: sessionId,
          credentialHash,
          expiresAt,
          createdIpHash: request.clientIpHash,
        });
        await recordAuditEvent(tx, {
          actorKind: 'anonymous',
          actorUserId: null,
          action: AUDIT_ACTIONS.anonymousSessionCreated,
          subjectType: 'system',
          subjectId: inserted.id,
          requestId: request.id,
          actorIpHash: request.clientIpHash,
          metadata: { ttlHours },
        });
        return inserted;
      });

      reply.code(201);
      return {
        sessionId: session.id,
        credential,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );
};
