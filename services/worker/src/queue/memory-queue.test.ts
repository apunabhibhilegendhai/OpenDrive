import { describe, expect, it } from 'vitest';
import { MemoryJobQueue } from './memory-queue.js';

/** A controllable clock so lease expiry and delays are tested without sleeping. */
function clock(start = Date.parse('2026-10-10T00:00:00.000Z')) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

const payload = { fileId: 'file_0123456789012345678901234a' };

describe('MemoryJobQueue', () => {
  it('delivers a job once and removes it on ack', async () => {
    const time = clock();
    const queue = new MemoryJobQueue({ now: time.now });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });

    const lease = await queue.dequeue({ leaseMs: 1000 });
    expect(lease?.id).toBe('job-1');
    expect(lease?.attempt).toBe(1);

    // A leased job is not handed out twice.
    expect(await queue.dequeue({ leaseMs: 1000 })).toBeNull();

    await queue.ack(lease!);
    expect(await queue.stats()).toEqual({ visible: 0, leased: 0, delayed: 0, deadLettered: 0 });
  });

  it('is idempotent per job id', async () => {
    const queue = new MemoryJobQueue();
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });
    expect((await queue.stats()).visible).toBe(1);
  });

  it('redelivers a job whose lease expired, with an incremented attempt count', async () => {
    const time = clock();
    const queue = new MemoryJobQueue({ now: time.now });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });

    const first = await queue.dequeue({ leaseMs: 1000 });
    expect(first?.attempt).toBe(1);

    time.advance(1500); // lease expired without an ack
    const second = await queue.dequeue({ leaseMs: 1000 });
    expect(second?.id).toBe('job-1');
    expect(second?.attempt).toBe(2);
    expect(second?.leaseId).not.toBe(first?.leaseId);
  });

  it('accepts an ack that arrives after the lease expired but before redelivery', async () => {
    const time = clock();
    const queue = new MemoryJobQueue({ now: time.now });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });
    const lease = await queue.dequeue({ leaseMs: 1000 });
    time.advance(2000);
    // The work was reported complete and nobody else has taken it: honour the ack.
    await queue.ack(lease!);
    expect(await queue.stats()).toEqual({ visible: 0, leased: 0, delayed: 0, deadLettered: 0 });
  });

  it('ignores a stale ack once the job has been redelivered to another worker', async () => {
    const time = clock();
    const queue = new MemoryJobQueue({ now: time.now });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });
    const first = await queue.dequeue({ leaseMs: 1000 });

    time.advance(2000);
    const second = await queue.dequeue({ leaseMs: 10_000 });
    expect(second?.attempt).toBe(2);

    // The slow first worker reports success late: it must not delete the job the second
    // worker is holding.
    await queue.ack(first!);
    expect(await queue.stats()).toEqual({ visible: 0, leased: 1, delayed: 0, deadLettered: 0 });

    await queue.ack(second!);
    expect(await queue.stats()).toEqual({ visible: 0, leased: 0, delayed: 0, deadLettered: 0 });
  });

  it('honours a retry delay on nack', async () => {
    const time = clock();
    const queue = new MemoryJobQueue({ now: time.now });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });
    const lease = await queue.dequeue({ leaseMs: 1000 });
    await queue.nack(lease!, { retryAfterMs: 5000 });

    expect(await queue.dequeue({ leaseMs: 1000 })).toBeNull();
    expect((await queue.stats()).delayed).toBe(1);

    time.advance(5000);
    const redelivered = await queue.dequeue({ leaseMs: 1000 });
    expect(redelivered?.id).toBe('job-1');
    expect(redelivered?.attempt).toBe(2);
  });

  it('dead-letters a job once it exhausts its attempts instead of looping forever', async () => {
    const queue = new MemoryJobQueue();
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload }, { maxAttempts: 3 });

    for (let round = 0; round < 3; round += 1) {
      const lease = await queue.dequeue({ leaseMs: 10_000 });
      expect(lease).not.toBeNull();
      await queue.nack(lease!);
    }

    expect(await queue.dequeue({ leaseMs: 1000 })).toBeNull();
    const dead = await queue.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(3);
    expect((await queue.stats()).deadLettered).toBe(1);
  });

  it('dead-letters immediately when a handler marks the job fatal', async () => {
    const queue = new MemoryJobQueue();
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload });
    const lease = await queue.dequeue({ leaseMs: 1000 });
    await queue.nack(lease!, { fatal: true });
    expect(await queue.dequeue({ leaseMs: 1000 })).toBeNull();
    expect((await queue.deadLetters())[0]?.lastError).toContain('fatal');
  });

  it('holds back delayed jobs until they are due', async () => {
    const time = clock();
    const queue = new MemoryJobQueue({ now: time.now });
    await queue.enqueue({ id: 'job-1', name: 'scan.requested', payload }, { delayMs: 60_000 });
    expect(await queue.dequeue({ leaseMs: 1000 })).toBeNull();
    time.advance(60_000);
    expect((await queue.dequeue({ leaseMs: 1000 }))?.id).toBe('job-1');
  });
});
