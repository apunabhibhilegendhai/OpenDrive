# OpenDrive

Private cloud storage and public file hosting: upload files, keep them private by default or
share them through links you control, and delete them again.

**Status: identity, metadata, authorization and the transfer path are implemented; the bytes need a
storage provider to exist.** A signed-in user and an anonymous visitor each own their own metadata —
files, folders, shares, API keys — and the API decides who may see it from the database rather than
from the request. Uploads, ranged downloads and deletion are real routes, but the default
deployment has `STORAGE_PROVIDER=none`, so they answer `503 STORAGE_UNAVAILABLE` rather than
pretending to store anything. Nothing unimplemented is dressed up as working: an unimplemented
capability answers `501 Not Implemented` and names the phase that owns it.

## What works today

| Capability                                                                 | State                                                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo, TypeScript config, lint/format/test tooling                      | Works                                                                                                                               |
| Shared contracts: ids, error model, API schemas, limits, storage interface | Works, tested; plus the pure domain rules (principals, ownership, quota, share resolution, file states)                             |
| `GET /healthz` (liveness)                                                  | Works                                                                                                                               |
| `GET /readyz` (readiness, per-dependency)                                  | Works; reports `503` and names the missing variable while a dependency is unconfigured                                              |
| `GET /api/v1/limits`, `GET /openapi.json`, `GET /docs`                     | Works (docs disabled by default in production)                                                                                      |
| CLI `health`, `readiness`, `limits`, `version`, `help`                     | Works                                                                                                                               |
| Web status console                                                         | Works (real API calls, no mock data)                                                                                                |
| Worker job contracts + queue semantics                                     | Works; no queue is consumed yet                                                                                                     |
| Metadata schema and migrations                                             | Two migrations; verified by 335 SQL checks against a scratch PostgreSQL. **Not yet applied to the real Supabase project**           |
| Authentication (Supabase Auth tokens, anonymous sessions, API keys)        | Works: verified access tokens, hashed session credentials and scoped API keys, with suspension and revocation honoured immediately  |
| Authorization on private resources                                         | Works: ownership is read from the database, never the request; another principal's resource is indistinguishable from a missing one |
| Files (list, read metadata) and folders                                    | Works, including pagination, a guarded folder hierarchy and soft delete                                                             |
| Share links                                                                | Works: create, resolve, revoke, expiry and download counting; only the token digest is stored                                       |
| Quota                                                                      | Works: per-principal limits with reservations, so two concurrent uploads cannot both pass the same allowance                        |
| Audit events                                                               | Emitted for authentication, authorization refusals and share activity                                                               |
| Uploads, ranged downloads, deletion                                        | Implemented, and unusable until a provider is attached: with `STORAGE_PROVIDER=none` they answer `503` with the reason              |
| Share link landing page (`/s/:token`)                                      | Works: renders the file's terms and streams it through `/s/:token/download`                                                         |
| Abuse reports                                                              | **Not implemented** — route published, answers `501`                                                                                |
| Storage providers                                                          | `memory-test` (a labelled test double, refused in production) and `telegram-experimental` (not production-validated)                |
| Redis, malware scanning, deployment                                        | Redis is wired for shared rate-limit counters; scanning and production deployment are **not implemented**                           |

Every "not implemented" row above is verifiable from the running API, not just from this table.

## Quick start

Requires Node 24 and pnpm 12 (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

```bash
pnpm install
pnpm --filter @opendrive/api dev     # http://127.0.0.1:3000
pnpm --filter @opendrive/web dev     # http://localhost:5173
```

Check the whole workspace:

```bash
pnpm verify        # format check, lint, type-check, build, unit tests, e2e tests
```

No database, Redis instance, cloud account or paid service is needed for the above. Two extra
suites need a PostgreSQL server (they create and drop their own throwaway database):

```bash
pnpm db:verify             # the schema, asserted: 335 checks
pnpm db:test:integration   # the API over that schema: 61 tests
```

## Layout

```
apps/web           React status console (static build)
apps/api           Fastify HTTP API: auth, authorization, repositories, routes, error shape
apps/cli           Command-line client
packages/shared    Shared contracts: ids, errors, API schemas, limits, domain rules
services/worker    Background job contracts and queue semantics
supabase/          SQL migrations and the six SQL assertion suites for the metadata store
tests/e2e          End-to-end tests against the compiled API
tests/integration  Tests of the API against a real PostgreSQL database
docs/              Architecture, security, storage providers, decisions, roadmap
```

## Documentation

| Document                                                   | Contents                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)               | Components, data ownership, large-file handling, reliability and backup rules                               |
| [docs/SECURITY.md](docs/SECURITY.md)                       | Threat model, authorization, tokens, secrets, abuse controls, and what encryption can and cannot be claimed |
| [docs/STORAGE-PROVIDERS.md](docs/STORAGE-PROVIDERS.md)     | Provider capability matrix and the Telegram evaluation (experimental, not production-validated)             |
| [docs/EDGE-CACHE.md](docs/EDGE-CACHE.md)                   | The local edge cache in front of the provider and the cacheable signed `/cdn` delivery URLs                 |
| [docs/SELF-HOSTED-BACKEND.md](docs/SELF-HOSTED-BACKEND.md) | The Supabase + Redis instance on GitHub Actions: topology, secrets, and its limits                          |
| [docs/DECISIONS.md](docs/DECISIONS.md)                     | Why the stack and design choices were made                                                                  |
| [docs/ROADMAP.md](docs/ROADMAP.md)                         | Phase plan and the Phase 1 prerequisites checklist                                                          |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)                 | Setup, commands, testing strategy, troubleshooting                                                          |

## Ground rules this project holds itself to

- No capability is described as working without a command and its output to prove it.
- Unimplemented endpoints are visible as `501`s with a named phase, never as plausible successes.
- Test doubles are named as test doubles in code, in docs and in registry output, and the
  in-memory storage provider is refused in production.
- Cost stays at zero beyond the existing domain: the self-hosted Supabase and Redis instance (see
  [docs/SELF-HOSTED-BACKEND.md](docs/SELF-HOSTED-BACKEND.md)), a free static host for the web
  build, and GitHub Actions. Actions runs that development backend as well as the checks, but it
  is never a CDN or a delivery path for user-uploaded bytes.
- Telegram storage is treated as an experiment with unresolved durability, limit and
  account-risk questions, not as free unlimited object storage.
- The edge cache (see [docs/EDGE-CACHE.md](docs/EDGE-CACHE.md)) is a **non-authoritative origin
  cache on the API host's own disk**, never Postgres or Redis. It is not a CDN: it is wiped with an
  ephemeral host, it shares nothing between nodes, and the storage provider remains the only
  authoritative copy of every byte.

## License

Not licensed for redistribution; this is a private project (`"license": "UNLICENSED"`).
