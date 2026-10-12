import type { Sql } from './client.js';

/**
 * Role safety.
 *
 * Row Level Security in PostgreSQL has one rule that surprises people: a **table owner bypasses its
 * own RLS policies** unless `FORCE ROW LEVEL SECURITY` is set, and a superuser bypasses every
 * policy. That means a deployment that connects as the wrong role is running with the database half
 * of its security silently switched off — while every policy still exists and every test still
 * passes.
 *
 * `BYPASSRLS` is deliberately *not* one of those hazards. The trusted backend role is supposed to
 * hold it (D20; `supabase/tests/00_local_supabase_shim.sql` records that the API's own queries
 * depend on it), because the API authorizes in code and the policies exist to guard the direct
 * PostgREST path. Treating it as a hazard would report every correctly provisioned deployment as
 * degraded forever. The flag is still disclosed in the `ok` detail, so the state stays visible
 * instead of hidden; a superuser, a table owner and an RLS-less table remain genuine hazards.
 *
 * This probe reports the state instead of assuming it. It never changes anything and it never
 * provisions a role.
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
        detail:
          `Connected as "${role.currentUser}"; every public table has RLS enabled. ` +
          (role.bypassesRls
            ? 'The role bypasses RLS as the trusted backend role, so the policies guard the direct PostgREST path.'
            : 'The role is subject to the policies.'),
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
