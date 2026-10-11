import { z } from 'zod';

/**
 * Visibility and malware-scan vocabulary.
 *
 * Visibility answers "who may be told this resource exists", never "who may read its bytes".
 * A `public` file is still addressed by an unguessable identifier (an id the owner handed out,
 * or a share token); there is no directory that turns a public file into enumerable content.
 * Keeping those two questions apart is what stops "it is public" from becoming a blanket
 * authorization bypass.
 */

export const FILE_VISIBILITIES = ['private', 'public', 'unlisted'] as const;
export type FileVisibility = (typeof FILE_VISIBILITIES)[number];
export const fileVisibilitySchema = z.enum(FILE_VISIBILITIES);

/** Private by default: every read of a private file requires a server-side decision. */
export const DEFAULT_FILE_VISIBILITY: FileVisibility = 'private';

export function isPrivateFile(visibility: FileVisibility): boolean {
  return visibility === 'private';
}

export const SCAN_STATES = [
  /** No scanner has looked at this file: the state of a deployment with scanning disabled. */
  'not_scanned',
  /** Queued for scanning. */
  'pending',
  'clean',
  'infected',
  /** The scanner itself failed. Treated as not-clean: an error is never a pass. */
  'error',
] as const;
export type ScanState = (typeof SCAN_STATES)[number];
export const scanStateSchema = z.enum(SCAN_STATES);

/**
 * A scan verdict only counts as a pass when it is explicitly `clean`. `error` and `not_scanned`
 * are not evidence of safety, so a file whose scan state is unknown must not be served as if it
 * had one.
 */
export function isScanPass(
  scanState: ScanState | null,
  options: { readonly scanningEnabled: boolean },
): boolean {
  if (!options.scanningEnabled) return true;
  return scanState === 'clean';
}

export const SHARE_KINDS = ['public', 'unlisted'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
export const shareKindSchema = z.enum(SHARE_KINDS);

/**
 * Whether a resource may be *listed* to someone who never had its link, given its visibility and
 * the kind of share that exposed it.
 *
 * This is a listing decision only — it grants no read access. Resolution of the bytes is always
 * a separate authorization step (owner identity or a verified share token).
 */
export function isDiscoverable(visibility: FileVisibility, kind: ShareKind): boolean {
  return visibility === 'public' && kind === 'public';
}
