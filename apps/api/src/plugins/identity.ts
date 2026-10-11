import { AppError, isAppError } from '@opendrive/shared';
import type { FastifyInstance } from 'fastify';
import type { RequestIdentity } from '../auth/identity.js';
import { resolveRequestIdentity } from '../auth/identity.js';
import type { IpHasher } from '../auth/ip-hash.js';
import type { AccessTokenVerifier } from '../auth/tokens.js';
import { API_PREFIX } from '@opendrive/shared';
import type { Sql } from '../db/client.js';

/**
 * Request identity.
 *
 * Identity is resolved once per request, in an `onRequest` hook, and stored on the request. Doing
 * it in the hook (rather than in each handler) is what makes the policy below uniform: a request
 * that presents a credential it cannot prove is refused *before* any handler runs, on every route
 * under the API prefix.
 *
 * System endpoints (`/healthz`, `/readyz`, `/docs`) are deliberately outside that policy. They must
 * stay answerable even while authentication is misconfigured, which is exactly when an operator
 * needs them.
 *
 * The hook records the outcome rather than deciding it per route, and the audit-relevant facts
 * (which credential was used, the hashed client address) are attached here so handlers never have
 * to re-derive them from headers.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until the hook runs; handlers should call `requestIdentity()`. */
    identity: RequestIdentity | null;
    /** Keyed hash of the client address, or null when no hashing secret is configured. */
    clientIpHash: string | null;
  }
}

export interface IdentityOptions {
  readonly sql: Sql | null;
  readonly verifier: AccessTokenVerifier;
  readonly hashIp: IpHasher;
  /** Injectable clock, for tests that exercise expiry. */
  readonly now?: () => Date;
}

/**
 * Installs the decorators and the hook on the *root* instance.
 *
 * This is deliberately not a Fastify plugin. A plugin is encapsulated: hooks registered inside it
 * apply only to routes registered in the same scope, so identity resolution would silently skip
 * every route registered afterwards — a failure mode where the only symptom is a 500 from a
 * handler that never received an identity. Registering on the instance the server builds keeps the
 * hook global and the decorators visible everywhere.
 */
export function applyIdentityResolution(app: FastifyInstance, options: IdentityOptions): void {
  app.decorateRequest('identity', null);
  app.decorateRequest('clientIpHash', null);

  app.addHook('onRequest', async (request, reply) => {
    request.clientIpHash = options.hashIp(request.ip);

    if (!request.url.startsWith(API_PREFIX)) {
      request.identity = { kind: 'none' };
      return;
    }

    try {
      request.identity = await resolveRequestIdentity(request.headers, {
        sql: options.sql,
        verifier: options.verifier,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } catch (error) {
      // A refused credential is an answer, not an exception: the shared error handler renders it
      // as a problem document with the right status (401, 403, 400 or 503).
      const appError = isAppError(error)
        ? error
        : new AppError('INTERNAL', {
            detail: 'The credential could not be resolved.',
            expose: false,
            cause: error,
          });
      if (appError.code === 'INTERNAL')
        request.log.error({ err: error }, 'identity resolution failed');
      void reply
        .status(appError.status)
        .send(appError.toProblemDetails({ instance: request.url, requestId: request.id }));
    }
  });
}

/** The resolved identity, or an internal error if the plugin was not registered on this instance. */
export function requestIdentity(request: { identity: RequestIdentity | null }): RequestIdentity {
  if (request.identity === null) {
    throw new AppError('INTERNAL', {
      detail: 'Request identity was not resolved for this route.',
      expose: false,
    });
  }
  return request.identity;
}
