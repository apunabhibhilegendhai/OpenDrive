import type { JobName } from '../jobs/types.js';

/**
 * Queue contract.
 *
 * Chosen semantics (deliberately explicit, because "at-least-once" hides the details):
 * - `enqueue` is idempotent per job id, so a retried producer does not duplicate work.
 * - `dequeue` leases a job for a bounded time. A job that is not acked before the lease
 *   expires becomes visible again and is redelivered with an incremented attempt count.
 * - `ack` removes the job. `nack` makes it visible again, immediately or after a delay,
 *   unless it has exhausted `maxAttempts`, in which case it is dead-lettered rather than
 *   looping forever.
 *
 * Redis is the intended production backend (Phase 2). This interface exists so the worker
 * does not depend on any particular client, and so the semantics above can be tested
 * without a running Redis.
 */

export interface EnqueueOptions {
  /** Milliseconds to wait before the job becomes visible. */
  delayMs?: number;
  maxAttempts?: number;
}

export interface LeasedJob {
  id: string;
  name: JobName;
  payload: unknown;
  attempt: number;
  /** Opaque token proving the lease; required for ack/nack. */
  leaseId: string;
  /** ISO timestamp at which the lease expires and the job becomes visible again. */
  leaseExpiresAt: string;
}

export interface NackOptions {
  retryAfterMs?: number;
  /** Give up immediately: move the job to dead letters instead of retrying. */
  fatal?: boolean;
}

export interface QueueStats {
  visible: number;
  leased: number;
  delayed: number;
  deadLettered: number;
}

export interface DeadLetteredJob {
  id: string;
  name: JobName;
  payload: unknown;
  attempts: number;
  lastError?: string;
}

export interface JobQueue {
  enqueue(
    job: { id: string; name: JobName; payload: unknown },
    options?: EnqueueOptions,
  ): Promise<void>;
  dequeue(options: { leaseMs: number }): Promise<LeasedJob | null>;
  ack(lease: LeasedJob): Promise<void>;
  nack(lease: LeasedJob, options?: NackOptions): Promise<void>;
  stats(): Promise<QueueStats>;
  deadLetters(): Promise<DeadLetteredJob[]>;
}
