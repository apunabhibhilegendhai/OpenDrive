# Deploying the API (GitHub Actions + Cloudflare Tunnel)

This is how OpenDrive's API is made reachable from anywhere without paying for a host: a GitHub
Actions runner runs the API process and a `cloudflared` tunnel, and Cloudflare publishes the tunnel
over HTTPS. The rationale and its limits are in [docs/DECISIONS.md](DECISIONS.md) (D34); the
metadata/Redis backend this connects to is described in
[docs/SELF-HOSTED-BACKEND.md](SELF-HOSTED-BACKEND.md) (D26).

> This is a **development deployment**, not production. The runner is reclaimed at the end of the
> session, and the backend is ephemeral (D26). Never let it hold the only copy of anything.

## Topology

```
   browser / CLI / client
             │  HTTPS
             ▼
   https://api.opendrive.indevs.in        (Cloudflare proxied, TLS)
             │  Cloudflare Tunnel
             ▼
   GitHub Actions runner
     ├─ cloudflared  ──►  http://localhost:3000
     ├─ node apps/api/dist/index.js  ──►  DATABASE_URL (direct Postgres)
     └─ cloudflared access tcp  ──►  127.0.0.1:5432 / :6379  (Access-gated, see below)
```

Only the tunnel hostname is public. The API binds `127.0.0.1:3000` and is reached by `cloudflared`
on the same runner; it is never exposed directly.

## The one prerequisite that trips people up

The API opens a **direct `postgres://` connection**, not PostgREST. The self-hosted Supabase stack
(D26) publishes Postgres on its host, and the `database` tunnel exposes it at
`db.opendrive.indevs.in` behind a Cloudflare **Access** application. So the runner does not dial that
hostname itself; the workflow instead:

1. runs `cloudflared access tcp --hostname db.opendrive.indevs.in --url 127.0.0.1:5432` carrying a
   Zero Trust **service token** (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`), then
2. points `DATABASE_URL` at that loopback listener
   (`postgresql://opendrive_app:<password>@127.0.0.1:5432/postgres`).

Before the API starts, the workflow proves the tunnel carries a real session (`select 1`), so a
broken tunnel is reported as such instead of surfacing later as an unexplained `/readyz` 503.

`DATABASE_URL` may instead point at any PostgreSQL reachable from GitHub-hosted runners (a managed
instance, a separately tunnelled host); the Access-gated tunnel above is simply the intended
self-hosted path.

Redis, when configured, uses the same shape and the same service token: the workflow runs
`cloudflared access tcp --hostname redis-tcp.opendrive.indevs.in --url 127.0.0.1:6379` and points
`REDIS_URL` at `redis://default:<password>@127.0.0.1:6379/0`. It is optional — a failed Redis tunnel
is not fatal, the API starts anyway, and `/readyz` reports `redis`. The `redis-tcp` hostname must be
in the same Access application as `db` (one service token covers both).

## Two things that silently break readiness

Both of these were hit while bringing the public deployment up, and neither produces an obvious
error of its own.

- **Cloudflare Bot Fight Mode must be off for the zone.** The API fetches the JWKS endpoint
  (`supabase.opendrive.indevs.in`) at request time to verify access tokens. With Bot Fight Mode on
  (the default in some accounts), Cloudflare answers that fetch with **403** from GitHub's
  datacenter IPs while residential traffic passes — so `/readyz` reports `auth: unavailable` and this
  action's readiness gate can never pass. Turn it off under **Security → Bots**, or add a WAF
  exception for the JWKS path.
- **`opendrive_app` needs `EXECUTE` on the `public` functions.** The `opendrive_*` helpers are
  `SECURITY INVOKER` but revoke `PUBLIC`, granting only
  `postgres` / `anon` / `authenticated` / `service_role`. Without an explicit grant, every
  `POST /api/v1/uploads` fails with `42501 permission denied for function
opendrive_reserve_storage`. The `supabase-actions` session grants this on every start (step
  “Grant OpenDrive runtime privileges”).

## Setting up the tunnel (once)

1. In **Cloudflare Zero Trust → Networks → Tunnels**, create a tunnel (or reuse the existing one).
2. Copy its **token** — this becomes the `CLOUDFLARE_TUNNEL_TOKEN` secret below. It is a credential;
   it never belongs in the repository.
3. Add a **public hostname** to the tunnel with ingress service `http://localhost:3000`, for example
   `api.opendrive.indevs.in`. Because the ingress is remotely managed, the workflow passes no local
   config file — `cloudflared tunnel run --token …` is all it needs.

## Secrets (repository → Settings → Secrets and variables → Actions → Secrets)

| Secret                     | What it is                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Direct PostgreSQL URL the runner can reach (see the prerequisite above).                                                                                         |
| `CLOUDFLARE_TUNNEL_TOKEN`  | The tunnel token from Cloudflare Zero Trust.                                                                                                                     |
| `CF_ACCESS_CLIENT_ID`      | Access service-token id for the Access-gated Postgres tunnel.                                                                                                    |
| `CF_ACCESS_CLIENT_SECRET`  | Access service-token secret for the same tunnel.                                                                                                                 |
| `SUPABASE_JWKS_URL`        | Access-token verification (asymmetric). Prefer this over the secret below. JWKS verification fails if the path is behind Bot Fight Mode or Access.               |
| `SUPABASE_JWT_SECRET`      | HS256 fallback when no JWKS URL is configured.                                                                                                                   |
| `SUPABASE_JWT_ISSUER`      | Expected `iss` of an access token.                                                                                                                               |
| `IP_HASH_SECRET`           | HMAC key for hashed client addresses. Rotating it invalidates old hashes.                                                                                        |
| `REDIS_URL`                | Optional. `redis://…@127.0.0.1:6379/0` through the Access-gated `redis-tcp` tunnel; when set, rate-limit counters are shared (Redis) instead of in-process.      |
| `TELEGRAM_BOT_TOKEN`       | Telegram storage backend credential (D27).                                                                                                                       |
| `TELEGRAM_STORAGE_CHAT_ID` | The channel the bot stores objects in.                                                                                                                           |
| `VITE_SUPABASE_ANON_KEY`   | Publishable Supabase anon key, baked into the **web** bundle at build time (`web-host.yml`). It is designed to be shipped to browsers; RLS is the real boundary. |
| `VERCEL_TOKEN`             | Vercel API token used by `web-host.yml` to publish the web build to the `opendrive` project.                                                                     |

## Variables (repository → … → Variables)

Non-secret configuration. Optional ones fall back to the defaults shown by the workflow.

| Variable                                   | Default                         | Notes                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_PROVIDER`                         | `telegram-experimental`         | Must not be `none`, or uploads answer 503.                                                                                                                                                                                |
| `CORS_ORIGINS`                             | (empty → CORS off)              | Comma-separated browser origins.                                                                                                                                                                                          |
| `PUBLIC_BASE_URL`                          | (empty)                         | Origin used to build share links.                                                                                                                                                                                         |
| `STORAGE_MAX_FILE_SIZE_BYTES`              | `2147483648` (2 GiB)            | Per-deployment ceiling for a declared upload.                                                                                                                                                                             |
| `STORAGE_CHUNK_SIZE_BYTES`                 | `8388608` (8 MiB)               | Client part size; the provider may clamp it. Values above **32 MiB** are clamped with a startup warning (edge body cap and origin timeout).                                                                               |
| `TELEGRAM_API_BASE_URL`                    | `http://127.0.0.1:8081`         | Loopback → the job compiles, caches and starts the **Local Bot API** server, lifting the 20 MiB retrieval cap. Set to `https://api.telegram.org` to skip that ~20 min TDLib build — but then only 20 MiB files come back. |
| `TELEGRAM_MAX_PART_SIZE_BYTES`             | `20971520` (20 MiB)             | Largest single part. Must be downloadable by the Bot API **and** ≤ the edge-safe 32 MiB (`33554432`).                                                                                                                     |
| `RATE_LIMIT_REQUESTS_PER_MINUTE`           | `120`                           | Per principal.                                                                                                                                                                                                            |
| `RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE`       | `600`                           | Per principal, part route only.                                                                                                                                                                                           |
| `UPLOAD_SESSION_TTL_HOURS`                 | `24`                            | How long an incomplete upload keeps its hold.                                                                                                                                                                             |
| `UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` | `3`                             | Open uploads at once per principal.                                                                                                                                                                                       |
| `DATABASE_TUNNEL_HOSTNAME`                 | `db.opendrive.indevs.in`        | Access-gated hostname the DB tunnel is dialled at.                                                                                                                                                                        |
| `REDIS_TUNNEL_HOSTNAME`                    | `redis-tcp.opendrive.indevs.in` | Access-gated hostname the Redis tunnel is dialled at.                                                                                                                                                                     |
| `VITE_SUPABASE_URL`                        | (none)                          | `https://supabase.opendrive.indevs.in`. Baked into the web bundle.                                                                                                                                                        |
| `VITE_API_BASE_URL`                        | (none)                          | `https://api.opendrive.indevs.in`. Baked into the web bundle; the browser talks to the API directly, so this origin must be in `CORS_ORIGINS`.                                                                            |
| `VERCEL_ORG_ID`                            | (none)                          | Vercel team id, so the CLI deploys to the existing project instead of creating one. Not secret.                                                                                                                           |
| `VERCEL_PROJECT_ID`                        | (none)                          | Vercel project id (`opendrive`). Not secret.                                                                                                                                                                              |

> **The part size is capped by Cloudflare at 100 MiB, not by Telegram.** The public API is a
> Cloudflare-proxied hostname, so the edge rejects any request body above **100 MiB** with `413`
> before it reaches the origin (measured 2026-10-13: `104857600` passes, `105906176` fails).
> Keep `STORAGE_CHUNK_SIZE_BYTES` and `TELEGRAM_MAX_PART_SIZE_BYTES` at `104857600` (= 100 MiB).
> The Local Bot API server can hold a 2000 MB file, but that ceiling sits behind this one: a
> 2 GiB object arrives as **21 parts**, not one request. Setting the part size above 100 MiB
> makes every large part fail at the edge — it does not raise the ceiling.

## Running it

1. Make sure a `supabase-actions` session (or your own PostgreSQL) is up and `DATABASE_URL` points
   at it.
2. It runs on its own: `schedule` starts a run every four hours and `concurrency` queues it behind
   the running one, so the API stays up without anyone pressing a button. To start one now, use
   **Actions → API host (Cloudflare Tunnel) → Run workflow**, optionally setting the duration
   (default 300 minutes, capped at 330). A scheduled run uses the default duration.
3. Watch the job log: it prints when the API reports ready, then holds. The public URL is the tunnel
   hostname from step 3 of the tunnel setup.
4. To stop early, cancel the run — the trap kills the API, `cloudflared`, and both access tunnels.

The job is bounded by a 350-minute timeout so it can never outlive the runner's ceiling; the
in-step timer ends it cleanly before that.

## Verifying a run

```bash
curl -fsS https://api.opendrive.indevs.in/healthz     # liveness
curl -fsS https://api.opendrive.indevs.in/readyz      # dependencies: postgres, redis, storage
curl -fsS https://api.opendrive.indevs.in/openapi.json >/dev/null && echo docs ok
```

## Hosting the web app (Vercel)

The browser app is a static build published to Vercel at `https://opendrive.indevs.in`. It is built
and uploaded by `.github/workflows/web-host.yml` (D38), which runs on a push that touches
`apps/web/**`, `packages/shared/**`, or `pnpm-lock.yaml`, and can also be started by hand
(**Actions → Web host (Vercel) → Run workflow**).

The workflow:

1. installs the workspace, builds `@opendrive/shared`, then builds `@opendrive/web` with
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_API_BASE_URL` from repository settings;
2. copies `apps/web/vercel.json` (the SPA rewrite) beside the output; and
3. runs `vercel deploy apps/web/dist --prod`, authorizing with `VERCEL_TOKEN` and targeting the
   existing project through `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID`.

Vercel never builds the monorepo: a pnpm workspace needs every member's dependencies, and building
here keeps one toolchain (the same one CI uses) and hands Vercel a finished directory. The app talks
to the API directly from the browser, so `opendrive.indevs.in` must be listed in `CORS_ORIGINS`.

## Large uploads: one Telegram document per file

The public API is Cloudflare-proxied, so the edge rejects any single request body above **100 MiB**
(measured 2026-10-13: `104857600` passes, `105906176` fails). A file far larger than that therefore
_arrives_ as many parts, but it should still be stored as **one** Telegram document. The provider has
a staged mode for exactly that (D39):

- With `TELEGRAM_API_BASE_URL` pointing at the loopback Local Bot API server, the provider stages
  each received part to a local spool file instead of sending it. At `POST /uploads/:id/complete` it
  verifies the assembled length and whole-object checksum from the spool, reassembles the parts, and
  sends the object as a single `sendDocument` — up to the server's own 2000 MB ceiling.
- That send is slow, so `complete` answers **`202`** with `{ state: 'processing' }` while it runs in
  the background; the client polls the same endpoint until it answers **`200`** with the file. Small
  objects (≤ 64 MiB) still settle inside the first request, so the common case stays one round trip.
- The spool is removed only once the object is committed. A failed send leaves it in place, so a
  retry of `complete` re-sends from byte zero without the client re-uploading anything. Finalizing is
  idempotent: polling never starts a second send.

`STORAGE_MAX_FILE_SIZE_BYTES` (2 GiB) is the declared ceiling; with a 100 MiB part size a 2 GiB
object is uploaded as 21 parts and finalized as one document.

## What “multi-user uploads with rate limits” means here

- Every protected route resolves the caller to a principal and the limiter keys on **that** principal
  (user id, or anonymous session id), falling back to the client address only when no credential was
  proven (D33). A shared NAT no longer makes one caller's traffic everyone's problem.
- Ordinary requests are capped per principal (`RATE_LIMIT_REQUESTS_PER_MINUTE`); part uploads have
  their own, higher ceiling (`RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE`) because one upload is hundreds of
  requests.
- Two further bounds live in the upload engine: how many uploads a principal may **start** per day
  (`ANONYMOUS_UPLOADS_PER_DAY` / `REGISTERED_UPLOADS_PER_DAY`) and how many may be **open at once**
  (`UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL`). Storage bytes are bounded separately by the quota
  hold taken before any byte moves (D23).
- These counters are **shared across instances when `REDIS_URL` is set** (D37), and in-process
  otherwise; `/readyz` names which store is in use. Counter sharing is what makes the limits hold
  for the principal even if traffic lands on a different process.

**Verifying the ceilings.** Send a _concurrent_ burst, not a sequential loop: every request crosses
the Access tunnels to reach Postgres and Redis, so a sequential client only manages roughly 40
requests a minute — comfortably under a 120/minute ceiling and, on its own, proof of nothing. A
burst of 200 concurrent requests from one principal should show about `RATE_LIMIT_REQUESTS_PER_MINUTE`
answers of `200` and the remainder `429`, with a second, fresh principal still answered `200`.
Expect each request to pay one extra tunnel round trip for the Redis counter; that cost is the price
of shared limits here, and it is why the limiter fails _open_ rather than stalling if the tunnel
drops (D37).

## Why this is separate from CI

`ci.yml` must stay reproducible for anyone who clones the repository, so it uses throwaway service
containers and **no** secrets. This workflow is the opposite: it needs credentials and holds a
runner for hours. Keeping them in different files is what lets both contracts hold at once. Hosting
a multi-hour server on Actions is something GitHub's Acceptable Use Policies restrict, which is why
this only ever runs when an operator asks for it or a schedule fires (D26, D34, D37).
