import { z } from 'zod';
import { isScanPass, type FileVisibility, type ScanState } from './visibility.js';
import { isServable, type FileState } from './file-states.js';

/**
 * Share-link resolution.
 *
 * A share link is a bearer credential: whoever holds the token is the audience. Resolution must
 * therefore re-check four independent things on every request — the link's own status, its
 * expiry, its download allowance, and the file's current state. Checking only the token is how a
 * link keeps working after it was revoked, or serves a file that has since been quarantined.
 *
 * Every refusal deliberately collapses to the same client-visible answer (404, "not found"), so
 * probing cannot distinguish "revoked" from "expired" from "never existed".
 */

export const SHARE_STATUSES = ['active', 'revoked', 'expired'] as const;
export type ShareStatus = (typeof SHARE_STATUSES)[number];
export const shareStatusSchema = z.enum(SHARE_STATUSES);

/** The share row, as far as resolution is concerned. No token, no hash: those never leave SQL. */
export interface ShareLinkState {
  readonly status: ShareStatus;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
}

/** The file a share points at, as far as resolution is concerned. */
export interface SharedFileState {
  readonly state: FileState;
  readonly visibility: FileVisibility;
  readonly deletedAt: Date | null;
  readonly scanState: ScanState | null;
}

export type ShareRefusalReason =
  | 'link_revoked'
  | 'link_expired'
  | 'link_inactive'
  | 'download_limit_reached'
  | 'file_deleted'
  | 'file_not_servable'
  | 'file_scan_not_clean';

export type ShareResolution =
  | { readonly ok: true; readonly visibility: FileVisibility }
  | { readonly ok: false; readonly reason: ShareRefusalReason };

export interface ShareResolutionOptions {
  readonly now: Date;
  readonly scanningEnabled: boolean;
  /** Downloads already served for this link, when the caller tracks them separately from the row. */
  readonly downloadCount?: number;
}

/**
 * The whole decision, in one place and free of I/O, so it can be reasoned about and tested
 * without a database.
 *
 * Revocation is checked first and is absolute: a revocation timestamp that ever existed makes
 * the link dead, even if the status column says otherwise. Belt and braces on purpose — a
 * single wrong column must not resurrect a revoked link.
 */
export function resolveShareLink(
  link: ShareLinkState,
  file: SharedFileState,
  options: ShareResolutionOptions,
): ShareResolution {
  if (link.revokedAt !== null || link.status === 'revoked') {
    return { ok: false, reason: 'link_revoked' };
  }
  if (link.status === 'expired') {
    return { ok: false, reason: 'link_expired' };
  }
  if (link.expiresAt !== null && link.expiresAt.getTime() <= options.now.getTime()) {
    return { ok: false, reason: 'link_expired' };
  }

  const downloadCount = options.downloadCount ?? link.downloadCount;
  if (link.maxDownloads !== null && downloadCount >= link.maxDownloads) {
    return { ok: false, reason: 'download_limit_reached' };
  }

  // Expiry is a property of the link; the same field on the file is an independent clock.
  if (file.deletedAt !== null) {
    return { ok: false, reason: 'file_deleted' };
  }
  if (!isServable(file.state, { scanningEnabled: options.scanningEnabled })) {
    return { ok: false, reason: 'file_not_servable' };
  }
  if (!isScanPass(file.scanState, { scanningEnabled: options.scanningEnabled })) {
    return { ok: false, reason: 'file_scan_not_clean' };
  }

  return { ok: true, visibility: file.visibility };
}

/**
 * Whether the resolution outcome may be disclosed at all. `false` means the caller must answer
 * exactly as it would for a token that does not exist.
 */
export function isShareRefusalIndistinguishable(reason: ShareRefusalReason): boolean {
  return reason !== 'download_limit_reached';
}

/** A stable, non-secret code for logs and audit events. Never returned to a client verbatim. */
export function shareRefusalAuditAction(reason: ShareRefusalReason): string {
  return `share.denied.${reason}`;
}
