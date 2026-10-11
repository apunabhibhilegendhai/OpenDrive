import { z } from 'zod';
import { AppError } from '../errors.js';

/**
 * The authoritative file lifecycle.
 *
 * The `file_status` PostgreSQL enum fixes *which* states exist; this table fixes which moves
 * between them are legal. Both are needed: the enum rejects a typo, this rejects a wrong move —
 * and a wrong move is exactly how a pending, failed or quarantined file ends up downloadable.
 * The API calls {@link assertTransition} before every state change, and
 * {@link isServable} before every byte of a file is handed to a caller.
 *
 * Migration: supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql
 * (renames `pending` -> `pending_upload`, `available` -> `ready`, adds `uploaded`, `deleting`).
 */

export const FILE_STATES = [
  /** Metadata row exists, no bytes have arrived. */
  'pending_upload',
  /** Bytes arriving; a quota hold covers them. */
  'uploading',
  /** Bytes are durable but not yet cleared for serving. */
  'uploaded',
  /** Scanner is examining the stored bytes. */
  'scanning',
  /** Durable, cleared, and servable. The only state a reader may ever receive bytes from. */
  'ready',
  /** Upload or storage failed. Nothing is servable; the row may be retried or deleted. */
  'failed',
  /** Soft-deleted; the storage cleanup job has not confirmed the object is gone yet. */
  'deleting',
  /** Terminal. */
  'deleted',
  /** Refused: infected, scan error, or an upheld abuse report. */
  'quarantined',
] as const;

export type FileState = (typeof FILE_STATES)[number];

export const fileStateSchema = z.enum(FILE_STATES);

/**
 * Transitions, keyed by origin. A target that is absent from the list is refused — including
 * every transition out of `deleted`, which is terminal by design: resurrection would make a
 * deletion mean nothing.
 */
const TRANSITIONS: Readonly<Record<FileState, readonly FileState[]>> = {
  pending_upload: ['uploading', 'failed', 'deleted'],
  uploading: ['uploaded', 'failed', 'deleted'],
  // `uploaded` fans out: scanning when a scanner is configured, straight to `ready` when the
  // operator has turned scanning off. `canTransition` picks between them.
  uploaded: ['scanning', 'ready', 'quarantined', 'failed', 'deleting', 'deleted'],
  scanning: ['uploaded', 'ready', 'quarantined', 'failed', 'deleted'],
  ready: ['scanning', 'quarantined', 'deleting', 'deleted'],
  // A quarantined file may be cleared again, but only by going back through a state decision
  // (`ready` directly, or a re-scan) — never by editing the row into `ready` silently.
  quarantined: ['scanning', 'ready', 'deleting', 'deleted'],
  // Retrying a failed upload restarts the same file row rather than leaving a trail of them.
  failed: ['pending_upload', 'deleted'],
  deleting: ['deleted'],
  deleted: [],
};

export interface LifecycleOptions {
  /**
   * Whether malware scanning is enabled for this deployment. When it is disabled, `uploaded`
   * is servable and `scanning` is unreachable; when it is enabled, `ready` is the only
   * servable state.
   */
  readonly scanningEnabled: boolean;
}

/** The states a file in `state` may move to under `options`. */
export function allowedTransitions(
  state: FileState,
  options: LifecycleOptions,
): readonly FileState[] {
  const targets = TRANSITIONS[state];
  if (options.scanningEnabled) {
    // Disabling is not the only direction that matters: with scanning on, `uploaded` may not
    // jump straight to `ready` (that would be an unscanned file served as if it were clean).
    return targets.filter((target) => !(state === 'uploaded' && target === 'ready'));
  }
  return targets.filter((target) => target !== 'scanning');
}

export function canTransition(from: FileState, to: FileState, options: LifecycleOptions): boolean {
  return allowedTransitions(from, options).includes(to);
}

/**
 * Throws a `CONFLICT` (409) when the transition is not allowed. The message names states only:
 * it is shown to the caller, so it must not leak paths, provider references or scan verdicts.
 */
export function assertTransition(from: FileState, to: FileState, options: LifecycleOptions): void {
  if (canTransition(from, to, options)) return;
  throw new AppError('CONFLICT', {
    detail: `A file in state "${from}" cannot move to "${to}".`,
    context: { from, to, scanningEnabled: options.scanningEnabled },
  });
}

export function isTerminalState(state: FileState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * Whether bytes may leave the server for a file in this state.
 *
 * This is the single gate for "is it downloadable". A caller that has proved ownership of a
 * `pending_upload`, `failed`, `quarantined`, `deleting` or `deleted` file still gets nothing:
 * knowing an id — or owning the row — is not the same as having a servable object.
 */
export function isServable(state: FileState, options: LifecycleOptions): boolean {
  if (state === 'ready') return true;
  return !options.scanningEnabled && state === 'uploaded';
}

/**
 * Whether the file's bytes count against the owner's storage quota.
 *
 * Mirrors `opendrive_used_storage` in SQL exactly. A `pending_upload` row holds no bytes and an
 * `uploading` row's partial bytes are covered by its reservation; counting either as stored
 * would let an abandoned metadata row consume quota forever and would double-count a live
 * upload. `quarantined` and `deleting` DO count: the bytes are still on disk until cleanup
 * confirms otherwise.
 */
export function countsAsStored(state: FileState): boolean {
  return (
    state !== 'pending_upload' && state !== 'uploading' && state !== 'failed' && state !== 'deleted'
  );
}

export function isDeletedState(state: FileState): boolean {
  return state === 'deleted';
}
