/**
 * Unpredictable tokens and their hashes.
 *
 * Share links, anonymous deletion tokens and API keys are bearer credentials:
 * possession grants access. They are therefore generated from 256 bits of CSPRNG
 * output and stored ONLY as SHA-256 hashes in the database. A database leak must
 * not hand an attacker working credentials.
 *
 * Hashes are used for lookup, not for password-style key derivation — 256 bits of
 * entropy means no brute-force stretching is required.
 */

const TOKEN_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Creates a URL-safe bearer token (43 characters, 256 bits of entropy). */
export function newOpaqueToken(byteLength: number = TOKEN_BYTES): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of the UTF-8 encoding of `value`, lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(digest);
}

/**
 * SHA-256 of raw bytes, lowercase hex — used for upload integrity checks.
 *
 * Takes `Uint8Array | ArrayBuffer` rather than the DOM `BufferSource` alias so that
 * Node's `Buffer` (typed as `Uint8Array<ArrayBufferLike>`) can be passed directly.
 * The cast is safe: WebCrypto accepts any ArrayBufferView at runtime.
 */
export async function sha256HexOfBytes(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return toHex(digest);
}

/**
 * Constant-time comparison of two strings.
 * Used for bearer tokens and hashes; never use `===` for those.
 */
export function tokensEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
