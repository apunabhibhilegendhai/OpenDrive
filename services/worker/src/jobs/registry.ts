import { z } from 'zod';
import type {
  EnqueuedJob,
  JobContext,
  JobDefinition,
  JobLogger,
  JobName,
  JobOutcome,
} from './types.js';

/**
 * Job registry.
 *
 * Responsibilities: hold the declared jobs and their payload contracts, validate incoming
 * payloads, and dispatch them to a handler when one exists. Unknown jobs and invalid
 * payloads are rejected explicitly (a queue full of silently dropped work is worse than a
 * visible rejection).
 */

export class JobRegistry {
  private readonly definitions = new Map<JobName, JobDefinition>();

  register(definition: JobDefinition): this {
    if (this.definitions.has(definition.name)) {
      throw new Error(`Job "${definition.name}" is already registered.`);
    }
    if (definition.state === 'implemented' && definition.run === undefined) {
      throw new Error(`Job "${definition.name}" claims to be implemented but has no handler.`);
    }
    if (definition.state === 'declared' && definition.run !== undefined) {
      throw new Error(
        `Job "${definition.name}" is declared but ships a handler; mark it implemented or remove the handler.`,
      );
    }
    this.definitions.set(definition.name, definition);
    return this;
  }

  names(): JobName[] {
    return [...this.definitions.keys()];
  }

  describe(): { name: JobName; state: JobDefinition['state']; phase: string; summary: string }[] {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      state: definition.state,
      phase: definition.phase,
      summary: definition.summary,
    }));
  }

  has(name: string): name is JobName {
    return this.definitions.has(name as JobName);
  }

  /** Validates a payload against the job's published contract. */
  validate(name: string, payload: unknown): { ok: true } | { ok: false; reason: string } {
    const definition = this.definitions.get(name as JobName);
    if (definition === undefined) {
      return { ok: false, reason: `Unknown job "${name}".` };
    }
    const parsed = definition.payload.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        reason: `Payload for "${name}" is invalid: ${issue?.path.join('.') ?? '(root)'} ${issue?.message ?? 'is invalid'}.`,
      };
    }
    return { ok: true };
  }

  async dispatch(job: EnqueuedJob, logger: JobLogger): Promise<JobOutcome> {
    const definition = this.definitions.get(job.name);
    if (definition === undefined) {
      return {
        kind: 'rejected',
        jobId: job.id,
        name: job.name,
        reason: `Unknown job "${job.name}".`,
      };
    }

    const parsed = definition.payload.safeParse(job.payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        kind: 'rejected',
        jobId: job.id,
        name: job.name,
        reason: `Invalid payload: ${issue?.path.join('.') ?? '(root)'} ${issue?.message ?? 'is invalid'}.`,
      };
    }

    if (definition.state === 'declared' || definition.run === undefined) {
      // No handler exists. Reporting success here would be a lie that hides unimplemented work.
      logger.warn('job not implemented; leaving it for its implementation phase', {
        jobId: job.id,
        name: job.name,
        phase: definition.phase,
      });
      return { kind: 'not_implemented', jobId: job.id, name: job.name, phase: definition.phase };
    }

    const context: JobContext = {
      jobId: job.id,
      attempt: job.attempt,
      log: (message, fields) => logger.info(message, { jobId: job.id, name: job.name, ...fields }),
    };

    const startedAt = Date.now();
    try {
      await definition.run(parsed.data, context);
      return {
        kind: 'succeeded',
        jobId: job.id,
        name: job.name,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const retryable = !(error instanceof NonRetryableJobError);
      logger.error('job failed', {
        jobId: job.id,
        name: job.name,
        attempt: job.attempt,
        retryable,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        kind: 'failed',
        jobId: job.id,
        name: job.name,
        error: error instanceof Error ? error.message : String(error),
        retryable,
      };
    }
  }
}

/** Thrown by a handler when retrying cannot help (bad request, permanently gone). */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableJobError';
  }
}

// ---------------------------------------------------------------------------
// Payload contracts for the declared jobs
// ---------------------------------------------------------------------------

export const jobPayloads = {
  'scan.requested': z.object({
    fileId: z.string().regex(/^file_/),
    storageLocator: z.string().min(1).describe('Opaque provider locator; never a public id.'),
    declaredMimeType: z.string().min(1),
    declaredSizeBytes: z.number().int().positive(),
  }),
  'retention.expire_uploads': z.object({
    olderThan: z.iso.datetime(),
    limit: z.number().int().positive().max(1000).default(100),
  }),
  'retention.expire_shares': z.object({
    now: z.iso.datetime(),
    limit: z.number().int().positive().max(1000).default(500),
  }),
  'maintenance.cleanup_orphans': z.object({
    dryRun: z
      .boolean()
      .default(true)
      .describe('Must be explicitly set to false to delete anything.'),
    olderThan: z.iso.datetime(),
  }),
  'maintenance.edge_cache_evict': z.object({
    now: z.iso.datetime(),
    dryRun: z
      .boolean()
      .default(true)
      .describe('Must be explicitly set to false to evict; eviction already happens in-process.'),
  }),
  'moderation.apply_takedown': z.object({
    reportId: z.string().regex(/^rpt_/),
    fileId: z.string().regex(/^file_/),
    reason: z.enum(['copyright', 'malware', 'illegal_content', 'spam', 'other']),
  }),
} as const;

/**
 * The jobs this platform declares. Every one of them is `declared`: no handler exists yet,
 * and dispatch reports `not_implemented` rather than pretending the work happened.
 */
export const declaredJobs: JobDefinition[] = [
  {
    name: 'scan.requested',
    payload: jobPayloads['scan.requested'],
    phase: 'Phase 4',
    state: 'declared',
    summary:
      'Malware-scan a stored object. Until this exists, a file may not become downloadable when MALWARE_SCAN_ENABLED is true.',
  },
  {
    name: 'retention.expire_uploads',
    payload: jobPayloads['retention.expire_uploads'],
    phase: 'Phase 1',
    state: 'declared',
    summary: 'Abort and release storage for upload sessions that were never finalized.',
  },
  {
    name: 'retention.expire_shares',
    payload: jobPayloads['retention.expire_shares'],
    phase: 'Phase 1',
    state: 'declared',
    summary: 'Mark expired share links as inactive and purge their token hashes.',
  },
  {
    name: 'maintenance.cleanup_orphans',
    payload: jobPayloads['maintenance.cleanup_orphans'],
    phase: 'Phase 2',
    state: 'declared',
    summary: 'Find storage objects with no live metadata row (or the reverse) and reconcile them.',
  },
  {
    name: 'maintenance.edge_cache_evict',
    payload: jobPayloads['maintenance.edge_cache_evict'],
    phase: 'Phase 5',
    state: 'declared',
    summary:
      'Reclaim disk from the edge cache. The API already evicts least-recently-used entries in-process ' +
      'on every write; this job exists only for a future multi-node edge, where eviction must be driven ' +
      'centrally rather than by one process.',
  },
  {
    name: 'moderation.apply_takedown',
    payload: jobPayloads['moderation.apply_takedown'],
    phase: 'Phase 4',
    state: 'declared',
    summary: 'Disable access to a reported file and record the moderation action.',
  },
];

export function createDefaultRegistry(): JobRegistry {
  const registry = new JobRegistry();
  for (const job of declaredJobs) registry.register(job);
  return registry;
}
