import { createHmac, hkdfSync } from 'node:crypto';
import { tokensEqual } from '@opendrive/shared';

/**
 * Short-lived, single-file preview tokens.
 *
 * A browser element (`<img>`, `<video>`, `<audio>`) cannot attach an `Authorization` header, so a
 * preview grant has to travel in the URL instead. The token is not a random secret stored anywhere:
 * it is an HMAC over the file id and an expiry, so it cannot be forged or replayed against another
 * file, and it stops working at the instant it names. That is what keeps a URL that ends up in a
 * `Referer`, a history entry or a log line from being a durable credential.
 *
 * The signing key is derived with HKDF-SHA256 (distinct `salt`/`info`) from a configured secret, so
 * the preview key and the address-hashing secret are never the same key even when one is configured
 * from the other. `createPreviewSigner` returns `null` when no secret is configured; the preview
 * routes then answer `503` rather than minting tokens under a default key.
 *
 * The token is deliberately not usable as a credential: `verify` checks it against a specific file
 * id, and the content route only accepts it for an inline-servable type, so a leaked token exposes
 * exactly one already-owned file for at most the token's TTL.
 */

export interface PreviewToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface PreviewSigner {
  mint(fileId: string, now: Date): PreviewToken;
  verify(token: string, fileId: string, now: Date): boolean;
}

const KEY_SALT = 'opendrive/preview-url';
const KEY_INFO = 'opendrive/preview-url/v1';
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
 * Builds a signer for one configured secret, or `null` when there is none.
 *
 * A blank secret (an empty placeholder in a `.env` file) is treated as "not configured", matching
 * how every other optional secret in `config.ts` behaves.
 */
export function createPreviewSigner(options: {
  readonly secret: string | null;
  readonly ttlSeconds: number;
}): PreviewSigner | null {
  const secret = options.secret?.trim();
  if (secret === undefined || secret === '') return null;

  const ttlSeconds = options.ttlSeconds;
  const key = deriveKey(secret);
  const mac = (payload: string): string => createHmac('sha256', key).update(payload).digest('hex');

  return {
    mint(fileId, now) {
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
      // The payload is base64url, so it can never contain the `.` that separates it from the MAC.
      const payload = Buffer.from(`${fileId}.${expiresAtSeconds}`, 'utf8').toString('base64url');
      return { token: `${payload}.${mac(payload)}`, expiresAt };
    },

    verify(token, fileId, now) {
      const separator = token.indexOf('.');
      if (separator <= 0 || separator === token.length - 1) return false;
      const payload = token.slice(0, separator);
      const provided = token.slice(separator + 1);
      // Verify the signature over the exact bytes that were signed *before* decoding the payload,
      // so a malformed payload is never parsed on the strength of a forged MAC.
      if (!tokensEqual(mac(payload), provided)) return false;

      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      const dot = decoded.lastIndexOf('.');
      if (dot <= 0) return false;
      if (decoded.slice(0, dot) !== fileId) return false;
      const expiresAtSeconds = Number(decoded.slice(dot + 1));
      if (!Number.isSafeInteger(expiresAtSeconds)) return false;
      // Expiry is compared against the server's clock: the client cannot extend its own grant.
      return expiresAtSeconds > Math.floor(now.getTime() / 1000);
    },
  };
}
