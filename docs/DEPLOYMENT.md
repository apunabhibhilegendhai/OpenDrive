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
     └─ node apps/api/dist/index.js  ──►  DATABASE_URL (direct Postgres)
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

| Secret                     | What it is                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Direct PostgreSQL URL the runner can reach (see the prerequisite above).                                                                           |
| `CLOUDFLARE_TUNNEL_TOKEN`  | The tunnel token from Cloudflare Zero Trust.                                                                                                       |
| `CF_ACCESS_CLIENT_ID`      | Access service-token id for the Access-gated Postgres tunnel.                                                                                      |
| `CF_ACCESS_CLIENT_SECRET`  | Access service-token secret for the same tunnel.                                                                                                   |
| `SUPABASE_JWKS_URL`        | Access-token verification (asymmetric). Prefer this over the secret below. JWKS verification fails if the path is behind Bot Fight Mode or Access. |
| `SUPABASE_JWT_SECRET`      | HS256 fallback when no JWKS URL is configured.                                                                                                     |
| `SUPABASE_JWT_ISSUER`      | Expected `iss` of an access token.                                                                                                                 |
| `IP_HASH_SECRET`           | HMAC key for hashed client addresses. Rotating it invalidates old hashes.                                                                          |
| `REDIS_URL`                | Optional; the in-process limiter is used until Redis is wired in.                                                                                  |
| `TELEGRAM_BOT_TOKEN`       | Telegram storage backend credential (D27).                                                                                                         |
| `TELEGRAM_STORAGE_CHAT_ID` | The channel the bot stores objects in.                                                                                                             |

## Variables (repository → … → Variables)

Non-secret configuration. Optional ones fall back to the defaults shown by the workflow.

| Variable                                   | Default                  | Notes                                                 |
| ------------------------------------------ | ------------------------ | ----------------------------------------------------- |
| `STORAGE_PROVIDER`                         | `telegram-experimental`  | Must not be `none`, or uploads answer 503.            |
| `CORS_ORIGINS`                             | (empty → CORS off)       | Comma-separated browser origins.                      |
| `PUBLIC_BASE_URL`                          | (empty)                  | Origin used to build share links.                     |
| `STORAGE_MAX_FILE_SIZE_BYTES`              | `2147483648` (2 GiB)     | Per-deployment ceiling for a declared upload.         |
| `STORAGE_CHUNK_SIZE_BYTES`                 | `8388608` (8 MiB)        | Client part size; the provider may clamp it.          |
| `TELEGRAM_API_BASE_URL`                    | Telegram cloud API       | Point at a self-hosted server to lift the 20 MiB cap. |
| `TELEGRAM_MAX_PART_SIZE_BYTES`             | `20971520` (20 MiB)      | Must stay downloadable by the Bot API.                |
| `RATE_LIMIT_REQUESTS_PER_MINUTE`           | `120`                    | Per principal.                                        |
| `RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE`       | `600`                    | Per principal, part route only.                       |
| `UPLOAD_SESSION_TTL_HOURS`                 | `24`                     | How long an incomplete upload keeps its hold.         |
| `UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL` | `3`                      | Open uploads at once per principal.                   |
| `DATABASE_TUNNEL_HOSTNAME`                 | `db.opendrive.indevs.in` | Access-gated hostname the DB tunnel is dialled at.    |

## Running it

1. Make sure a `supabase-actions` session (or your own PostgreSQL) is up and `DATABASE_URL` points
   at it.
2. **Actions → API host (Cloudflare Tunnel) → Run workflow**, optionally setting the duration
   (default 300 minutes, capped at 330).
3. Watch the job log: it prints when the API reports ready, then holds. The public URL is the tunnel
   hostname from step 3 of the tunnel setup.
4. To stop early, cancel the run — the trap kills both the API and `cloudflared`.

The job is bounded by a 350-minute timeout so it can never outlive the runner's ceiling; the
in-step timer ends it cleanly before that.

## Verifying a run

```bash
curl -fsS https://api.opendrive.indevs.in/healthz     # liveness
curl -fsS https://api.opendrive.indevs.in/readyz      # dependencies: postgres, redis, storage
curl -fsS https://api.opendrive.indevs.in/openapi.json >/dev/null && echo docs ok
```

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
- These counters are in-process for now; a multi-instance deployment needs the shared Redis the
  backend already provides (see `docs/ROADMAP.md`).

## Why this is separate from CI

`ci.yml` must stay reproducible for anyone who clones the repository, so it uses throwaway service
containers and **no** secrets. This workflow is the opposite: it needs credentials and holds a
runner for hours. Keeping them in different files is what lets both contracts hold at once. Hosting
a multi-hour server on Actions is something GitHub's Acceptable Use Policies restrict, which is why
this only ever runs when an operator asks for it (D26, D34).
