# Development

Everything in this document has been run against this repository. Commands that were not
verified are marked as such.

## Prerequisites

| Tool    | Version                                                            | Notes                                    |
| ------- | ------------------------------------------------------------------ | ---------------------------------------- |
| Node.js | 24.x (pinned in `.nvmrc`, enforced by `engines` + `engine-strict`) | Node 24 or newer within the 24 line.     |
| pnpm    | 12.x (pinned via `packageManager`)                                 | `corepack enable` or `npm i -g pnpm@12`. |
| Git     | any recent version                                                 |                                          |

No database, Redis, cloud account or paid service is required for install, lint, type-check,
build or test.

> Keeping the checkout out of a cloud-synced folder (OneDrive, Dropbox) is recommended:
> `node_modules` contains tens of thousands of files, and sync clients lock and re-upload them.

## Install

```bash
pnpm install
```

`pnpm install` uses `--frozen-lockfile` semantics in CI. Dependency install scripts are blocked
by pnpm 12 except for `esbuild` (required by `tsx`); see `pnpm-workspace.yaml`.

## Commands

Run from the repository root.

| Command                             | What it does                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Starts every package's dev task in parallel (web dev server + API watcher).                                                                                                   |
| `pnpm dev:api`                      | API only, with `tsx watch`.                                                                                                                                                   |
| `pnpm dev:web`                      | Web dev server only (proxies `/api`, `/healthz`, `/readyz` to the API).                                                                                                       |
| `pnpm build`                        | Builds every package in dependency order (`tsc` and `vite build`).                                                                                                            |
| `pnpm typecheck`                    | Type-checks every package (topologically, so `@opendrive/shared` is built first).                                                                                             |
| `pnpm lint`                         | ESLint with type-aware rules over the whole workspace.                                                                                                                        |
| `pnpm lint:fix`                     | Same, applying fixes.                                                                                                                                                         |
| `pnpm format` / `pnpm format:check` | Prettier write / check.                                                                                                                                                       |
| `pnpm test`                         | Unit and contract tests in every application, package and service. Needs no service.                                                                                          |
| `pnpm test:e2e`                     | Builds, then runs `tests/e2e` against the compiled API process.                                                                                                               |
| `pnpm verify`                       | Everything CI's Node checks run: format check, lint, type-check, build, test, e2e. Needs no database.                                                                         |
| `pnpm db:verify`                    | Applies the shim, both migrations and the six SQL assertion suites to a throwaway database (335 checks). **Needs a local PostgreSQL** (`psql`, `createdb`, `dropdb` on PATH). |
| `pnpm db:test:integration`          | Provisions a second throwaway database, applies the migrations, and runs `tests/integration` (61 tests) against real repositories and real SQL. **Needs a local PostgreSQL.** |
| `pnpm verify:db`                    | Both database suites in one run.                                                                                                                                              |
| `pnpm clean`                        | Removes build output from every package.                                                                                                                                      |

Package-scoped commands work as expected:

```bash
pnpm --filter @opendrive/api test
pnpm --filter @opendrive/web build
pnpm --filter @opendrive/worker dev
```

## Running the API locally

```bash
pnpm --filter @opendrive/api dev      # http://127.0.0.1:3000
```

Useful endpoints:

| Endpoint             | Meaning                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /healthz`       | Liveness. Never rate limited, touches no dependency.                                             |
| `GET /readyz`        | Readiness. Answers `503` while a required dependency is unverified, naming the missing variable. |
| `GET /api/v1/limits` | The limits this deployment enforces.                                                             |
| `GET /openapi.json`  | The published contract, OpenAPI 3.1.                                                             |
| `GET /docs`          | Interactive docs (disabled when `NODE_ENV=production` unless `DOCS_ENABLED=true`).               |

Configuration comes from the environment; copy `.env.example` to `.env` and fill in what you
need. **No value is required to start the API**: an unconfigured integration is reported as
`not_configured` by `/readyz`, and a protected route answers `503` rather than trusting the
request. Invalid values, by contrast, stop startup with a message naming the variable.

To exercise the authenticated routes locally you need three things, none of which are secrets in
the repository:

| Variable                                     | Why                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                               | The metadata database. Without it `/readyz` reports `postgres: not_configured`. Connect as a **non-owner** role: `files` does not use `FORCE ROW LEVEL SECURITY`, so a table owner would bypass RLS. |
| `SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET` | Access-token verification. With neither, protected routes fail closed with `503`.                                                                                                                    |
| `IP_HASH_SECRET`                             | Keyed hashing of client addresses. Unset means addresses are simply not recorded — there is no raw-address fallback.                                                                                 |

Access tokens are signed by the self-hosted Supabase Auth instance at `SUPABASE_JWT_ISSUER` with
the `SUPABASE_JWT_AUDIENCE` audience (default `authenticated`). Verification is covered by the
test suites and needs no live Supabase: signature, expiry, issuer, audience, algorithms and a
declared deny-list are all asserted in `apps/api/src/auth/tokens.test.ts`.

## Running the web app

```bash
pnpm --filter @opendrive/api dev      # terminal 1
pnpm --filter @opendrive/web dev      # terminal 2 → http://localhost:5173
```

The Vite dev server proxies `/healthz`, `/readyz` and `/api` to `OPENDRIVE_API_URL`
(default `http://127.0.0.1:3000`), so the browser makes same-origin requests and no CORS
configuration is needed locally. A deployed build can instead set `VITE_API_BASE_URL` and rely
on the API's `CORS_ORIGINS` allow-list.

## Running the CLI

```bash
pnpm --filter @opendrive/cli build
node apps/cli/dist/index.js --help
node apps/cli/dist/index.js health
node apps/cli/dist/index.js readiness --json
node apps/cli/dist/index.js limits
```

Exit codes: `0` success, `1` usage error, `2` API answered but unhealthy, `3` unreachable,
`4` internal error. Diagnostics go to stderr, so `--json` output stays machine-readable.

## Running the worker

```bash
pnpm --filter @opendrive/worker build
node services/worker/dist/index.js          # contract report
node services/worker/dist/index.js --json
```

It reports the declared jobs and exits non-zero only if a contract is internally inconsistent.
It does not consume a queue yet; see `services/worker/src/index.ts` for why.

## Test strategy

| Layer                                   | Where                                | Runs                       |
| --------------------------------------- | ------------------------------------ | -------------------------- |
| Contract and unit tests                 | `packages/shared/src/**/*.test.ts`   | `pnpm test`                |
| API route tests (in-process)            | `apps/api/src/**/*.test.ts`          | `pnpm test`                |
| CLI commands against a real HTTP server | `apps/cli/src/**/*.test.ts`          | `pnpm test`                |
| Web data layer                          | `apps/web/src/**/*.test.ts`          | `pnpm test`                |
| Worker registry and queue semantics     | `services/worker/src/**/*.test.ts`   | `pnpm test`                |
| End-to-end against the compiled API     | `tests/e2e/src/**/*.test.ts`         | `pnpm test:e2e`            |
| Schema against real PostgreSQL          | `supabase/tests/**/*.sql`            | `pnpm db:verify`           |
| API over the real schema                | `tests/integration/src/**/*.test.ts` | `pnpm db:test:integration` |

Notes:

- API tests use Fastify's `inject`, so they are fast and port-free; `tests/e2e` covers the built
  artefact over a real socket.
- Package tests alias `@opendrive/shared` to its source, so `pnpm test` works without a build.
  `tests/e2e` deliberately runs the built output instead.
- `tests/integration` is the only suite that needs a database. It is deliberately not part of
  `pnpm test`: a suite that silently skips when `DATABASE_URL` is unset proves nothing, so it
  fails with the command to run instead. Each of the two database suites creates and drops its own
  scratch database and never touches a configured one.
- Web rendering is verified in a browser; component-level rendering tests (jsdom +
  testing-library) are a Phase 1 addition, since the data layer is where the real logic lives.

## Database work

Migrations live in `supabase/migrations/` and are plain SQL. Both of them are verified against a
scratch database by a script and six assertion suites, all under `supabase/tests/`.

```bash
pnpm db:verify              # drop+create VERIFY_DB, apply everything, run 335 checks
pnpm db:test:integration    # a second scratch database, then the API over that schema
```

Requirements: `psql`, `createdb` and `dropdb` on `PATH`, and a PostgreSQL server the current user
can create databases on (PostgreSQL 15+; verified on 17.6). Configure with the standard libpq
variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`) and `VERIFY_DB` (default `opendrive_verify`).
The script refuses to run against any database whose name does not start with `opendrive_verify`,
and keeps the scratch database for inspection when an assertion fails (`KEEP_DB=1` keeps it on
success too).

How the pieces fit:

| File                                  | Role                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/00_local_supabase_shim.sql`    | Reconstructs what Supabase provides on a plain Postgres: roles `anon`/`authenticated`/`service_role`, schema `auth`, `auth.users`, `auth.uid()`. Never run this against Supabase. |
| `tests/01_assert_helpers.sql`         | `verify.eq` / `verify.rejected` / `verify.accepted`. A failure raises, so the run stops and exits non-zero; passes are recorded and printed.                                      |
| `tests/10_structure.sql`              | Structure, defaults, grants, enums, indexes, triggers, platform assumptions.                                                                                                      |
| `tests/20_constraints.sql`            | Every constraint rejects what it claims to, each naming the constraint it must fail on.                                                                                           |
| `tests/30_rls.sql`                    | Real RLS behaviour as `authenticated`, `anon` and `service_role`, including cross-tenant attempts.                                                                                |
| `tests/40_identity_ownership.sql`     | Identity, ownership and placement: session rules, exactly one principal per resource, folder hierarchy and sibling uniqueness, cross-owner references refused.                    |
| `tests/50_quota.sql`                  | The quota functions branch by branch: allowances, holds, the reservation lifecycle, and the refusals.                                                                             |
| `tests/60_secrets_and_invariants.sql` | Credentials are digests, addresses are hashes, provider locators stay in one place, no `bytea` column exists, and no client role can execute the quota functions.                 |
| `tests/run-local.sh`                  | The runner: applies shim → migrations → suites → seed (twice), then prints every check that passed.                                                                               |

`tests/integration/run-local.sh` is the second runner: it provisions its own scratch database, applies the
same migrations, and runs the suite with `DATABASE_URL` pointed at it. It applies no seed — these
tests build their own fixtures, so "how many bytes does this principal store?" never depends on
seed data.

Only `scripts`-free plain SQL and two bash scripts are involved, so the verification has no
dependencies beyond a PostgreSQL client — it runs the same way locally and in CI.

Applying to the real instance is still a separate, deliberate step:

```bash
supabase db push            # applies both migrations in filename order
# or, one at a time:
psql "$SUPABASE_DB_URL" -f supabase/migrations/20261010000001_initial_schema.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql
```

Rules: never edit an applied migration — add a new one; never run destructive statements against
a database holding real data without a backup and a rollback plan. The migration is intentionally
not idempotent: applying it twice fails rather than silently skipping.

## Adding a package

1. Create the directory under `apps/`, `packages/`, `services/` or `tests/` — the globs in
   `pnpm-workspace.yaml` pick it up.
2. Give it a `package.json` (`"private": true`, `"type": "module"`) with `build`, `typecheck`,
   `test` and `clean` scripts, and a `tsconfig.json` extending `../../tsconfig.base.json`
   (`tsconfig.build.json` for emit).
3. Reference shared versions through the catalog (`"typescript": "catalog:"`).
4. Add it to the table in [ARCHITECTURE.md](ARCHITECTURE.md) so the layout stays documented.

## Troubleshooting

| Symptom                                     | Cause and fix                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_PNPM_IGNORED_BUILDS`                   | A new dependency ships an install script. Add it to `onlyBuiltDependencies` in `pnpm-workspace.yaml` deliberately, or choose a dependency that does not need one. |
| `Unsupported engine`                        | Node or pnpm is outside `engines`; `engine-strict` refuses instead of producing confusing build errors.                                                           |
| `command not found: tsc` in a package       | Run scripts through pnpm (`pnpm --filter <pkg> build`), not directly; pnpm puts each package's binaries on its own PATH.                                          |
| `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`         | A package script failed; the output above the error names the package and the failing command.                                                                    |
| e2e fails with "compiled API was not found" | Run `pnpm build` first, or use `pnpm test:e2e`, which builds for you.                                                                                             |
| A `501` response from an endpoint           | Expected: that capability is not implemented yet. See [ARCHITECTURE.md](ARCHITECTURE.md) §7.                                                                      |
