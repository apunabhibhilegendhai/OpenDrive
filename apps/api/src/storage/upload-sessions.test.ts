import { describe, expect, it } from 'vitest';
import { isAppError } from '@opendrive/shared';
import type { Principal, UploadSession } from '@opendrive/shared';
import { UploadSessionStore } from './upload-sessions.js';
import type { UploadSessionRecord } from './upload-sessions.js';

/**
 * The session registry is the piece of the upload engine that must never leak one principal's
 * upload to another, and must never let one principal open unbounded work. Both properties are
 * cheaper to prove here than against a live server.
 *
 * The clock is injected throughout: sessions expire by wall time, and a test that used the real
 * clock would silently sweep everything the moment the calendar moved past its fixtures.
 */

const FIXED_NOW = new Date('2026-01-01T00:00:00Z');
const HOUR = 3600_000;

function clock(start: Date): { now: () => Date; set: (value: Date) => void } {
  let current = start;
  return { now: () => current, set: (value) => (current = value) };
}

const USER: Principal = { kind: 'user', userId: '11111111-1111-1111-1111-111111111111' };
const OTHER_USER: Principal = { kind: 'user', userId: '22222222-2222-2222-2222-222222222222' };

function providerSession(uploadId: string): UploadSession {
  return {
    uploadId,
    fileId: 'file_0123456789012345678901234a',
    providerId: 'memory-test',
    state: 'initiated',
    partSizeBytes: 1024,
    expectedParts: 2,
    providerSessionRef: null,
    expiresAt: null,
  };
}

function record(
  uploadId: string,
  principal: Principal,
  overrides: Partial<UploadSessionRecord> = {},
): UploadSessionRecord {
  const ownerKey = UploadSessionStore.ownerKeyFor(principal);
  return {
    uploadId,
    fileId: 'file_0123456789012345678901234a',
    ownerKey,
    principal,
    reservationId: 'resv_0123456789012345678901234a',
    providerSession: providerSession(uploadId),
    declaredSizeBytes: 2048,
    partSizeBytes: 1024,
    deletionTokenHash: null,
    createdAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + HOUR),
    ...overrides,
  };
}

describe('UploadSessionStore', () => {
  it('returns a session to its owner and reports it absent for anyone else', () => {
    const store = new UploadSessionStore({
      maxActiveSessionsPerPrincipal: 3,
      now: () => FIXED_NOW,
    });
    const ownerKey = UploadSessionStore.ownerKeyFor(USER);
    store.create(record('upl_0123456789012345678901234a', USER));

    const mine = store.get('upl_0123456789012345678901234a', ownerKey);
    expect(mine?.record.uploadId).toBe('upl_0123456789012345678901234a');

    const theirs = store.get(
      'upl_0123456789012345678901234a',
      UploadSessionStore.ownerKeyFor(OTHER_USER),
    );
    // Not "forbidden": an upload that belongs to somebody else is indistinguishable from one that
    // does not exist, so the same value comes back for both.
    expect(theirs).toBeNull();
  });

  it('reports an unknown session as absent', () => {
    const store = new UploadSessionStore({
      maxActiveSessionsPerPrincipal: 3,
      now: () => FIXED_NOW,
    });
    expect(store.get('upl_0123456789012345678901234a', 'user:x')).toBeNull();
  });

  it('counts open sessions and refuses one beyond the per-principal maximum', () => {
    const store = new UploadSessionStore({
      maxActiveSessionsPerPrincipal: 2,
      now: () => FIXED_NOW,
    });
    const ownerKey = UploadSessionStore.ownerKeyFor(USER);
    store.create(record('upl_0123456789012345678901234a', USER));
    store.create(record('upl_0123456789012345678901234b', USER));
    expect(store.activeCountFor(ownerKey)).toBe(2);

    expect(() => store.assertCapacity(ownerKey)).toThrowError();
    try {
      store.assertCapacity(ownerKey);
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (isAppError(error)) expect(error.code).toBe('RATE_LIMITED');
    }

    // A different principal is unaffected by the first one's limit.
    expect(() => store.assertCapacity(UploadSessionStore.ownerKeyFor(OTHER_USER))).not.toThrow();
  });

  it('frees capacity once a session reaches a terminal state, but keeps it readable', () => {
    const store = new UploadSessionStore({
      maxActiveSessionsPerPrincipal: 1,
      now: () => FIXED_NOW,
    });
    const ownerKey = UploadSessionStore.ownerKeyFor(USER);
    const uploadId = 'upl_0123456789012345678901234a';
    store.create(record(uploadId, USER));

    store.finish(uploadId, 'finalized');

    expect(store.activeCountFor(ownerKey)).toBe(0);
    expect(() => store.assertCapacity(ownerKey)).not.toThrow();
    // The status route can still report how the upload ended.
    expect(store.get(uploadId, ownerKey)?.state).toBe('finalized');
  });

  it('records received parts and moves the session to in_progress', () => {
    const store = new UploadSessionStore({
      maxActiveSessionsPerPrincipal: 1,
      now: () => FIXED_NOW,
    });
    const ownerKey = UploadSessionStore.ownerKeyFor(USER);
    const uploadId = 'upl_0123456789012345678901234a';
    store.create(record(uploadId, USER));
    expect(store.get(uploadId, ownerKey)?.state).toBe('initiated');

    store.markPartReceived(uploadId, 2);
    store.markPartReceived(uploadId, 1);
    store.markPartReceived(uploadId, 2);

    const view = store.get(uploadId, ownerKey);
    expect(view?.state).toBe('in_progress');
    expect([...(view?.partsReceived ?? [])].sort()).toEqual([1, 2]);
  });

  it('drops sessions past their expiry', () => {
    const time = clock(FIXED_NOW);
    const store = new UploadSessionStore({
      maxActiveSessionsPerPrincipal: 5,
      now: time.now,
    });
    const ownerKey = UploadSessionStore.ownerKeyFor(USER);
    const uploadId = 'upl_0123456789012345678901234a';
    store.create(record(uploadId, USER, { expiresAt: new Date(FIXED_NOW.getTime() + 30 * 60_000) }));
    expect(store.get(uploadId, ownerKey)).not.toBeNull();

    time.set(new Date(FIXED_NOW.getTime() + 2 * HOUR));
    expect(store.get(uploadId, ownerKey)).toBeNull();
    expect(store.activeCountFor(ownerKey)).toBe(0);
  });
});
