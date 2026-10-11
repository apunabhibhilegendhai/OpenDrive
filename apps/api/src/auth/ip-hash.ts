import { createHmac } from 'node:crypto';

/**
 * Hashing client addresses.
 *
 * The database stores `created_ip_hash` for anonymous sessions and `actor_ip_hash` for audit
 * events — never a raw address. That only works if the hash is **keyed**: an unkeyed SHA-256 of an
 * IPv4 address is reversible in seconds (the whole space is 2^32), which would make the column a
 * location log with extra steps.
 *
 * So when no secret is configured the address is not recorded at all. Storing a reversible hash
 * would be worse than storing nothing.
 */

export type IpHasher = (address: string | null | undefined) => string | null;

export function createIpHasher(secret: string | null): IpHasher {
  if (secret === null || secret.trim() === '') {
    return () => null;
  }
  const key = new TextEncoder().encode(secret);
  return (address) => {
    if (address === null || address === undefined || address.trim() === '') return null;
    return createHmac('sha256', key).update(address.trim()).digest('hex');
  };
}

/**
 * Hashes an already-verified email or reporter address with the same keyed construction, so an
 * abuse report can be correlated with a reporter without storing who they are.
 */
export function hashWithSecret(
  secret: string | null,
  value: string | null | undefined,
): string | null {
  if (secret === null || secret.trim() === '' || value === null || value === undefined) return null;
  if (value.trim() === '') return null;
  return createHmac('sha256', new TextEncoder().encode(secret))
    .update(value.trim().toLowerCase())
    .digest('hex');
}
