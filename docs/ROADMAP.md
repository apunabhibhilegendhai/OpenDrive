# Roadmap and prerequisites

## Phase 0 — foundation (done)

Completed: monorepo, workspace and TypeScript configuration, lint/format/test tooling, shared contracts (errors, identifiers, tokens, limits, API schemas, storage interface), live system endpoints, published-but-unimplemented file/upload/share/moderation contracts answering `501`, CLI system commands, a status console, worker job contracts plus queue semantics, the metadata migration, docs and CI.

Not completed, by design: authentication, database access, Redis, any storage provider, uploads, downloads, shares, scanning, moderation. See [ARCHITECTURE.md](ARCHITECTURE.md) §7.

## Phase 1 — identity, metadata and authorization foundation (this build)

Goal: a signed-in user and an anonymous visitor each own their own metadata, and only the right
people can ever see it. The file-transfer half of the goal (uploading and reading back bytes) is
still Phase 2, and every route that would move bytes answers `501` with the phase that owns it.

Delivered and verified in this build:

1. **Schema.** `20261011000001_phase1_identity_ownership_quota.sql` adds `profiles`,
   `anonymous_sessions`, `folders`, `usage_counters`, `quota_reservations` and `quota_limits`, the
   stored generated `owner_key`, the folder-hierarchy guard, the quota functions, and the
   `file_status` changes the API depends on. Verified by 335 SQL checks against a scratch
   PostgreSQL (six suites, `pnpm db:verify`) — **not** yet against the real Supabase project.
2. **Repository layer over Postgres** (parameterised queries only, no string-built SQL) with
   mappers tested against malformed rows, and constraint-name → error-code translation so a
   database refusal becomes a precise API problem instead of a 500.
3. **Authentication.** Supabase access-token verification (HS256 secret or an asymmetric JWKS
   endpoint), issuer/audience/expiry/algorithm enforcement, a deny-list, and anonymous sessions
   with a hashed bearer credential and expiry.
4. **Authorization foundation.** Ownership is read from the database, never from the request;
   identity is required before any private resource is touched; every refusal is recorded as an
   audit event without disclosing which rule refused.
5. **Shares with expiry, revocation and counters**, and only the token digest stored.
6. **Quota reservations** so two concurrent uploads cannot each pass the same allowance check.
7. **Folders** with a guarded hierarchy, and file metadata listing and reading.
8. **The API over the real schema**, proven by `tests/integration` (61 tests, `pnpm db:test:integration`).

Deliberately not started here, and carried into Phase 2: the upload engine and byte transfer,
streaming download, deletion by owner and by anonymous deletion token, Redis-backed rate limiting
and counters, and browser end-to-end tests. Their contracts stay published and answer `501`.

## Phase 2 — file transfer (what `501` routes are waiting for)

Goal: the bytes half of Phase 1's goal — a signed-in user and an anonymous visitor can upload a
file and only the right people can read it back.

1. The upload engine over one storage provider that has passed capability verification:
   `uploads.initiate`, `uploads.part`, `uploads.status`, `uploads.complete`, `uploads.abort`.
2. Streaming download with correct headers and per-part checksum verification, so
   "private by default" is finally provable for bytes and not only for metadata.
3. Deletion by owner and by anonymous deletion token (both routes exist and answer `501`).
4. Redis-backed rate limiting and quota counters, so limits hold across instances.
5. The Telegram experiment, measured against the provider contract and either enabled with its
   measured limits or documented as rejected. Implemented and contract-verified against the test
   transport (D27); the provider now streams a single-shot whole object through a one-time disk
   spool with bounded memory and retries transient uploads, and reads `--local` absolute paths
   from disk or a file-server base URL (D31). Real-API limits are still unmeasured, so it is not
   yet enabled for bytes.

Background processing follows the same phase: job queue on Redis behind the existing `JobQueue`
interface, retention jobs implemented, orphan reconciliation.

## Phase 3 — CLI and API surface

(Auth-scoped, revocable API keys and audit-event emission shipped in Phase 1 — see
`apps/api/src/routes/api-keys.ts`. What remains here is the client surface.)

Full CLI client (upload, download, share, list); partition `audit_events` if volume justifies it;
API versioning policy in practice.

## Phase 4 — trust and safety

Malware scanning gate, abuse reporting and triage workflow, takedown actions with an audit trail, preview allow-lists, and an abuse contact published on the site.

## Phase 5 — deployment

TLS termination, backups with a **passing restore drill**, monitoring and alerting on readiness, a static-host decision for the web app, and a documented incident runbook.

## Phase 6 — monetization (not before)

Paid tiers, quotas per plan, and payment integration. Deliberately last: no payment provider is chosen, and none is needed for the product to be useful.

---

## Remaining prerequisites — checklist

Carried into Phase 2: items Phase 1 could verify locally are marked done, and each remaining item
names the evidence that would show it is done. Nothing should be reported as working before its
evidence exists.

### Environment and credentials

- [ ] **Postgres reachable from the development machine.** Evidence: `psql "$SUPABASE_DB_URL" -c 'select 1'` succeeds (or the Supabase CLI connects), with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set outside version control.
- [ ] **Redis reachable and authenticated.** Evidence: `redis-cli -u "$REDIS_URL" ping` answers `PONG`, and Redis is not reachable from the public internet.
- [ ] **Secrets stored outside the repository.** Evidence: `.env` exists locally and is git-ignored; `git status --porcelain` shows no `.env`; the CI workflow remains secret-free.
- [ ] **A deliberate storage decision.** Evidence: a `docs/DECISIONS.md` entry naming the provider and the reason.

### Migration

> The three items below are **verified against a scratch PostgreSQL** by
> `supabase/tests/run-local.sh` (335 checks, also run in CI), and **not yet against the real
> Supabase project**. The remaining work is stated for each item; the local evidence is already in
> the repository, so it does not need to be redone by hand.

- [ ] **Migration applied.** Local: both migrations apply cleanly, in filename order and one transaction per file, to an empty database with no manual edits (`pnpm db:verify`). Remaining: apply them to the real project and record `supabase migration list` output.
- [ ] **RLS verified, not assumed.** Local: `supabase/tests/30_rls.sql` proves cross-tenant reads and writes match 0 rows as `authenticated`, that `anon` holds no table privilege, that an `authenticated` request with no JWT claims sees nothing, and that `service_role` sees everything. Remaining: repeat the cross-tenant query against the real project, where Supabase's own `auth.uid()` and roles apply, and confirm the application role configured in `DATABASE_URL` is **not** a table owner (`files` does not use `FORCE ROW LEVEL SECURITY`; `60_secrets_and_invariants.sql` records this hazard).
- [ ] **Constraint behaviour tested.** Local: `supabase/tests/20_constraints.sql` shows a 2 GiB+1 byte file, a malformed checksum, a second `active` `storage_objects` row, an unknown API-key scope and 30-odd others each rejected by the named constraint; `40_` and `50_` add ownership, placement and quota refusals. Remaining: nothing, beyond re-running the suites after the migrations are applied for real.

### Storage provider

- [ ] **Capabilities measured, not assumed.** Evidence: the provider's real maximum object size measured by uploading progressively larger objects, with the date and the resulting number recorded in `docs/DECISIONS.md`.
- [~] **Contract suite passes against the provider.** `describeStorageProviderContract` passes against `TelegramStorageProvider` (2026-10-11) using the in-memory fake transport, including capability-failure paths (range read refusal, checksum mismatch, idempotent delete). Real-API verification remains pending — see `docs/DECISIONS.md` D27. Evidence: `apps/api/src/storage/providers/telegram.test.ts`.
- [x] **Transient transfers retried.** The provider retries retryable read _and_ upload failures with backoff; a streamed whole-object upload is spooled once to disk so each attempt re-reads from byte zero, and a non-retryable size refusal is surfaced immediately (2026-10-12). Evidence: `telegram.test.ts` — "streams a whole-object upload through a spool and retries transient failures", "retries a transient part-upload failure and still verifies", "does not retry a Telegram size refusal". See `docs/DECISIONS.md` D31.
- [ ] **A `--local` server measured.** Evidence: a self-hosted `telegram-bot-api --local` server, with a single file above 20 MiB uploaded and downloaded through it, and the measured maximum recorded in `docs/DECISIONS.md`. The `--local` absolute-path `getFile` behaviour and the 2000 MB ceiling are still unmeasured.
- [ ] **Interruption and resume demonstrated.** Evidence: a multi-part upload killed mid-way, then resumed, produces byte-identical content with a matching whole-file checksum.
- [ ] **Orphan cleanup demonstrated.** Evidence: an aborted upload leaves no retrievable object, or the cleanup job removes it, with before/after object counts.

### Application behaviour

- [~] **Private by default proven by test.** Metadata half done: `tests/integration/src/ownership.test.ts` shows another principal's file is invisible and refused, and that ownership comes from the database rather than the request. The byte half is blocked on the download route, which still answers `501`; the test must be extended when it moves.
- [x] **Share-token properties proven by test.** `tests/integration/src/shares.test.ts`: expiry and revocation take effect on the next resolution, refusals are indistinguishable from a token that never existed, the plaintext token appears in no column of the row, and only its digest is stored.
- [ ] **Anonymous deletion proven by test.** Blocked on `files.delete` and `anonymous_sessions` deletion, which are not implemented (both answer `501`).
- [ ] **No whole-file buffering.** Evidence: a 2 GiB (or the measured maximum) upload completes with the API process's resident memory staying within a small, recorded bound. The multipart path streams each part with no staging; the single-shot path spools once to local disk (never RAM) and streams from there per attempt — neither holds the object in memory, but neither is measured at 2 GiB yet.
- [ ] **Concurrent uploads from multiple principals stay bounded.** Evidence: many simultaneous uploads from distinct principals do not exhaust a single bot token's per-chat flood limits or the process's memory, and per-principal upload throttling holds across instances. Known gaps today: the Telegram provider keeps upload state in process memory (`resumableUpload: false`), the global limiter is 120 req/min while one 2 GiB multipart upload alone issues hundreds of part requests, and there is no per-principal upload limit. See `docs/DECISIONS.md` D31.
- [ ] **Rate limits actually shared.** Evidence: two API instances behind the same Redis reject beyond the configured limit, demonstrated with a request count above the limit.
- [ ] **Backup drill passed.** Evidence: a restore into a scratch database reproduces metadata, with the command and its output recorded in `docs/DECISIONS.md`.

### Tooling and process

- [ ] **Browser end-to-end tests.** Evidence: Playwright (or equivalent) driving the sign-in, upload, download and share flow against a running stack.
- [ ] **Branch protection on `main`.** Evidence: the CI workflow is required to pass before merge, with no direct pushes.
- [ ] **Incident basics.** Evidence: a documented step for taking the API offline, and an abuse contact (`ABUSE_CONTACT_EMAIL`) published where the platform is described.

### Decisions to make before Phase 2 code is written

- [x] Which identity flows exist for anonymous uploads (deletion token only, or an optional account later). Decided in Phase 1: an anonymous session with a hashed credential and expiry, plus a per-file deletion token, and no account requirement — see `docs/DECISIONS.md` D24. A conversion path to a real account needs an explicit ownership transfer, and is not designed yet.
- [ ] The public API's compatibility promise for v1 once real clients exist.
- [ ] Whether previews are generated on upload or on first request (affects storage layout and cost).

### Environment for local database work

- [x] **A local PostgreSQL to run the suites against.** Evidence: `pnpm db:verify` and `pnpm db:test:integration` each create and drop their own `opendrive_verify*` database and pass (335 SQL checks, 61 integration tests). The scripts refuse to touch any database whose name does not start with `opendrive_verify`.
- [ ] **The real instance reachable.** Evidence: `psql "$DATABASE_URL" -c 'select 1'` succeeds against the Supabase project, with the values supplied outside version control, and `/readyz` reporting `postgres: ok`.
