# Self-hosted Supabase + Redis configuration audit

Read-only audit, 2026-10-18. **No code or `.env` value was changed.** Names and verdicts only;
no secret value appears in this file.

Topology under test (as recorded in `docs/SELF-HOSTED-BACKEND.md` and the generated credentials):

| Endpoint                                                             | What it is                                          | Reached by                                  |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `https://supabase.opendrive.indevs.in`                               | Kong → GoTrue, PostgREST, Studio                    | HTTPS                                       |
| `https://supabase.opendrive.indevs.in/auth/v1/.well-known/jwks.json` | GoTrue signing keys (live: one **ES256** key)       | HTTPS                                       |
| `db.opendrive.indevs.in:5432`                                        | Postgres, raw TCP                                   | `cloudflared access tcp` → `127.0.0.1:5432` |
| `redis-tcp.opendrive.indevs.in:6379`                                 | Redis, raw TCP                                      | `cloudflared access tcp` → `127.0.0.1:6379` |
| `redis.opendrive.indevs.in`                                          | Redis Commander **web UI**, not a protocol endpoint | HTTPS                                       |

## 1. What the process actually reads

47 names are read by `apps/api` (the zod schema in `apps/api/src/config.ts` is the complete
surface; nothing else reads `process.env` except `STORAGE_PROVIDER`'s token in
`storage/registry.ts`, which is passed the same environment). `apps/web` reads exactly three
`import.meta.env` names. `services/worker` reads **none** — its package description says "Redis
wiring is Phase 2", and no `REDIS_URL` consumer exists there yet.

`apps/api/src/env.ts` loads the nearest `.env` at or above `apps/api/src`, so the repository-root
`.env` is what a local run sees, and a real environment variable wins over the file. Both were
verified (see §5).

### 1.1 Topology-bearing variables

| Variable                    | Value shape for this topology                                                      | Local `.env` | Verdict                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`              | `https://supabase.opendrive.indevs.in`                                             | absent       | **Inert.** Parsed and validated, read by no production code. Setting it changes nothing.                                                      |
| `SUPABASE_ANON_KEY`         | JWT from the workflow run summary                                                  | absent       | **Inert in the API.** Only the web bundle needs an anon key, under its `VITE_` name.                                                          |
| `SUPABASE_SERVICE_ROLE_KEY` | JWT from the workflow run summary                                                  | absent       | **Inert in the API** (deliberately: the API uses its own Postgres login role, not PostgREST).                                                 |
| `SUPABASE_JWKS_URL`         | `https://supabase.opendrive.indevs.in/auth/v1/.well-known/jwks.json`               | absent       | **Required.** Live endpoint answers `200` with one ES256 key (verified).                                                                      |
| `SUPABASE_JWT_SECRET`       | GoTrue `JWT_SECRET` (HS256)                                                        | absent       | **Secondary only.** This instance signs access tokens with ES256; the shared secret verifies HS256 tokens, which this instance does not mint. |
| `SUPABASE_JWT_ISSUER`       | `https://supabase.opendrive.indevs.in/auth/v1`                                     | absent       | **Required.** When unset, `iss` is not checked at all (`tokens.ts` drops it from `requiredClaims` and from `jwtVerify`).                      |
| `SUPABASE_JWT_AUDIENCE`     | `authenticated`                                                                    | absent       | Correct by default.                                                                                                                           |
| `DATABASE_URL`              | `postgres://opendrive_app:<pw>@127.0.0.1:5432/postgres` **while a tunnel is open** | absent       | **Required, and tunnel-dependent.** No pooler in this topology; `postgres.js` connects directly.                                              |
| `REDIS_URL`                 | `redis://default:<pw>@127.0.0.1:6379/0` **while a tunnel is open**                 | absent       | **Optional but wanted.** Without it limits are per-process and the read cache is inert.                                                       |
| `USER_CACHE_ENABLED`        | `true`                                                                             | absent       | On by default; inert without `REDIS_URL`.                                                                                                     |
| `USER_CACHE_TTL_SECONDS`    | `15`                                                                               | absent       | Default is fine.                                                                                                                              |
| `VITE_SUPABASE_URL`         | `https://supabase.opendrive.indevs.in`                                             | absent       | **Required for the web build**; not read from the root `.env` (see §3, F4).                                                                   |
| `VITE_SUPABASE_ANON_KEY`    | anon JWT                                                                           | absent       | **Required for the web build.** Public by design.                                                                                             |
| `VITE_API_BASE_URL`         | `https://api.opendrive.indevs.in` in the deployed build; empty = same-origin proxy | absent       | Default (`''`) is correct for `vite dev`; a deployed build must bake the API origin.                                                          |

There is **no Supabase Storage / S3 configuration anywhere** in `apps/api`, `apps/web` or
`packages/shared`: no bucket name, no `/storage/v1` endpoint, no access/secret pair. File bytes go
to the storage provider (`none`, `memory-test`, `telegram-experimental`). "Supabase storage
endpoint defaulting to cloud" therefore does not apply to this repository; nothing can silently
resolve to it because nothing exists to resolve.

### 1.2 Remaining API variables (not topology-bearing)

All are read by `config.ts`; none names a host or endpoint, so none can resolve to a cloud service
by default.

`NODE_ENV`, `API_HOST`, `API_PORT`, `LOG_LEVEL`, `DOCS_ENABLED`, `CORS_ORIGINS`,
`RATE_LIMIT_ENABLED`, `RATE_LIMIT_REQUESTS_PER_MINUTE`, `RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE`,
`TRUST_PROXY`, `UPLOAD_SESSION_TTL_HOURS`, `UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL`,
`STORAGE_PROVIDER`, `STORAGE_MAX_FILE_SIZE_BYTES`, `STORAGE_CHUNK_SIZE_BYTES`, `IP_HASH_SECRET`,
`PREVIEW_SIGNING_SECRET`, `PREVIEW_TOKEN_TTL_SECONDS`, `EDGE_CACHE_ENABLED`, `EDGE_CACHE_DIR`,
`EDGE_CACHE_MAX_BYTES`, `EDGE_CACHE_TTL_SECONDS`, `EDGE_DELIVERY_SIGNING_SECRET`,
`EDGE_DELIVERY_TTL_SECONDS`, `EDGE_PUBLIC_MAX_AGE_SECONDS`, `ANONYMOUS_SESSION_TTL_HOURS`,
`ANONYMOUS_UPLOADS_PER_DAY`, `REGISTERED_UPLOADS_PER_DAY`, `PUBLIC_BASE_URL`,
`MALWARE_SCAN_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_STORAGE_CHAT_ID`,
`TELEGRAM_API_BASE_URL`, `TELEGRAM_MAX_PART_SIZE_BYTES`, `TELEGRAM_WORK_DIR`,
`TELEGRAM_FILES_BASE_URL`.

`.env.example` and the code disagree in six places: it documents three names nothing reads
(`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `ABUSE_CONTACT_EMAIL`) and omits two it does read
(`TRUST_PROXY`, and `TELEGRAM_WORK_DIR` / `TELEGRAM_FILES_BASE_URL` appear only as comments).

## 2. The local `.env` state

17 keys are present: `NODE_ENV`, `API_HOST`, `API_PORT`, `LOG_LEVEL`, `CORS_ORIGINS`,
`DOCS_ENABLED`, `RATE_LIMIT_ENABLED`, `STORAGE_PROVIDER`, five `TELEGRAM_*`, `TELEGRAM_API_ID`,
`TELEGRAM_API_HASH`, and three deployment tokens.

**It defines none of the ten variables that name the deployed topology** (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_SECRET`,
`SUPABASE_JWT_ISSUER`, `DATABASE_URL`, `REDIS_URL`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`). A local `pnpm dev` therefore runs with no metadata database, no shared
rate limiting, no read cache and no way to verify a login.

Observed, not inferred: four boot configurations against this `.env` (§5.1). The baseline answers
`/readyz` with `503` and `postgres`, `auth`, `redis` all `not_configured`.

## 3. Defaults and fallbacks that silently resolve elsewhere

| #   | Fallback                                                                                                                                                                                                                                                             | Where                                         | Severity                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| F1  | `SUPABASE_URL` is accepted and validated but read by no production code, so an operator who follows `.env.example` ("Supabase … metadata only") still gets `auth: not_configured`                                                                                    | `config.ts:68`, no consumer                   | **High** (silent no-op, verified)                     |
| F2  | `/readyz` reports `auth: ok — verified with the configured HS256 secret` on the _presence_ of `SUPABASE_JWT_SECRET`, without fetching the JWKS or checking the algorithm. A secret-only deployment behind an ES256 instance is green while every real login is `401` | `dependencies.ts` `probeAuth`                 | **High** (verified locally and against the live host) |
| F3  | `apiBaseUrl ?? 'https://api.telegram.org'` — file bytes silently go to Telegram's cloud Bot API when `TELEGRAM_API_BASE_URL` is unset                                                                                                                                | `storage/providers/telegram-transport.ts:195` | Low (documented trade-off, but silent)                |
| F4  | Vite loads `.env` from its own root (`apps/web`); `vite.config.ts` sets no `envDir`, and `apps/web` has no env file, so `VITE_*` in the repository-root `.env` is **ignored**. Exported shell variables and the build workflow still work                            | `apps/web/vite.config.ts`                     | Medium (local dev only)                               |
| F5  | `PUBLIC_BASE_URL` falls back to the bind address, `http://127.0.0.1:3000`, so share links minted locally name loopback                                                                                                                                               | `config.ts` `publicBaseUrl`                   | Medium if unset on a deployed host                    |
| F6  | Redis rate-limit keys use the plugin default namespace `fastify-rate-limit-<METHOD><URL>-<principal>`; the read cache uses `od:cache`. Both share db `/0` with the unrelated app that lives on the same instance                                                     | `server.ts:311`, `cache/user-cache.ts`        | Low (collision needs an identical route path)         |
| F7  | `db/client.ts` comments "a pooler handles the rest", but this topology has **no** PgBouncer: `max: 10` is the hard per-process ceiling                                                                                                                               | `db/client.ts:60`                             | Low (comment only)                                    |

Nothing else resolves to a cloud endpoint: `SUPABASE_URL` is never defaulted, the JWKS URL is never
derived, `DATABASE_URL` and `REDIS_URL` have no default, and there is no cloud storage client.

## 4. Gap list, verdict and minimal fix (config only — not applied)

| Gap                                                                                                                                     | Severity | Verdict                                                           | Minimal fix                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 The working `.env` names no part of the deployed topology                                                                            | **High** | Real                                                              | Add the nine API-side names from §1.1. A tunnel (`cloudflared access tcp --hostname db.… --url 127.0.0.1:5432`, same for `redis-tcp.…` → `127.0.0.1:6379`) must be running first. |
| G2 JWT verification is pointed at HS256 while the instance mints ES256                                                                  | **High** | Real (this instance)                                              | Set `SUPABASE_JWKS_URL` and `SUPABASE_JWT_ISSUER`. Keep `SUPABASE_JWT_SECRET` only if HS256 tokens are still issued.                                                              |
| G3 `DATABASE_URL`/`REDIS_URL` are unreachable without the Access tunnel; the public hostnames answer `443` only                         | Medium   | By design, but undocumented in `.env.example` beyond one sentence | Start the tunnels; keep both URLs on loopback ports.                                                                                                                              |
| G4 `TRUST_PROXY` is absent from `.env.example` and unverifiable from outside                                                            | Medium   | Unverified                                                        | Confirm on the host. Behind cloudflared every request arrives from loopback, so with `TRUST_PROXY` unset the per-address limit collapses to one global bucket.                    |
| G5 `.env.example` tells an operator to set three `SUPABASE_*` names the API never reads, and does not make the JWKS requirement primary | Medium   | Real                                                              | Reword the Supabase section; do not delete the names (the web's `VITE_` pair is separate). Report, not edit.                                                                      |
| G6 `VITE_*` are not found from the root `.env`                                                                                          | Medium   | Real (local dev)                                                  | Put them in `apps/web/.env.local`, or set `envDir` in `apps/web/vite.config.ts` (a code change; not made).                                                                        |
| G7 `/readyz` cannot see a broken JWKS when a secret is also configured                                                                  | Medium   | Real                                                              | Prefer the JWKS probe when `SUPABASE_JWKS_URL` is set and report both sources (a ~5-line change; not made, this pass is read-only).                                               |
| G8 `PUBLIC_BASE_URL` unset                                                                                                              | Low      | Potential                                                         | Set it to the public API/web origin.                                                                                                                                              |
| G9 Redis key namespace on a shared instance                                                                                             | Low      | Real but harmless today                                           | Set a `nameSpace` on the rate limiter if another app ever uses the default prefix.                                                                                                |

## 5. Evidence

### 5.1 Boot configurations (local, real entry point `src/index.ts`)

| Run overrides                                             | `/readyz`                                                                                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| none (repo `.env` only)                                   | `503`: postgres `not_configured` (DATABASE_URL), auth `not_configured` (SUPABASE_JWKS_URL, SUPABASE_JWT_SECRET), redis `not_configured` (REDIS_URL), storage `ok` (Telegram bot reachable) |
| `SUPABASE_URL=https://supabase.opendrive.indevs.in`       | **identical to baseline** — proves F1                                                                                                                                                      |
| `SUPABASE_JWKS_URL=…/jwks.json` + `SUPABASE_JWT_ISSUER=…` | auth `ok — JWKS endpoint (1 key(s))`, rest unchanged                                                                                                                                       |
| `SUPABASE_JWT_SECRET=<throwaway>`                         | auth `ok — verified with the configured HS256 secret`, rest unchanged — proves F2                                                                                                          |
| unreachable `DATABASE_URL` + `REDIS_URL`                  | `503` in 0.69 s: postgres `unavailable` (ECONNREFUSED), redis `unavailable`; `/api/v1/limits` still `200`                                                                                  |

`API_PORT` supplied in the shell overrode the value in `.env` on every run, confirming that a real
environment variable beats the file.

### 5.2 The deployed environment

| Probe                                                              | Result                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET https://api.opendrive.indevs.in/healthz`                      | `200`, uptime ~12 036 s                                                                                                                                   |
| `GET https://api.opendrive.indevs.in/readyz`                       | `200 ready`: postgres `ok` (77 ms, role `opendrive_app`, RLS on every public table), auth `ok` (reported as HS256), redis `ok` (PING 75 ms), storage `ok` |
| `GET https://supabase.opendrive.indevs.in/auth/v1/health`          | `401` "No API key found in request" (Kong requires `apikey`)                                                                                              |
| `GET …/auth/v1/.well-known/jwks.json`                              | `200`, one `ES256`/`P-256` key                                                                                                                            |
| `GET …/rest/v1/`                                                   | `401`                                                                                                                                                     |
| `GET https://opendrive.indevs.in/` + `assets/index-*.js`           | `200`; bundle contains `https://supabase.opendrive.indevs.in` and `api.opendrive.indevs.in`                                                               |
| CORS preflight from `https://opendrive.indevs.in`                  | `204`, `access-control-allow-origin: https://opendrive.indevs.in`                                                                                         |
| CORS preflight from `https://evil.example`                         | `204` **without** an `allow-origin` header                                                                                                                |
| raw TCP `db.opendrive.indevs.in:5432` / `redis-tcp.…:6379`         | timeout after 6 s each (Cloudflare Access + no tunnel)                                                                                                    |
| `GET /api/v1/files` with an `ES256`-header token (bogus signature) | `401` "not valid" → the live API **does** attempt asymmetric verification                                                                                 |
| same with an `HS256` token (bogus signature)                       | `401` "not valid"                                                                                                                                         |
| no token                                                           | `401` "This endpoint requires a credential"                                                                                                               |

Conclusion: the **deployed** environment is reachable and consistent with the code — Postgres,
Redis, storage and JWKS all answer, the web bundle is built against the self-hosted instance, and
CORS admits exactly the deployed origin. The **local** checkout is not configured at all. The one
inconsistency on the host is reporting, not behaviour: `/readyz` says "HS256 secret" even though an
ES256 token reaches signature verification, so the JWKS is never health-checked there (G7).

### 5.3 Suites, types and lint (this machine: Node 24.22.0, no `pnpm` on PATH, no Docker, no psql)

| Check                               | Command                                                         | Result                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API unit tests                      | `apps/api/node_modules/.bin/vitest run`                         | **exit 0** — 303 passed, 1 skipped (25 files, 1 skipped)                                                                                                                                        |
| Web unit tests                      | `apps/web/node_modules/.bin/vitest run`                         | **exit 0** — 134 passed (12 files)                                                                                                                                                              |
| API typecheck                       | `tsc -p apps/api/tsconfig.json --noEmit`                        | **exit 0**                                                                                                                                                                                      |
| Web typecheck                       | `tsc -p apps/web/tsconfig.json --noEmit`                        | **exit 0**                                                                                                                                                                                      |
| ESLint                              | `eslint apps/api/src apps/web/src --max-warnings=0`             | **exit 1** — one pre-existing `no-floating-promises` error in `apps/api/src/cache/user-cache.test.ts:205`, part of the unrequested Redis read-cache work already in the tree. Not touched here. |
| `db:verify` / `db:test:integration` | `supabase/tests/run-local.sh`, `tests/integration/run-local.sh` | **Not runnable** — both need a local PostgreSQL (`PGHOST=127.0.0.1:5432`); no server, no `psql`, no Docker on this machine. They never touch the live instance by design.                       |

## 6. Security notes

- The credentials in the mission message are now in a chat transcript. Rotate
  `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `OPENDRIVE_APP_PASSWORD`, `JWT_SECRET` and the derived
  anon/service-role keys, then update the Actions secrets and `VITE_SUPABASE_ANON_KEY`.
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `OPENDRIVE_APP_PASSWORD` and the Studio password are the
  same value. Compromise of any one of them reaches the others.
- `opendrive-infra-credentials.txt` is git-ignored (`.gitignore:60`) and untracked — verified with
  `git check-ignore` and `git ls-files`. Keep it that way; it holds the values above.
- `docs/SELF-HOSTED-BACKEND.md` already records that Redis Commander and the tunnel hostnames are
  public and that the stack is ephemeral; nothing in this audit contradicts it.

## 7. Changes made

None to code or configuration. This file is the only addition.
