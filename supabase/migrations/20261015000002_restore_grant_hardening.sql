-- Re-assert the privilege hardening from 20261012000001_harden_rls_and_grants.sql.
--
-- Additive in the sense that matters: no column, row, index or policy changes, and nothing a
-- developer or an existing user depends on. What it removes are grants that migration already
-- removed once and that are not supposed to exist at all.
--
-- Why this file exists: it was written after running the assertion suite in
-- supabase/tests/live/ against the self-hosted instance. Row Level Security was exactly where the
-- earlier migrations left it — enabled on every OpenDrive table, including the migration ledger —
-- but **every** client grant had come back: `anon` and `authenticated` each held the full ALL mask
-- (SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES) on profiles, files, folders,
-- shares, storage_objects, upload_sessions, api_keys, audit_events, abuse_reports,
-- moderation_actions, anonymous_sessions, quota_limits, quota_reservations, usage_counters and
-- `_schema_migrations`. `anon` could SELECT the migration ledger.
--
-- RLS still denied the rows, so this was not a data exposure — it was the exact gap 102 closed:
-- a table the API should never touch must not carry a client grant either, because the next policy
-- mistake turns a grant into a read. Something in the infrastructure re-applies the grants after
-- the migrations run (the workflow itself does not; the restore path is the prime suspect), so the
-- revocation is stated again here, idempotently, and the last section re-enables RLS as a guard
-- against the same path disabling it.
--
-- The narrow `authenticated` surface is restored afterwards, matching 102 exactly: those policies
-- were written in the first two migrations, so the grants they need must exist — for `authenticated`
-- only. `anon` gets nothing, because nothing in this product reads `public` tables through
-- PostgREST: the API connects as `opendrive_app`, which is untouched here.
--
-- Verification status: executed against the self-hosted instance as
-- `106-opendrive-restore-grant-hardening.sql`, then re-checked by
-- supabase/tests/live/70_anonymous_migration_live.sql (its privilege assertions) and by a direct
-- `has_table_privilege` query over every OpenDrive table.

-- 1. The migration ledger is bookkeeping, not an API resource. Guarded, because a plain-psql harness
--    and `opendrive_app` never created it and the table may not exist.
do $$
begin
  if to_regclass('public._schema_migrations') is null then
    return;
  end if;
  execute 'revoke all on table public._schema_migrations from anon, authenticated';
  execute 'alter table public._schema_migrations enable row level security';
end
$$;

-- 2. No OpenDrive table is reachable by a client role.
revoke all on table
  public.profiles,
  public.files,
  public.folders,
  public.shares,
  public.storage_objects,
  public.upload_sessions,
  public.api_keys,
  public.audit_events,
  public.abuse_reports,
  public.moderation_actions,
  public.anonymous_sessions,
  public.quota_limits,
  public.quota_reservations,
  public.usage_counters
from anon;

revoke all on table
  public.profiles,
  public.files,
  public.folders,
  public.shares,
  public.storage_objects,
  public.upload_sessions,
  public.api_keys,
  public.audit_events,
  public.abuse_reports,
  public.moderation_actions,
  public.anonymous_sessions,
  public.quota_limits,
  public.quota_reservations,
  public.usage_counters
from authenticated;

-- 3. The `authenticated` surface the RLS policies of the first two migrations were written for, and
--    nothing more: own profile, own rows, own shares. It is a re-grant of what the policies expect,
--    not a widening.
grant select, update on table public.profiles to authenticated;
grant select, delete on table public.files to authenticated;
grant select, delete on table public.folders to authenticated;
grant select on table public.shares to authenticated;

-- 4. RLS stays on, on every OpenDrive table. Enabled state survives a restore, but this costs
--    nothing and makes the intent executable rather than documented.
alter table public.profiles enable row level security;
alter table public.files enable row level security;
alter table public.folders enable row level security;
alter table public.shares enable row level security;
alter table public.storage_objects enable row level security;
alter table public.upload_sessions enable row level security;
alter table public.api_keys enable row level security;
alter table public.audit_events enable row level security;
alter table public.abuse_reports enable row level security;
alter table public.moderation_actions enable row level security;
alter table public.anonymous_sessions enable row level security;
alter table public.quota_limits enable row level security;
alter table public.quota_reservations enable row level security;
alter table public.usage_counters enable row level security;
