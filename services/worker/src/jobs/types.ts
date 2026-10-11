import type { z } from 'zod';

/**
 * Background job contracts.
 *
 * Every job is declared with a Zod payload schema and an explicit implementation state.
 * A job that is declared but not implemented dispatches to a `not_implemented` outcome —
 * it must never look like it ran. This keeps the queue honest: operators can see which
 * work exists as a contract and which work actually happens.
 *
 * The payload type parameter is intentionally absent: handlers receive a parsed `unknown`
 * and narrow it themselves, so a heterogeneous registry stays type-safe without casts.
 */

export type JobName =
  | 'scan.requested'
  | 'retention.expire_uploads'
  | 'retention.expire_shares'
  | 'maintenance.cleanup_orphans'
  | 'moderation.apply_takedown';

export type ImplementationState = 'declared' | 'implemented';

export interface JobContext {
  /** Stable id for correlating logs across a retry chain. */
  readonly jobId: string;
  readonly attempt: number;
  log: (message: string, fields?: Record<string, string | number | boolean>) => void;
}

export interface JobDefinition {
  readonly name: JobName;
  /** Zod schema describing the queue payload. */
  readonly payload: z.ZodTypeAny;
  /** Phase in which the implementation is expected. */
  readonly phase: string;
  readonly state: ImplementationState;
  readonly summary: string;
  /** Present only when `state` is 'implemented'. */
  readonly run?: (payload: unknown, context: JobContext) => Promise<void>;
}

export type JobOutcome =
  | { kind: 'succeeded'; jobId: string; name: JobName; durationMs: number }
  | { kind: 'failed'; jobId: string; name: JobName; error: string; retryable: boolean }
  | { kind: 'not_implemented'; jobId: string; name: JobName; phase: string }
  | { kind: 'rejected'; jobId: string; name: JobName; reason: string };

export interface EnqueuedJob {
  readonly id: string;
  readonly name: JobName;
  readonly payload: unknown;
  readonly attempt: number;
}

export interface JobLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
