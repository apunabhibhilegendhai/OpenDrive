# OpenDrive — Phase 2 completion prompt (code-anchored)

**Repository root:** `C:/Users/basud/OneDrive/Desktop/New folder`
**Context file already in the repo:** [CURRENT-STAGE.md](CURRENT-STAGE.md) — read that first; it is the project's own summary of what is proven vs only designed.
**Sibling backend repo (separate, do not conflate):** `C:/Users/basud/OneDrive/Desktop/supabase-actions/`

You are continuing an existing OpenDrive TypeScript monorepo. Do **not** restart the project, regenerate the monorepo, replace working modules, or re-litigate Phase 0/1 choices. The repo already has a Fastify API, Supabase Auth verification, ownership-from-the-database authorization, folders, shares, API keys, quota reservations, an upload-session engine, a Telegram storage provider with a passed mock contract suite and live Bot API tests at 256 KiB and 25 MiB, Redis-wired rate-limit counters, and worker/job contracts. Your job is to complete the **file-transfer** half of Phase 2 on top of that, preserving the project's existing security posture and its "never claim a capability without evidence" discipline.

---

## Ground rules (read carefully)

1. **Prove before you claim.** The project forbids stating that a capability works without a command and its output to prove it. For every "done" you assert, record the exact verification: which test, which live run, which measurement, which output. Numbers in `CURRENT-STAGE.md` are from the project's own docs; treat them as claims to re-verify, not as gospel.
2. **Keep the 501/503 honesty.** Published-but-unimplemented contracts must keep answering `501 NOT_IMPLEMENTED` until they are real (`apps/api/src/routes/stubs.ts`, `STUB_PHASE = 'Phase 2'`). A route that accepts bytes it cannot store is a lie; the registry already refuses that (`apps/api/src/storage/registry.ts`, `requireStorageProvider`). Do not weaken either.
3. **Ownership is from the database, never the request.** `ownerKey` is a stored generated column; the authorization layer compares against it (`apps/api/src/authz.ts`, `isOwner`, `assertFileOwnership`). Do not introduce any code path that trusts a client-supplied owner id, folder id, or visibility.
4. **Cross-owner answers are 404, not 403.** The project deliberately makes another principal's resource indistinguishable from a missing one. Preserve that for uploads, files, downloads, shares, and deletion.
5. **Secrets stay out of code, logs, responses, and chat.** Telegram bot token and chat id are read at provider-attach time from the runtime environment (`apps/api/src/storage/registry.ts`, `readEnv`), not from the resolved `ApiConfig`. `.env` is git-ignored; the infra credential files in both repos exist and are sensitive. Never echo credential values.
6. **Telegram limits are honest limits, not bugs to hide.** The provider explicitly declares `resumableUpload: false`, `rangedRead: false`, `directDownloadUrl: false`, `serverSideChecksum: false`, `permanentRetention: false`, `guaranteedDurability: false`, `deleteIsFinal: false` (`apps/api/src/storage/providers/telegram.ts`, `capabilities`). Telegram can keep serving a deleted file; the provider compensates with a **process-local** tombstone (`deleted` Set). Do not claim deletion is final. Do not claim durability. Do not claim ranged reads work.
7. **Redis is best-effort for limits and the worker is not a permanent server.** `@fastify/rate-limit` is registered with `skipOnError` (`apps/api/src/server.ts`), so an unreachable Redis fails open. The worker (`services/worker/src/index.ts`) explicitly does not consume a queue yet. Do not turn GitHub Actions into a permanent app server or file proxy; the project already says the api-host workflow is an ephemeral development deployment (D26/D34/D37).

---

## The actual starting state (what exists today, file by file)

### Upload workflow — largely implemented, provider is the variable
- Route handler: `apps/api/src/routes/uploads.ts`
  - `POST /api/v1/uploads` — declares file, checks size, checks open-session cap (`services.uploadSessions.assertCapacity`), checks daily upload-start cap (`countFilesCreatedSince`), asserts folder ownership if named, creates the file row in `pending_upload`, **reserves quota before any byte moves** (`reserveStorage`), then opens the provider session (`provider.initiateUpload`); on provider failure it releases the reservation and transitions the file to `failed`; on success it transitions to `uploading`, and for anonymous uploads issues a one-time deletion token whose SHA-256 is stored (`setDeletionTokenHash`).
  - `PUT /api/v1/uploads/:uploadId/parts/:partNumber` — ownership-scoped session lookup, state guard (`initiated`/`in_progress`), content-length + part-size checks, optional per-part checksum header (`x-part-checksum-sha256`), delegates to `provider.uploadPart`, then `markPartReceived`.
  - `GET /api/v1/uploads/:uploadId` — progress view.
  - `POST /api/v1/uploads/:uploadId/complete` — `provider.finalizeUpload` (idempotent), `insertActiveStorageObject`, `commitReservation`, then file transitions `uploading → uploaded → (scanning|ready)`.
  - `DELETE /api/v1/uploads/:uploadId` — `provider.abortUpload`, `releaseReservation`, file transition to `failed`.
- Session registry: `apps/api/src/storage/upload-sessions.ts` — `UploadSessionStore`, process-local, ownership-scoped reads, open-session cap, sweep on lookup/create.
- Provider contract: `packages/shared/src/storage/types.ts` (interface), `packages/shared/src/storage/capabilities.ts` (capability flags + `assertCapability`), `packages/shared/src/storage/testing/storage-contract.ts` (`describeStorageProviderContract`).
- In-process test double: `packages/shared/src/storage/testing/memory-provider.ts` — `MemoryStorageProvider`, test-only, refused in production by the registry.
- Telegram provider: `apps/api/src/storage/providers/telegram.ts` — multipart + single-shot, spooled whole-object upload, retried reads/writes, bounded verify window, locator encoding, process-local deletion tombstone.
- Telegram transport: `apps/api/src/storage/providers/telegram-transport.ts` — `TelegramHttpTransport`, `sendDocument` (buffered `FormData` for parts, streamed multipart body with `duplex: 'half'` for whole-object), `getFile`, `download` (public file URL or local-file or `filesBaseUrl` rewrite for `--local`), `deleteMessage`, `getMe`, error classification (`TelegramApiError`, `TelegramNotFoundError`, `TelegramPayloadTooLargeError`, `TelegramRateLimitedError`).
- Provider registry: `apps/api/src/storage/registry.ts` — `resolveStorageProvider` returns `StorageResolution`; `STORAGE_PROVIDER=none` → 503; `memory-test` → refused in production; `telegram-experimental` → attached only when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_STORAGE_CHAT_ID` present, `productionSafe: false`.
- Services wiring: `apps/api/src/services.ts` — `AppServices` includes `storage: StorageResolution`, `uploadSessions: UploadSessionStore`, `redis: RedisConnection | null`.
- Config: `apps/api/src/config.ts` — `STORAGE_PROVIDER` enum `['none','memory-test','telegram-experimental']`; Telegram vars optional; `storageProvider` selection + `telegram.configured`.
- Limits: `packages/shared/src/limits.ts` — `TARGET_MAX_FILE_SIZE_BYTES = 2 GiB`, `DEFAULT_CHUNK_SIZE_BYTES = 8 MiB`, `MIN_CHUNK_SIZE_BYTES = 1 MiB`, `MAX_CHUNK_SIZE_BYTES = 2,000,000,000`, `MAX_PARTS_PER_UPLOAD = 10,000`, `maxFileSizeVerified: false` by default.
- API contracts: `packages/shared/src/api.ts` — `initiateUploadRequestSchema`, `initiateUploadResponseSchema` (includes optional `deletionToken`), `uploadPartResponseSchema`, `uploadStatusResponseSchema`, `completeUploadResponseSchema`, `UPLOAD_PART_CHECKSUM_HEADER = 'x-part-checksum-sha256'`.
- Quota: `apps/api/src/db/repositories/quota.ts` — `reserveStorage`, `commitReservation`, `releaseReservation`, `sweepExpiredReservations`, `readQuotaSummary`; `quotaArgsFor` maps principal to the SQL function shape; refusal reasons are a closed vocab (`packages/shared/src/domain/quota.ts`, `QUOTA_REFUSAL_REASONS`).

### Download — route exists, implementation is partial
- Route handler: `apps/api/src/routes/files.ts`
  - `GET /api/v1/files/:fileId/content` — asserts ownership, checks `isServable(file.state, { scanningEnabled })`, looks up the active storage object (`findActiveStorageObjectByFileId`), calls `provider.openReadStream(object.ref)`, sets `content-type`, `content-length`, `content-disposition` (conservative ASCII+encoded filename), `cache-control: private, no-store`, `accept-ranges: none`, and replies with `Readable.from(read.stream)`.
  - This route is wired and honest: it refuses non-servable states with 409, missing objects with 404, and it never streams a non-servable file. What it does **not** yet do in production is depend on a real provider being attached — the provider is required by `requireStorageProvider`, so the route fails with 503 when no provider is configured.
- File repository: `apps/api/src/db/repositories/files.ts` — `findFileById` (owner-scoped), `findFileByIdForAccessCheck` (unscoped, for share/deletion-token paths), `createFile`, `applyFileTransition` (compare-and-set `WHERE status = $from`), `countFilesCreatedSince`, `setDeletionTokenHash`, `findDeletionTokenHash`.
- Storage-object repository: `apps/api/src/db/repositories/storage-objects.ts` — `insertActiveStorageObject` (idempotent via existing-active check), `findActiveStorageObjectByFileId`, `markStorageObjectDeleted`.
- Servable decision: `packages/shared/src/domain/file-states.ts` — `isServable` returns true only for `ready`, or `uploaded` when scanning is disabled; `countsAsStored` mirrors `opendrive_used_storage` (excludes `pending_upload`/`uploading`/`failed`/`deleted`).
- Share resolution (used by the share download path, not yet a download route): `packages/shared/src/domain/share-links.ts` — `resolveShareLink` checks revocation, expiry, download limit, file deletion, `isServable`, and scan pass; `isShareRefusalIndistinguishable` for most reasons.

### Deletion — route exists, implementation is partial
- Route handler: `apps/api/src/routes/files.ts`
  - `DELETE /api/v1/files/:fileId` — two paths:
    - Authenticated owner: `requireScope(identity, filesWrite)`, `assertFileOwnership`, then find active object, `provider.deleteObject(object.ref)`, `markStorageObjectDeleted`, then `applyFileTransition(... to 'deleted')` if not already deleted.
    - Anonymous deletion token: require `x-deletion-token` header, `findFileByIdForAccessCheck`, `findDeletionTokenHash`, `sha256Hex(token)`, constant-time `tokensEqual`; wrong token or missing file → 404 indistinguishable; then same object-delete + row-transition sequence.
  - This route is wired and honest; it already implements the order "delete object first, then mark row deleted" and the constant-time token compare. It does **not** yet depend on a real production provider being attached — same 503 reality as the rest of the transfer paths.
- Deletion-token vault: `apps/api/src/db/repositories/files.ts` — `setDeletionTokenHash`, `findDeletionTokenHash` (deliberately separate from entities; never serialized).

### Shares — implemented for metadata, download path not yet a route
- Route handler: `apps/api/src/routes/shares.ts` (existing).
- Share repository: `apps/api/src/db/repositories/shares.ts` — `insertShare`, `findShareByTokenHash`, `listSharesForFile`, `revokeShare` (owner-scoped, status+revoked_at in one statement).
- Resolution logic: `packages/shared/src/domain/share-links.ts` — `resolveShareLink`, `shareRefusalAuditAction`.

### Authentication / identity / authorization — done, do not rewrite
- Identity resolution: `apps/api/src/auth/identity.ts` — Supabase access token, anonymous session credential (`ods_...`), API key (`odk_...`); three-credential model; profile provisioning on first use; account status / disabled checks; constant-time key digest compare; session expiry + revocation on every request.
- Token verification: `apps/api/src/auth/tokens.ts` — `createAccessTokenVerifier`; HS256 secret or JWKS; algorithm allow-list per source; issuer/audience/expiry/role claims; `service_role` refused.
- Authorization: `apps/api/src/authz.ts` — `requireIdentity`, `requireUser`, `requireSessionCredential`, `requireScope`, `ownerKeyOf`, `principalOf`, `isOwner`, `assertFileOwnership`, `assertFolderOwnership`, `mayReadFileMetadata`.
- Identity payload mapping: `apps/api/src/auth/payload.ts` — `toAuthContext`.
- IP hashing: `apps/api/src/auth/ip-hash.ts` — keyed hash, null when secret unset.

### System / readiness / limits — done
- `apps/api/src/routes/system.ts` — `/healthz`, `/readyz`, `/api/v1/limits`.
- `apps/api/src/dependencies.ts` — probes for postgres/redis/storage/auth; `evaluateReadiness`.
- `apps/api/src/db/role-safety.ts` — `inspectDatabaseRole`; `BYPASSRLS` disclosed as ok, superuser/table-owner/RLS-less-table as degraded.
- `apps/api/src/redis.ts` — optional `RedisConnection`, `createRedisConnection`, `ping`.

### DB layer — done
- `apps/api/src/db/client.ts` — `createDatabaseClient`, `requireSql` → 503 when unconfigured.
- `apps/api/src/db/errors.ts` — constraint-name → error-code translation.
- `apps/api/src/db/entities.ts` — stored row shapes (include internal fields like `ownerKey`, `tokenHash`, `credentialHash`, `keyHash`).
- `apps/api/src/db/mappers.ts` — `toFileRecord`, `toAuthContext`, `toQuotaSummary`, etc.; contract tests assert internal fields do not leak.
- `apps/api/src/db/parse.ts` — byte-count + timestamp parsing.

### Worker — contracts declared, no queue consumer
- `services/worker/src/index.ts` — self-check report; declares 5 jobs: `scan.requested`, `retention.expire_uploads`, `retention.expire_shares`, `maintenance.cleanup_orphans`, `moderation.apply_takedown`.
- `services/worker/src/jobs/registry.ts` — `JobRegistry`, payload contracts, dispatch with `not_implemented` outcome for declared jobs.
- `services/worker/src/jobs/types.ts` — job types.
- SQL already has `opendrive_sweep_expired_reservations`; the worker just isn't consuming a queue yet.

### Tests — know what exists before adding more
- Integration harness: `tests/integration/src/harness.ts` — `createHarness`, `memoryStorage()`, `createAccount`, `createAnonymousSession`, `createApiKey`, `createFileFixture`, `signUserToken`, `bearer`, `TEST_JWT_SECRET`/`TEST_ISSUER`/`TEST_AUDIENCE`.
- Integration uploads: `tests/integration/src/uploads.test.ts` — full upload workflow with the in-memory provider: single-part round-trip with byte-exact download, multi-part out-of-order assembly, progress + premature-complete refusal, isolation (another account sees 404), abort releases hold + fails file, owner deletion + stop serving, anonymous deletion token (correct/wrong/none), enforcement (file too large before any bytes, open-session cap, oversize part).
- Integration identity/ownership/shares/quota: `tests/integration/src/identity.test.ts`, `ownership.test.ts`, `shares.test.ts`, `quota.test.ts`.
- E2E: `tests/e2e/src/api-smoke.test.ts` — compiles and drives the built server over a real socket; currently forces unconfigured state (`DATABASE_URL=''`, `STORAGE_PROVIDER='none'`) and asserts liveness, readiness 503 with named missing vars, limits, unauthenticated upload 401, validation, OpenAPI doc, defensive headers, unknown route 404, graceful SIGTERM shutdown.
- Provider tests: `apps/api/src/storage/providers/telegram.test.ts` and `apps/api/src/storage/providers/telegram.live-single-2gb.test.ts`; contract suite `packages/shared/src/storage/testing/storage-contract.ts` run against `MemoryStorageProvider`.

---

## What you are actually completing

The project already has the upload engine and the download/delete routes written against the storage interface. The gap between "implemented as a workflow" and "a working file-transfer service" is mostly about **attaching a real, measured provider and making the transfer paths provably work end to end**, plus the operational pieces (real DB application, Redis failure behavior, job consumer, evidence).

Do the work in this order, because each task depends on the previous one being real rather than assumed.

---

### Task 1 — Establish a verified baseline

**Goal:** before changing code, know exactly what passes today and what fails, and inspect every transfer-related module so later changes are anchored in what exists.

**Do:**
1. Read `CURRENT-STAGE.md` end to end.
2. Inspect these files in full:
   - `apps/api/src/routes/uploads.ts`
   - `apps/api/src/routes/files.ts`
   - `apps/api/src/storage/upload-sessions.ts`
   - `apps/api/src/storage/registry.ts`
   - `apps/api/src/storage/providers/telegram.ts`
   - `apps/api/src/storage/providers/telegram-transport.ts`
   - `apps/api/src/db/repositories/files.ts`
   - `apps/api/src/db/repositories/storage-objects.ts`
   - `apps/api/src/db/repositories/quota.ts`
   - `packages/shared/src/storage/types.ts`
   - `packages/shared/src/storage/capabilities.ts`
   - `packages/shared/src/storage/testing/storage-contract.ts`
   - `packages/shared/src/storage/testing/memory-provider.ts`
   - `packages/shared/src/domain/file-states.ts`
   - `packages/shared/src/domain/share-links.ts`
   - `packages/shared/src/domain/quota.ts`
   - `apps/api/src/config.ts`
   - `apps/api/src/services.ts`
   - `apps/api/src/server.ts`
   - `apps/api/src/dependencies.ts`
   - `apps/api/src/redis.ts`
   - `apps/api/src/authz.ts`
   - `apps/api/src/auth/identity.ts`
   - `apps/api/src/auth/tokens.ts`
   - `tests/integration/src/uploads.test.ts`
   - `tests/integration/src/harness.ts`
   - `tests/e2e/src/api-smoke.test.ts`
   - `services/worker/src/index.ts`
   - `services/worker/src/jobs/registry.ts`
3. Run the existing verification commands that can run without credentials:
   - `pnpm format:check`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm build:libs && pnpm --filter @opendrive/api build`
   - `pnpm test`
   - `pnpm test:e2e`
4. If a local PostgreSQL is available, run:
   - `pnpm db:verify`
   - `pnpm db:test:integration`
5. Record the results verbatim: command, exit code, and any failures. If a command cannot run (no psql, no compiled output, no PG), say so explicitly and do not invent a pass.
6. From the code, write a short map of which transfer operations already have a real implementation path and which still hit `requireStorageProvider` → 503 / `notImplemented` → 501:
   - Upload initiate/part/complete/abort
   - Download
   - Owner deletion
   - Anonymous deletion-token deletion
   - Share resolution (metadata-only today)
   - Worker job consumption

**Deliverable:** a short baseline note listing the commands run, their results, the files inspected, and the real/501/503 map above. Do not change code in this task.

---

### Task 2 — Validate the real database integration safely

**Goal:** make the real Supabase application status explicit, and provide a safe operator procedure for applying the migrations and re-verifying RLS/role — without printing credentials or destructive commands.

**Do:**
1. Identify the exact migration files this repo owns:
   - `supabase/migrations/20261010000001_initial_schema.sql`
   - `supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql`
2. Identify the **separate** repo that hosts the self-hosted Supabase/Redis backend:
   - `C:/Users/basud/OneDrive/Desktop/supabase-actions/`
   - Its `supabase/migrations/` are the **upstream stack's** migrations (numbered 001–008), not OpenDrive's.
3. From `apps/api/src/dependencies.ts` and `apps/api/src/db/role-safety.ts`, restate the role requirements in plain language:
   - The API connects directly to PostgreSQL (not PostgREST).
   - `files` does not use `FORCE ROW LEVEL SECURITY`.
   - A table owner or superuser would bypass RLS.
   - The readiness probe reports `BYPASSRLS` as `ok` (by design) and reports superuser/table-owner/RLS-less-table as `degraded`.
4. Write a **non-destructive** operator procedure for applying the OpenDrive migrations to the intended self-hosted Supabase instance and re-verifying, covering:
   - How to confirm `DATABASE_URL` points at a reachable PostgreSQL the runner/machine can actually reach (not merely a tunnel-only hostname).
   - How to confirm the connected role is the intended non-owner application role.
   - How to apply migrations in filename order.
   - How to re-run the local suites after applying.
   - How to record the output.
5. Explicitly mark anything you cannot verify remotely as **unverified operator-run procedure**, and do not print any real credential, connection string, or destructive SQL.

**Deliverable:** a safe, credentials-free migration/verification procedure and a clear statement of the current real-DB status (verified / not verified / blocked), with the role-hazard reminder.

---

### Task 3 — Complete uploads against a real provider

**Goal:** make the upload workflow work end to end against a real, configured storage provider without breaking the existing reserve-before-byte, idempotency, part-ordering, abort, and failure semantics.

**The implementation already exists as a workflow.** Your job is to make it work against a real provider and to keep it honest about what that provider can and cannot do.

**Do:**
1. Use the existing seams; do not re-implement the workflow:
   - `apps/api/src/routes/uploads.ts`
   - `apps/api/src/storage/upload-sessions.ts`
   - `apps/api/src/storage/registry.ts`
   - `apps/api/src/db/repositories/files.ts`
   - `apps/api/src/db/repositories/quota.ts`
   - `apps/api/src/db/repositories/storage-objects.ts`
2. Verify the provider path you intend to use:
   - If using `telegram-experimental`, use the existing `TelegramStorageProvider` + `TelegramHttpTransport`; do not rewrite them unless a real failure shows they are wrong.
   - If the chosen provider is not Telegram, implement against the existing `StorageProvider` interface and run `describeStorageProviderContract` before enabling it.
3. Confirm the upload path preserves:
   - Size check before anything is written.
   - Open-session cap (`assertCapacity`) before the metadata row and hold are created.
   - Daily upload-start cap (`countFilesCreatedSince`).
   - Folder ownership if a folder is named.
   - Quota reservation **before** the provider session is opened.
   - Rollback on provider-initiate failure (release reservation + transition file to `failed`).
   - File transition `pending_upload → uploading` after the session is opened.
   - Anonymous deletion token issued once, hashed, stored, never returned again.
   - Part recv guarded by state + declared size + part-size ceiling + duplicate-part refusal.
   - Complete is non-destructive: a failed finalize does not orphan a recoverable upload.
   - Abort releases the hold and transitions the file to `failed`.
   - Cross-owner upload sessions are invisible (404).
4. Add/update tests that prove the real-provider path, distinguishing:
   - In-memory double tests (fast, no network).
   - Local PostgreSQL integration tests with a real provider if one is available.
   - Live external-service tests only if a real provider is reachable, and label them clearly.
5. Do **not** enable a provider for production bytes until its limits are measured and recorded. If measurement is not possible in this session, leave `maxFileSizeVerified: false` and say so.

**Deliverable:** whichever upload pieces you completed or verified, the tests added/updated, and an explicit note on whether the provider is enabled for bytes yet or still experimental.

---

### Task 4 — Implement downloads

**Goal:** make `GET /api/v1/files/:fileId/content` provably stream bytes from the configured provider with correct authorization, correct state checks, correct headers, bounded memory, and no fake success.

**Do:**
1. Reuse the existing route in `apps/api/src/routes/files.ts`; the scaffold is already there.
2. Verify the route keeps:
   - Ownership assertion for authenticated owners.
   - `isServable` check; non-servable states → 409.
   - Active storage object lookup; missing object → 404.
   - Deletion-token path for anonymous deletion (separate from ownership).
   - `content-type`, `content-length`, `content-disposition`, `cache-control: private, no-store`, `accept-ranges: none`.
   - Streaming via `Readable.from(read.stream)`, not whole-body buffering.
3. If a provider supports ranged reads, only then consider `Range` handling; until then `accept-ranges: none` is the honest answer and partial requests should not return wrong partial content. The existing provider declares `rangedRead: false`.
4. Prove:
   - Owner downloads byte-exact content.
   - Another principal gets 404.
   - Non-servable files (including deleted/quarantined/failed/uploading) are not downloadable.
   - Missing storage object is reported honestly.
   - Streaming does not materialize the whole file in the API process for the sizes you test.
5. Share-based download is a separate concern: the share resolution logic exists, but a share download route is a new route if one is desired. If you add one, it must re-run `resolveShareLink` on every request and refuse indistinguishably for revoked/expired/etc.

**Deliverable:** the download behavior you verified, the tests added/updated, and an explicit note on ranged reads (supported or deliberately not supported for the chosen provider).

---

### Task 5 — Implement deletion

**Goal:** make owner deletion and anonymous deletion-token deletion work end to end, keeping token hashing, constant-time compare, ordered object-then-row deletion, and idempotent retry behavior.

**Do:**
1. Reuse the existing `DELETE /api/v1/files/:fileId` handler; it already implements the important parts.
2. Verify it keeps:
   - Owner path: authenticated, `files:write`, ownership assertion.
   - Anonymous path: `x-deletion-token` header required; wrong token or missing file → 404 indistinguishable; no credential → 401.
   - Constant-time token compare (`tokensEqual`).
   - `provider.deleteObject` first, then `markStorageObjectDeleted`, then `applyFileTransition(... to 'deleted')`.
   - Idempotent behavior where possible (repeat deletes should not error confusingly).
3. Be explicit about the provider's deletion semantics:
   - For Telegram, record that deletion is **not provably final** because the tombstone is process-local and Telegram may keep serving the file. The existing provider already does this; do not claim otherwise.
   - For any other provider, state its `deleteIsFinal` capability honestly.
4. Prove:
   - Owner deletes and the file is no longer downloadable.
   - Anonymous uploader deletes with correct token.
   - Wrong token is indistinguishable from missing file.
   - No credential is 401.
   - Failed provider deletion is handled gracefully and does not leave the row in a misleading state.

**Deliverable:** the deletion behavior you verified, the tests added/updated, and an explicit statement of whether deletion is final for the chosen provider.

---

### Task 6 — Validate Telegram experimentally (only if that is the chosen provider)

**Goal:** measure the real provider honestly, or document why it is not yet enableable for bytes.

**Do:**
1. Use the existing provider and transport; do not rewrite them just to look active.
2. If a real bot token/chat is available and you are authorized to use it:
   - Confirm `health()` reaches the bot.
   - Upload and download a file larger than 20 MiB **only** if a `--local` server or equivalent ceiling lift is actually in use; otherwise stay within the public API's measured limits.
   - Verify whole-object checksum matches after a round trip.
   - Test multi-part reconstruction for byte-exact content.
   - Test what you can safely test for interruption/recovery and orphan behavior.
3. If no real provider is available or authorized, document the blocker precisely instead of faking a measurement.
4. Record:
   - What you actually measured.
   - What you could not measure.
   - Whether `maxFileSizeVerified` can be set to `true` for any size, and if so, which size and when.
5. Do **not** delete or touch any Telegram content that is not part of an authorized test channel.

**Deliverable:** a measured/unmeasured/blocked summary with exact numbers where they exist, and an honest statement about whether Telegram is enableable for bytes yet.

---

### Task 7 — Complete distributed limits and job processing

**Goal:** make Redis behavior and the worker honest and safer where possible, without pretending the platform is more distributed or more durable than it is.

**Do:**
1. Redis rate limiting:
   - Re-read `apps/api/src/redis.ts` and `apps/api/src/server.ts`.
   - The current behavior is: with `REDIS_URL` set, counters are shared; with Redis unreachable, the limiter skips (`skipOnError`) and limits effectively disappear.
   - Decide and implement one of:
     - A safer bounded fallback for sensitive operations, **or**
     - An explicit, documented fail-open choice with the narrow failure window recorded (`redis unavailable + postgres available`).
   - Do not claim cluster-wide rate limiting works until you can show two instances behind the same Redis actually enforce the limit. The project already says upload sessions are process-local, so two simultaneous instances are intentionally unsupported; be consistent with that.
2. Upload sessions:
   - The session store is process-local by design. If the deployment will ever run more than one API instance, that is a real limitation to fix or to document, not to paper over.
3. Worker:
   - The worker has declared job contracts and a dispatch path, but no queue consumer.
   - If a durable queue backend (Redis) is available, implement the minimal consumer for the jobs that should run, using the existing `JobRegistry` and job types.
   - If no reliable worker host is available, document the blocker rather than pretending jobs run continuously.
   - Do not use GitHub Actions as a permanent job runner or file proxy.

**Deliverable:** the Redis/worker changes you made or the blockers you documented, with the exact current behavior of rate limiting and job processing.

---

### Task 8 — Tests and evidence

**Goal:** the transfer paths are proven by tests and live evidence, with mock/local/live tests clearly separated.

**Add or update tests for, at minimum:**
- Real-provider upload + byte-exact download (single-part and multi-part where possible).
- Quota exhaustion and concurrent reservation behavior.
- Interrupted upload and retry/abort behavior.
- Unauthorized private download (another principal → 404; non-servable → 409).
- Invalid, expired, and incorrect deletion tokens.
- Failed and repeated deletion.
- Missing storage objects.
- Provider timeouts/rate limits where you can trigger them safely.
- File state enforcement (no download from non-servable states; no finalize of incomplete upload; no abort of finalized upload).
- Cleanup and bounded-memory behavior for the sizes you can test.

**Run and report:**
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build:libs && pnpm --filter @opendrive/api build`
- `pnpm test`
- `pnpm test:e2e`
- `pnpm db:verify` (if PostgreSQL available)
- `pnpm db:test:integration` (if PostgreSQL available)
- Any provider contract run you performed

For each, record command + exit code + outcome. Clearly label which results are mock, local, and live external-service.

---

## Acceptance criteria

Do **not** claim Phase 2 complete until all of these are true **and evidenced**:

1. Working upload, download, and deletion paths replace the relevant `501`/`503` stubs for the configured provider, **or** the remaining stubs are explicitly listed with the reason they are still empty.
2. Authorization is still enforced on every transfer path: ownership for owners, share resolution for share downloads, deletion-token constant-time compare for anonymous deletion.
3. Quota reservation and release behavior is tested and re-verified, including the "refuse before any byte moves" property.
4. Storage integrity is verified: checksums/matchers are checked before an object becomes readable, and a mismatch does not make bytes available.
5. Provider limitations are documented honestly: durability, retention, ranged reads, direct download URLs, deletion finality, part size ceiling, and the maximum size that has actually been measured.
6. The real Supabase integration status is explicit: applied or not, role verified or not, RLS re-verified or not, with a safe procedure for the operator to do it.
7. Redis failure behavior and worker/job behavior are addressed or explicitly blocked, with the current behavior stated.
8. All executed checks and unexecuted checks are listed honestly, with their exit codes where available.

---

## Output format at the end

Return:
1. A short status summary: what was already real, what you completed, what remains blocked.
2. The exact files changed or created, with paths relative to the repo root.
3. The exact verification commands run and their results.
4. Any live provider measurements, with numbers and dates if they exist.
5. The remaining blockers, each labeled as code blocker / environment blocker / decision blocker.
6. The exact next steps, in order.

Do not begin the web UI or monetization work during this phase. Do not introduce paid services. Do not expose credentials. Do not reset production data. Do not deploy publicly without explicit approval.
