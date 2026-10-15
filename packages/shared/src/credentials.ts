import { newOpaqueToken, sha256Hex } from './tokens.js';
import { newBase32Suffix } from './ids.js';

/**
 * Credential formats for the three authentication paths.
 *
 * One header carries all three kinds (`Authorization: Bearer …`) because the value itself is
 * self-describing, and a request that carries two credentials is rejected rather than resolved —
 * see the conflict policy in docs/SECURITY.md.
 *
 *   - Supabase access token: a JWT (`header.payload.signature`), verified, never trusted.
 *   - Anonymous session:      `ods_` + 43 base64url characters (256 bits of CSPRNG output).
 *   - API key:                `odk_` + 8 base32 characters (public prefix) + `_` + 43 base64url.
 *
 * Only the plaintext form appears here. Hashing lives beside each caller's storage code, and the
 * database never holds anything but a SHA-256 hex digest (or, for API keys, nothing but the
 * digest and the public prefix).
 */

export const AUTHORIZATION_HEADER = 'authorization';
export const API_KEY_HEADER = 'x-api-key';
/**
 * Share token, as a header rather than a path segment.
 *
 * A bearer credential in a URL leaks into access logs, `Referer` headers and browser history. The
 * resolution endpoint therefore accepts the token in this header or in its request body, and the
 * content endpoint (Phase 2) will use the same header.
 */
export const SHARE_TOKEN_HEADER = 'x-share-token';

/**
 * An anonymous session credential presented alongside a *different* credential.
 *
 * `Authorization` can only carry one credential, and a request that carried two would be refused
 * as ambiguous (see the conflict policy in docs/SECURITY.md). Bringing an anonymous session's
 * resources into an account is the one operation that genuinely needs both at once, so the
 * anonymous half travels in this header: the caller proves which account it is (as always, from
 * the credential) and, separately, that it holds the session being migrated. Nothing about the
 * account is ever read from the body.
 */
export const ANONYMOUS_CREDENTIAL_HEADER = 'x-anonymous-credential';

/** Prefix of an anonymous session credential. Named in the `anonymous_sessions` table comment. */
export const ANONYMOUS_SESSION_CREDENTIAL_PREFIX = 'ods_';

/** Prefix of an API key. `api_keys.key_prefix` stores this plus 8 base32 characters. */
export const API_KEY_PREFIX = 'odk_';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
/** Base64url length of 32 bytes: the secret half of every bearer credential here. */
const OPAQUE_SECRET_LENGTH = 43;
const KEY_PREFIX_SUFFIX_LENGTH = 8;
const SECRET_PATTERN_SOURCE = `[A-Za-z0-9_-]{${OPAQUE_SECRET_LENGTH}}`;

export const ANONYMOUS_SESSION_CREDENTIAL_PATTERN = new RegExp(`^ods_${SECRET_PATTERN_SOURCE}$`);
export const API_KEY_PREFIX_PATTERN = /^odk_[0-9a-hjkmnp-tv-z]{8}$/;

/**
 * An API key, captured as its two halves.
 *
 * The separators are anchored explicitly rather than found with `lastIndexOf('_')`: the secret
 * half is base64url, so it may itself contain `_`. Splitting on the wrong underscore would either
 * reject a valid key or — worse — hand the lookup a prefix that belongs to another key.
 */
const API_KEY_PREFIX_SOURCE = 'odk_[0-9a-hjkmnp-tv-z]{8}';
const API_KEY_CAPTURE = new RegExp(`^(${API_KEY_PREFIX_SOURCE})_(${SECRET_PATTERN_SOURCE})$`);
export const API_KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX_SOURCE}_${SECRET_PATTERN_SOURCE}$`);

export type CredentialKind = 'supabase_access_token' | 'anonymous_session' | 'api_key' | 'unknown';

/**
 * Classifies a presented credential by shape only.
 *
 * Classification is routing, not authentication: the value is still verified by the path it is
 * routed to, and an `unknown` result becomes an authentication failure rather than a fallback.
 */
export function classifyCredential(value: string): CredentialKind {
  const trimmed = value.trim();
  if (trimmed === '') return 'unknown';
  if (ANONYMOUS_SESSION_CREDENTIAL_PATTERN.test(trimmed)) return 'anonymous_session';
  if (API_KEY_PATTERN.test(trimmed)) return 'api_key';
  if (looksLikeJwt(trimmed)) return 'supabase_access_token';
  return 'unknown';
}

/** Three non-empty dot-separated segments, each base64url with a JSON-looking header segment. */
function looksLikeJwt(value: string): boolean {
  const segments = value.split('.');
  if (segments.length !== 3) return false;
  return segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

/** A fresh anonymous session credential. Hash it before storing; the plaintext is shown once. */
export function newAnonymousSessionCredential(): string {
  return `${ANONYMOUS_SESSION_CREDENTIAL_PREFIX}${newOpaqueToken()}`;
}

export interface ApiKeyMaterial {
  /** The full key, shown to the owner exactly once. */
  readonly key: string;
  /** The public half, safe to display, log and index: `odk_XXXXXXXX`. */
  readonly keyPrefix: string;
}

export function newApiKeyMaterial(): ApiKeyMaterial {
  const keyPrefix = `${API_KEY_PREFIX}${newBase32Suffix(KEY_PREFIX_SUFFIX_LENGTH)}`;
  const secret = newOpaqueToken();
  return { key: `${keyPrefix}_${secret}`, keyPrefix };
}

export interface ParsedApiKey {
  readonly keyPrefix: string;
  readonly secret: string;
}

/** Splits a presented API key. Null when it is not one — never a partially-parsed guess. */
export function parseApiKey(value: string): ParsedApiKey | null {
  const match = API_KEY_CAPTURE.exec(value.trim());
  if (match === null) return null;
  const keyPrefix = match[1];
  const secret = match[2];
  if (keyPrefix === undefined || secret === undefined) return null;
  return { keyPrefix, secret };
}

/**
 * The stored digest of a presented credential.
 *
 * Always hashing the whole presented string (prefix included) means the stored digest is not
 * itself a credential: presenting a leaked digest value fails, because its own hash is what is
 * compared. Every credential type in this file uses this one function.
 */
export function credentialDigest(credential: string): Promise<string> {
  return sha256Hex(credential);
}

export const CROCKFORD_ALPHABET = CROCKFORD;
