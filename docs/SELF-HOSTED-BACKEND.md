# Self-hosted backend (Supabase + Redis on GitHub Actions)

OpenDrive's metadata database and Redis are self-hosted, at zero cost, by running the Supabase
stack on a GitHub Actions runner and publishing it over HTTPS with a Cloudflare Tunnel. This
document records what exists, how the OpenDrive schema reaches it, and — deliberately — what it
cannot be trusted with. The decision and its rationale are in
[docs/DECISIONS.md](DECISIONS.md) (D26).

## Topology

```
   OpenDrive API / browser / CLI
              │  HTTPS only
              ▼
   https://supabase.opendrive.indevs.in        (Cloudflare proxied, TLS)
              │  Cloudflare Tunnel "database"
              ▼
   GitHub Actions runner ── docker compose ──┬─ Kong :8000  (Studio, Auth, REST, Realtime)
   (apunlegendtha/supabase-actions)          ├─ Postgres 17 (metadata)
                                             └─ Redis 7     (rate limits, short-lived jobs)
```

PostgreSQL (`5432`) and Redis (`6379`) are **not** published. They exist only on the runner's
Docker network. Two HTTPS hostnames are the entire public surface:

| Hostname                       | Ingress target   | What it serves                                    | Login                                        |
| ------------------------------ | ---------------- | ------------------------------------------------- | -------------------------------------------- |
| `supabase.opendrive.indevs.in` | `localhost:8000` | Kong → Studio, Auth, REST, Realtime, Functions    | `supabase` / the `DASHBOARD_PASSWORD` secret |
| `redis.opendrive.indevs.in`    | `localhost:8081` | Redis Commander (Web UI for the rate-limit Redis) | `redis` / `redis`                            |

Both hostnames are Cloudflare-proxied CNAMEs to the `database` tunnel. The tunnel ingress is
remotely managed (Cloudflare Zero Trust), not a local `cloudflared` config file.

## Where each piece lives

| Piece                              | Location                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The stack + workflow               | `github.com/apunlegendtha/supabase-actions` (separate repo, branch `main`)                                                                      |
| The workflow                       | `.github/workflows/supabase-host.yml` (runs ~5h per 6h session)                                                                                 |
| OpenDrive migrations applied there | `supabase/migrations/100-opendrive-initial-schema.sql`, `101-opendrive-identity-ownership-quota.sql`, `102-opendrive-harden-rls-and-grants.sql` |
| Least-privilege role SQL           | `supabase/volumes/db/init/zz-opendrive-role.sql` (run every session by the workflow)                                                            |
| CI (unchanged contract)            | `.github/workflows/ci.yml` in this repo — service containers only, no secrets                                                                   |

The migration files in the infra repo are copies of `supabase/migrations/20261010000001_*.sql`,
`20261011000001_*.sql` and `20261012000001_*.sql` here. **When a migration is added or changed in
this repo, copy it into the infra repo's `supabase/migrations/` as well** (the infra repo's own
`001`–`008` belong to an unrelated app that shares the instance).

## Security model (RLS)

RLS is **enabled on every table in `public`**. The trusted OpenDrive API connects directly as the
`opendrive_app` login role, which is granted `BYPASSRLS` because the API performs its own
authorization (the same shape as Supabase's own `service_role`). RLS therefore exists to protect
**direct PostgREST access** by the `anon` and `authenticated` roles:

- `anon` holds **no** privileges on any OpenDrive table (defence in depth on top of RLS).
- `authenticated` holds only the privileges its policies actually use: `SELECT, UPDATE` on
  `profiles`, `SELECT, DELETE` on `files`/`folders`, and `SELECT` on `shares`. Every other
  OpenDrive table (api_keys, anonymous_sessions, quota_*, usage_counters, storage_objects,
  upload_sessions, audit_events, abuse_reports, moderation_actions) carries **no** client grant, so
  RLS denies by default.
- `public._schema_migrations` (the migration ledger) had RLS **disabled** and full `authenticated`
  grants when created by the migration runner. Migration `102` revokes all client access and
  enables RLS on it.

`102-opendrive-harden-rls-and-grants.sql` is the migration that establishes this; it is idempotent
and re-runs on a fresh database because the ledger starts empty.

## How OpenDrive gets a database role

`docker-entrypoint-initdb.d` scripts run only on a brand-new data directory, so they never re-run
on a restored snapshot. The workflow therefore creates the `opendrive_app` login role on **every**
session (before migrations), then grants runtime DML after migrations. The role is a normal login
role, never a superuser, and holds no rights on Supabase system schemas. `psql` does not
interpolate `:'VAR'` inside `$$ ... $$` blocks, so the SQL uses `format(%L)` with `\gexec` instead
of a `DO` block.

## Required Actions secrets

Set on `apunlegendtha/supabase-actions` (**Settings → Secrets and variables → Actions**). Names
only; values are never written to this repository:

`CF_TUNNEL_TOKEN`, `CF_TUNNEL_DOMAIN`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `DASHBOARD_PASSWORD`,
`REDIS_PASSWORD`, `OPENDRIVE_APP_PASSWORD`.

## Running it

Actions is enabled on `apunlegendtha`. Start a session with **Actions → Full Supabase
Self-Hosted → Run workflow**, or wait for the 6-hourly schedule (the first session takes longer:
it pulls images and applies migrations for the first time).

> Migrated note: these repositories were moved to `apunlegendtha` after GitHub disabled Actions
> on the previous account (`apunlegendhai`). Running a multi-hour server on Actions is what
> GitHub's Acceptable Use Policies forbid, so the same restriction can recur on any account.

## Connecting OpenDrive to it

The Supabase HTTP surface verifies access tokens; the API's own `postgres://` connection is carried
by the same `database` tunnel, through a Cloudflare **Access** TCP route:

- `SUPABASE_URL=https://supabase.opendrive.indevs.in`
- `SUPABASE_JWKS_URL=https://supabase.opendrive.indevs.in/auth/v1/.well-known/jwks.json` — keep this
  hostname off **Bot Fight Mode**, or the fetch is answered `403` from runner IPs and `/readyz`
  reports `auth: unavailable`.
- `SUPABASE_JWT_ISSUER=https://supabase.opendrive.indevs.in/auth/v1`
- `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — from the workflow run summary
- `REDIS_URL` — via the instance's HTTPS bridge, not a raw `redis://` TCP endpoint

The API host reaches Postgres by dialling the Access-gated tunnel on loopback
(`cloudflared access tcp --hostname db.opendrive.indevs.in --url 127.0.0.1:5432` with a service
token) and pointing `DATABASE_URL` at that loopback URL; the same tunnel is available to local
tooling via `pg-tunnel.sh`. Connected as `opendrive_app`, expect no rights beyond the `public` schema
and, per D20/D36, `BYPASSRLS`. The session workflow also grants `opendrive_app` `EXECUTE` on the
`public` functions (step “Grant OpenDrive runtime privileges”), because the `opendrive_*` helpers
revoke `PUBLIC` and would otherwise fail every upload with `42501`.

## Limitations (read before relying on this)

- **Ephemeral.** Each session lasts about five hours; there is a one-to-two minute gap every six
  hours. State is carried between sessions by the GitHub Actions cache (7-day eviction, 10 GB
  cap), so **total data loss is possible**. Never let this hold the only copy of anything.
- **Not production.** It is a development backend. Real user data belongs on a persistent,
  access-controlled host (see D26's "Revisit when").
- **Shared instance.** The infra repo also carries an unrelated application's migrations.
- **Redis fallback.** The upstream workflow contains a hard-coded fallback Redis password in a
  public log line; this instance sets a real random `REDIS_PASSWORD`, so the fallback is unused,
  but the upstream default is still present in source.
- **`bore.pub` relay.** The workflow also opens an ephemeral `bore.pub` TCP relay to Redis (random
  port, password-gated). No durable data is stored in Redis.

## CI vs. the live instance

CI (`pnpm test`, `pnpm db:verify`, `pnpm db:test:integration`, `pnpm test:e2e`) never talks to
this instance. The `database` job provisions throwaway `postgres:17` and `redis:7` service
containers, so a test run is bounded, secret-free and reproducible. The live instance is for
manual and integration use, not for gating pull requests.
