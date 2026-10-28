import { AppError, requireOwnerKey } from '@opendrive/shared';
import type { Principal, UploadSession, UploadSessionState } from '@opendrive/shared';

/**
 * In-process upload-session registry.
 *
 * An upload is a stateful, multi-request workflow: `initiate` opens it, `parts` fill it, and
 * `complete`/`abort` finish it. The provider keeps the staged bytes, but it keys them by a session
 * object the API must hand back on every call, so the API needs its own record of which principal
 * owns which session and which quota hold covers it.
 *
 * The record is deliberately process-local. `resumableUpload` is `false` for every provider in this
 * build, which means a restart cannot resume a partially-uploaded object anyway; persisting the
 * API-side record in Postgres would give the *appearance* of resumability without the bytes. When a
 * provider can resume, this is the seam that moves to the database (the schema already reserves
 * `upload_sessions`).
 *
 * Two properties are enforced here rather than at each call site:
 *
 *   * **Ownership.** A session is looked up by id and then matched to the caller's owner key. A
 *     session belonging to somebody else is reported absent, exactly like an unknown id, so the
 *     registry cannot be used to probe for other people's uploads.
 *   * **Bounded concurrency.** One principal may hold at most `maxActiveSessionsPerPrincipal` *open*
 *     sessions. Finished sessions stay readable for their TTL (so `GET /uploads/:id` can report
 *     `finalized`/`aborted`), but they no longer count against the limit.
 */

export type UploadSessionStateName = Extract<
  UploadSessionState,
  'initiated' | 'in_progress' | 'finalized' | 'aborted' | 'failed' | 'expired'
>;

/**
 * API-level state, one step beyond the provider's. `processing` means the client has sent every
 * byte and finalization (assembling a single document, then sending it) is running in the
 * background; the upload is no longer taking parts, but it is not `finalized` yet.
 */
export type UploadProgressState = UploadSessionStateName | 'processing';

export interface UploadSessionRecord {
  readonly uploadId: string;
  readonly fileId: string;
  /** The database `owner_key` the session belongs to. */
  readonly ownerKey: string;
  readonly principal: Principal;
  /** The quota hold created before any bytes moved. */
  readonly reservationId: string;
  /** The provider's session, echoed back on every part/finalize/abort call. */
  readonly providerSession: UploadSession;
  readonly declaredSizeBytes: number;
  readonly partSizeBytes: number;
  /** SHA-256 of the one-time deletion token, for anonymous uploads; null otherwise. */
  readonly deletionTokenHash: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

interface Progress {
  state: UploadProgressState;
  partsReceived: Set<number>;
}

export interface UploadSessionStoreOptions {
  readonly maxActiveSessionsPerPrincipal: number;
  /** Injectable clock, so expiry can be tested without waiting. */
  readonly now?: () => Date;
}

export interface UploadSessionView {
  readonly record: UploadSessionRecord;
  readonly state: UploadProgressState;
  readonly partsReceived: readonly number[];
}

const OPEN_STATES: readonly UploadProgressState[] = ['initiated', 'in_progress'];

export class UploadSessionStore {
  private readonly records = new Map<string, UploadSessionRecord>();
  private readonly progress = new Map<string, Progress>();
  private readonly maxActive: number;
  private readonly now: () => Date;

  constructor(options: UploadSessionStoreOptions) {
    this.maxActive = options.maxActiveSessionsPerPrincipal;
    this.now = options.now ?? (() => new Date());
  }

  /** Derives the registry key for a principal. Throws for an identity that can never own rows. */
  static ownerKeyFor(principal: Principal): string {
    return requireOwnerKey(principal);
  }

  /** Opens a session, refusing when the principal already holds its maximum. */
  create(record: UploadSessionRecord): void {
    this.sweep();
    this.assertCapacity(record.ownerKey);
    this.records.set(record.uploadId, record);
    this.progress.set(record.uploadId, { state: 'initiated', partsReceived: new Set() });
  }

  /**
   * Throws 429 when `ownerKey` already holds its maximum number of open sessions.
   *
   * Exposed separately so `initiate` can refuse *before* it writes a metadata row and a quota hold:
   * checking only at `create` would leave an orphaned row behind on every refused attempt.
   */
  assertCapacity(ownerKey: string): void {
    this.sweep();
    if (this.activeCountFor(ownerKey) >= this.maxActive) {
      throw new AppError('RATE_LIMITED', {
        detail:
          `At most ${this.maxActive} uploads may be open at once for this account. ` +
          'Finish or abort an existing upload before starting another.',
      });
    }
  }

  /** Records that a part was accepted, moving the session to `in_progress`. */
  markPartReceived(uploadId: string, partNumber: number): void {
    const progress = this.progress.get(uploadId);
    if (progress === undefined) return;
    progress.state = 'in_progress';
    progress.partsReceived.add(partNumber);
  }

  /**
   * Marks the byte-transfer phase finished and the finalize phase started. Only meaningful while
   * the session is open; a terminal state is never downgraded to `processing`.
   */
  markProcessing(uploadId: string): void {
    const progress = this.progress.get(uploadId);
    if (progress === undefined) return;
    if (!OPEN_STATES.includes(progress.state)) return;
    progress.state = 'processing';
  }

  /**
   * Returns a session to the byte-transfer phase after a finalize attempt failed.
   *
   * `processing` is only true while a finalize is in flight. When one fails the provider still holds
   * the staged bytes — a missing part may simply not have arrived — so the client must be able to
   * send more before retrying. The state is recomputed from the parts actually received, never
   * remembered from before: it cannot claim progress the provider does not have.
   */
  reopen(uploadId: string): void {
    const progress = this.progress.get(uploadId);
    if (progress === undefined) return;
    if (progress.state !== 'processing') return;
    progress.state = progress.partsReceived.size === 0 ? 'initiated' : 'in_progress';
  }

  /** Records a terminal state. The session remains readable until its TTL passes. */
  finish(uploadId: string, state: 'finalized' | 'aborted' | 'failed'): void {
    const progress = this.progress.get(uploadId);
    if (progress !== undefined) progress.state = state;
  }

  /**
   * Looks a session up for an owner. Expired sessions are swept first, and a session that belongs
   * to another owner is reported as absent — never as forbidden.
   */
  list(ownerKey: string): UploadSessionView[] {
    this.sweep();
    const result: UploadSessionView[] = [];
    for (const [uploadId, record] of this.records) {
      if (record.ownerKey !== ownerKey) continue;
      const progress = this.progress.get(uploadId);
      if (progress === undefined) continue;
      result.push({ record, state: progress.state, partsReceived: [...progress.partsReceived] });
    }
    return result;
  }

  get(uploadId: string, ownerKey: string): UploadSessionView | null {
    this.sweep();
    const record = this.records.get(uploadId);
    const progress = this.progress.get(uploadId);
    if (record === undefined || progress === undefined) return null;
    if (record.ownerKey !== ownerKey) return null;
    return { record, state: progress.state, partsReceived: [...progress.partsReceived] };
  }

  /** Number of *open* sessions for an owner key. Terminal sessions do not count. */
  activeCountFor(ownerKey: string): number {
    let count = 0;
    for (const [uploadId, record] of this.records) {
      if (record.ownerKey !== ownerKey) continue;
      const state = this.progress.get(uploadId)?.state;
      if (state !== undefined && OPEN_STATES.includes(state)) count += 1;
    }
    return count;
  }

  /** Drops every session whose TTL has passed. Called before each lookup and creation. */
  sweep(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [uploadId, record] of this.records) {
      if (record.expiresAt.getTime() <= now) {
        this.records.delete(uploadId);
        this.progress.delete(uploadId);
        removed += 1;
      }
    }
    return removed;
  }
}
