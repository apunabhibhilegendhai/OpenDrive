# Phase 1 report — database, authentication and authorization

Scope of this phase: the metadata schema and migrations, the Postgres repository layer,
Supabase Auth integration, the authorization foundation, quotas, shares, and the automated tests
that prove them. **Not** in scope, and not implemented: the file-transfer engine, the frontend,
malware scanning and deployment. Every route that would move bytes answers `501` and names the
phase that owns it.

Every number in this report comes from a command that was run against this working tree on
2026-10-11. Nothing here is an expectation.

## 1. Files added or modified

### Database

| File                                                                                                                                                | What it is                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql](../supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql) | The Phase 1 migration: `profiles`, `anonymous_sessions`, `folders`, `usage_counters`, `quota_reservations`, `quota_limits`, `owner_key` generated columns, the folder-hierarchy guard, 7 `opendrive_*` functions, and the `file_status` renames. |
| [supabase/tests/40_identity_ownership.sql](../supabase/tests/40_identity_ownership.sql)                                                             | Identity, ownership and placement assertions.                                                                                                                                                                                                    |
| [supabase/tests/50_quota.sql](../supabase/tests/50_quota.sql)                                                                                       | Quota function assertions, branch by branch.                                                                                                                                                                                                     |
| [supabase/tests/60_secrets_and_invariants.sql](../supabase/tests/60_secrets_and_invariants.sql)                                                     | Credential-storage and schema-wide invariants, plus the RLS-role hazards.                                                                                                                                                                        |
| [supabase/seed/development_seed.sql](../supabase/seed/development_seed.sql)                                                                         | Extended to seed profiles, an anonymous session, folders and quota-relevant rows; guarded against a database holding real accounts and safe to re-run.                                                                                           |

The shim, assertion helpers, suites `10`/`20`/`30`, `run-local.sh` and the initial migration came
from Phase 0 and were extended, not replaced.

### Shared contracts

- Added: [credentials.ts](../packages/shared/src/credentials.ts), and the pure domain rules
  [domain/principals.ts](../packages/shared/src/domain/principals.ts),
  [domain/quota.ts](../packages/shared/src/domain/quota.ts),
  [domain/share-links.ts](../packages/shared/src/domain/share-links.ts),
  [domain/file-states.ts](../packages/shared/src/domain/file-states.ts),
  [domain/visibility.ts](../packages/shared/src/domain/visibility.ts),
  [domain/api-keys.ts](../packages/shared/src/domain/api-keys.ts) — with tests for each.
- Modified: [api.ts](../packages/shared/src/api.ts) (identity, session, file, folder, share and
  API-key schemas), [index.ts](../packages/shared/src/index.ts), [ids.ts](../packages/shared/src/ids.ts)
  (session/file/folder prefixes, and a parse fix for secrets containing the separator character).

### API

| Area           | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication | [auth/tokens.ts](../apps/api/src/auth/tokens.ts), [auth/payload.ts](../apps/api/src/auth/payload.ts), [auth/identity.ts](../apps/api/src/auth/identity.ts), [auth/ip-hash.ts](../apps/api/src/auth/ip-hash.ts), [plugins/identity.ts](../apps/api/src/plugins/identity.ts)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Authorization  | [authz.ts](../apps/api/src/authz.ts) — the single authorization matrix every protected route goes through                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Database layer | [db/client.ts](../apps/api/src/db/client.ts), [db/entities.ts](../apps/api/src/db/entities.ts), [db/mappers.ts](../apps/api/src/db/mappers.ts), [db/parse.ts](../apps/api/src/db/parse.ts), [db/errors.ts](../apps/api/src/db/errors.ts), [db/role-safety.ts](../apps/api/src/db/role-safety.ts) and repositories: [identity](../apps/api/src/db/repositories/identity.ts), [files](../apps/api/src/db/repositories/files.ts), [folders](../apps/api/src/db/repositories/folders.ts), [shares](../apps/api/src/db/repositories/shares.ts), [api-keys](../apps/api/src/db/repositories/api-keys.ts), [quota](../apps/api/src/db/repositories/quota.ts), [audit](../apps/api/src/db/repositories/audit.ts) |
| Routes         | New: [identity](../apps/api/src/routes/identity.ts), [sessions](../apps/api/src/routes/sessions.ts), [api-keys](../apps/api/src/routes/api-keys.ts), [files](../apps/api/src/routes/files.ts), [folders](../apps/api/src/routes/folders.ts), [shares](../apps/api/src/routes/shares.ts). Rewritten to honest `501`s with the owning phase: [uploads](../apps/api/src/routes/uploads.ts), [abuse](../apps/api/src/routes/abuse.ts), [stubs.ts](../apps/api/src/routes/stubs.ts). Extended: [system.ts](../apps/api/src/routes/system.ts), [index.ts](../apps/api/src/routes/index.ts)                                                                                                                     |
| Support        | [services.ts](../apps/api/src/services.ts), [problems.ts](../apps/api/src/problems.ts), [pagination.ts](../apps/api/src/pagination.ts), [mime.ts](../apps/api/src/mime.ts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Modified       | [config.ts](../apps/api/src/config.ts), [env.ts](../apps/api/src/env.ts), [dependencies.ts](../apps/api/src/dependencies.ts), [server.ts](../apps/api/src/server.ts) and their tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Tests

- New suite: [tests/integration](../tests/integration) — `harness.ts` plus
  [identity](../tests/integration/src/identity.test.ts), [ownership](../tests/integration/src/ownership.test.ts),
  [shares](../tests/integration/src/shares.test.ts), [quota](../tests/integration/src/quota.test.ts),
  and `run-local.sh` (provisions and drops its own scratch database).
- Updated: [tests/e2e/src/api-smoke.test.ts](../tests/e2e/src/api-smoke.test.ts) — the two Phase 0
  assertions that Phase 1 legitimately changed (postgres now requires `DATABASE_URL`; the upload
  stub now belongs to Phase 2) were corrected, and the suite now clears `DATABASE_URL` explicitly
  so a developer's shell cannot change what it asserts.

### Tooling and documentation

- [package.json](../package.json): `test` is now the unit suites only; `db:verify`,
  `db:test:integration` and `verify:db` were added; `test:e2e` calls the renamed e2e script.
- [pnpm-lock.yaml](../pnpm-lock.yaml): the integration suite's dependencies.
- [.github/workflows/ci.yml](../.github/workflows/ci.yml): the `database` job now installs Node and
  runs **both** database suites (`pnpm db:verify`, `pnpm db:test:integration`) against its
  `postgres:17` container; the Node job's step is labelled unit tests, since the service-backed
  suites moved.
- [.env.example](../.env.example): the Phase 1 variables.
- Docs rewritten or extended: [README.md](../README.md), [supabase/README.md](../supabase/README.md),
  [ARCHITECTURE.md](../docs/ARCHITECTURE.md), [SECURITY.md](../docs/SECURITY.md),
  [DEVELOPMENT.md](../docs/DEVELOPMENT.md), [ROADMAP.md](../docs/ROADMAP.md),
  [DECISIONS.md](../docs/DECISIONS.md) (D20–D25).

## 2. Migrations created

| Migration                                            | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261010000001_initial_schema.sql` (Phase 0)        | 9 tables, enums, checks, indexes, RLS, `updated_at` triggers.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `20261011000001_phase1_identity_ownership_quota.sql` | `profiles`, `anonymous_sessions`, `folders`, `usage_counters`, `quota_reservations`, `quota_limits`; generated `owner_key` columns; the exactly-one-principal constraints; the folder hierarchy guard trigger (depth, cycles, same-owner parents, sibling names); `opendrive_reserve_storage` / `commit_reservation` / `release_reservation` / `expire_stale_reservations` / `used_storage` and the folder guards; grants to `service_role` only; the `file_status` renames the API depends on. 14 tables in total. |

Ordering is by filename, one transaction per file, which is how `supabase db push` applies them.
The Phase 1 file adds and alters; it does not rewrite Phase 0 objects, so an instance already
carrying Phase 0 can be brought forward without dropping data.

## 3. Commands

```bash
# Apply (tracks migration state; preferred)
supabase link --project-ref <your-project-ref>
supabase db push

# Apply directly, in filename order
psql "$DATABASE_URL" -f supabase/migrations/20261010000001_initial_schema.sql
psql "$DATABASE_URL" -f supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql

# Tests
pnpm test                    # unit + contract suites (no service needed)
pnpm test:e2e                # build, then the compiled API over a real socket
pnpm db:verify               # schema: shim, migrations, 6 SQL suites, seed twice
pnpm db:test:integration     # API over that schema, in a scratch database
pnpm verify                  # format:check, lint, typecheck, build, test, test:e2e
pnpm verify:db               # db:verify && db:test:integration
```

Both database scripts require `psql`, `createdb` and `dropdb` on `PATH`, a reachable PostgreSQL
(verified on 17.6), and the standard libpq variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`),
plus `VERIFY_DB`. They refuse any database whose name does not start with `opendrive_verify`, and
never contact Supabase.

## 4. Results of the checks actually run

| Check         | Command                            | Result                                                                                         |
| ------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Format        | `pnpm format:check`                | Pass — all files match Prettier                                                                |
| Lint          | `pnpm lint`                        | Pass — 0 errors, 0 warnings                                                                    |
| Type-check    | `pnpm typecheck`                   | Pass — all 7 packages                                                                          |
| Build         | `pnpm build` (via `pnpm test:e2e`) | Pass                                                                                           |
| Unit/contract | `pnpm test`                        | **257 tests in 30 files** pass (shared 92, api 118, worker 20, cli 20, web 7)                  |
| End-to-end    | `pnpm test:e2e`                    | **9 tests** pass against the compiled process                                                  |
| Schema        | `pnpm db:verify`                   | **335 SQL checks** pass; both migrations apply in one transaction each; the seed applies twice |
| Integration   | `pnpm db:test:integration`         | **61 tests in 4 files** pass against real PostgreSQL                                           |

Defects this phase found and fixed, rather than worked around:

- `audit_events.id` had no default, so **every** audit insert failed. Fixed with a default in the
  migration; the integration suite now covers an audit-writing path.
- Folder-hierarchy refusals raised `check_violation` for one case and a custom error for another;
  the mapping now produces the right API problem for each.
- The credential parser split an anonymous-session or API key on its last separator, so any
  credential whose secret happened to contain that character was mis-parsed into the wrong id.
  The parse now uses a capture group, with tests covering a secret that contains it.
- The e2e suite was asserting the Phase 0 wording of two responses. Both were corrected to the
  Phase 1 truth, and the suite now clears `DATABASE_URL` so a developer's environment cannot make
  it pass for the wrong reason.

## 5. Environment variables (names only)

Required for a working authenticated API:

| Variable                                         | Purpose                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                   | Metadata database. Must be a **non-owner** application role (a table owner bypasses RLS). |
| `SUPABASE_JWKS_URL` **or** `SUPABASE_JWT_SECRET` | Access-token verification. With neither, protected routes answer `503`.                   |
| `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`   | Expected `iss` / `aud` (audience defaults to `authenticated`).                            |
| `IP_HASH_SECRET`                                 | Keyed hash for client addresses. Unset means addresses are not recorded at all.           |

Optional or Phase-1-adjacent: `ANONYMOUS_SESSION_TTL_HOURS`, `PUBLIC_BASE_URL` (share-link origin;
never derived from the request), and the pre-existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `STORAGE_PROVIDER`, `STORAGE_*`, `RATE_LIMIT_*`,
`ANONYMOUS_*`, `REGISTERED_UPLOADS_PER_DAY`, `MALWARE_SCAN_ENABLED`, `ABUSE_CONTACT_EMAIL`,
`TRUST_PROXY`, `CORS_ORIGINS`, `DOCS_ENABLED`, `LOG_LEVEL`, `API_HOST`, `API_PORT`, `NODE_ENV`.

No value is committed anywhere; `.env` is git-ignored and `.env.example` holds placeholders only.

## 6. Unresolved issues and security limitations

1. **The migrations have never run against the real Supabase project.** They are verified against
   plain PostgreSQL plus a shim that reconstructs Supabase's roles, `auth.users` and `auth.uid()`.
   A faithful reconstruction is not the platform. This remains the top Phase 1 carry-over.
2. **No byte transfer exists**, so nothing here proves anything about file _contents_. Upload,
   download and delete routes answer `501`. "Private by default" is proven for metadata only.
3. **Anonymous deletion is not implemented**, so the roadmap's "deletion with the correct token
   removes access" item is unproven — the routes are `501`.
4. **Rate limiting is in-process**, therefore per-instance. Redis is not wired up. Limits do not
   hold across two API processes.
5. **RLS is not the control on this path.** The API connects with a role that Supabase grants
   `BYPASSRLS`, so application scoping is what protects a request. RLS protects the direct-database
   path. `/readyz` reports the connected role's hazards (superuser, owning `files`, any table
   without RLS) and marks readiness `degraded` when it finds one, but nothing prevents an operator
   from deploying with the wrong role. `BYPASSRLS` itself is expected for the trusted backend role
   and is disclosed in the probe's detail rather than treated as a hazard (D36).
6. **Identity is verified, not issued.** There is no sign-in, registration, password reset or MFA
   in this build, and no browser-facing flow. Nothing here should be read as a claim about account
   lifecycle.
7. **Expired-hold sweeping needs a scheduler.** `sweep_expired_reservations` is implemented and
   tested, but the worker does not consume a queue yet, so nothing calls it on a schedule in
   production. Holds also expire lazily at reservation time.
8. **No browser end-to-end test.** The e2e suite drives the compiled API over HTTP; no browser
   automation yet, and the web app remains a status console.
9. **`audit_events` is not partitioned and has no retention policy**; there is no reader/UI for it.
10. **No performance measurement was taken.** Chunk sizes, memory bounds and the 2 GiB ceiling are
    configuration and schema facts, not measured throughput; no load test exists.
11. **Backups are untested** and no restore drill has been run. No deployment exists yet.

Not a limitation but worth stating: no secret, token, service-role key or database password is
committed, the CI workflow needs no secrets, and no file bytes or raw addresses exist anywhere in
the schema (asserted by `60_secrets_and_invariants.sql`).

## 7. Readiness checklist for Phase 2

- [ ] Apply both migrations to the real Supabase project; record `supabase migration list`.
- [ ] Re-run the cross-tenant RLS query and the whole `pnpm db:verify` suite against that instance.
- [ ] Confirm the configured `DATABASE_URL` role is **not** a table owner and **not** a superuser;
      `/readyz` must report `postgres: ok` with no hazards. The trusted backend role is expected to
      hold `BYPASSRLS` (D20, D36), and the probe names that in its detail.
- [ ] Configure `SUPABASE_JWKS_URL` (or the HS256 secret), issuer and audience; confirm an expired,
      wrong-issuer and `service_role` token are each refused by the running deployment.
- [ ] Verify a real Supabase-issued access token resolves to the right profile (provisioning on
      first use) and that a second request does not reset its limits.
- [ ] Choose and document the storage provider (a `DECISIONS.md` entry), then measure its real
      maximum object size instead of assuming one.
- [ ] Implement the upload engine and downloads on top of `quota_reservations` and the existing
      storage contract, and extend the roadmap's "private by default" test to bytes.
- [ ] Implement deletion (owner and anonymous deletion token) and prove idempotency.
- [ ] Wire Redis so rate limits hold across instances, and schedule the expired-hold sweep.
- [ ] Add browser end-to-end coverage for the sign-in → upload → download → share flow.
- [ ] Keep the two database suites in CI and add a gate that refuses a deployment whose `/readyz`
      reports a role hazard.
