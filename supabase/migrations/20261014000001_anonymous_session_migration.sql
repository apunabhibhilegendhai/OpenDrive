-- OpenDrive: anonymous-session migration (bringing an anonymous session's resources into an
-- account).
--
-- Builds on 20261010000001_initial_schema.sql, 20261011000001_phase1_identity_ownership_quota.sql
-- and the two 20261012000001 hardening/ceiling migrations. Additive only: no column is dropped, no
-- row is rewritten, and every existing session keeps working exactly as before with all six new
-- columns NULL.
--
-- What this adds is the *record* of where a session's resources went, and that record is what makes
-- the transfer rules enforceable rather than conventional:
--
--   * `migrated_at` + `migrated_to_user_id` are written together, so "this session was migrated" and
--     "it went to this account" cannot disagree. A repeat of the same request is answered from the
--     stored counts (idempotent), and a request from any other account is refused — resources never
--     move between accounts, and ownership is never inferred from a request body.
--   * The recorded counts (`migrated_file_count`, `migrated_bytes`, `migrated_folders`,
--     `migrated_skipped_files`) make a replay answer with the same numbers the first call reported,
--     instead of recomputing them from rows that no longer belong to the session.
--   * A migrated session is necessarily revoked: its credential must stop working the moment its
--     resources belong to an account, or the same data would have two owners.
--
-- Note that migration moves OWNERSHIP, not bytes: `storage_objects` rows and their opaque provider
-- references are untouched, and `files.id` never changes. The generated `owner_key` columns on
-- files, folders, usage_counters and quota_reservations follow the owner columns automatically.
--
-- Verification status: executed against the self-hosted instance on 2026-10-14 (PostgreSQL 17.6)
-- as `104-opendrive-anonymous-session-migration.sql`, together with 105 and 106. The invariants it
-- introduces were then asserted there by supabase/tests/live/70_anonymous_migration_live.sql — 33
-- checks covering every column, the consistency constraint (each invalid combination refused), the
-- foreign key that protects the receiving account, and a full transfer of a session's resources —
-- all inside a block that rolls back. `pnpm verify:db` still runs the same schema through the
-- psql-based suite in supabase/tests where a local PostgreSQL server is available.

-- ---------------------------------------------------------------------------
-- Anonymous sessions: the migration record
-- ---------------------------------------------------------------------------

alter table anonymous_sessions
  add column migrated_at timestamptz,
  -- ON DELETE RESTRICT, like files and folders: the record of who received a session's resources
  -- must survive, so a profile that received one is not silently deletable.
  add column migrated_to_user_id uuid references profiles (id) on delete restrict,
  add column migrated_file_count integer check (migrated_file_count is null or migrated_file_count >= 0),
  add column migrated_bytes bigint check (migrated_bytes is null or migrated_bytes >= 0),
  add column migrated_folders integer check (migrated_folders is null or migrated_folders >= 0),
  add column migrated_skipped_files integer check (migrated_skipped_files is null or migrated_skipped_files >= 0);

-- One statement's worth of invariants, so no combination of them can be observed half-written:
--   * migrated iff a target account is recorded;
--   * a migrated session is revoked (the credential stops working when ownership moves);
--   * the counts exist exactly when the record does.
alter table anonymous_sessions add constraint anonymous_sessions_migration_consistency check (
  (migrated_at is null) = (migrated_to_user_id is null)
  and (migrated_at is null or status = 'revoked')
  and (migrated_at is not null
       or (migrated_file_count is null
           and migrated_bytes is null
           and migrated_folders is null
           and migrated_skipped_files is null))
);

comment on column anonymous_sessions.migrated_to_user_id is
  'The account this session''s resources were transferred to. Present with migrated_at, never without it. A second migration of the same session is refused unless it names this account, which is what keeps resources from moving between accounts.';
comment on column anonymous_sessions.migrated_file_count is
  'Files transferred, as reported to the caller. Stored so a repeated request answers with the same numbers instead of recounting rows that are no longer this session''s.';

comment on table anonymous_sessions is
  'Anonymous upload identity. A session is a row here, never a synthetic Supabase auth user. Expiry is evaluated as `now() > expires_at` on every use: an expired session cannot regain access because status alone is never sufficient. Sessions are revoked, not deleted, so their files stay attributable. A session may be migrated into a registered account (migrated_at/migrated_to_user_id), which transfers ownership of its files and folders and revokes the session.';

-- Finding the account a session went to is a rare, operator-shaped read, but the index also keeps
-- the consistency check's write path cheap.
create index anonymous_sessions_migrated_idx
  on anonymous_sessions (migrated_to_user_id)
  where migrated_to_user_id is not null;
