# Decisions

Each entry records what was chosen, why, and what would change the decision. Newest decisions
are appended; entries are not rewritten when circumstances change — superseded entries are
marked and replaced.

## D1. TypeScript monorepo with pnpm workspaces (not npm/yarn, not Nx/Turborepo)

**Chosen:** pnpm workspaces (`pnpm-workspace.yaml`) plus per-package scripts, run
topologically by `pnpm -r`.

**Why:** pnpm is strict about dependency isolation (a package cannot import a dependency it
did not declare), installs are content-addressable and fast, and `pnpm -r` already runs scripts
in dependency order. A task runner or Nx would add a dependency and a cache to debug for a
six-package workspace. Version drift is prevented with a pnpm _catalog_: one place declares
`typescript`, `vitest`, `zod`, `tsx`, `rimraf` and `@types/node`, and packages reference
`catalog:`.

**Revisit when:** build times or CI cache misses justify a task runner, or the workspace grows
past roughly 15 packages.

## D2. TypeScript 6.0.x, not 7.0.x

**Chosen:** `typescript@6.0.3`, pinned exactly, with `engine-strict` and a `packageManager`
field pinning pnpm.

**Why:** TypeScript 7 (the native compiler) does not yet expose the compiler API that
`typescript-eslint` needs; its documented support range ends below 6.1.0. Linting and
type-checking must run against the same TypeScript version, so a TS 7 upgrade would mean
losing type-aware linting. TypeScript is pinned exactly rather than with a caret so a minor
release cannot silently change diagnostics.

**Revisit when:** `typescript-eslint` declares TS 7 support.

## D3. Fastify for the API

**Chosen:** Fastify 5 with `fastify-type-provider-zod`, `@fastify/swagger` (OpenAPI 3.1) and
`@fastify/rate-limit`.

**Why:** NestJS brings a DI container, decorators and its own module system; the API here is a
handful of route groups over a repository layer, and a lighter runtime keeps cold start,
memory use and the amount of framework-specific knowledge needed to read the code low. Fastify's
schema-first pipeline fits the "validate before the handler" rule, and the Zod type provider
reuses the exact schemas the web client and CLI validate against — one contract, three
consumers. Both frameworks could satisfy the requirements; the deciding factor is that Fastify
lets the shared Zod schemas be the single source of truth without an adapter layer.

**Revisit when:** the API grows enough structure (many cross-cutting concerns, dozens of
modules) that explicit dependency injection pays for itself.

## D4. Zod as the only validation library

**Chosen:** Zod 4 for request validation, response contracts, environment validation, job
payloads and client-side response parsing.

**Why:** one schema definition produced the OpenAPI document, the TypeScript types, the runtime
validation and the tests. Adding a second validator (JSON Schema, io-ts, Valibot) would mean two
sources of truth for the same shape — the exact drift that published-but-unimplemented
contracts are meant to prevent.

## D5. Storage behind a capability-described provider contract

**Chosen:** `StorageProvider` in `packages/shared/src/storage/types.ts` with an explicit
`StorageCapabilities` record and `assertCapability`.

**Why:** no provider may be assumed to support multipart uploads, random access, direct
download URLs or permanent retention. Capabilities make those differences data instead of
assumptions, and they are enforced by a contract test suite that every provider must pass
before it is enabled. A provider that cannot stream must be able to say so.

## D6. Test doubles are labelled and blocked from production

**Chosen:** `MemoryStorageProvider` (shared) and `MemoryJobQueue` (worker) are exported under
test-only subpaths, self-describe as non-durable, and `resolveStorageProvider` refuses the
in-memory provider when `NODE_ENV=production` (asserted by a test).

**Why:** in-process fakes are valuable for developing and testing without a backend, and
dangerous the moment they are reachable in production. Naming them "test double" in code,
docs and registry output, plus a programmatic refusal, removes that risk.

## D7. Unimplemented endpoints are published and answer 501

**Chosen:** file, upload, share and moderation routes exist with full schemas and always throw
`501 NOT_IMPLEMENTED` naming the feature and its phase; a test asserts every one of them, and a
test asserts no fabricated identifiers appear in a `501` body.

**Why:** a documented contract lets the client, CLI and OpenAPI consumers be written against
the real shape, while a `501` guarantees nobody mistakes a missing feature for a working one.
The alternative — omitting the routes, or stubbing them with plausible successes — either hides
the plan or lies about it.

## D8. Errors use a single model and RFC 9457 problem details

**Chosen:** `AppError` with a stable `code`, an HTTP status fixed per code, and
`toProblemDetails()` output that includes `code`, `requestId` and field-level `errors`.

**Why:** clients need to branch on a machine-readable code, not on prose. Fixing the status per
code prevents the same failure being a 400 in one route and a 422 in another. Unexpected errors
are logged server-side and returned as a generic 500, so internals never leak.

## D9. Identifiers are prefixed and random; tokens are hashed

**Chosen:** `<kind>_<26-char Crockford base32>` identifiers from 128 bits of CSPRNG output, and
256-bit base64url bearer tokens stored only as SHA-256 hashes and compared in constant time.

**Why:** prefixes make logs and support legible without a lookup; random suffixes prevent
enumeration. Bearer tokens are the actual security boundary, so a database dump must not yield
usable credentials. 256 bits of entropy means no password-style derivation is needed.

## D10. The CLI has no CLI framework

**Chosen:** `node:util parseArgs` plus a small `Io` abstraction, with documented exit codes
(`0` success, `1` usage, `2` unhealthy, `3` unreachable, `4` internal).

**Why:** the Phase 0 surface is five commands and four flags; a framework would be a supply-chain
dependency in a client that users install, for no capability gain. Exit codes make the CLI
usable from scripts, which is its main purpose in Phase 0.

**Revisit when:** commands need nested subcommands or generated help.

## D11. Lint: type-aware typescript-eslint, with `require-await` off

**Chosen:** ESLint 10 flat config with `recommendedTypeChecked` for TypeScript, and
`@typescript-eslint/require-await` explicitly disabled.

**Why:** type-aware rules caught real defects here (unsafe `any` from `JSON.parse` and
`import.meta.env`, an unnecessary cast, an implicit coercion, an unbound method passed to an
assertion). `require-await` was the exception: `async` in this codebase is a _contract_ (Fastify
plugins, the storage and queue interfaces, async generators), so the rule flagged correct code
and would train readers to ignore the linter. Levels are errors, not warnings: a warning that
never fails CI is not a check.

## D12. Tests: in-process for the API, real process for e2e, real socket for the CLI

**Chosen:** API routes are tested with Fastify's `inject` (fast, no ports); `tests/e2e` spawns
the compiled `apps/api/dist/index.js` and drives it over HTTP, including a SIGTERM shutdown
test; CLI tests run commands against a throwaway `node:http` server.

**Why:** `inject` tests are fast and precise but cannot catch a broken build output, a missing
runtime dependency or an ESM resolution mistake. The CLI's job is network I/O, so a mocked
`fetch` would not exercise the part that breaks. The e2e suite fails with an explicit message
when the build artefact is missing rather than a stack trace.

Note: on Windows, `SIGTERM` is emulated by terminating the process, so graceful-shutdown exit
codes are asserted on POSIX only (CI runs Linux). The test states this instead of weakening the
assertion silently.

## D13. RLS enabled with no permissive defaults

**Chosen:** RLS on every table, narrow own-row policies for `profiles`/`files`/`shares`, no
client policies for server-only tables, and `revoke all ... from anon`.

**Why:** the API uses the service role and must make its own authorization decisions. Default-deny
RLS means a mistake in application code is the only way to expose data, and a future
mis-scoped policy cannot silently widen access. Public download access deliberately goes
through the API (share-token checks, expiry, counters) rather than a database policy, because
those rules cannot be expressed as a row predicate.

## D14. Migrations are written but unverified in Phase 0 — **superseded by D18**

**Chosen:** `supabase/migrations/20261010000001_initial_schema.sql` is written and reviewed, and
its header states plainly that it has not been applied to any database because no Postgres runs
in this environment or in CI.

**Why:** claiming a schema works because it looks correct is exactly the kind of unverified
claim this project forbids. Applying it to a development instance is a Phase 1 prerequisite
listed in [ROADMAP.md](ROADMAP.md).

**Superseded (2026-10-11):** the schema is now execution-verified against a real PostgreSQL
instance; see D18. The claim it replaced — "no Postgres runs in this environment" — was true when
written and stopped being true when a portable PostgreSQL 17.6 was installed outside the
repository. Supabase remains unverified: see D18 for exactly what the local proof does and does
not cover.

## D15. GitHub Actions: CI only, no secrets, no deployment - **superseded by D26**

**Chosen:** one workflow (`ci.yml`) with `permissions: contents: read`, running format check,
lint, type-check, build, unit/integration tests and e2e tests; a second advisory job reports
dependency advisories without gating.

**Why:** the platform's constraints forbid using runners as servers, proxies, CDNs or durable
job runners. Deployment stays a deliberate, separately authorized action. The advisory audit job
is explicitly non-gating: it is labelled as triage input, not as a passing check.

## D16. Vercel is a candidate, not a configuration

**Chosen:** no `vercel.json` and no deployment configuration is committed.

**Why:** a hosting configuration that has never been exercised is a claim. The web app is a
static build that any static host can serve; the decision and its configuration belong to the
phase that actually deploys it.

## D17. pnpm supply-chain defaults kept on

**Chosen:** pnpm 12's `minimumReleaseAge` policy stays enabled; the two exclusions it needed
(`@types/node`, `prettier`) are recorded in `pnpm-workspace.yaml`. Dependency install scripts
are blocked except for `esbuild`, which `tsx` requires.

**Why:** a newly published package is the highest-risk dependency, and this project installs
from the public registry on every CI run. Approving exactly one build script keeps the exception
list auditable.

## D18. The schema is proven by running it, against real PostgreSQL, with a shim for Supabase

**Chosen:** `supabase/tests/run-local.sh` creates a throwaway database, applies a local Supabase
shim, applies the migration, and then runs three SQL assertion suites (152 assertions) that print
every check they pass. The shim reconstructs only what Supabase would otherwise provide: the roles
`anon`/`authenticated`/`service_role` (with `service_role` holding `BYPASSRLS`), schema `auth`,
`auth.users`, and `auth.uid()` copied from Supabase's own definition.

**Why:** a schema is a set of claims about rejection and authorization, and reading SQL cannot
falsify any of them — the three things the requirement called out (a 2 GiB cap, RLS isolation, a
single active storage object per file) are exactly the kind that look right and behave otherwise.
Running the real thing also settled questions no review would have: that a policy's subquery on
`files` is filtered by `files`'s own RLS rather than erroring, that `owner_id = auth.uid()` with no
JWT claims matches nothing (so the system fails closed), and that `revoke all from anon` plus the
grant layout denies `anon` everything even though it can still read `auth.uid()`.

Two design choices inside the suites are deliberate. First, rejections name the constraint they
must fail on: a check that only asserts "something went wrong" passes when the statement breaks for
an unrelated reason, which is how a typo'd fixture briefly satisfied a scope-validation check here.
Successes are recorded in a `verify.results` table rather than printed as notices, so a green run
produces a readable list of what was proven instead of the absence of errors.

**What this does not establish:** that the migration applies to a real Supabase instance. The shim
is a reconstruction, not the platform — most importantly, Supabase's `auth.uid()` and role
definitions are its own, and the real project has extensions, schemas and a migration history this
database does not. Applying it there stays a Phase 1 prerequisite.

**Revisit when:** the migration is applied to the real project. At that point the shim should be
kept (it keeps the suites runnable on any Postgres) but its assumptions re-checked against the
platform.

## D19. Schema verification gates CI, in a job of its own

**Chosen:** a `database` job in `ci.yml` runs the same `supabase/tests/run-local.sh` against a
`postgres:17` service container. It is a separate job from `verify`, and `pnpm verify` does not run
it, so the Node toolchain checks stay free of any database requirement.

**Why:** a one-off local proof decays — the next migration could break a constraint or a policy and
nothing would notice until a human re-ran the script. Pinning the service container to the same
major version as the target keeps the check honest about the PostgreSQL the product actually uses.
The job needs no secret, no persistent service and no artifact upload, so it stays within the CI
constraints: a bounded, container-local test.

**Revisit when:** the project moves to a hosted Postgres with a different major version, or a second
migration makes a full migration-history test (Supabase CLI on a throwaway project) worth its cost.

## D20. The API talks to PostgreSQL directly; RLS is a second line, not the first

**Chosen:** the repository layer connects with `DATABASE_URL` and issues parameterised SQL. Supabase's
PostgREST API is not used for server-side work. Authorization is decided in the application — every
query is scoped by principal — and RLS stays enabled underneath as a backstop for a future
mis-scoped query or a leaked connection.

**Why:** two reasons, and the second is the uncomfortable one.

First, the rules this product needs cannot all be expressed as row predicates. A share link's
validity depends on its own expiry, its download allowance and the file's state; a quota check has
to hold across two concurrent requests; an anonymous refusal must be indistinguishable from a
not-found. Those belong in code.

Second, the API connects with a role Supabase grants `BYPASSRLS`, so on this path RLS is not
guarding anything at all — it never was. What protects a request is the application's own scoping,
proven by `tests/integration`. RLS still earns its keep for the direct-database path (PostgREST,
an leaked `anon` key, a future read-only tool), which is exactly why it stays enabled and why the
suites keep asserting it. Calling it a backstop and not the first line is the honest description,
and it is why D22's "ownership comes from the database" assertion matters more than the policies do.

**The hazard this creates, recorded rather than hidden:** `files` does not use `FORCE ROW LEVEL
SECURITY`, so a connection whose role owns the table bypasses RLS entirely. `60_secrets_and_invariants.sql`
asserts both halves of that — no client role owns a table, and the FORCE flag is off — so the
operator-facing requirement is explicit: `DATABASE_URL` must use a non-owner application role.

**Revisit when:** partial access is ever needed by a browser client (then the policies matter
more), or the connection is fronted by something other than this API.

## D21. Identity comes from a verified token; a suspended account is refused everywhere

**Chosen:** Supabase Auth signs access tokens; the API verifies them against either the HS256
shared secret (`SUPABASE_JWT_SECRET`) or a JWKS endpoint (`SUPABASE_JWKS_URL`), enforcing signature,
expiry, issuer, audience and algorithm, and refusing the `service_role` claim outright. With
neither key source configured, every protected route answers `503`. A verified user gets a
`profiles` row provisioned on first use, and only then are the account's limits and status read.

**Why:** the service-role token is a secret whose signature is perfectly valid — accepting it would
turn the API into an administrative back door for anyone who obtained it. Failing closed on missing
configuration is the only honest behaviour for a deployment that cannot establish identity; a
partially enabled auth path is worse than a disabled one. Provisioning on first use keeps identity
in `auth.users` (Supabase's) and product state in `profiles` (ours), rather than duplicating users.

**Verified by:** `apps/api/src/auth/tokens.test.ts` and `tests/integration/src/identity.test.ts`,
including expired, wrong-issuer, `alg: none`, tampered and service-role tokens, and the 503 path.

## D22. Authorization reads the database, never the request

**Chosen:** ownership is a stored generated column (`owner_key`) derived from the row's own
principal columns. Every access path scopes its query by the authenticated principal, and a request
body that supplies an owner, an owner id or a visibility is ignored. Cross-tenant refusals are
the same `404 NOT_FOUND` a nonexistent resource produces, and each refusal is recorded as an audit
event with the reason, so operators can see what a caller cannot.

**Why:** "do not trust client-supplied ownership" is easy to agree with and easy to violate — the
violation is one convenient `?? body.ownerId` away. Making the column generated means the database
refuses to accept a caller's claim even if the application stopped checking, and making every
refusal identical means the API cannot be used to enumerate other people's resources.

**Verified by:** `tests/integration/src/ownership.test.ts` (another owner's file answers exactly
like a missing one; ownership fields in a body are ignored) and the integration suite's folder and
placement cases.

## D23. Quota is reserved before bytes move, and holds count

**Chosen:** `quota_reservations` + a partial unique index, and four SQL functions
(`reserve`, `commit`, `release`, `sweep`) called by the repository layer. A reservation counts
towards both storage usage and the daily upload allowance while it is held; a partial unique index
allows at most one held reservation per file.

**Why:** the original failure mode is silent. Two uploads each ask "is there room?", both hear yes,
and the account ends up over its limit with nothing having failed. `opendrive_reserve_storage`
decides inside one statement, after taking a row lock on the principal (`profiles` or
`anonymous_sessions`), so two reservations for the _same_ account serialize: the second is refused
before any bytes exist. It sums both committed usage and today's outstanding holds, so the daily
allowance cannot be passed twice either. Quota moves in integer bytes, and the commit function
writes the counters in the same call that changes the reservation's state, so a counter cannot
disagree with the holds and commits behind it. The lock is per principal and never on the policy
rows, which are reference data — locking those would serialize every anonymous upload in the system
behind one row.

**Verified by:** 54 SQL checks in `supabase/tests/50_quota.sql` and the 13 tests in
`tests/integration/src/quota.test.ts`, including two concurrent reservations and a counter that
is never allowed to go negative.

## D24. An anonymous session is a principal, not a degraded user

**Chosen:** `anonymous_sessions` with a hashed bearer credential, an expiry, a revocation
consistency check and a last-used timestamp; `files` and `folders` carry exactly one principal
(`owner_user_id` xor `owner_session_id`, enforced by a check constraint); `owner_key` is the user
id or the session id accordingly. Client addresses are stored only as keyed hashes, and not at all
when `IP_HASH_SECRET` is unset.

**Why:** modelling anonymous uploads as "a user with no account" ends in nullable user ids
sprinkled through every query. A separate principal kind keeps the ownership predicate single and
uniform, and the exactly-one-owner constraint means a row cannot be claimed by both. Revoked and
expired sessions are kept as rows so the files that point at them stay attributable and auditable
rather than becoming orphans.

**Revisit when:** anonymous sessions gain a conversion path to an account, which needs an explicit
ownership-transfer step (never an in-place `owner_user_id` update).

## D25. A second, database-backed suite proves the application, not just the schema

**Chosen:** `tests/integration` runs the real repositories and the real HTTP layer (Fastify
`inject`) against a scratch database built by applying the same migrations, with access tokens
signed locally by the same secret the server is configured with. It has no `test` script: `pnpm
test` stays service-free, and `pnpm db:test:integration` is the only way to run it. CI runs it in
the `database` job, beside the SQL suites.

**Why:** the schema suites prove the database refuses what it should; only this suite proves the
_application_ uses that schema correctly — that a second owner's query really returns nothing,
that a share's revocation is visible on the next request, that a quota race is refused. A suite
that skipped itself when `DATABASE_URL` was unset would be a suite that reports green while
proving nothing, so it fails with the command to run instead. Keeping it out of `pnpm test` keeps
the ordinary developer loop free of a PostgreSQL requirement (D19); running it in CI keeps it from
decaying into a one-off.

**Revisit when:** these suites get slow enough that a per-pull-request run costs more than it
catches, at which point the split should be by what is at risk in the change, not by convenience.

## D26. The self-hosted Supabase stack runs on GitHub Actions as the development backend

**Chosen:** OpenDrive's metadata backend and Redis are provided by a self-hosted Supabase stack
running on GitHub Actions in a separate repository, `apunlegendtha/supabase-actions`, published
over HTTPS only through a Cloudflare Tunnel at `supabase.opendrive.indevs.in`. That workflow
applies OpenDrive's migrations (`supabase/migrations/100-*`, `101-*`) and creates a
least-privilege `opendrive_app` login role on every session. No raw TCP is exposed: PostgreSQL and
Redis stay on the runner's Docker network. CI keeps using throwaway container-local services
(`postgres:17`, `redis:7`), never the live instance.

**Why:** the cost target is zero and a paid managed Supabase/Redis was ruled out. The existing
`supabase-host.yml` stack was already present and is reused at the owner's direction, with its
limitations recorded below rather than hidden. This supersedes D15's "no deployment" rule for
this backend only; `ci.yml` keeps its no-secrets, read-only contract.

**Known limitations (accepted):** the instance is ephemeral - a session runs about five hours out
of every six, and state survives only through the GitHub Actions cache (7-day eviction, 10 GB
cap), so total data loss is possible and it must never hold the only copy of anything. It is a
development backend, not production storage. The upstream stack's workflow prints a fallback Redis
password into a public build log; the instance here sets a real random `REDIS_PASSWORD`, so that
fallback is never used, but the upstream source still contains the old default. Redis is also
reachable over an ephemeral `bore.pub` relay (random port, password-gated); nothing durable is
stored there.

**Revisit when:** the backend must hold real user data, at which point it moves to a persistent,
access-controlled host and this becomes a local development convenience only.

## D27. Telegram Bot API is the Phase 2 storage backend, as split-part object storage

**Chosen:** `TelegramStorageProvider` (`apps/api/src/storage/providers/telegram.ts`) stores each
object as an ordered list of parts; every part is uploaded as a chat document via `sendDocument`
and read back via `getFile` + the file endpoint. The locator persisted in `storage_objects`
encodes exactly those Telegram message/file ids, so a restarted process can stream or delete the
object from the locator alone. All Telegram access goes through an injectable `TelegramTransport`
(`telegram-transport.ts`): the production path is `TelegramHttpTransport`, and the contract
suite runs against an in-memory fake with no network. Storage is selected with
`STORAGE_PROVIDER=telegram-experimental`; `resolveStorageProvider` attaches the provider only
when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_STORAGE_CHAT_ID` are present in the runtime environment.

**Why:** file storage must hold up to the 2 GiB product target at zero cost, and the owner
chose Telegram as the backend (following the TGWebDrive / tg-s3 approaches). Multipart delivery
is required because the standard Bot API cannot download a single file above 20 MiB; the provider
keeps `maxPartSizeBytes` at 20 MiB by default so every part can always be read back, and a
self-hosted Local Bot API server can raise it via `TELEGRAM_MAX_PART_SIZE_BYTES`. A whole object
is verified by reading the staged parts back through Telegram and hashing them with a bounded
string digest, so memory stays bounded to one part even for multi-gigabyte objects.

**Verification record (2026-10-11):** the full provider contract suite
(`describeStorageProviderContract`) passes against the fake transport — multipart and
single-shot uploads, out-of-order parts, duplicate-part refusal, whole-object checksum mismatch
refusal, abort idempotency, range-read refusal (`STORAGE_CAPABILITY_UNSUPPORTED`), idempotent
delete, and restart-safe reads from the locator alone. The documented limits are the honest
standard Bot API limits: 20 MiB `getFile` download ceiling per part, whole-object uploads capped
at the part ceiling.

**Live verification (2026-10-11):** with a real bot token and a private channel the provider was
driven against the live Bot API. `health()` reported the bot reachable; a 256 KiB single-shot upload
and a 25 MiB four-part multipart upload each round-tripped with a matching whole-object SHA-256,
covering `finalizeUpload`'s read-back verification and a full `openReadStream`. The multipart
mechanism and the 20 MiB per-part read-back ceiling are therefore confirmed end-to-end at that scale.

**Still not verified (honest):** no object anywhere near the 2 GiB target has been stored, so
`maxFileSizeVerified` stays `false` — the mechanism is proven, the ceiling is not. Durability is not
guaranteed (`guaranteedDurability: false`, `permanentRetention: false`), ranged reads and direct
download URLs are not supported (`rangedRead: false`; a Telegram file link would embed the bot
token), and deletion is not provably final (`deleteIsFinal: false`) — see D29, which records that
Telegram keeps serving a deleted file and how the provider compensates.

**Revisit when:** an object near the 2 GiB target is stored and read back (ideally through a
self-hosted Local Bot API server, §3.1), at which point `maxFileSizeVerified` can be enabled and the
measured maximum recorded here.

## D30. Upload verification reads parts through a bounded window, and read failures are retryable

**Chosen:** `TelegramStorageProvider.finalizeUpload` verifies the whole-object SHA-256 by reading
staged parts back through a bounded concurrent window (`hashObjectParts` → `verifyWindowSize`), and
each part is read whole into memory by `readPartBytes` and retried on transient failure
(`DEFAULT_READ_RETRY_ATTEMPTS`, exponential-ish backoff via `readRetryDelayMs`). The window is capped
by both `maxVerifyConcurrency` and a byte budget (`VERIFY_BUFFER_BUDGET_BYTES`), so a provider with a
large part size reads fewer parts at once instead of buffering the whole object. `TelegramHttpTransport.download`
now wraps a failure that occurs while the response body is streaming as a retryable `TelegramApiError`,
and `TelegramStorageProvider.throwReadFailure` maps every read failure to `STORAGE_UNAVAILABLE`
(never a raw driver error), passing already-classified `AppError`s through unchanged.

**Why:** measuring the live Bot API showed the provider's original verify pass was the bottleneck for
the 2 GiB target, not the upload. Uploads scale near-linearly with concurrency (one stream ≈ 0.24 MiB/s,
8 parallel ≈ 2.4 MiB/s), but the original `hashObjectParts` read parts one at a time at ≈ 0.17 MiB/s, so
verifying a 2 GiB object would take hours. A mid-body failure also escaped unclassified: `download()`
resolves once headers arrive, so a socket dropped while iterating the body threw undici's raw
`TypeError: terminated` straight through `finalizeUpload`. Buffering each part whole makes the retry
correct (a partially-consumed stream cannot be resumed and a partially-hashed part cannot be rolled
back), and the byte budget keeps memory bounded to `window × part`.

**Verification record (2026-10-11):** unit tests cover a transient mid-body failure that is retried and
still verifies, a persistent failure that surfaces as `STORAGE_UNAVAILABLE`, a mid-body failure while
streaming to a client that also surfaces as `STORAGE_UNAVAILABLE`, the verify window staying within its
bound, and the transport wrapping a post-header body failure as retryable.

## D28. Pagination cursors are bound as `text`, then cast, so microseconds survive

**Chosen:** the keyset predicate in `listFiles` / `listFolders` casts the bound cursor parameter
to `text` before `timestamptz` (`${cursorCreatedAt}::text::timestamptz`). The cursor still carries
`created_at` as the exact six-digit-microsecond `to_char(..., 'US')` value; the extra cast only
pins the parameter's PostgreSQL type.

**Why:** PostgreSQL infers the comparison's parameter as `timestamptz`, and Postgres.js caches the
prepared statement after its first execution and, on every later bind, re-serialises a
`timestamptz` parameter through its JS `Date` adapter
(`(x instanceof Date ? x : new Date(x)).toISOString()` in `types.js`), truncating to milliseconds.
The first page binds `null` and is unaffected, so the loss is invisible until the second page —
and then only when a row and the cursor straddle a millisecond boundary, which is why the walk
test failed intermittently rather than always. Forcing the parameter to `text` selects
Postgres.js's identity serialiser, and `text::timestamptz` still parses the full-precision ISO
string. Verified against the live database: the prepared parameter's type resolves to `{text}` and
`2026-10-11T14:56:31.518917Z` round-trips exactly.

**Guarded by:** the integration walk test now pins five rows into a single millisecond, a
microsecond apart, so a cursor that collapses to the millisecond floor skips rows deterministically
instead of roughly 60% of the time.

## D29. Telegram deletion is recorded locally, because the Bot API keeps serving deleted files

**Chosen:** `TelegramStorageProvider` keeps an in-process tombstone (a `Set` of locators).
`deleteObject` adds the locator; `getMetadata` and `openReadStream` consult the tombstone first and
throw `NOT_FOUND` for a deleted object. The `getFile` probe is kept only as a best-effort existence
check for objects this process never deleted.

**Why:** the provider originally trusted a `getFile` probe to report a deleted object as gone. That
assumption was measured against the live Bot API on 2026-10-11 and is false: after `deleteMessage`,
`getFile` still returned a valid `file_path`, and `GET /file/bot<token>/<path>` still returned the
original bytes with an identical SHA-256 — more than 35 seconds later, and unchanged after a further
30 seconds. Telegram retains the file independently of the message. The in-memory fake transport had
encoded the opposite rule ("getFile fails for a deleted file"), so the contract suite passed while
the real backend returned metadata and bytes for objects the platform believed it had destroyed. The
fake now models the measured behaviour (message removed, file retained), and both the contract suite
and a dedicated regression test pin the tombstone.

**Honest limits:** the tombstone is process-local. Another process, or this one after a restart,
cannot observe it, so `deleteIsFinal` stays `false`: Telegram may still hold a copy, and only the
platform's own metadata can state that an object is gone. This makes deletion observable to the
process that performed it — which is what the storage contract requires — not provable in general.

**Guarded by:** `apps/api/src/storage/providers/telegram.test.ts` (the realistic fake plus an
explicit "deleted object reads as gone even though the file still resolves" case).
