/**
 * TEMPORARY diagnostic for the flaky pagination walk.
 *
 * Loops the exact five-row, limit-2 keyset walk many times, and on any round where the API's
 * pages do not cover every fixture it logs the direct database view alongside every page. This
 * file is not part of the suite's permanent intent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createAccount, createFileFixture, createHarness, type Harness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

describe('pagination diagnosis', () => {
  it('reproduces the five-row keyset walk over many rounds', async () => {
    const failures: unknown[] = [];

    for (let round = 0; round < 25; round += 1) {
      const account = await createAccount(h.sql);
      const created: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        created.push(
          await createFileFixture(h.sql, {
            owner: { kind: 'user', userId: account.userId },
            filename: `diag-${round}-${index}.bin`,
          }),
        );
      }

      const rawRows = (await h.sql`
        select id,
               to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt"
        from files
        where owner_key = ${account.userId} and deleted_at is null
        order by created_at desc, id desc
      `) as unknown as { id: string; cursorAt: string }[];

      const pages: { url: string; status: number; ids: string[]; nextCursor: string | null }[] = [];
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const url: string =
          cursor === null ? '/api/v1/files?limit=2' : `/api/v1/files?limit=2&cursor=${cursor}`;
        const response = await h.server.inject({
          method: 'GET',
          url,
          headers: bearer(account.token),
        });
        const body: { items?: { id: string }[]; nextCursor?: string | null } = response.json();
        const ids = (body.items ?? []).map((item) => item.id);
        pages.push({ url, status: response.statusCode, ids, nextCursor: body.nextCursor ?? null });
        seen.push(...ids);
        cursor = body.nextCursor ?? null;
        if (cursor === null) break;
      }

      const missing = created.filter((id) => !seen.includes(id));
      if (missing.length > 0 || rawRows.length !== 5) {
        failures.push({
          round,
          dbCount: rawRows.length,
          created,
          rawRows,
          seen,
          missing,
          pages,
        });
      }
    }

    if (failures.length > 0) {
      console.log('PAGINATION-DIAGNOSIS', JSON.stringify(failures, null, 2));
    }
    expect(
      failures.length,
      `${failures.length} failing round(s); see PAGINATION-DIAGNOSIS above`,
    ).toBe(0);
  }, 120_000);
});
