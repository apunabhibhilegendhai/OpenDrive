# OpenDrive — current project stage (for the next-phase prompt)

**Repository root:** `C:/Users/basud/OneDrive/Desktop/New folder`
**Sibling backend repo (separate):** `C:/Users/basud/OneDrive/Desktop/supabase-actions/`

---

## One-paragraph summary

OpenDrive is a private cloud-storage + public file-hosting service built as a TypeScript monorepo (pnpm workspaces, Node 24, pnpm 12.11.2, TypeScript 6.0.3, Fastify API, React/Vite web app, Vitest). Phase 1 is complete on its own terms (identity + metadata + authorization), Phase 2 built the transfer machinery (upload engine, provider contract, streaming download, deletion, Redis-wired limits), and **Phase 3 delivered the browser product**: a sign-in flow, a real file manager, honest upload/download/delete flows, and a documented set of things it deliberately does not offer because the API does not support them. The remaining center of gravity is **making the storage path real and measured, and closing the share flow** (see the end of this document).

Phase 1's stated goal was: *"a signed-in user and an anonymous visitor each own their own metadata, and only the right people can ever see it."* That goal is delivered and verified: identity comes from verified Supabase access tokens (HS256 secret or JWKS), anonymous uploads are first-class principals (`anonymous_sessions`), ownership is a stored generated column never trusted from the request, authorization refusals are indistinguishable from "not found" and are audited, quotas are reserved before any byte moves, folders are a guarded tree, file/folder metadata is listable and readable, share links support expiry/revocation/download-counting with only the token digest stored, and API keys are hashed and scoped.

Since then, Phases 2 and 3 moved the product forward: the transfer routes are implemented (`POST /uploads`, `PUT /uploads/:id/parts/:n`, `POST /uploads/:id/complete`, `DELETE /uploads/:id`, `GET /files/:id/content`, `DELETE /files/:id` with the anonymous deletion-token path), and a browser client exists that drives all of them. What remains genuinely unverified is not code but **environment and measurement**: the storage provider is `none` by default (uploads answer `5xx` with the reason, and the web app disables the control instead of hiding it), the migrations have not been applied to the real Supabase project, the 2 GiB/5 GiB ceiling is *configured, not verified against a provider*, upload sessions are process-local (so no resume across a restart), and shares have no listing route and no `/s/:token` landing page.

The honest one-line state: **the product is a working file manager the moment a storage provider is attached** — until then it is metadata, auth, authorization and a transfer UI that refuses with the API's own reason rather than pretending.

---

## What "done" looks like right now (verified, with evidence)

### Tooling and repo plumbing
- Monorepo, pnpm workspaces, TS 6.0.3, ESLint 10 with type-aware rules, Prettier, Vitest. `pnpm verify` wraps format:check → lint → typecheck → build → test → e2e.
- Strict settings: `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `useUnknownInCatchVariables`, `forceConsistentCasingInFileNames`.

### Two database migrations, execution-verified, not yet applied to the real Supabase project
- `supabase/migrations/20261010000001_initial_schema.sql` — Phase 0: 9 tables (`profiles`, `files`, `storage_objects`, `upload_sessions`, `shares`, `api_keys`, `audit_events`, `abuse_reports`, `moderation_actions`), enums, checks, indexes, RLS on every table, `updated_at` triggers.
- `supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql` — Phase 1: `profiles.status`/`.max_files`, `anonymous_sessions`, `folders` with hierarchy guard + cycle prevention + same-owner parenting + sibling-name uniqueness, `usage_counters`, `quota_reservations`, `quota_limits`, generated `owner_key` on files/folders/usage_counters/reservations, `opendrive_*` quota functions, `file_status` renames/additions (`pending_upload`, `uploaded`, `deleting`, `ready`).
- Verified by `pnpm db:verify` = **335 SQL checks** across 6 suites (`10_structure`, `20_constraints`, `30_rls`, `40_identity_ownership`, `50_quota`, `60_secrets_and_invariants`) against a local throwaway PostgreSQL, plus seed applied twice.
- **Not verified:** applied to a real Supabase instance (the shim is a reconstruction of Supabase roles/`auth.uid()`, not the platform).

### API surface (Fastify, schema-first with Zod, OpenAPI 3.1)
**Live, real, integration-tested (61 tests):**
- `GET /healthz` — liveness, no dependency, never rate limited.
- `GET /readyz` — per-dependency readiness; `503` while unconfigured and names the missing variable; reports `postgres: ok / redis: ok / telegram: ok / storage: not_configured` etc.
- `GET /api/v1/limits` — current deployment limits.
- `GET /openapi.json`, `GET /docs` — published contract (docs disabled in production unless `DOCS_ENABLED=true`).
- Authentication: token verification (signature, expiry, issuer, audience, algorithm, deny-list, `service_role` refusal), `503` when no key source configured; anonymous sessions with hashed bearer credential + expiry + revocation consistency; provisioning `profiles` on first use.
- Authorization: ownership from the database, not the request; identity required before private resources; refusals as `404 NOT_FOUND` indistinguishable from missing; audit events for auth/authz/share activity.
- Identity routes: sign-in is **not** in this build — there is no registration/password-reset/MFA/issuing. Identity is verified only.
- Sessions: create/list anonymous sessions; hashed credential returned once.
- API keys: create/list/revoke scoped keys; hashed `key_hash`, public `key_prefix`, immediate revocation.
- Files: list (paginated, cursored), read metadata, folder placement, soft delete marks; ownership-checked.
- Folders: create/list/move/delete with hierarchy guard enforced in SQL; depth 0–32; same-owner parents; sibling-name uniqueness including two NULL roots.
- Shares: create/resolve/revoke with expiry + download counting + token-digest-only storage; revocation visible on next resolution.
- Quota: `GET /api/v1/quota` summary from `opendrive_quota_summary`; reserve-before-byte semantics via `opendrive_reserve_storage` / commit / release; holds count against both storage and daily upload allowance; per-principal lock so two concurrent uploads by the same principal serialize.
- Uploads routes exist (`POST /uploads`, `PUT /uploads/:id/parts/:n`, `GET /uploads/:id`, `POST /uploads/:id/complete`, `DELETE /uploads/:id`) and are implemented as an engine with a process-local `UploadSessionStore`, quota hold taken before the first byte, and a non-destructive finalize — but the storage provider is `none` by default and the routes still answer `501` / `503` depending on configuration. They are Phase 2 routes that are partially built and partially stubbed.
- Abuse reports: route exists, answers `501` (Phase 4).

**Answer `501 Not Implemented` (published contracts, full schemas, phase-named):**
- Upload part/complete/abort when no provider is configured.
- Download (`GET /files/:id/content`).
- Deletion by owner and by anonymous deletion token (route exists, answers `501` in places — be precise here).
- Moderation/scanning workflow.

### Shared contracts (`packages/shared`)
- Ids: prefixed random ids (`file_`, `fold_`, `shr_`, `key_`, `evt_`, `resv_`, `sess_`, `upl_`, `sobj_`), Crockford base32, 128-bit CSPRNG.
- Errors: single `AppError` model, RFC 9457 problem details, stable `code` + fixed HTTP status per code, field-level `errors`, generic 500 for unexpected.
- Tokens/credentials: 256-bit base64url bearer tokens stored as SHA-256 hashes, constant-time compare; anonymous-session credential and API-key prefix/secret split; parse uses a capture group so secrets containing the separator still parse.
- Domain rules (pure, tested): principals, ownership, quota, share-link resolution/expiry/revocation, file states/transition table, visibility.
- Storage contract: `StorageProvider` interface + `StorageCapabilities` + `assertCapability`; contract test suite (`describeStorageProviderContract`) run against every provider before enabling; unsupported capabilities fail with `STORAGE_CAPABILITY_UNSUPPORTED`.
- Limits: per-principal limits, pagination caps, filename/part size bounds.

### Storage provider work (Phase 2, in progress but not production-validated as the backend)
- `TelegramStorageProvider` implemented in `apps/api/src/storage/providers/telegram.ts`: each object = ordered list of parts, each part uploaded as a chat document via `sendDocument`, read back via `getFile` + file endpoint; locator in `storage_objects.provider_ref` is the Telegram message/file ids so a restart can stream/delete from the locator alone.
- `TelegramHttpTransport` / injectable `TelegramTransport`; production path vs in-memory fake for contract tests.
- Contract suite passes against the fake transport (multipart, single-shot, out-of-order parts, duplicate-part refusal, checksum-mismatch refusal, abort idempotency, range reads, idempotent delete, restart-safe reads).
- Live Bot API verified at 256 KiB single-shot and 25 MiB 4-part multipart with matching whole-object SHA-256.
- Known honest limits: `resumableUpload: false` (process-local state), `guaranteedDurability: false`, `permanentRetention: false`, `directDownloadUrl: false`, `deleteIsFinal: false` (Telegram keeps serving a deleted file — provider keeps an in-process tombstone; another process / restart can't see it), max 20 MiB per part on the public API, whole-object capped at part ceiling unless a `--local` server is used.
- 2026-10-12 work (D31): streamed whole-object upload spooled once to temp disk (never RAM) with SHA-256 computed during spool; retried reads and uploads with backoff; `--local` absolute-path `getFile` reads from disk or via `TELEGRAM_FILES_BASE_URL` + `TELEGRAM_WORK_DIR`; size refusal not retried.
- Provider selected with `STORAGE_PROVIDER=telegram-experimental`; attached only when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_STORAGE_CHAT_ID` present.
- **Not yet done:** real maximum object size measured (2 GiB target not reached; Telegram local ceiling is 2000 MB), `--local` server measured, interruption/resume demonstrated, orphan cleanup demonstrated, contract suite run against real API limits.

### Worker (`services/worker`)
- Job contracts + queue semantics + `JobQueue` interface; `MemoryJobQueue` test double, refused in production.
- Retention job contracts declared (expire uploads, etc.); `sweep_expired_reservations` implemented in SQL but not scheduled because no queue is consumed yet.

### Web app (`apps/web`) — Phase 3, delivered and tested
- React 19 + Vite + `react-router` SPA calling only the OpenDrive API (no mock data in normal operation). Routes: `/signin`, `/drive` (`?folder=`), `/shares`, `/account`, `/status`; a session guard redirects an unauthenticated or expired visitor to `/signin` instead of rendering someone else's shell.
- **Sign-in**: Supabase Auth (lazily loaded, configured only from the public `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`), account creation with the "confirm your email" answer, and an anonymous session (`ods_…` held in memory for the tab, never written to storage). With no auth service configured the screen says so instead of offering a form that cannot work.
- **My Drive**: breadcrumbs from the API folder tree, list/grid switch, compact/comfortable density, this-page-only filter (labelled as such), cursor pagination, multi-select (shift range, Ctrl/Cmd toggle), per-file menu, bulk delete and bulk download with **per-file** results, empty/loading/error/filtered states kept distinct.
- **Upload tray** ("log pose"): one row per transfer, real byte counts, phases `queued`/`uploading`/`finalizing`/`ready`/`failed`/`aborted`, cancel that calls `DELETE /uploads/:id` (and says when that call failed), one-time deletion token for anonymous uploads, drag-and-drop overlay and file picker.
- **File inspector**, **share dialog**, **Shares page**, **Account page** (API keys created/revealed once/revoked), **System status** (readiness chips, enforced limits, capacity ruler, "known gaps in this build").
- **Command palette** (`Ctrl/Cmd+K`) assembled only from capabilities that exist; theme toggle (`Chart Paper` / `Night Voyage`); keyboard-reachable menus, dialogs with focus return, skip link, `prefers-reduced-motion` support.
- **Design system**: one token layer (`src/styles/tokens.css`), brutalist geometry, local-only typography (no webfont requests), CSS-drawn textures, local SVG icons. Contrast is **enforced by a test** (`src/styles/tokens.test.ts` asserts ≥4.5:1 for the pairs the UI paints, in both themes, and that no component stylesheet contains a literal colour) — it found and fixed one real dark-theme defect.
- **Honest-unavailable set** (nothing in the interface implies otherwise): uploads when `/readyz` reports `storage: not_configured`; share listing and `/s/:token` landing page; file rename/move; abuse reporting; previews/search/trash/favorites/version history.
- Tests: 86 web tests (see the test inventory below). Deliberately **not** verified: a live Supabase sign-in, a live storage round-trip, and real-browser automation — see the Phase 3 completion report's limitations.
- Full report: `PHASE3-COMPLETION-REPORT.md`.

### CLI (`apps/cli`)
- `health`, `readiness`, `limits`, `version`, `help` — all real, using `parseArgs`, exit codes 0/1/2/3/4. No auth/scoped commands yet.

### Tests
- Unit + contract: **389 tests** (`pnpm test`, no service needed): shared 92, api 171 (1 skipped), worker 20, cli 20, web 86. (The web app went from 7 tests to 86 in Phase 3.)
- E2E: **9 tests** (`pnpm test:e2e`) against compiled `apps/api/dist/index.js` over a real socket, including SIGTERM shutdown (POSIX only; Windows emulates).
- Integration: **61 tests in 5 files** (`pnpm db:test:integration`) against a scratch PostgreSQL with real repos + real HTTP (Fastify inject): identity, ownership, shares, quota, and uploads (the uploads integration suite is newer than `PHASE-1-REPORT.md`, which recorded 4 files). Needs `psql`/`createdb`/`dropdb` on PATH.
- SQL suites: 335 checks (`pnpm db:verify`).

### CI and deployment
- `.github/workflows/ci.yml`: `verify` job (Node 24) runs format → build:libs → lint → typecheck → build → test → e2e; separate `database` job runs `db:verify` + `db:test:integration` against `postgres:17`; advisory dependency-audit job (non-gating). Permissions `contents: read`. No secrets.
- `.github/workflows/api-host.yml`: operator-triggered (`workflow_dispatch`) OR scheduled (`0 */4 * * *`), concurrency group `api-host` serializes runs. Builds shared lib + API, installs `cloudflared`, optionally builds a self-hosted `telegram-bot-api --local` from pinned commit `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1` (cached), starts the API, opens a Cloudflare Tunnel to `http://localhost:3000`, optionally opens an Access-gated TCP tunnel to Redis. Duration 5–330 min, timeout 350 min. **Ephemeral development deployment, not production.** Explicit not-production caveats recorded in D26/D34/D37.
- The Supabase + Redis backend the host relies on lives in the **separate** repo `C:/Users/basud/OneDrive/Desktop/supabase-actions/` (`.github/workflows/supabase-host.yml`), published over HTTPS via Cloudflare Tunnel at `supabase.opendrive.indevs.in`. That repo has its own Supabase stack, migrations under `supabase/migrations/` (001–008, a different numbering — these are the upstream stack's, not OpenDrive's), `opendrive_role.sql`, tunnel helpers (`pg-tunnel.sh`, `redis-tunnel.sh`), `reset.sh`/`run.sh`/`remote.sh`, and a separate Cloudflare Worker (`worker/workflow-watchman/`).

### Environment
- `.env` exists locally (git-ignored). `.env.example` is the full template. Required for a working authenticated API: `DATABASE_URL` (non-owner app role; `files` does not use `FORCE ROW LEVEL SECURITY`), and one of `SUPABASE_JWKS_URL`/`SUPABASE_JWT_SECRET` plus issuer/audience. Optional but wired: `REDIS_URL`, `IP_HASH_SECRET`, `SUPABASE_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`, storage vars, rate-limit vars, Telegram vars.
- No value is committed. CI needs no secrets.

---

## What is proven vs what is only designed (read carefully)

### Proven by test/command (the "you can trust this" list)
- Format, lint, typecheck, build, unit/contract (389), e2e (9), SQL schema (335), integration (61, in 5 files — the uploads integration suite is newer than `PHASE-1-REPORT.md`'s "4 files" record). SQL and integration suites were **not re-run during Phase 3** (no local PostgreSQL was started); no migration was changed, but the numbers above are from their last green run, not from this phase.
- "Private by default" proven for **metadata** (`tests/integration/src/ownership.test.ts`) and for **bytes** (`tests/integration/src/uploads.test.ts`: owner gets byte-exact content, everyone else gets 404).
- Share-token properties proven (`tests/integration/src/shares.test.ts`): expiry/revocation take effect on next resolution, refusals indistinguishable from nonexistent token, plaintext token in no column, only digest stored.
- Anonymous deletion proven by test (`tests/integration/src/uploads.test.ts`: correct token deletes, wrong token 404, no credential 401).
- Quota race refused (local + integration: two concurrent reservations for same principal serialize, hold counts against daily allowance).
- Telegrams provider contract verified against fake transport; live Bot API verified at 256 KiB and 25 MiB.
- Rate limiting keys on the principal (not address); part traffic has its own higher ceiling; per-principal daily-start + open-session caps exist; with `REDIS_URL` set both ceilings counted in Redis (D37).
- Deletion token compared in constant time against stored digest.
- Migration integrity: generated `owner_key`, composite foreign keys enforce same-owner parents and folder placement, folder hierarchy guard enforces depth/cycles/same-owner/sibling-name, quota functions lock per-principal.

### Designed / partially built but not yet proven for the real product
- The migrations applied to the real Supabase instance (top carry-over).
- RLS re-verified against the real platform (Supabase's own `auth.uid()` and roles), and the `DATABASE_URL` role confirmed non-owner, non-superuser, `BYPASSRLS` disclosed by `/readyz`.
- Storage provider maximum object size measured near the 2 GiB target.
- `--local` Telegram Bot API server measured (single file > 20 MiB up/down; the 2000 MB ceiling and absolute-path `getFile` behaviour still unmeasured).
- Interruption + resume producing byte-identical content with matching checksum.
- Orphan cleanup demonstrated (aborted upload leaves no retrievable object, or cleanup job removes it, with before/after counts).
- No whole-file buffering measured at 2 GiB (mechanism is there: multipart streams one bounded part; single-shot spools to disk once; neither holds in RAM, but no 2 GiB measurement exists).
- Concurrent uploads from multiple principals bounded end-to-end (throttling exists per principal; Redis shares counters; but upload sessions are per-instance, so multi-instance is still unsupported).
- Rate limits actually shared across two simultaneous API instances (Redis-backed whenever `REDIS_URL` set, but two instances are intentionally avoided because sessions are in-process).
- Backup + restore drill passed (documented as not done).
- Browser end-to-end tests (Playwright or equivalent) driving sign-in → upload → download → share. Phase 3 added jsdom + Testing Library coverage of the same flows through the real client/providers/routes against a fake API, which is weaker evidence than a real browser and is described that way in the report.
- A live Supabase sign-in and a live storage round-trip **through the web app** (Phase 3 exercised the `storage: not_configured` path instead, which is the truthful state of this deployment).
- Branch protection on `main` (CI required to pass before merge, no direct pushes).
- Incident basics: documented "take API offline" step + published `ABUSE_CONTACT_EMAIL`.

---

## Open decisions and known limitations you should be aware of

1. **Top carry-over:** migrations never applied to the real Supabase project; schema suites are against a reconstruction, not the platform.
2. **No byte transfer yet** for the product path — uploads/downloads/deletes are `501`/unconfigured; "private by default" is proven for metadata and partially proven for bytes only via the integration test's in-process double path.
3. **No sign-in/registration/password-reset/MFA flow** — identity is verified tokens only; no browser-facing account lifecycle. Anonymous uploads use a hashed-credential session + per-file deletion token; account conversion is not designed (would need explicit ownership transfer).
4. **Single-instance upload engine** — upload sessions are process-local; the deployment is intentionally one instance behind the tunnel. Redis is wired for rate-limit counters (D37) but not for session sharing.
5. **Telegram storage is experimental** with honest limits: no durability guarantee, no permanent retention guarantee, no ranged read, no direct download URL, deletion not provably final (tombstone is process-local), max 20 MiB/part on public API, 2000 MB ceiling only with a `--local` server, 2 GiB target not yet measured, shared bot token is the real concurrency bottleneck.
6. **`files` does not use `FORCE ROW LEVEL SECURITY`** — the API must connect as a non-owner role; a table owner would bypass RLS. This hazard is asserted by `60_secrets_and_invariants.sql` and disclosed by `/readyz`, but nothing prevents an operator from deploying with the wrong role.
7. **Trusted backend role holds `BYPASSRLS`** by design (D20/D36) — the API authorizes in code; RLS is a backstop for direct PostgREST/direct-db access. `/readyz` discloses `BYPASSRLS` in the `ok` detail rather than failing.
8. **Redis is best-effort for limits** — `@fastify/rate-limit` registered with `skipOnError`, so unreachable Redis fails open (limiter skips, limits disappear). Redis and Postgres share the same backend host, so "Redis down, Postgres up" is the narrow window where limits silently vanish; `/readyz` reports `redis: unavailable` throughout it.
9. **Audit events not partitioned, no retention policy, no reader/UI.**
10. **No performance measurement taken** — chunk sizes/memory bounds/2 GiB ceiling are config + schema facts, not measured throughput; no load test.
11. **Backups untested, no restore drill run, no production deployment.**
12. **GitHub Actions host is explicitly a development deployment** with an ephemeral runner, 7-day/10 GB Actions-cache state survival, and possible total data loss; must never hold the only copy of anything. The upstream Supabase repo's workflow prints a fallback Redis password into a public log (the OpenDrive instance sets a real random password so the fallback isn't used, but the upstream source still contains the old default).
13. **Public API v1 compatibility promise not yet made** (should be decided once real clients exist).
14. **Preview generation strategy undecided** (on upload vs on first request — affects storage layout and cost).
15. **Cost target is zero** beyond existing domain; no paid managed Supabase/Redis; Telegram treated as experiment with unresolved durability/limit/account-risk questions, not free unlimited storage.

---

## Where the repo stands relative to the roadmap

Per `docs/ROADMAP.md`:

- **Phase 0 (foundation):** done.
- **Phase 1 (identity + metadata + authorization):** delivered and verified on its own terms; the readiness checklist's local-verified items are marked done. The real-Supabase-application, storage-provider-measurement, delete-by-owner, browser-e2e, branch-protection, incident-basics, backup-drill items remain and are carried into Phase 2 (the roadmap literally says "Carried into Phase 2").
- **Phase 2 (file transfer):** this is the big next one — the upload engine + streaming download + deletion + Redis-backed cluster-wide limits + storage provider enabled/measured + job queue consumed + browser e2e. A lot of the scaffolding for this is already built (upload routes/engine, Telegram provider, Redis wiring, quota reservations); what's missing is turning the `501`s into the real thing on a measured/survivable provider and applying the schema for real.
- **Phase 3 (web app + file manager):** delivered — the browser product described above (sign-in, file manager, uploads, downloads, deletion, shares, keys, status) with 86 tests, and every unsupported capability stated rather than faked. The CLI half of the client surface (upload/download/share) is still open; so is the public API v1 compatibility promise.
- **Phase 4 (trust & safety):** malware scanning gate, abuse reporting/triage, takedown actions with audit trail, preview allow-lists, published abuse contact.
- **Phase 5 (deployment):** TLS termination beyond the tunnel, backups with a **passing restore drill**, monitoring/alerting on readiness, static-host decision for the web app, incident runbook. (The dev host action exists earlier than this phase but is explicitly not production.)
- **Phase 6 (monetization):** deliberately last; no payment provider chosen.

---

## A few concrete "current state" facts an LLM prompt should not have to infer

- The API default `STORAGE_PROVIDER=none`; Telegram is `telegram-experimental` and only attaches when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_STORAGE_CHAT_ID` are set.
- `.env` exists locally with real-looking placeholder values; `.env` is git-ignored; `.env.example` is the template. **Do not treat anything in `.env` as a public credential.** The infra credentials files (`opendrive-infra-credentials.txt`, `opendrive_password_hints.txt` in both repos) are present — treat as sensitive and don't echo.
- The real Supabase backend lives in a **separate** repo at `C:/Users/basud/OneDrive/Desktop/supabase-actions/`; its `supabase/migrations/` are numbered 001–008 and are the upstream stack's migrations, **not** OpenDrive's (OpenDrive's are in `New folder/supabase/migrations/` and are timestamped `20261010...`/`20261011...`).
- There is a Cloudflare Tunnel public hostname (`supabase.opendrive.indevs.in` for the backend; the API host tunnel's public hostname is managed in Cloudflare Zero Trust, not in this repo).
- The `supabase-actions` repo also contains a Cloudflare Worker (`worker/workflow-watchman/`) with `wrangler.toml` — a separate small service, not the OpenDrive API.
- The API's identity model: Supabase Auth issues tokens; the API verifies them; there is no local sign-up/ sign-in endpoint. Anonymous uploads are a separate principal kind (`anonymous_sessions`), not "a user with no account."
- The web app's public configuration is only `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (both public by design) and `VITE_API_BASE_URL` (empty = same origin, the Vite dev proxy). No server-only secret is referenced from browser code, and the web tests assert that nothing but three view preferences is ever written to `localStorage`.
- In normal operation the web app stores exactly one key in `localStorage`: `opendrive.web.prefs` (`{theme, view, density}`). Sessions, credentials and deletion tokens are never persisted.

---

## Suggested framing for the next-phase prompt

If you're feeding this to an LLM to decide/prompt the next phase, the honest framing is:

> "Phase 1 is complete and verified for metadata + auth + authorization. The next phase is file transfer (Phase 2), but much of its scaffolding already exists: upload routes/engine with reserve-before-byte, a Telegram storage provider with a passed contract-suite and live round-trips at 256 KiB / 25 MiB, Redis-wired rate-limit counters, quota functions, and an ephemeral development host behind a Cloudflare Tunnel. What remains is: apply both migrations for real to Supabase and re-verify RLS/role; measure and enable a storage provider against the real 2 GiB target (Telegram with a `--local` server is the candidate, with honest durability/retention/deletion-finality limits); implement streaming download and deletion-by-owner + deletion-by-token against that provider; make the upload `501`s real; get the job queue consuming; and add browser e2e. Keep the existing `501`-with-phase discipline for anything not finished, and don't claim durability/retention/final-deletion for Telegram beyond what's measured."

---

*Generated from a deep read of the repository on 2026-10-12. Numbers (test counts, check counts, file paths, env var names, limits) are taken from the actual files; the "honest limits" are quoted from the project's own docs/decisions.*
