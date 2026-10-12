import { describe, expect, it } from 'vitest';
import type { Sql } from './client.js';
import { inspectDatabaseRole } from './role-safety.js';

/**
 * `inspectDatabaseRole` needs a live connection, so these tests drive it with a tag-template stub
 * that answers the two queries it issues: the current role's attributes, then the public tables
 * whose RLS is off. The reconciliation they pin down is D36 — `BYPASSRLS` on the provisioned
 * backend role is expected and disclosed, while a superuser, a table owner and an RLS-less table
 * stay hazards.
 */

interface RoleFixture {
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  readonly ownsFiles: boolean;
}

function stubSql(role: RoleFixture, tablesWithoutRls: readonly string[] = []): Sql {
  let call = 0;
  const query = (): Promise<unknown[]> => {
    call += 1;
    if (call === 1) {
      return Promise.resolve([{ currentUser: 'opendrive_app', ...role }]);
    }
    return Promise.resolve(tablesWithoutRls.map((tableName) => ({ tableName })));
  };
  return query as unknown as Sql;
}

const safeRole: RoleFixture = { isSuperuser: false, bypassesRls: false, ownsFiles: false };

describe('database role safety', () => {
  it('is ok for the provisioned backend role and discloses that it bypasses RLS', async () => {
    const report = await inspectDatabaseRole(stubSql({ ...safeRole, bypassesRls: true }));

    expect(report.status).toBe('ok');
    expect(report.hazards).toEqual([]);
    expect(report.detail).toContain('bypasses RLS');
  });

  it('is ok for a role that is subject to the policies', async () => {
    const report = await inspectDatabaseRole(stubSql(safeRole));

    expect(report.status).toBe('ok');
    expect(report.hazards).toEqual([]);
    expect(report.detail).toContain('subject to the policies');
  });

  it('is degraded for a superuser, which bypasses every policy', async () => {
    const report = await inspectDatabaseRole(stubSql({ ...safeRole, isSuperuser: true }));

    expect(report.status).toBe('degraded');
    expect(report.hazards.join(' ')).toContain('superuser');
  });

  it('is degraded when the role owns public.files', async () => {
    const report = await inspectDatabaseRole(stubSql({ ...safeRole, ownsFiles: true }));

    expect(report.status).toBe('degraded');
    expect(report.hazards.join(' ')).toContain('owns public.files');
  });

  it('is degraded when a public table has RLS disabled', async () => {
    const report = await inspectDatabaseRole(stubSql(safeRole, ['_schema_migrations']));

    expect(report.status).toBe('degraded');
    expect(report.hazards.join(' ')).toContain('_schema_migrations');
  });

  it('is unavailable when the inspection itself fails', async () => {
    const failing = (() => Promise.reject(new Error('permission denied'))) as unknown as Sql;
    const report = await inspectDatabaseRole(failing);

    expect(report.status).toBe('unavailable');
    expect(report.detail).toContain('permission denied');
  });
});
