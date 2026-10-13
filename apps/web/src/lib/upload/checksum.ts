/**
 * Per-part SHA-256.
 *
 * The API's optional `x-part-checksum-sha256` header makes a corrupt or truncated part fail
 * immediately instead of at finalize. It is only sent when the browser can compute it, so an
 * environment without WebCrypto simply omits the header (the provider still verifies the whole
 * object at finalize, which is the authoritative check).
 */
export function canChecksum(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';
}

export async function sha256HexOfBlob(blob: Blob): Promise<string | undefined> {
  if (!canChecksum()) return undefined;
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}
