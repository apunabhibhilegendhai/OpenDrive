import { newOpaqueToken } from '@opendrive/shared';
import type { JobName } from '../jobs/types.js';
import type {
  DeadLetteredJob,
  EnqueueOptions,
  JobQueue,
  LeasedJob,
  NackOptions,
  QueueStats,
} from './types.js';

/**
 * TEST DOUBLE AND SINGLE-PROCESS RUNNER.
 *
 * `MemoryJobQueue` keeps jobs in the process heap. It is used by tests and by the
 * worker's `--list`/self-check modes. It is explicitly NOT a production queue: state is
 * lost on restart and is not shared between processes, so two workers would double-process
 * the same job. The Redis-backed implementation lands in Phase 2 behind the same interface.
 *
 * What it does model faithfully, because these are the parts that hide bugs:
 * lease expiry, redelivery with attempt counting, at-least-once delivery, and dead letters
 * once `maxAttempts` is exhausted.
 */

const DEFAULT_MAX_ATTEMPTS = 5;

interface QueueEntry {
  id: string;
  name: JobName;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  visibleAt: number;
}

export interface MemoryJobQueueOptions {
  now?: () => number;
}

export class MemoryJobQueue implements JobQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly leases = new Map<string, { jobId: string; expiresAt: number }>();
  private readonly dead: DeadLetteredJob[] = [];
  private readonly now: () => number;

  constructor(options: MemoryJobQueueOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async enqueue(
    job: { id: string; name: JobName; payload: unknown },
    options: EnqueueOptions = {},
  ): Promise<void> {
    // Idempotent per id: a producer that retries must not create duplicate work.
    if (this.entries.has(job.id) || this.dead.some((entry) => entry.id === job.id)) return;
    this.entries.set(job.id, {
      id: job.id,
      name: job.name,
      payload: job.payload,
      attempts: 0,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      visibleAt: this.now() + (options.delayMs ?? 0),
    });
  }

  async dequeue(options: { leaseMs: number }): Promise<LeasedJob | null> {
    this.reapExpiredLeases();
    const now = this.now();
    const due = [...this.entries.values()]
      .filter((entry) => entry.visibleAt <= now && !this.isLeased(entry.id))
      .sort((left, right) => left.visibleAt - right.visibleAt)[0];

    if (due === undefined) return null;

    due.attempts += 1;
    const leaseId = newOpaqueToken(16);
    const expiresAt = now + options.leaseMs;
    this.leases.set(leaseId, { jobId: due.id, expiresAt });
    return {
      id: due.id,
      name: due.name,
      payload: due.payload,
      attempt: due.attempts,
      leaseId,
      leaseExpiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Acknowledges completion.
   *
   * The ack is honoured only while this lease is still the current one for the job:
   * - Ack arriving after the lease expired but before redelivery: accepted. The work was
   *   reported complete, and no other worker has taken it.
   * - Ack arriving after the job was redelivered under a new lease: ignored, so a slow
   *   worker cannot delete a job another worker is actively processing. It is not an
   *   error, because redelivery is expected in an at-least-once system.
   */
  async ack(lease: LeasedJob): Promise<void> {
    const current = this.leases.get(lease.leaseId);
    if (current === undefined || current.jobId !== lease.id) return;
    this.leases.delete(lease.leaseId);
    this.entries.delete(lease.id);
  }

  async nack(lease: LeasedJob, options: NackOptions = {}): Promise<void> {
    this.leases.delete(lease.leaseId);
    const entry = this.entries.get(lease.id);
    if (entry === undefined) return;

    if (options.fatal === true || entry.attempts >= entry.maxAttempts) {
      this.entries.delete(entry.id);
      this.dead.push({
        id: entry.id,
        name: entry.name,
        payload: entry.payload,
        attempts: entry.attempts,
        ...(options.fatal === true ? { lastError: 'marked fatal by the handler' } : {}),
      });
      return;
    }
    entry.visibleAt = this.now() + (options.retryAfterMs ?? 0);
  }

  async stats(): Promise<QueueStats> {
    this.reapExpiredLeases();
    const now = this.now();
    const leased = this.leases.size;
    let visible = 0;
    let delayed = 0;
    for (const entry of this.entries.values()) {
      if (this.isLeased(entry.id)) continue;
      if (entry.visibleAt <= now) visible += 1;
      else delayed += 1;
    }
    return { visible, leased, delayed, deadLettered: this.dead.length };
  }

  async deadLetters(): Promise<DeadLetteredJob[]> {
    return [...this.dead];
  }

  private isLeased(jobId: string): boolean {
    for (const lease of this.leases.values()) {
      if (lease.jobId === jobId) return true;
    }
    return false;
  }

  /** Expired leases return their job to the visible set: at-least-once delivery. */
  private reapExpiredLeases(): void {
    const now = this.now();
    for (const [leaseId, lease] of this.leases) {
      if (lease.expiresAt <= now) this.leases.delete(leaseId);
    }
  }
}
