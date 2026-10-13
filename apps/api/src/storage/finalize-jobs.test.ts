import { describe, expect, it } from 'vitest';
import { FinalizeJobStore } from './finalize-jobs.js';

/** A promise the test settles by hand, so the in-flight window is observable. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FinalizeJobStore', () => {
  it('runs the job once and reports it done', async () => {
    const store = new FinalizeJobStore();
    let runs = 0;
    const gate = deferred();
    const reservation = store.reserve('u1', async () => {
      runs += 1;
      await gate.promise;
    });

    expect(reservation.state).toBe('processing');
    expect(store.status('u1')?.state).toBe('processing');

    gate.resolve();
    await reservation.settled;
    expect(store.status('u1')?.state).toBe('done');
    expect(runs).toBe(1);
  });

  it('joins an in-flight attempt instead of starting a second send', async () => {
    const store = new FinalizeJobStore();
    let runs = 0;
    const gate = deferred();
    const first = store.reserve('u1', async () => {
      runs += 1;
      await gate.promise;
    });
    const second = store.reserve('u1', async () => {
      runs += 1;
    });

    expect(second.state).toBe('processing');
    gate.resolve();
    await first.settled;
    await second.settled;
    expect(runs).toBe(1);
    expect(store.status('u1')?.state).toBe('done');
  });

  it('records a failure and allows a fresh attempt after resetIfFailed', async () => {
    const store = new FinalizeJobStore();
    const boom = new Error('boom');
    const first = store.reserve('u1', async () => {
      throw boom;
    });
    await first.settled;

    const failed = store.status('u1');
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toBe(boom);

    store.resetIfFailed('u1');
    expect(store.status('u1')).toBeNull();

    let ran = false;
    const retry = store.reserve('u1', async () => {
      ran = true;
    });
    await retry.settled;
    expect(ran).toBe(true);
    expect(store.status('u1')?.state).toBe('done');
  });

  it('never resets a successful job', async () => {
    const store = new FinalizeJobStore();
    const done = store.reserve('u1', async () => undefined);
    await done.settled;

    store.resetIfFailed('u1');
    expect(store.status('u1')?.state).toBe('done');

    store.clear('u1');
    expect(store.status('u1')).toBeNull();
  });

  it('reports null for an upload that was never reserved', () => {
    const store = new FinalizeJobStore();
    expect(store.status('never-seen')).toBeNull();
  });
});
