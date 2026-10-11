/**
 * Identifier conventions.
 *
 * Every persisted resource gets a prefixed, opaque identifier: `<kind>_<random>`.
 * The prefix makes an id self-describing for logs and support, while the random
 * suffix is generated from 128 bits of CSPRNG output so ids cannot be enumerated.
 *
 * Ids are *not* security tokens. Objects that must be unguessable to grant access
 * (share links, deletion tokens, API keys) use `newOpaqueToken` from `tokens.ts`.
 */

export const ID_KINDS = {
  user: 'usr',
  /** Anonymous session row. Prefix fixed by the `anonymous_sessions` check constraint. */
  anonymousSession: 'sess',
  folder: 'fold',
  file: 'file',
  upload: 'upl',
  share: 'shr',
  apiKey: 'key',
  auditEvent: 'evt',
  abuseReport: 'rpt',
  storageObject: 'sobj',
  quotaReservation: 'resv',
  moderationAction: 'mod',
} as const;

export type IdKind = keyof typeof ID_KINDS;
export type IdPrefix = (typeof ID_KINDS)[IdKind];

// Crockford base32 (no I, L, O, U) keeps ids unambiguous when read aloud or copied by hand.
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** 16 bytes of randomness => 26 base32 characters (130 bits, 128 significant). */
const ID_RANDOM_BYTES = 16;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function toBase32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += CROCKFORD[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) {
    output += CROCKFORD[(buffer << (5 - bits)) & 31];
  }
  return output;
}

export function newId(kind: IdKind): string {
  return `${ID_KINDS[kind]}_${toBase32(randomBytes(ID_RANDOM_BYTES))}`;
}

/**
 * A Crockford base32 string of exactly `characters` characters (5 bits each), drawn from CSPRNG
 * output. Used where a value must match a fixed-length SQL check pattern — an API key's public
 * prefix, for example — rather than a full identifier.
 */
export function newBase32Suffix(characters: number): string {
  if (!Number.isInteger(characters) || characters < 1 || characters > 64) {
    throw new RangeError('base32 suffix length must be an integer between 1 and 64');
  }
  const bytes = Math.ceil((characters * 5) / 8);
  return toBase32(randomBytes(bytes)).slice(0, characters);
}

export interface ParsedId {
  kind: IdKind;
  prefix: IdPrefix;
  suffix: string;
}

const ID_PATTERN = new RegExp(`^(${Object.values(ID_KINDS).join('|')})_([${CROCKFORD}]{26})$`);

export function parseId(value: string): ParsedId | null {
  const match = ID_PATTERN.exec(value);
  if (match === null) return null;
  const prefix = match[1] as IdPrefix;
  const suffix = match[2] as string;
  const kind = (Object.keys(ID_KINDS) as IdKind[]).find((key) => ID_KINDS[key] === prefix);
  if (kind === undefined) return null;
  return { kind, prefix, suffix };
}

export function isIdOfKind(value: string, kind: IdKind): boolean {
  const parsed = parseId(value);
  return parsed !== null && parsed.kind === kind;
}
