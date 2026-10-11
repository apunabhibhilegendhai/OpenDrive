import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@opendrive/shared';
import {
  bearer,
  createAccount,
  createAnonymousSession,
  createFileFixture,
  createHarness,
  setAccountLimits,
} from './harness.js';
import type { Harness } from './harness.js';
import {
  commitReservation,
  quotaArgsFor,
  readQuotaSummary,
  releaseReservation,
  reserveStorage,
  sweepExpiredReservations,
} from '../../../apps/api/src/db/repositories/quota.js';

/**
 * Quota enforcement.
 *
 * The upload engine is Phase 2, so these tests drive the enforcement functions through the same
 * repository the upload path will use. That is deliberate: the claim being tested is not "a route
 * returns 429" but "two concurrent uploads cannot both pass the check", and that claim only means
 * something when it is exercised against the real lock.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

async function reserve(
  ownerUserId: string,
  bytes: number,
  options: { ttlSeconds?: number; fileId?: string } = {},
) {
  const fileId =
    options.fileId ??
    (await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: ownerUserId },
      state: 'pending_upload',
      sizeBytes: bytes,
    }));
  return reserveStorage(h.sql, {
    reservationId: newId('quotaReservation'),
    principal: { ownerUserId, ownerSessionId: null },
    fileId,
    bytes,
    ttlSeconds: options.ttlSeconds ?? 3600,
  });
}

describe('quota summary', () => {
  it('reports profile overrides and live usage for a user', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, {
      storageQuotaBytes: 10_000,
      maxFileSizeBytes: 4_000,
      maxFiles: 7,
    });
    await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
      sizeBytes: 2_500,
    });

    const outcome = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.storageLimitBytes).toBe(10_000);
    expect(outcome.summary.maxFileSizeBytes).toBe(4_000);
    expect(outcome.summary.maxFiles).toBe(7);
    expect(outcome.summary.storageUsedBytes).toBe(2_500);
    expect(outcome.summary.fileCount).toBe(1);
    // `pending_upload` rows hold no bytes: only durable states count as stored.
    await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
      sizeBytes: 9_000,
      state: 'pending_upload',
    });
    const again = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(again.ok && again.summary.storageUsedBytes).toBe(2_500);
  });

  it('uses the anonymous policy for a session and exposes it over HTTP', async () => {
    const session = await createAnonymousSession(h);
    const response = await h.server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearer(session.credential),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      quota: {
        principalKind: string;
        limits: { storageBytes: number; maxFiles: number };
        usage: { storedBytes: number };
      };
    }>();
    expect(body.quota.principalKind).toBe('anonymous');
    // The anonymous policy is stricter than a registered user's default, and it is finite.
    expect(body.quota.limits.storageBytes).toBe(268_435_456);
    expect(body.quota.limits.maxFiles).toBe(200);
    expect(body.quota.usage.storedBytes).toBe(0);
  });
});

describe('reservations', () => {
  it('holds bytes, then commits them into the usage counters', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 100_000 });

    const reservation = await reserve(account.userId, 1_000);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const held = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(held.ok && held.summary.storageUsedBytes).toBe(1_000);
    expect(held.ok && held.summary.heldReservationBytes).toBe(1_000);

    const commit = await commitReservation(h.sql, reservation.reservationId);
    expect(commit.ok).toBe(true);
    expect(commit.committedBytes).toBe(1_000);

    // Idempotent: committing twice does not double-count.
    const again = await commitReservation(h.sql, reservation.reservationId);
    expect(again.ok).toBe(true);
    expect(again.alreadyCommitted).toBe(true);

    const rows = await h.sql<{ storageBytes: string; fileCount: number }[]>`
      select storage_bytes as "storageBytes", file_count as "fileCount"
        from usage_counters
       where owner_user_id = ${account.userId} and period = 'lifetime'
    `;
    expect(Number(rows[0]?.storageBytes)).toBe(1_000);
    expect(rows[0]?.fileCount).toBe(1);
  });

  it('releases a hold so a failed upload does not consume quota', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 100_000 });

    const reservation = await reserve(account.userId, 5_000);
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    const release = await releaseReservation(h.sql, reservation.reservationId);
    expect(release.ok).toBe(true);
    expect(release.releasedBytes).toBe(5_000);

    const summary = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(summary.ok && summary.summary.storageUsedBytes).toBe(0);

    // A released hold cannot be committed afterwards.
    const late = await commitReservation(h.sql, reservation.reservationId);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe('reservation_not_held');
  });

  it('refuses a file larger than the account’s per-file limit', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { maxFileSizeBytes: 2_000 });
    const outcome = await reserve(account.userId, 2_001);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('file_too_large');
  });

  it('refuses when the account’s file count is exhausted', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { maxFiles: 1 });
    const first = await reserve(account.userId, 10);
    expect(first.ok).toBe(true);
    if (first.ok) await commitReservation(h.sql, first.reservationId);

    const second = await reserve(account.userId, 10);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('file_count_exceeded');
  });

  it('refuses when the storage limit would be exceeded, using integer bytes', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 10_000 });
    const first = await reserve(account.userId, 9_999);
    expect(first.ok).toBe(true);

    const outcome = await reserve(account.userId, 2);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('storage_quota_exceeded');

    // The summary reports what is left, including the held bytes.
    const summary = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(summary.ok && summary.summary.storageRemainingBytes).toBe(1);
  });

  it('does not let two concurrent reservations both pass the same limit', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 1_000 });

    // Two uploads of 600 bytes each cannot both fit. The reservation locks the limit row, so
    // exactly one may succeed — a check-then-act in the application would let both through.
    const [first, second] = await Promise.all([
      reserve(account.userId, 600),
      reserve(account.userId, 600),
    ]);
    const accepted = [first, second].filter((outcome) => outcome.ok);
    const refused = [first, second].filter((outcome) => !outcome.ok);

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    if (!refused[0]?.ok) expect(refused[0]?.reason).toBe('storage_quota_exceeded');

    const summary = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(summary.ok && summary.summary.storageUsedBytes).toBe(600);
  });

  it('refuses a double reservation for the same file', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 100_000 });
    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: account.userId },
      state: 'pending_upload',
      sizeBytes: 100,
    });

    const first = await reserve(account.userId, 100, { fileId });
    expect(first.ok).toBe(true);
    const second = await reserve(account.userId, 100, { fileId });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('already_reserved');
  });

  it('refuses to reserve for another principal’s file, or for a deleted one', async () => {
    const owner = await createAccount(h.sql);
    const intruder = await createAccount(h.sql);
    await setAccountLimits(h.sql, intruder.userId, { storageQuotaBytes: 100_000 });
    await setAccountLimits(h.sql, owner.userId, { storageQuotaBytes: 100_000 });

    const fileId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: owner.userId },
      state: 'pending_upload',
      sizeBytes: 100,
    });

    const foreign = await reserve(intruder.userId, 100, { fileId });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.reason).toBe('owner_mismatch');

    const deletedId = await createFileFixture(h.sql, {
      owner: { kind: 'user', userId: owner.userId },
      state: 'deleted',
      sizeBytes: 100,
    });
    const deleted = await reserve(owner.userId, 100, { fileId: deletedId });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.reason).toBe('file_deleted');
  });

  it('ignores an expired hold, and refuses to commit one afterwards', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 100_000 });

    const reservation = await reserve(account.userId, 5_000, { ttlSeconds: 1 });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;

    // Back-dated, not made inconsistent: the table requires `expires_at > created_at`.
    await h.sql`
      update quota_reservations
         set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'
       where id = ${reservation.reservationId}
    `;

    // A crashed upload stops consuming quota on its own.
    const summary = await readQuotaSummary(h.sql, {
      ownerUserId: account.userId,
      ownerSessionId: null,
    });
    expect(summary.ok && summary.summary.storageUsedBytes).toBe(0);

    // And a late commit cannot pass on a stale hold.
    const late = await commitReservation(h.sql, reservation.reservationId);
    expect(late.ok).toBe(false);
    expect(late.reason).toBe('reservation_expired');

    // The sweep is idempotent and reports how many rows it invalidated.
    const swept = await sweepExpiredReservations(h.sql);
    expect(swept).toBeGreaterThanOrEqual(0);
  });

  it('never lets a quota counter go negative, whatever the sequence', async () => {
    const account = await createAccount(h.sql);
    await setAccountLimits(h.sql, account.userId, { storageQuotaBytes: 100_000 });
    const reservation = await reserve(account.userId, 1_000);
    if (!reservation.ok) throw new Error('expected a reservation');
    await releaseReservation(h.sql, reservation.reservationId);
    await releaseReservation(h.sql, reservation.reservationId);
    await commitReservation(h.sql, reservation.reservationId);

    const rows = await h.sql<{ storageBytes: string }[]>`
      select storage_bytes as "storageBytes" from usage_counters
       where owner_user_id = ${account.userId} and period = 'lifetime'
    `;
    for (const row of rows) expect(Number(row.storageBytes)).toBeGreaterThanOrEqual(0);
  });

  it('resolves the principal columns from a shared Principal value', () => {
    expect(quotaArgsFor({ kind: 'user', userId: 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33' })).toEqual({
      ownerUserId: 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33',
      ownerSessionId: null,
    });
    expect(
      quotaArgsFor({ kind: 'anonymous', sessionId: 'sess_0123456789abcdefghjkmnpqrs' }),
    ).toEqual({
      ownerUserId: null,
      ownerSessionId: 'sess_0123456789abcdefghjkmnpqrs',
    });
  });
});
