/**
 * In-process registry of background finalize jobs.
 *
 * Finalizing a large upload is slow: a whole object may have to be reassembled from staged parts
 * and sent to Telegram as one document, which takes minutes — longer than an edge proxy will hold
 * a request open. `POST /uploads/:id/complete` therefore starts the work once and returns `202`
 * while it runs; the client polls the same endpoint, which answers `200` with the file once the job
 * is `done`.
 *
 * The record is process-local for the same reason the upload-session record is (see
 * `upload-sessions.ts`): the staged bytes live in the provider's process. A restart loses both, so
 * persisting one without the other would only pretend to be resumable.
 *
 * Idempotence is the whole point: `reserve` never starts a second send while one is in flight, so
 * polling cannot upload the same object twice.
 */

export type FinalizeJobState = 'processing' | 'done' | 'failed';

export interface FinalizeJobSnapshot {
  readonly state: FinalizeJobState;
  /** The failure, present only when `state` is `failed`. */
  readonly error?: unknown;
}

export interface FinalizeReservation {
  /** `processing` on a fresh or joined attempt; `done`/`failed` when it already settled. */
  readonly state: FinalizeJobState;
  /** Resolves when the attempt settles. Never rejects — read the outcome via `status`. */
  readonly settled: Promise<void>;
}

interface Job {
  state: FinalizeJobState;
  error?: unknown;
}

export class FinalizeJobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly running = new Map<string, Promise<void>>();

  /** Starts `run` unless an attempt is already in flight; a second call joins the first. */
  reserve(uploadId: string, run: () => Promise<void>): FinalizeReservation {
    const existing = this.jobs.get(uploadId);
    if (existing?.state === 'processing') {
      const inFlight = this.running.get(uploadId);
      return { state: 'processing', settled: inFlight ? settledOf(inFlight) : Promise.resolve() };
    }
    const job: Job = { state: 'processing' };
    this.jobs.set(uploadId, job);
    const promise = run().then(
      () => {
        job.state = 'done';
        job.error = undefined;
      },
      (error: unknown) => {
        job.state = 'failed';
        job.error = error;
      },
    );
    this.running.set(uploadId, promise);
    return { state: 'processing', settled: settledOf(promise) };
  }

  status(uploadId: string): FinalizeJobSnapshot | null {
    const job = this.jobs.get(uploadId);
    if (job === undefined) return null;
    return job.error === undefined ? { state: job.state } : { state: job.state, error: job.error };
  }

  /** Forgets a failed attempt so `reserve` may begin a fresh one; a retry is safe and idempotent. */
  resetIfFailed(uploadId: string): void {
    const job = this.jobs.get(uploadId);
    if (job?.state === 'failed') this.clear(uploadId);
  }

  clear(uploadId: string): void {
    this.jobs.delete(uploadId);
    this.running.delete(uploadId);
  }
}

/** A promise that resolves (never rejects) when `promise` settles. */
function settledOf(promise: Promise<void>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}
