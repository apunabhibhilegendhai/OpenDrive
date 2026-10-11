# Supabase (metadata store)

OpenDrive uses the existing self-hosted Supabase/PostgreSQL instance for **metadata only**:
profiles, anonymous sessions, files, folders, upload sessions, storage references, shares, API
keys, quota counters and reservations, audit events and moderation records. File contents never
enter this database.

## Migrations

| File                                                 | Adds                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261010000001_initial_schema.sql`                  | The Phase 0 schema: 9 tables, enums, checks, indexes, RLS and the `updated_at` trigger.                                                                                                                                                                                           |
| `20261011000001_phase1_identity_ownership_quota.sql` | Phase 1: `profiles`, `anonymous_sessions`, `folders`, `usage_counters`, `quota_reservations` and `quota_limits`, the `owner_key` generated column, the folder-hierarchy guard, the quota/storage functions, and the `file_status` renames the API depends on. 14 tables in total. |

Migrations are the version-controlled source of truth for schema changes and are applied in
filename order, one transaction per file — exactly how `supabase db push` applies them. The
Phase 1 migration is **not** a rewrite of the Phase 0 one: it adds and alters, so an instance
already carrying Phase 0 can be brought forward without dropping data.

## Verification status

Both migrations are **execution-verified against a throwaway local PostgreSQL instance**.
`tests/run-local.sh` applies the local Supabase shim, then every migration, then runs six
assertion suites, and finally applies the development seed **twice** (a seed a developer cannot
re-run is a seed that gets replaced by an unrecorded manual session). The current run prints
**335 checks**; a failure stops at the first wrong result with the SQLSTATE and message, and
exits non-zero. The same script runs in CI against a `postgres:17` service container, so neither
the schema nor the app-level integration suite can silently drift away from what the tests prove.

| Suite                           | What it establishes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `10_structure.sql`              | 14 tables, RLS on all of them, exactly 7 client policies, no table owned by a client role, every enum's exact shape, the partial unique indexes (one active storage object per file, one held reservation per file, unique folder siblings), the generated `owner_key`, the `updated_at` triggers, and the quota policy table's relative strictness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `20_constraints.sql`            | Every check, unique, foreign-key and enum constraint rejects what it claims to, **naming the constraint it must fail on** (a statement that breaks for an unrelated reason fails the suite), plus the referential actions: cascades and `set null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `30_rls.sql`                    | Behaviour as `authenticated`, `anon` and `service_role`: cross-tenant reads and writes match 0 rows, direct writes by a client role are denied, an `authenticated` request with no JWT claims fails closed, and the service role bypasses RLS as designed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `40_identity_ownership.sql`     | Identity, ownership and placement as the schema expresses them, not as the API promises them: anonymous-session rules (id prefix, unique credential digest, expiry after creation, revocation recorded consistently, and a raw address in `created_ip_hash` refused); profile limits and status transitions; **exactly one principal** on every file and folder, so a resource can never be claimed by both a user and a session; folder trees that compute their own depth, refuse cycles and self-parenting, stop at 32 levels, and cannot cross owners (`folders_parent_same_owner`, `files_folder_same_owner`); sibling names unique per owner and parent — case-insensitively, including two `NULL`-parent roots, and reusable after a soft delete.                                                                                                                               |
| `50_quota.sql`                  | The quota functions `20261011000001` adds, exercised branch by branch as `service_role`: principal validation, suspended and expired principals refused, storage and daily-upload allowances, holds counted towards both usage and the daily allowance so parallel uploads cannot each pass, the legal reservation transitions (held → committed / released / expired), committed usage landing in the counters, and the 2 GiB per-file ceiling that no policy can exceed. Two-connection concurrency lives in `tests/integration`, because one SQL session cannot hold two transactions open at once.                                                                                                                                                                                                                                                                                 |
| `60_secrets_and_invariants.sql` | Schema-wide invariants asserted against the catalogue, so a later migration that quietly adds a `plaintext_token` column or a `bytea` body fails here: every credential-shaped column is a SHA-256 digest (64 lowercase hex) and the only clear-text credential material is the public API-key prefix; nothing stores a raw client address; provider locators exist only in `storage_objects`/`upload_sessions`; **no `bytea` column and no large object**, so file bytes cannot accumulate in Postgres; no `opendrive_*` function is executable by `PUBLIC`, `anon` or `authenticated`; and every table the API's repository layer addresses exists. It also records two known hazards explicitly rather than silently: `files` does **not** use `FORCE ROW LEVEL SECURITY`, so the API must connect as a non-owner role (see `DATABASE_URL` below), and no client role owns a table. |

What is still **not** verified: neither migration has been applied to a real Supabase instance.
The suites run against plain PostgreSQL plus `tests/00_local_supabase_shim.sql`, which
reconstructs the Supabase-provided surface the migrations depend on — the three roles,
`auth.users`, and `auth.uid()` copied from Supabase's own definition. That is a faithful
reconstruction, not the platform, so applying them to a development Supabase project remains a
Phase 1 prerequisite in [../docs/ROADMAP.md](../docs/ROADMAP.md).

### Running the verification

```bash
pnpm db:verify      # requires psql/createdb/dropdb on PATH and a reachable PostgreSQL
```

Configuration: the standard libpq variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`) plus
`VERIFY_DB` (default `opendrive_verify`). The script refuses to touch any database whose name does
not start with `opendrive_verify`, drops and recreates it, and keeps it for inspection when a
check fails (`KEEP_DB=1` keeps it on success too). It never contacts Supabase.

The API itself is verified against these same migrations by a second, separate suite:

```bash
pnpm db:test:integration    # tests/integration: real repositories, real SQL, real HTTP
```

It provisions its own scratch database (`opendrive_verify_integration`), applies the same
migrations, and drives the compiled repositories through Fastify's `inject` — 61 tests covering
identity, ownership, share links and quota reservations.

## Applying them

```bash
# Supabase CLI (recommended: it tracks migration state)
supabase link --project-ref <your-project-ref>
supabase db push

# or directly, in filename order
psql "$SUPABASE_DB_URL" -f supabase/migrations/20261010000001_initial_schema.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql
```

Migrations are not idempotent by design — `create type` and `create table` fail if the objects
already exist. Apply each exactly once, through whichever tool tracks migration state, and add a
new file with a later timestamp for every subsequent change.

Never edit an applied migration: add a new file with a later timestamp. Never run destructive
statements against a database holding real data without a verified backup.

## Security posture encoded in the schema

- **Metadata only.** `storage_objects.provider_ref` is a jsonb locator, so provider-specific
  identifiers stay in one server-side place and never reach an API response. No table has a
  `bytea` column, and `60_secrets_and_invariants.sql` fails the suite if one appears.
- **Bearer credentials are hashed.** `shares.token_hash`, `files.deletion_token_hash`,
  `anonymous_sessions.credential_hash` and `api_keys.key_hash` store SHA-256 only; plaintext is
  returned once, at creation.
- **Private by default.** `files.visibility` defaults to `private`.
- **No client address is stored.** `audit_events.actor_ip_hash`, `created_ip_hash` and the
  reporter hashes store keyed hashes, and only when `IP_HASH_SECRET` is configured — there is no
  raw-address column to fall back to.
- **Ownership is data, not a claim.** `owner_key` is a **stored generated column**, so a caller
  cannot supply it: it is derived from the row's own principal columns, and the API checks it
  against the authenticated principal instead of trusting an id in the request.
- **RLS on every table with no permissive default.** Narrow own-row policies exist for
  `profiles`, `files`, `shares` and `folders`. `storage_objects`, `api_keys`, `audit_events`,
  `anonymous_sessions`, `usage_counters`, `quota_reservations`, `quota_limits`,
  `abuse_reports` and `moderation_actions` have no client policies at all. `anon` has no direct
  table access: public downloads go through the API, which applies share-token checks, expiry
  and counters that a row policy cannot express.
- **Quota is reserved, not counted afterwards.** `quota_reservations` records a hold before
  bytes move, and a partial unique index allows at most one held reservation per file, so two
  concurrent uploads cannot each pass the same allowance check.

## Credentials

`DATABASE_URL`, `SUPABASE_JWKS_URL` (or `SUPABASE_JWT_SECRET`), `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `IP_HASH_SECRET` come from the environment
(see `../.env.example`); names only, never values, belong in this repository. The service-role
key and the database URL are server-side only and must never be shipped to a browser or
committed. The API does not need any of them to start: without them, `/readyz` reports
`postgres: not_configured` and protected routes answer `503` rather than trusting a request.
