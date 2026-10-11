# OpenDrive architecture

Phase 0 status: this document describes the intended system and states plainly which parts
exist today. Nothing here claims a running capability that has no implementation.

## 1. Shape of the system

```
                 ┌──────────────────────────┐
  browser ──────▶│ apps/web (React + Vite)  │  static build, no server state
                 └───────────┬──────────────┘
                             │ HTTPS (same origin in dev via Vite proxy)
                 ┌───────────▼──────────────┐        ┌──────────────────────────┐
  CLI ──────────▶│ apps/api (Fastify)       │◀──────▶│ Postgres (Supabase)      │
  HTTP API users │ authz · quotas · limits  │        │ METADATA ONLY            │
                 └───────┬──────────┬───────┘        └──────────────────────────┘
                         │          │
                         │          └───────────────▶ Redis (rate limits, short-lived jobs)
                         │
                 ┌───────▼──────────────────┐
                 │ StorageProvider contract │──▶ memory-test  (test double, not durable)
                 └───────┬──────────────────┘──▶ telegram-experimental (Phase 2, unvalidated)
                         │                     ──▶ future: S3-compatible, VPS disk, … (candidate, undecided)
                 ┌───────▼──────────────────┐
                 │ services/worker          │  background jobs: scanning, retention, cleanup
                 └──────────────────────────┘
```

Three rules the picture encodes:

1. **Bytes are not in Postgres and not in Redis.** Postgres holds metadata; Redis holds
   ephemeral coordination state; the storage provider holds file contents.
2. **The API is the only component that talks to clients.** Storage provider identifiers and
   locators never leave the server (see `packages/shared/src/api.ts`, `fileRecordSchema`).
3. **Nothing streams through CI.** GitHub Actions lints, type-checks, tests and builds.

## 2. Workspace layout and responsibilities

| Path                  | Responsibility                                                                            | State after Phase 1                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/web`            | Presentation only. Renders status, calls the API, holds no authority.                     | Live status console (real API calls)                                                                               |
| `apps/api`            | HTTP surface: routing, validation, authorization, quotas, error shape, OpenAPI.           | Identity, sessions, API keys, folders, file metadata and shares are live; upload, download and delete answer `501` |
| `apps/cli`            | Operator and user command-line access.                                                    | `health`, `readiness`, `limits`, `version`, `help` — all real                                                      |
| `packages/shared`     | Contracts shared by every component: ids, errors, API schemas, limits, storage interface. | Complete and tested, plus the pure domain rules (principal, ownership, quota, share resolution, file states)       |
| `services/worker`     | Background processing: scanning, retention, orphan reconciliation.                        | Job contracts + queue semantics; no queue consumed yet                                                             |
| `supabase/migrations` | Metadata schema, RLS, indexes.                                                            | Two migrations, verified against a scratch PostgreSQL by 335 checks; not yet applied to the real Supabase project  |
| `tests/e2e`           | Tests against the compiled API process over a real socket.                                | Live (9 tests)                                                                                                     |
| `tests/integration`   | Tests of the API against a real PostgreSQL database.                                      | Live (61 tests)                                                                                                    |
| `docs/`               | Architecture, security, storage providers, decisions, roadmap.                            | This document set                                                                                                  |

Concern separation, mapped to where the code lives:

| Concern                             | Where                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Web presentation                    | `apps/web/src`                                                                                                                  |
| Authentication / authorization      | `apps/api/src/auth` (token verification, identity), `apps/api/src/authz.ts` (the authorization matrix), Supabase Auth, RLS      |
| File metadata / database operations | `apps/api/src/db` — the repository layer over Postgres; schema in `supabase/migrations/`                                        |
| Upload and download coordination    | Routes exist and answer `501`; the storage contract they will use is in `packages/shared/src/storage/types.ts`                  |
| Physical file storage               | Storage provider implementations behind that contract (none enabled)                                                            |
| Background processing               | `services/worker/src` (registry, queue contract, job payloads)                                                                  |
| Rate limiting and quotas            | `apps/api/src/server.ts` (global limiter), `packages/shared/src/limits.ts` (limits), quota SQL in `supabase/migrations/`        |
| Share links and expiration          | `apps/api/src/routes/shares.ts`, decisions in `packages/shared/src/domain/share-links.ts`                                       |
| Audit events and abuse reports      | Audit events are emitted by the API (`apps/api/src/db/repositories/audit.ts`); the abuse report surface answers `501` (Phase 4) |

## 3. Large-file handling (designed in Phase 0, implemented in Phase 1)

The 2 GB target must never require a 2 GB buffer anywhere.

- **Chunked, resumable uploads.** The client declares size and MIME type, receives an upload
  id and the provider's effective part size, then sends parts. `upload_sessions` records how
  far the client got so an interrupted upload can resume instead of restarting.
- **Bounded streaming.** `UploadPartInput.source` is an `AsyncIterable<Uint8Array>` and the
  contract forbids whole-object buffering; the in-memory double enforces a hard ceiling so a
  violation fails a test rather than a production node.
- **Configurable chunk sizes** with documented bounds (1 MiB – 64 MiB, default 8 MiB) and a
  part-count ceiling, resolved from the environment and validated at startup.
- **Integrity checks.** Per-part and whole-object SHA-256, verified before a file becomes
  readable (`integrityCheckFailed` in `packages/shared/src/storage/errors.ts`).
- **Cleanup of incomplete uploads.** Every session has `expires_at`; `retention.expire_uploads`
  (declared, Phase 1) aborts them and releases staged bytes.

## 4. Storage provider contract

Defined in [packages/shared/src/storage/types.ts](../packages/shared/src/storage/types.ts),
capabilities in [capabilities.ts](../packages/shared/src/storage/capabilities.ts), and the
provider matrix in [STORAGE-PROVIDERS.md](STORAGE-PROVIDERS.md).

The interface deliberately does **not** assume multipart uploads, random access, direct
download URLs or permanent retention:

- Every provider publishes `StorageCapabilities`; callers must call `assertCapability` before
  relying on optional behaviour, and unsupported operations fail with
  `STORAGE_CAPABILITY_UNSUPPORTED` instead of failing halfway through an upload.
- `StorageProvider` covers initiate, part upload, whole-object upload, finalize, abort,
  metadata, ranged read, optional direct download URL, delete, usage and health.
- Uploads are stateful workflows: sessions have explicit states, `finalizeUpload` is
  idempotent, `abortUpload` is idempotent for repeated cleanup, `deleteObject` is idempotent,
  and duplicate part numbers are rejected rather than silently overwriting.
- The same contract suite (`storage/testing/storage-contract.ts`) will be run against every
  real provider before it is enabled.

## 5. Data ownership and reliability

| Data                                          | Authoritative store | Notes                                                             |
| --------------------------------------------- | ------------------- | ----------------------------------------------------------------- |
| File contents                                 | Storage provider    | Never Postgres, Redis, GitHub or CI artifacts                     |
| File metadata, shares, API keys, audit events | Postgres            | Redeployable API instances hold no state                          |
| Rate-limit counters, short-lived job state    | Redis               | Must be reconstructible; losing Redis must not lose file metadata |
| Upload progress                               | Postgres            | Survives an API restart so uploads can resume                     |

Failure handling that the design anticipates:

- **Interrupted uploads**: resumable sessions, expiry, and abort with staged-byte release.
- **Provider failure**: `health()` feeds readiness; providers surface
  `STORAGE_UNAVAILABLE`; retries happen at the part/object level, never by re-uploading a
  whole file blindly.
- **Duplicate requests**: idempotency keys at every state transition (upload id, job id,
  idempotent finalize/delete/abort).
- **Orphaned storage objects**: `storage_objects.state` can be `orphaned`; the
  `maintenance.cleanup_orphans` job reconciles both directions (object without metadata,
  metadata without object) and defaults to `dryRun: true`.

### Backup and restoration

Requirements (not yet implemented — no database or bucket exists yet):

1. Postgres: point-in-time recovery or scheduled logical dumps, stored **outside** the
   database host, with a documented retention window.
2. Storage: a provider-level replication or a periodic manifest-based copy. A provider with
   `guaranteedDurability: false` cannot be the only copy of anything that matters.
3. Migrations must be replayable from an empty database (`supabase db push`).
4. **A backup is not considered valid until a restoration test passes.** Phase 1 must
   include a restore drill: restore the newest dump into a scratch database, apply
   migrations, and verify that metadata rows match the storage manifest. Until that drill
   has run and its result recorded, no document may describe backups as working.

## 6. Deployment topology (target, contingent on verification)

- **VPS (existing)**: Postgres (Supabase) and Redis are already there; the API and worker are
  small Node processes. Capacity is not assumed unlimited: chunk size, concurrency and part
  limits are configuration, and the API holds no per-upload buffers beyond one part.
- **Web**: static files, deployable to the existing host or a free static host. Vercel's free
  tier is a candidate, deliberately **not** configured in Phase 0 — no `vercel.json` is
  committed, because a deployment configuration that has never been exercised is a claim,
  not a configuration.
- **GitHub Actions**: CI only. It is never a file proxy, CDN, durable job runner or
  application server; that would break GitHub's terms and this project's constraints.
- **Telegram**: experimental storage candidate; see [STORAGE-PROVIDERS.md](STORAGE-PROVIDERS.md)
  for limits, risks and the verification gate.

## 7. What the build deliberately does not have yet

As of Phase 1:

- No upload engine and no byte transfer: `POST /api/v1/uploads` and the part/complete/abort routes
  answer `501` with the phase that owns them.
- No download route, and no deletion (`files.delete` answers `501`).
- No Redis client, so no shared rate-limit counters across instances.
- No storage provider implementation (the in-memory provider is a test double).
- No browser-facing sign-in flow: the API verifies tokens, it does not issue them.
- No malware scanning or abuse triage (Phase 4), and no deployment (Phase 5).

Each of those is visible as a `501` endpoint, a `not_configured` dependency, or a `declared`
job — never as a success response.
