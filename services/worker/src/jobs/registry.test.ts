import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  JobRegistry,
  NonRetryableJobError,
  createDefaultRegistry,
  jobPayloads,
} from './registry.js';
import type { JobLogger, JobName } from './types.js';

function silentLogger(): { logger: JobLogger; warnings: unknown[] } {
  const warnings: unknown[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message, fields) => warnings.push({ message, ...fields }),
      error: () => {},
    },
  };
}

const fileId = 'file_0123456789012345678901234a';

describe('JobRegistry registration rules', () => {
  it('registers every declared job from the default registry', () => {
    const registry = createDefaultRegistry();
    expect(registry.names()).toEqual([
      'scan.requested',
      'retention.expire_uploads',
      'retention.expire_shares',
      'maintenance.cleanup_orphans',
      'maintenance.edge_cache_evict',
      'moderation.apply_takedown',
    ]);
  });

  it('refuses duplicate registrations', () => {
    const registry = new JobRegistry();
    const definition = {
      name: 'scan.requested' as JobName,
      payload: jobPayloads['scan.requested'],
      phase: 'Phase 4',
      state: 'declared' as const,
      summary: 'duplicate',
    };
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow(/already registered/);
  });

  it('refuses an "implemented" job that ships no handler', () => {
    const registry = new JobRegistry();
    expect(() =>
      registry.register({
        name: 'scan.requested',
        payload: jobPayloads['scan.requested'],
        phase: 'Phase 4',
        state: 'implemented',
        summary: 'claims to work',
      }),
    ).toThrow(/no handler/);
  });

  it('refuses a "declared" job that ships a handler', () => {
    const registry = new JobRegistry();
    expect(() =>
      registry.register({
        name: 'scan.requested',
        payload: jobPayloads['scan.requested'],
        phase: 'Phase 4',
        state: 'declared',
        summary: 'contradictory',
        run: async () => {},
      }),
    ).toThrow(/declared but ships a handler/);
  });
});

describe('payload validation', () => {
  it('accepts a payload matching the published schema', () => {
    const registry = createDefaultRegistry();
    expect(
      registry.validate('scan.requested', {
        fileId,
        storageLocator: 'provider/locator',
        declaredMimeType: 'application/pdf',
        declaredSizeBytes: 10,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects unknown jobs and invalid payloads with a reason', () => {
    const registry = createDefaultRegistry();
    const unknown = registry.validate('not.a.job', {});
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain('Unknown job');

    const invalid = registry.validate('scan.requested', { fileId: 'nope' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toContain('invalid');
  });

  it('requires cleanup jobs to opt in explicitly to deletion', () => {
    const registry = createDefaultRegistry();
    expect(
      registry.validate('maintenance.cleanup_orphans', { olderThan: '2026-01-01T00:00:00.000Z' }),
    ).toEqual({ ok: true });
    expect(registry.validate('maintenance.cleanup_orphans', { olderThan: 'not-a-date' }).ok).toBe(
      false,
    );
  });
});

describe('dispatch honesty', () => {
  it('reports not_implemented for declared jobs instead of pretending they ran', async () => {
    const registry = createDefaultRegistry();
    const { logger, warnings } = silentLogger();
    const outcome = await registry.dispatch(
      {
        id: 'job-1',
        name: 'scan.requested',
        payload: {
          fileId,
          storageLocator: 'provider/locator',
          declaredMimeType: 'application/pdf',
          declaredSizeBytes: 10,
        },
        attempt: 1,
      },
      logger,
    );
    expect(outcome.kind).toBe('not_implemented');
    if (outcome.kind === 'not_implemented') expect(outcome.phase).toBe('Phase 4');
    expect(warnings).toHaveLength(1);
  });

  it('rejects unknown jobs and invalid payloads', async () => {
    const registry = createDefaultRegistry();
    const { logger } = silentLogger();
    const unknown = await registry.dispatch(
      { id: 'job-2', name: 'ghost.job' as JobName, payload: {}, attempt: 1 },
      logger,
    );
    expect(unknown.kind).toBe('rejected');

    const invalid = await registry.dispatch(
      { id: 'job-3', name: 'moderation.apply_takedown', payload: { reportId: 'x' }, attempt: 1 },
      logger,
    );
    expect(invalid.kind).toBe('rejected');
    if (invalid.kind === 'rejected') expect(invalid.reason).toContain('Invalid payload');
  });

  it('runs an implemented handler and reports success', async () => {
    const registry = new JobRegistry();
    let received: unknown = null;
    registry.register({
      name: 'retention.expire_shares',
      payload: z.object({ now: z.iso.datetime() }),
      phase: 'Phase 1',
      state: 'implemented',
      summary: 'test-only handler',
      run: async (payload, context) => {
        received = payload;
        context.log('expired shares');
      },
    });
    const { logger } = silentLogger();
    const outcome = await registry.dispatch(
      {
        id: 'job-4',
        name: 'retention.expire_shares',
        payload: { now: '2026-10-10T00:00:00.000Z' },
        attempt: 1,
      },
      logger,
    );
    expect(outcome.kind).toBe('succeeded');
    expect(received).toEqual({ now: '2026-10-10T00:00:00.000Z' });
  });

  it('reports a retryable failure for an unexpected throw and a non-retryable one when declared fatal', async () => {
    const registry = new JobRegistry();
    registry.register({
      name: 'retention.expire_uploads',
      payload: z.object({
        olderThan: z.iso.datetime(),
        limit: z.number().int().positive().default(100),
      }),
      phase: 'Phase 1',
      state: 'implemented',
      summary: 'test-only handler',
      run: async (payload) => {
        const parsed = payload as { olderThan: string };
        if (parsed.olderThan === '2026-01-01T00:00:00.000Z') throw new Error('database is down');
        throw new NonRetryableJobError('nothing to do');
      },
    });

    const { logger } = silentLogger();
    const retryable = await registry.dispatch(
      {
        id: 'job-5',
        name: 'retention.expire_uploads',
        payload: { olderThan: '2026-01-01T00:00:00.000Z' },
        attempt: 1,
      },
      logger,
    );
    expect(retryable.kind).toBe('failed');
    if (retryable.kind === 'failed') {
      expect(retryable.retryable).toBe(true);
      expect(retryable.error).toContain('database is down');
    }

    const fatal = await registry.dispatch(
      {
        id: 'job-6',
        name: 'retention.expire_uploads',
        payload: { olderThan: '2026-02-01T00:00:00.000Z' },
        attempt: 1,
      },
      logger,
    );
    expect(fatal.kind).toBe('failed');
    if (fatal.kind === 'failed') expect(fatal.retryable).toBe(false);
  });
});
