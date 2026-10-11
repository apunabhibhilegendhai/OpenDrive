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
   (apunlegendhai/supabase-actions)          ├─ Postgres 17 (metadata)
                                             └─ Redis 7     (rate limits, short-lived jobs)
```

PostgreSQL (`5432`) and Redis (`6379`) are **not** published. They exist only on the runner's
Docker network. The single public surface is the HTTPS hostname above.

## Where each piece lives

| Piece                              | Location                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The stack + workflow               | `github.com/apunlegendhai/supabase-actions` (separate repo, branch `main`)                           |
| The workflow                       | `.github/workflows/supabase-host.yml` (runs ~5h per 6h session)                                      |
| OpenDrive migrations applied there | `supabase/migrations/100-opendrive-initial-schema.sql`, `101-opendrive-identity-ownership-quota.sql` |
| Least-privilege role SQL           | `supabase/volumes/db/init/zz-opendrive-role.sql` (run every session by the workflow)                 |
| CI (unchanged contract)            | `.github/workflows/ci.yml` in this repo — service containers only, no secrets                        |

The migration files in the infra repo are copies of `supabase/migrations/20261010000001_*.sql`
and `20261011000001_*.sql` here. **When a migration is added or changed in this repo, copy it into
the infra repo's `supabase/migrations/` as well** (the infra repo's own `001`–`008` belong to an
unrelated app that shares the instance).

## How OpenDrive gets a database role

`docker-entrypoint-initdb.d` scripts run only on a brand-new data directory, so they never re-run
on a restored snapshot. The workflow therefore creates the `opendrive_app` login role on **every**
session (before migrations), then grants runtime DML after migrations. The role is a normal login
role, never a superuser, and holds no rights on Supabase system schemas. `psql` does not
interpolate `:'VAR'` inside `$$ ... $$` blocks, so the SQL uses `format(%L)` with `\gexec` instead
of a `DO` block.

## Required Actions secrets

Set on `apunlegendhai/supabase-actions` (**Settings → Secrets and variables → Actions**). Names
only; values are never written to this repository:

`CF_TUNNEL_TOKEN`, `CF_TUNNEL_DOMAIN`, `POSTGRES_PASSWORD`, `JWT_SECRET`, `DASHBOARD_PASSWORD`,
`REDIS_PASSWORD`, `OPENDRIVE_APP_PASSWORD`.

## Before it can run

GitHub Actions must be enabled for the account (Settings → Actions). It is currently turned off,
so no workflow on either repository can run. Once enabled, start a session with **Actions → Full
Supabase Self-Hosted → Run workflow** (or wait for the 6-hourly schedule).

## Connecting OpenDrive to it

Because only HTTPS is exposed, the API/worker cannot open a direct `postgres://` connection from
outside the runner. Configure OpenDrive with the Supabase HTTP surface and the Redis bridge:

- `SUPABASE_URL=https://supabase.opendrive.indevs.in`
- `SUPABASE_JWKS_URL=https://supabase.opendrive.indevs.in/auth/v1/.well-known/jwks.json`
- `SUPABASE_JWT_ISSUER=https://supabase.opendrive.indevs.in/auth/v1`
- `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — from the workflow run summary
- `REDIS_URL` — via the instance's HTTPS bridge, not a raw `redis://` TCP endpoint

`DATABASE_URL` (a direct Postgres URL) is available only for tooling that runs **inside** the
runner, or locally through `pg-tunnel.sh`; it is not reachable from a deployed OpenDrive process.

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
