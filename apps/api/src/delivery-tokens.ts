import { createHmac, hkdfSync } from 'node:crypto';
import { tokensEqual } from '@opendrive/shared';

/**
 * Short-lived, single-object delivery tokens (the credential behind a cacheable CDN URL).
 *
 * A `<img>`/`<video>`/`<audio>` cannot attach an `Authorization` header, and a cacheable URL
 * cannot carry a bearer credential that varies per request — so a delivery link has to prove
 * itself from the URL alone. The token is not a random secret stored anywhere: it is an HMAC over
 * the file id, the *object version* and an expiry, so it cannot be forged, cannot be replayed
 * against another file or another version of the same file, and stops working at the instant it
 * names.
 *
 * Binding the token to the object version (`storage_objects.id`) is what makes `immutable` caching
 * safe: a re-uploaded file becomes a new object with a new id, so an old URL — and any byte a cache
 * stored under it — can never serve the wrong bytes. See docs/EDGE-CACHE.md and docs/DECISIONS.md
 * (D45, D46).
 *
 * The signing key is derived with HKDF-SHA256 from the configured secret under its own `salt`/
 * `info`, distinct from the preview key (`opendrive/preview-url/v1`), so a preview token and a
 * delivery token can never be interchanged even when both are configured from one secret.
 * `createDeliverySigner` returns `null` when no secret is configured; the mint route then answers
 * `503` rather than signing under a default key.
 */

export interface DeliveryToken {
  readonly token: string;
  readonly expiresAt: Date;
}

/** What a verified token asserts. The route compares these against the request it is answering. */
export interface DeliveryClaims {
  readonly fileId: string;
  readonly version: string;
  readonly expiresAt: Date;
}

export interface DeliverySigner {
  mint(fileId: string, version: string, now: Date): DeliveryToken;
  /** Returns the claims, or `null` for a malformed, tampered or expired token. */
  verify(token: string, now: Date): DeliveryClaims | null;
}

const KEY_SALT = 'opendrive/delivery-url';
const KEY_INFO = 'opendrive/delivery-url/v1';
const KEY_BYTES = 32;

function deriveKey(secret: string): Buffer {
  const key = hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from(KEY_SALT, 'utf8'),
    Buffer.from(KEY_INFO, 'utf8'),
    KEY_BYTES,
  );
  return Buffer.from(key);
}

/**
 * Builds a signer for one configured secret, or `null` when there is none. A blank secret (an
 * empty placeholder in a `.env` file) is treated as "not configured", matching every other optional
 * secret in `config.ts`.
 */
export function createDeliverySigner(options: {
  readonly secret: string | null;
  readonly ttlSeconds: number;
}): DeliverySigner | null {
  const secret = options.secret?.trim();
  if (secret === undefined || secret === '') return null;

  const ttlSeconds = options.ttlSeconds;
  const key = deriveKey(secret);
  const mac = (payload: string): string => createHmac('sha256', key).update(payload).digest('hex');

  return {
    mint(fileId, version, now) {
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
      // The payload is base64url (no `.`), so the single separator below is unambiguous even though
      // the decoded payload itself is dot-joined.
      const payload = Buffer.from(`${fileId}.${version}.${expiresAtSeconds}`, 'utf8').toString(
        'base64url',
      );
      return { token: `${payload}.${mac(payload)}`, expiresAt };
    },

    verify(token, now) {
      const separator = token.indexOf('.');
      if (separator <= 0 || separator === token.length - 1) return null;
      const payload = token.slice(0, separator);
      const provided = token.slice(separator + 1);
      // Verify the signature over the exact bytes that were signed *before* decoding the payload,
      // so a malformed payload is never parsed on the strength of a forged MAC.
      if (!tokensEqual(mac(payload), provided)) return null;

      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      const parts = decoded.split('.');
      if (parts.length !== 3) return null;
      const [fileId, version, expiresAtRaw] = parts as [string, string, string];
      if (fileId === '' || version === '') return null;
      const expiresAtSeconds = Number(expiresAtRaw);
      if (!Number.isSafeInteger(expiresAtSeconds)) return null;
      // Expiry is compared against the server's clock: the client cannot extend its own grant.
      if (expiresAtSeconds <= Math.floor(now.getTime() / 1000)) return null;
      return { fileId, version, expiresAt: new Date(expiresAtSeconds * 1000) };
    },
  };
}
