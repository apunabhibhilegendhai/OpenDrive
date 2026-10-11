import { AppError } from '@opendrive/shared';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import type { ApiConfig } from '../config.js';

/**
 * Supabase access-token verification.
 *
 * Decoding a JWT is not authenticating it. Every claim that matters is checked here, against the
 * deployment's own configuration:
 *
 *   - the **signature**, using the JWKS endpoint or the shared secret (and never `alg: none`);
 *   - the **issuer**, so a token minted by a different Supabase instance is refused;
 *   - the **audience** (`authenticated` by default, matching Supabase's own convention);
 *   - the **expiry**, with a small clock tolerance for a skewed container clock;
 *   - the presence of `sub` and `exp`, so a token that simply omits a claim cannot pass;
 *   - the **role** claim, which must be `authenticated`. A `service_role` token is the Supabase
 *     secret key: treating it as a user identity would hand a request the power to bypass every
 *     policy in the database.
 *
 * The algorithm is taken from the token header *only* to choose which key source to use, and the
 * allowed set is fixed per source — the classic `alg` confusion attack needs the verifier to trust
 * the header, and this one does not.
 */

export interface VerifiedAccessToken {
  readonly userId: string;
  readonly role: 'authenticated';
  readonly email: string | null;
  readonly expiresAt: Date;
  readonly issuedAt: Date | null;
}

export interface AccessTokenVerifier {
  readonly configured: boolean;
  /** Resolves the token's identity, or throws an AppError (401, or 503 when unconfigured). */
  verify: (token: string) => Promise<VerifiedAccessToken>;
}

const SYMMETRIC_ALGORITHMS = ['HS256', 'HS384', 'HS512'] as const;
const ASYMMETRIC_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

function unauthenticated(detail: string, cause?: unknown): AppError {
  return new AppError('UNAUTHENTICATED', {
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function unconfigured(): AppError {
  return new AppError('SERVICE_UNAVAILABLE', {
    detail:
      'This deployment cannot verify access tokens: no JWKS URL or JWT secret is configured. ' +
      'Protected endpoints are unavailable until it is.',
  });
}

export function createAccessTokenVerifier(config: ApiConfig['auth']): AccessTokenVerifier {
  const secret = config.jwtSecret === null ? null : new TextEncoder().encode(config.jwtSecret);
  const jwks =
    config.jwksUrl === null
      ? null
      : createRemoteJWKSet(new URL(config.jwksUrl), {
          // A JWKS is fetched once and cached; a rotated key is picked up on the next miss.
          cooldownDuration: 30_000,
          cacheMaxAge: 600_000,
        });

  return {
    configured: config.configured,
    verify: async (token) => {
      if (secret === null && jwks === null) throw unconfigured();

      let algorithm: string;
      try {
        const header = decodeProtectedHeader(token);
        if (typeof header.alg !== 'string')
          throw unauthenticated('The access token has no alg header.');
        algorithm = header.alg;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw unauthenticated('The access token is not a well-formed JWT.', error);
      }

      const symmetric = (SYMMETRIC_ALGORITHMS as readonly string[]).includes(algorithm);
      const asymmetric = (ASYMMETRIC_ALGORITHMS as readonly string[]).includes(algorithm);
      if (!symmetric && !asymmetric) {
        // `alg: none`, an unknown algorithm, or a homemade one: refused by name, before any key
        // source is consulted.
        throw unauthenticated('The access token uses an unsupported signing algorithm.');
      }

      const key = symmetric ? secret : jwks;
      if (key === null) {
        // Reached when a deployment configures only one key source and the token needs the other.
        throw unauthenticated(
          'The access token uses a signing key this deployment does not accept.',
        );
      }

      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, key, {
          algorithms: symmetric ? [...SYMMETRIC_ALGORITHMS] : [...ASYMMETRIC_ALGORITHMS],
          ...(config.issuer === null ? {} : { issuer: config.issuer }),
          audience: config.audience,
          clockTolerance: '30s',
          requiredClaims: config.issuer === null ? ['exp', 'sub'] : ['exp', 'sub', 'iss'],
        });
        payload = result.payload;
      } catch (error) {
        // One message for every failure: which check failed is useful to an operator (the log)
        // and useful to an attacker (the response).
        throw unauthenticated('The access token is not valid.', error);
      }

      const subject = payload.sub;
      if (typeof subject !== 'string' || subject.trim() === '') {
        throw unauthenticated('The access token has no subject claim.');
      }
      if (payload.role !== 'authenticated') {
        throw unauthenticated('The access token does not carry the "authenticated" role claim.');
      }
      if (typeof payload.exp !== 'number') {
        // `requiredClaims` already enforces this; the check keeps the type honest below.
        throw unauthenticated('The access token has no expiry claim.');
      }

      return {
        userId: subject,
        role: 'authenticated',
        email: typeof payload.email === 'string' ? payload.email : null,
        expiresAt: new Date(payload.exp * 1000),
        issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000) : null,
      };
    },
  };
}
