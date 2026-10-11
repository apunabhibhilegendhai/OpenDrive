import type { Sql } from './client.js';

/**
 * Role safety.
 *
 * Row Level Security in PostgreSQL has one rule that surprises people: a **table owner bypasses its
 * own RLS policies** unless `FORCE ROW LEVEL SECURITY` is set, and a superuser or a role with
 * `rolbypassrls` bypasses every policy. That means a deployment that connects as the wrong role is
 * running with the database half of its security silently switched off — while every policy still
 * exists and every test still passes.
 *
 * This probe reports that state instead of assuming. It never changes anything, it never fails
 * readiness outright (the API still works), and it names the hazard rather than saying "degraded".
 */

export interface RoleSafetyReport {
  readonly status: 'ok' | 'degraded' | 'unavailable';
  readonly detail: string;
  readonly currentUser: string | null;
  readonly hazards: readonly string[];
  /** Public tables that exist without RLS enabled. Should always be empty. */
  readonly tablesWithoutRls: readonly string[];
}

interface RoleRow {
  currentUser: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
  ownsFiles: boolean;
}

interface TableRow {
  tableName: string;
}

export async function inspectDatabaseRole(sql: Sql): Promise<RoleSafetyReport> {
  try {
    const roleRows = await sql<RoleRow[]>`
      select current_user as "currentUser",
             coalesce((select r.rolsuper from pg_roles r where r.rolname = current_user), false) as "isSuperuser",
             coalesce((select r.rolbypassrls from pg_roles r where r.rolname = current_user), false) as "bypassesRls",
             coalesce((select pg_get_userbyid(c.relowner) = current_user
                         from pg_class c
                        where c.oid = to_regclass('public.files')), false) as "ownsFiles"
    `;
    const role = roleRows[0];
    if (role === undefined) {
      return {
        status: 'unavailable',
        detail: 'The database did not report the current role.',
        currentUser: null,
        hazards: [],
        tablesWithoutRls: [],
      };
    }

    const tableRows = await sql<TableRow[]>`
      select c.relname as "tableName"
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relrowsecurity = false
       order by c.relname
    `;
    const tablesWithoutRls = tableRows.map((row) => row.tableName);

    const hazards: string[] = [];
    if (role.isSuperuser) {
      hazards.push('connected as a superuser, which bypasses every RLS policy');
    } else if (role.bypassesRls) {
      hazards.push('the connected role has BYPASSRLS, so RLS is not enforced');
    }
    if (role.ownsFiles) {
      hazards.push(
        'the connected role owns public.files, and a table owner bypasses its own RLS unless FORCE ROW LEVEL SECURITY is set',
      );
    }
    if (tablesWithoutRls.length > 0) {
      hazards.push(`RLS is not enabled on: ${tablesWithoutRls.join(', ')}`);
    }

    if (hazards.length === 0) {
      return {
        status: 'ok',
        detail: `Connected as "${role.currentUser}"; every public table has RLS enabled and the role is subject to it.`,
        currentUser: role.currentUser,
        hazards,
        tablesWithoutRls,
      };
    }

    return {
      status: 'degraded',
      detail: `Connected as "${role.currentUser}". Row Level Security is not enforced for this role: ${hazards.join('; ')}. Application-level authorization is the only remaining control.`,
      currentUser: role.currentUser,
      hazards,
      tablesWithoutRls,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      detail: `The database role could not be inspected: ${error instanceof Error ? error.message : 'unknown error'}`,
      currentUser: null,
      hazards: [],
      tablesWithoutRls: [],
    };
  }
}
