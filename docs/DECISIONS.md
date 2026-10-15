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
guaranteed (`guaranteedDurability: false`, `permanentRetention: false`), direct download URLs are
not supported (`directDownloadUrl: false`; a Telegram file link would embed the bot token), and
deletion is not provably final (`deleteIsFinal: false`) — see D29, which records that Telegram
keeps serving a deleted file and how the provider compensates. Ranged reads are supported as of
D40.

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

## D31. A single 2 GB upload is streamed with a one-time disk spool, retried, and `--local` reads are supported

**Chosen:** the Telegram provider and its transport were corrected on 2026-10-12 in four ways, all
of which the earlier documentation got wrong:

1. **`--local` is what raises Telegram's ceilings, not `TELEGRAM_MAX_PART_SIZE_BYTES` on its own.**
   A self-hosted `telegram-bot-api` server behaves exactly like the cloud API — 50 MB upload,
   20 MiB download — unless it is started with `--local`; `--dir` only picks where files are
   cached. `docs/STORAGE-PROVIDERS.md` §3.1 and `.env.example` now say so, and the earlier claim
   that `--dir` "lifts the 20 MiB ceiling" is removed.
2. **The single-shot path no longer buffers the whole object.** `uploadWholeObject` refused a
   stream above the part ceiling and `sendDocument` assembled a `File` from the entire buffer,
   violating the "no whole-object buffering" rule in `packages/shared/src/storage/types.ts` and
   `docs/ARCHITECTURE.md` §3. A streamed whole object is now spooled exactly once to a temp file
   while its SHA-256 is computed, and sent as a hand-built multipart body (`duplex: 'half'`) that
   frames the parts around the caller's chunks. Memory stays bounded to a part for multipart and
   to a write buffer for single-shot; the multipart path still stages one bounded part in memory.
3. **Uploads are retried like reads.** `uploadPartBytes` retries retryable `sendDocument`
   failures with the same backoff the read path uses. Because a stream cannot be rewound, the
   spool is what makes a retry correct: each attempt reads a fresh stream from the spooled file,
   so it restarts at byte zero instead of resuming an exhausted generator. A checksum mismatch is
   computed before the send and leaves no orphan; a size refusal (`Payload too large`) is never
   retried.
4. **`--local` downloads are supported.** With `--local`, `getFile` returns an absolute on-disk
   path. `download()` now reads it from the local filesystem when the API shares the server's
   disk, or — when it does not — rewrites it through `TELEGRAM_FILES_BASE_URL` +
   `TELEGRAM_WORK_DIR` (a file server exposing the server's `--dir`). An absolute path with a file
   base URL but no work dir is refused with a configuration error rather than mis-fetched.

**Why:** the user's requirement is a _single_ file up to 2 GB uploaded via Telegram. The only
route to a single file above 20 MiB is a `--local` server, and the honest implementation of that
route (stream it, retry it, and read it back) is what these changes deliver. Buffering a
multi-gigabyte object in the API process would OOM a production node; a streamed upload with no
retry would lose the whole transfer to a single dropped connection over the minutes it takes.

**Honest limits (unchanged or newly explicit):** a true 2 GiB file (2,147,483,648 bytes) still
cannot be delivered as one Telegram upload — the server's local ceiling is 2000 MB
(2,000,000,000 bytes) — so the largest objects continue to use multipart, and
`maxFileSizeVerified` stays `false` until a `--local` server is actually measured. Upload sessions
remain process-local (`resumableUpload: false`), and the global 120 req/min limiter is small
relative to the hundreds of part requests a 2 GiB multipart upload issues, so multi-principal
concurrency is bounded by the shared bot token, not by per-principal quotas. Those gaps are
recorded in `docs/ROADMAP.md` rather than hidden.

**Guarded by:** `apps/api/src/storage/providers/telegram.test.ts` (spool + retry of a streamed
whole object; part-upload retry; a size refusal that is _not_ retried; streamed whole-object size
and checksum mismatches that send nothing; streaming multipart framing; `--local` disk read;
file-server rewrite; and the missing-work-dir refusal) and `apps/api/src/config.test.ts` (the two
new environment variables).

## D32. The upload workflow is a real engine, and a failed finalize does not destroy a recoverable upload

**Chosen:** `apps/api/src/routes/uploads.ts` implements the full workflow the contract publishes —
`POST /uploads` (declare, then reserve a quota hold **before any byte moves**), `PUT
/uploads/:id/parts/:n` (raw `application/octet-stream`, bounded by the chunk size the initiate
response advertised), `GET /uploads/:id` (progress), `POST /uploads/:id/complete` (verify, persist the
locator, commit the hold, transition to `ready`/`scanning`), and `DELETE /uploads/:id` (abort). A
process-local `UploadSessionStore` owns the session record and the per-principal open-session cap;
the locator is written to `storage_objects` by a new repository. A `complete` that fails — missing
parts, a checksum mismatch — is deliberately **not** terminal: the provider keeps the staged parts,
so the client may send what is missing and retry, or abort to release the hold. Only an explicit
abort ends a session, and `insertActiveStorageObject` is idempotent so a retried complete cannot
double-record an object.

**Why:** the provider contract (D27, D30) already stages parts and is idempotent; the value the route
adds is the _bookkeeping_ around it, and two of those rules are load-bearing. First, reserving before
the first byte is what stops a caller from filling the disk and then discovering they are over quota
(D23). Second, treating a premature `complete` as a permanent failure would turn a transient client
mistake into a lost upload: the bytes are already staged and a single missing part is trivially
recoverable, so the engine must let the caller recover rather than punish them. A hold left behind by
a crashed client is not a leak — it expires on its own and the worker sweeps it.

**Honest limits (unchanged):** the API-side session record is process-local, so `resumableUpload`
stays `false` (the schema reserves `upload_sessions` for when a provider can resume). Deletion marks
the local object `deleted` and soft-deletes the row; it is as final as the backend's `deleteIsFinal`
(D29).

**Guarded by:** `apps/api/src/storage/upload-sessions.test.ts` (ownership, the open-session cap,
expiry, part accounting) and `tests/integration/src/uploads.test.ts` (single- and multi-part
round-trips with byte-exact download, out-of-order parts, resume-after-failed-complete, abort
releasing the hold, owner and deletion-token deletion, and the size/part-size/concurrency refusals).

## D33. Rate limiting keys on the principal, and part traffic gets its own ceiling

**Chosen:** `@fastify/rate-limit` is registered _after_ identity resolution, with a `keyGenerator`
that returns the authenticated principal (`user:<id>` or `session:<id>`) and falls back to the
request address only when no credential was proven. The part route additionally carries its own,
higher ceiling (`RATE_LIMIT_UPLOAD_PARTS_PER_MINUTE`, default 600/min) via the route's
`config.rateLimit`. Two further bounds live in the engine rather than the limiter: a per-principal
daily cap on uploads _started_ (`ANONYMOUS_UPLOADS_PER_DAY` / `REGISTERED_UPLOADS_PER_DAY`) and a cap
on open sessions at once (`UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL`).

**Why:** an address-keyed limiter punishes everyone behind a shared NAT and cannot stop one
authenticated account from saturating the API — the two failure modes that matter for a multi-user
service. Keying on the principal fixes both. But one rule cannot fit both shapes of traffic: a
single legitimate upload issues one request per part, so the ordinary 120/min ceiling would throttle
a perfectly normal 2 GiB upload, while a per-part ceiling of 600/min would be far too loose for
metadata routes. Splitting the ceiling by route keeps each honest. The daily-start and open-session
caps bound _abuse_ — how often work may begin and how much may be in flight — separately from the
storage quota, which bounds _bytes_.

**Honest limits:** the session registry is in-process, so open sessions are per instance (D31).
The limiter's counters were per instance too, until D37 wired Redis in: with `REDIS_URL` set, both
ceilings are counted in Redis and belong to the principal regardless of which process served the
request. The upload engine itself remains single-instance, which `api-host.yml`'s `concurrency`
group enforces.

**Guarded by:** `apps/api/src/server.test.ts` (the limiter still answering 429 with the principal
keying in place) and `tests/integration/src/uploads.test.ts` (the open-session cap).

## D34. The API is hosted on GitHub Actions behind a Cloudflare Tunnel, as an operator-triggered action - **amended by D37 (schedule)**

**Chosen:** `.github/workflows/api-host.yml` builds the API and runs it for a bounded session
(5–330 minutes) on a GitHub Actions runner, publishing it over HTTPS through a Cloudflare Tunnel
whose token is a repository secret. It runs only on `workflow_dispatch` — never on `push` — and it
refuses to start unless `DATABASE_URL` and `CLOUDFLARE_TUNNEL_TOKEN` are set. (D37 adds a `schedule`
trigger: the constraint that still matters is that a _push_ never starts it, because that is the
contract `ci.yml` is protecting.) The operator steps, required secrets and the one hard prerequisite
(a `DATABASE_URL` the runner can actually reach) are in `docs/DEPLOYMENT.md`. `ci.yml` is untouched
and keeps its no-secrets, read-only contract.

**Why:** the cost target stays zero and the decision to use this shape was already made for the
metadata backend (D26); hosting the API the same way is the consistent choice, and it is what turns
a working upload engine into something reachable from anywhere. The separation from CI is the point:
CI must stay reproducible for anyone who clones the repo, while a hosted deployment needs
credentials and holds a runner for hours. Making it operator-triggered means hosting is always a
deliberate act, which also respects the Acceptable Use Policy constraint D26 already records.

**Honest limits:** the session is ephemeral (the runner is reclaimed, and the deployment inherits
D26's data-loss caveat); the tunnel's public hostname is managed in Cloudflare Zero Trust, not in
this repository; and because only HTTPS is exposed by the tunnel, the API needs a _separately
reachable_ PostgreSQL, not the tunnel-only Supabase hostname. All three are documented rather than
papered over.

**Revisit when:** the service must be continuously available or hold real user data, at which point
this becomes a development convenience and the API moves to a persistent host.

## D35. A file's stored scan verdict is nullable; the wire contract normalizes it

**Chosen:** `files.scan_state` stays nullable - a fresh `pending_upload`/`uploading` row has no
verdict yet - and `FileEntity.scanState` is typed `ScanState | null` to match. `toFileRecord` maps a
stored `NULL` to `'not_scanned'`, so the published `FileRecord.scanState` remains the non-null
`ScanState` union every consumer already assumes.

**Why:** the column and the contract disagreed about whether "no verdict yet" is representable. The
database needs `NULL` so a row can exist before any scanner runs (the constraint suite relies on
writing it); the contract wants one vocabulary, and `SCAN_STATES` already carries the honest word for
this case. Normalizing at the single serialization boundary keeps both truthful and stays fail-safe:
`isScanPass` treats `not_scanned` exactly as it treats `NULL` once scanning is enabled. Fixing this
in the route instead would have left every other reader of a pending row - the listing and metadata
routes - able to hit the same serialization fault.

**Guarded by:** `apps/api/src/db/mappers.test.ts` (a `NULL` verdict publishes `not_scanned` and
validates against the contract) and `tests/integration/src/uploads.test.ts` (a completed upload's
response serializes).

## D36. The trusted backend role holds `BYPASSRLS`; readiness discloses it instead of failing

**Chosen:** `DATABASE_URL` connects as a non-owner backend role that holds `BYPASSRLS` (self-hosted:
`opendrive_app`; Supabase: the `service_role` shape). `inspectDatabaseRole` no longer treats
`BYPASSRLS` as a hazard: a superuser, a table owner and any public table with RLS disabled are still
hazards, but the bypass flag is named in the `ok` detail. `/readyz` therefore reports
`postgres: ok` for a correctly provisioned deployment.

**Why:** D20 already says this path depends on bypassing RLS — the API authorizes in code, and the
policies exist to guard direct PostgREST access, which D13 keeps narrow, so no permissive
`opendrive_app` policies were added to appease the probe. The probe contradicted that design, so
every correctly provisioned self-hosted deployment answered `/readyz` with `503` forever and the
host action's readiness gate could never pass. `supabase/tests/00_local_supabase_shim.sql` and
`supabase/tests/10_structure.sql` record the dependency explicitly ("service_role has BYPASSRLS
(the API path depends on it)"), which makes the probe the outlier rather than the role. Keeping the
flag visible in the detail preserves the disclosure the probe existed to provide without turning the
documented architecture into a permanent failure.

**Guarded by:** `apps/api/src/db/role-safety.test.ts` (the bypass flag is `ok` and disclosed, while
a superuser, an owner of `public.files` and an RLS-less table stay `degraded`) and
`apps/api/src/dependencies.test.ts` (a required probe that is `degraded` or `unavailable` still
makes readiness `degraded`).

## D37. The host action also runs on a schedule, and rate-limit counters live in Redis

**Chosen:** two changes to the deployment D34 describes.

1. `api-host.yml` gains `schedule: - cron: '0 */4 * * *'` beside `workflow_dispatch`. The existing
   `concurrency: { group: api-host, cancel-in-progress: false }` serialises the two, so a scheduled
   run is queued and takes over as the running one ends rather than running alongside it. Startup
   tolerance is widened to match: the database pre-flight retries for about three minutes and the
   readiness gate waits 120 s, because the backend session restarts on its own schedule.
2. The API wires `ioredis` into `@fastify/rate-limit` when `REDIS_URL` is set, so both ceilings
   (ordinary requests and upload parts) are counted in Redis instead of in the process. Redis is
   reached exactly as the database is — an Access-gated TCP tunnel
   (`cloudflared access tcp --hostname redis-tcp.opendrive.indevs.in --url 127.0.0.1:6379`, same
   Zero Trust service token) pointed at `REDIS_URL=redis://…@127.0.0.1:6379/0`. Without `REDIS_URL`
   the limiter stays in-process, and `/readyz` reports which store is in use.

**Why:** a manual dispatch makes availability depend on someone pressing the button three times a
day, forever. A schedule plus a serialising concurrency group gives continuity without running two
API instances — which would be actively harmful, because upload sessions are in-process (D31), so a
second instance behind the same tunnel would strand a multipart upload that started on the first.
The startup retry exists for the same reason: a scheduled start can land inside the backend's own
restart window, and failing there would turn a one-minute outage into a four-hour one. Redis is
wired because the counters were the one part of the rate-limiting design that did not hold under
the property it exists for: D33's counters must belong to the _principal_, not to whichever process
happened to serve the request.

**Honest limits:** the limiter is registered with `skipOnError`, so an unreachable Redis fails
_open_ — the limiter skips instead of turning a cache outage into an API outage. Redis and Postgres
share the same backend host, so "Redis down, Postgres up" is the narrow window in which limits
silently disappear; `/readyz` reports `redis: unavailable` throughout it. Redis also sits behind the
same Access tunnel as the database, so every request pays one more tunnel round trip for its counter
— which is why only a _concurrent_ burst can trip the ceiling. Upload sessions stay
in-process, so a second instance is still unsupported: Redis makes the limiter cluster-wide, not
the upload engine, and the `concurrency` group is what keeps the deployment single-instance.

**Guarded by:** `apps/api/src/dependencies.test.ts` (a wired client reports `ok` on a `PING`, a
broken one reports `unavailable`, and because Redis is not `required` neither changes readiness).
The live deployment reports `redis: ok` in `/readyz` with the round-trip time.

## D38. The web app is deployed to Vercel from CI, as a finished static directory

**Chosen:** `.github/workflows/web-host.yml` builds `@opendrive/web` inside CI and uploads the
result to the existing Vercel project with `vercel deploy apps/web/dist --prod`. A committed
`apps/web/vercel.json` carries the single-page-app rewrite. This supersedes D16 ("Vercel is a
candidate, not a configuration"): the hosting phase D16 deferred to has arrived.

**Why:** the web build imports `@opendrive/shared` through a Vite alias, so it cannot be built
without the workspace installed first. Rather than teach Vercel a pnpm workspace — a second
toolchain to keep in step with CI — the workflow builds with the same toolchain CI uses and hands
Vercel a finished directory. Building in CI also means the deploy is one command an operator can
reproduce, and the SPA rewrite is a reviewed file instead of dashboard state that lives nowhere.

**Honest limits:** the browser talks to `https://api.opendrive.indevs.in` directly, so the web
origin must be in `CORS_ORIGINS` and the API must be up for the app to be usable; a Vercel
deployment with a down API serves the shell and fails every request. The `VITE_*` values are baked
in at build time, so changing them needs a redeploy, not a restart. The Supabase anon key ships in
the bundle by design; row-level security, not secrecy, is what protects data.

**Guarded by:** the workflow itself (a failed build or deploy fails the job) and `CORS_ORIGINS`
containing `https://opendrive.indevs.in` and `https://www.opendrive.indevs.in`.

## D39. A large object is staged locally and sent as one Telegram document, finalized asynchronously

**Chosen:** the Telegram provider gains a staged mode. When `TELEGRAM_API_BASE_URL` points at the
loopback Local Bot API server (`--local`), `uploadPart` writes each part to a spool file instead of
sending it, and `finalizeUpload` verifies the assembled length and whole-object checksum, then sends
the reassembled object as a single `sendDocument`. Because that send can take minutes,
`POST /uploads/:id/complete` runs finalization as a background job and answers `202` with
`{ state: 'processing' }`; the client polls the same endpoint until it answers `200` with the file.
Objects at or below 64 MiB still finalize inside the first request.

**Why:** Cloudflare's edge rejects any single request body above 100 MiB on the public API hostname,
so a multi-gigabyte file _arrives_ as many parts — but the whole point of running the Local Bot API
server (`--local`) is that Telegram will hold a 2000 MB document, and one document per file is what
a person expects to see in the chat. Sending each part as its own document (the previous behaviour)
produced 21 separate files for a 2 GiB object. The async finalize exists because a synchronous send
of that object outlives the edge proxy's ~100 s response timeout, which would surface as a `524`
even though the send was succeeding.

**Honest limits:** the spool is process-local disk, so a runner that ends mid-upload loses it — the
same caveat as the in-process upload sessions (D31), and the reason the spool is deleted only after
the object is committed (a failed send is retryable from the spool, but a lost runner is not). The
64 MiB sync threshold is a time budget against the edge timeout, not a correctness boundary. A
`202` means "poll", not "done", and a client that stops polling leaves the upload `processing` until
the session TTL reclaims it.

**Guarded by:** `apps/api/src/storage/providers/telegram.test.ts` (staged parts stay off Telegram
until finalize, one document is sent, a failed send keeps the spool for a retry, and an object above
the ceiling still uses multipart), `apps/api/src/storage/finalize-jobs.test.ts` (one attempt per
upload, join-not-restart, retry after failure), and `apps/web/src/state/uploadQueue.retry.test.ts`
plus the web client's `202` handling.

## D40. Byte ranges are served per part, and an unsatisfiable range is a real `416`

**Chosen:** `StorageProvider.openReadStream(ref, range)` is honoured by the Telegram provider.
`rangedRead` flips to `true`, and a range is mapped onto the parts that cover it: parts before the
window are skipped without a request, and the parts at either edge are downloaded for only the
sub-range they contribute (`readPartRange` → `openPartStream(part, subRange)` →
`TelegramHttpTransport.download(filePath, range)`). The transport sends a `Range` header; a `206`
body is streamed as-is, and a server that answers `200` (ignoring `Range`) has its body trimmed to
the requested window, so the caller always receives exactly the bytes it asked for and never the
whole object. The content route parses a single `bytes=` range (`parseRangeHeader`), answers `206`
with `Content-Range`/`Content-Length` and `Accept-Ranges: bytes`, serves the whole object `200` when
there is no range (or multiple ranges, or a non-`bytes` unit), and answers an out-of-bounds range
`416` with `Content-Range: bytes */<size>` — a new `RANGE_NOT_SATISFIABLE` error code (status 416) in
the shared error taxonomy.

**Why:** downloading a stored object as one stream through the edge proxy hit Cloudflare's ~100 s
origin timeout for a ~862 MiB file (`524`, HTML body) even though the bytes were fine — the same
failure mode that motivated the async finalize (D39). Ranged reads let a media element seek and
stream, and let a client fetch a large object in bounded, retryable windows instead of one
all-or-nothing response. The web client now does exactly that: `downloadFileContent` writes the
object to disk window by window (or buffers it into one Blob where the File System Access API is
absent), retrying a window that fails transiently rather than restarting the file. The window's size
is only a ceiling - each request is time-boxed, so a slow object simply fills less of it and the next
request continues (D42).

**Honest limits:** only a single range is served; a multi-range request is answered with the whole
object rather than `multipart/byteranges`, which no client here needs and which would require
fetching parts out of order. Range correctness depends on the locator's recorded part sizes, so a
part whose size on Telegram differs from the locator surfaces as a read failure rather than silent
corruption. The Blob fallback still holds the whole object in memory — the windowing removes the
long-request timeout, not the platform's memory ceiling.

**Guarded by:** the provider contract suite's `rangedRead` branch (now active for Telegram),
`apps/api/src/storage/providers/telegram.test.ts` (a range spanning parts fetches only the
overlapping parts and only their needed sub-ranges; an invalid range is `INVALID_REQUEST`),
`apps/api/src/routes/range.test.ts` (the header parser), `tests/integration/src/uploads.test.ts`
(`206`, `Content-Range`, byte-exact body, `200` without a range, and `416` past the end), and
`apps/web/src/lib/files/download.test.ts` (window sizing and order, retry, whole-object fallback,
the buffered path, keeping a window's bytes when it is cut mid-body or stalls, and retrying an edge
`524`).

## D41. A failed upload releases its session, so "try again" is actually possible

**Chosen:** the web upload queue remembers the id of every server session it opens and releases it
(`DELETE /uploads/:id`) whenever the upload will not be finalized - because the run failed after
every retry was spent, or because the queue was torn down (sign-out, account switch, unmount). A
user cancel is unchanged: it still reports when its own release call does not reach the API. The
release is best-effort and idempotent - a session already gone answers `404`, which the client
treats as success - with the server's session TTL as the backstop.

**Why:** the API bounds how many uploads one principal may have open at once
(`UPLOAD_MAX_ACTIVE_SESSIONS_PER_PRINCIPAL`, default 3), and an open session counts until it is
finalized, aborted or expires. A large upload that failed partway (a transient edge `502` on one
part, as the 862 MiB E2E sees) left its session open, so a few failed attempts in a row made the
_next_ attempt answer `429 RATE_LIMITED` "At most 3 uploads may be open at once" - which reads to a
person as "the same file cannot be uploaded again". The bytes were never the problem: uploading the
same file twice in a row is accepted (there is no content dedup). Releasing the abandoned session is
what restores the retry.

**Honest limits:** releasing drops the staged bytes, so a retry restarts the object from its first
part rather than resuming it. A tab closed mid-upload cannot run a release; that session lingers
until its TTL (24 h) or the API process restarts (sessions are process-local, not persisted). This is
client hygiene, not server-side resumption.

**Guarded by:** `apps/web/src/routes/DriveRoute.test.tsx` ("gives the failed session back, so the
next upload is not refused"): a part refused with `413` ends the upload and the client issues the
`DELETE`; the live API was also driven through six release-then-retry cycles, every one accepted.

## D42. A download window is time-boxed, and the edge's own 5xx are retried

**Chosen:** a ranged download window is bounded by wall-clock time, not only by size.
`downloadFileContent` asks for up to `DOWNLOAD_WINDOW_BYTES` (64 MiB) but reads for at most
`DOWNLOAD_WINDOW_BUDGET_MS` (30 s) per request: whatever bytes arrived are written, the offset
advances by exactly those bytes, and the next request continues from there. A read that fails after
some bytes landed is not treated as an error - those bytes are a contiguous prefix of the requested
range - so only a failure that delivered nothing is retried, and then with backoff
(`DOWNLOAD_WINDOW_ATTEMPTS` = 6). The client also treats an edge timeout (`524`) and its
`408`/`520`-`523`/`5xx` siblings as transient in `isTransientFailure`, so that retry actually runs.

**Why:** the edge proxy in front of the API cuts a request at ~100 s and answers `524`; an 862 MiB
object died on its very first 64 MiB window because the Local Bot API was still pulling that document
from Telegram and streamed it slower than the fixed window assumed. A fixed byte window cannot know
the throughput, so it is either too large (wait ~100 s, then `524`) or too small (a request per few
MiB, forever). Time-boxing removes the failure mode: every request finishes in ~30 s, well inside the
edge timeout, and a download always moves forward however poor the throughput. Reading to a deadline
rather than waiting for an error is also what lets the client keep the bytes it already has instead of
discarding them with the failed request.

**Honest limits:** a slow object becomes many requests, each paying a fresh round trip through the
edge; the budget bounds one request's time, not the download's total. A stalled request that delivered
nothing spends the full budget before the retry, and after six attempts the download fails rather than
looping forever. The unranged whole-object fallback (a server that ignores `Range`) cannot be resumed,
so it is read without a budget and still depends on the edge not cutting it - which is why the content
route always answers `206` for a range (D40).

**Guarded by:** `apps/web/src/lib/files/download.test.ts` ("keeps the bytes a window delivered before
it was cut, and continues from there", "cuts a stalled window at the time budget and keeps the bytes
that did arrive", "retries an edge timeout (524) instead of failing the download"), and
`apps/web/src/lib/api/errors.ts`'s `RETRYABLE_STATUSES`.

## D43. An inline preview is a short-lived, file-scoped signed URL the browser streams directly

**Chosen:** `POST /api/v1/files/:fileId/preview` (owner-authenticated) returns `{ path, expiresAt }`,
where `path` is `/api/v1/files/:fileId/content?preview=<token>` and is relative to the API origin.
The token is `base64url("<fileId>.<expEpochSec>")` + `"."` + a hex HMAC-SHA256 over exactly that
encoded payload; the key is HKDF-SHA256 (`info` = `opendrive/preview-url/v1`) of
`PREVIEW_SIGNING_SECRET`, falling back to `IP_HASH_SECRET`, with a TTL of
`PREVIEW_TOKEN_TTL_SECONDS` (default 3600). The content route accepts the token only when no bearer
identity is present, only for the file id it names, only before its expiry, and only when the file's
effective type is in the inline allow-list (`isInlinePreviewable`: raster image, audio or video;
`image/svg+xml` is excluded). Such a response is served `inline` with
`cross-origin-resource-policy: cross-origin`; anything else answers 409 (not previewable) or 503 (no
signing secret). `security.ts` no longer overwrites a CORP a route set for itself, and `server.ts`
redacts the `preview` query parameter from request logs.

**Why:** a browser's `<img>`/`<video>`/`<audio>` cannot attach an `Authorization` header, so "show
the file in the page" needs either a URL-borne credential or fetching the whole object into memory
and handing the element a blob URL. The second is unusable for a large video: it buffers the entire
file in the tab and cannot seek until the download finishes. A signed URL lets the element stream and
seek through the provider directly, reusing the range machinery of D40. Scope and expiry are what make
a URL credential acceptable here: it names one file, it dies on its own, and even a valid one is
refused for a type the server would not render inline anyway. Deriving the key with HKDF keeps it
distinct from the address-hashing secret even when it is configured from it.

**Honest limits:** the token lives in the URL, so it can leak through a `Referer` header, browser
history or a log line — a short TTL and log redaction reduce that, they do not remove it. Previews
need a configured secret: with both `PREVIEW_SIGNING_SECRET` and `IP_HASH_SECRET` unset the mint
route answers 503 rather than signing under a default key. Text and code are previewed by reading the
object through the authenticated client and rendering it as text, capped at 1 MiB; a larger text file
is only offered as a download. PDF and SVG are deliberately not previewed (SVG is scriptable; PDF is
served as an attachment by choice), and the interface says so rather than rendering them.

**Guarded by:** `apps/api/src/preview-tokens.test.ts` (mint/verify, expiry, cross-file, tamper, wrong
secret), `tests/integration/src/preview.test.ts` (the signed URL streams without a credential and
sets cross-origin CORP; a token is scoped to one file and refused for a sibling type; a credentialed
download keeps same-origin; no secret answers 503), and `apps/web/src/routes/DriveRoute.test.tsx`
("shows an image through a signed preview link the API minted", "reports a refused preview instead of
showing a broken element").

## D44. A share link opens a landing page and streams from a range-capable byte route; opening the page is what counts

**Chosen:** `/s/:token` and `/s/:token/download`, on the API origin and outside `API_PREFIX`, give a
share link a public face for a browser rather than an API client. `GET /s/:token` renders a small
self-contained HTML page — filename, size, type, an inline `<img>`/`<video>`/`<audio>` for the
inline allow-list, and a download button — and `GET /s/:token/download` streams the stored object
with the same range handling as the owner content route (D40), the shared `contentDisposition`
(`inline` for the allow-list, `attachment` otherwise) and `cache-control: private, no-store`. Both
routes resolve through one helper (`lookUpShare`), so they cannot disagree. A refusal answers the
same "Link not available" page (404) as an unknown token; the one disclosed refusal is an exhausted
download allowance, which answers `410` with its own wording. Opening the page increments
`download_count` through `countShareOpen`, whose predicate is part of the `UPDATE`, so two requests
cannot both take the last slot. The _byte_ route does not touch the counter. The page ships no
scripts and its own CSP (`default-src 'none'; img-src 'self'; media-src 'self'; style-src
'unsafe-inline'; frame-ancestors 'none'`), which `security.ts` now leaves alone the way it already
left a route-set CORP alone. `server.ts` redacts the `/s/<token>` path segment from request logs, as
it already redacts a `preview` token. Both routes are `hide: true`: they answer HTML and bytes, not
JSON, so they are not part of the OpenAPI contract.

**Why:** a share URL is opened by a person, so it must return a page, and the byte route must be
separate so that a click, a range request and an embedded element all reach one streaming handler.
Counting the _open_ is what makes "page then download counts once": if the byte route also
incremented, a video's many range requests would drain the allowance mid-playback — which is the
whole reason D40 exists — and if the page did not increment, a capped link would never count at all.
Serving bytes `inline` for the allow-list is what lets the page embed a preview, and the allow-list
keeps SVG and HTML as downloads, so the API origin never renders active content.

**Honest limits:** the byte route cannot raise the counter, so a hotlinker who never opens the page
can read the object without spending allowance — the cap bounds _opens_, not bandwidth, and is not a
DRM. The token still travels in the URL and therefore through `Referer` headers and history, which is
why resolution is re-checked on every request and revocation takes effect immediately. There is still
no share _listing_ route, so an owner can see a link only where it was created, and the page shows
expiry as a date rather than a countdown.

**Guarded by:** `apps/api/src/share-page.test.ts` (escaping, preview-element choice, size
formatting), `apps/api/src/server.test.ts` ("redacts a share token in a path without hiding the
route"), and `tests/integration/src/shares.test.ts` ("renders a landing page that embeds the file
inline and links the download route", "streams the shared bytes byte-exactly, and honours a range",
"answers a revoked, unknown or spent link with the same unavailable page", "counts one open per page
load and refuses the next past the cap").

## D45. The edge cache is a local, non-authoritative decorator over the storage provider, bounded by an LRU byte budget

**Chosen:** `CachingStorageProvider` implements the same `StorageProvider` interface and wraps the
resolved provider, so every existing read and write path is unchanged. It changes exactly one thing:
`openReadStream`. A cache **hit** is served from a local disk blob; a **miss** is answered by the
provider _and_ starts a de-duplicated background fill (the whole object, streamed to a temp file and
atomically renamed into place) so the **next** read — including the next byte range of the same video
— is local. Every other method delegates, and the wrapper publishes the wrapped provider's own
capabilities: the cache adds speed, never a capability the provider lacks. Bytes live in
`EDGE_CACHE_DIR` (default `.edge-cache`) as content-addressed blobs keyed by
`sha256(providerId \0 locator \0 size \0 checksum)` — never by the locator itself, which may be a
credential-bearing Telegram path — with a small JSON index beside them. `EDGE_CACHE_MAX_BYTES`
(default 5 GiB) is an **LRU budget, not a size gate**: any object is cacheable, and least-recently-used
entries are evicted on every write to stay under it. Evidence is `fs` atomic rename (a reader can
never observe a half-written blob; a size mismatch is treated as a miss) and `EDGE_CACHE_TTL_SECONDS`
(default 7 days) after which an entry is re-fetched. `deleteObject` purges the blob before delegating,
so a deleted object cannot be served from disk. The wrapper is applied in `applyEdgeCache` and wired
in `services.ts`; a test-injected resolution bypasses it. The store is closed (index flushed)
best-effort on server shutdown; a fill still in flight is abandoned, because the bytes are on the
provider.

**Why:** the storage bottleneck is Telegram's throttled read path (~0.17 MiB/s), and the API is the
only component that may talk to the provider, so a local copy in front of it is the only place a
second read can get faster. Making it a decorator rather than a new code path means the delivery
surface, the owner route and the share route all benefit without changing, and the provider contract
suite still applies to the wrapped provider unchanged. Background-fill (rather than a synchronous
read-through) is what makes it work for video: a range read cannot populate a whole-object entry, so
the fill must run in parallel with the first pass-through. A byte budget rather than a size cap
honours "cache everything, any size" while still bounding disk. Keeping bytes off Postgres and Redis
is the architecture's existing rule (D5, D20): the cache is derived state whose loss costs only speed.

**Honest limits:** on the ephemeral GitHub Actions host this cache is **wiped with the runner**. It is
a session-scoped _origin_ cache, not a geographically distributed CDN, and nothing is shared between
nodes — a second instance re-fetches everything. The first read of any object is _slower_ than a
direct read (the provider read plus a disk write), and a fill of a large object costs one full
provider read even if only one range was requested. There is no `ETag`-based revalidation of a cached
blob against the provider: freshness is the TTL plus the object's own immutability (a re-upload is a
new object with a new key). Eviction is in-process and per-node, which is why
`maintenance.edge_cache_evict` is _declared_ but not implemented: a single process does not need a job
to evict, and a multi-node edge would. A 5 GiB budget of large objects is a small number of entries,
so a low hit ratio under mixed traffic is expected and not a bug.

**Guarded by:** `apps/api/src/storage/cache/caching-provider.test.ts` (the storage contract suite
against the wrapper, fill-then-serve-without-touching-the-provider, range-from-cache, concurrent-fill
de-duplication, per-object limit, purge-on-delete, failed-fill-is-a-miss, health reports cache state),
`apps/api/src/storage/cache/disk-byte-cache.test.ts` (keying, commit/lookup/purge, partial-entry
refusal, TTL staleness, LRU eviction, index reload drops missing blobs), and `apps/api/src/config.test.ts`
(the new defaults).

## D46. Cacheable delivery is a separate, version-bound signed URL — not the owner content route

**Chosen:** `POST /api/v1/files/:fileId/delivery-url` (owner, scope `files:read`) returns
`{ url, path, expiresAt }` where `path` is `/cdn/:fileId/:version?token=<token>` on the API origin,
outside `API_PREFIX`. The token is `base64url("<fileId>.<version>.<expEpochSec>")` + `"."` + a hex
HMAC-SHA256 over exactly that encoded payload; the key is HKDF-SHA256 (`info` =
`opendrive/delivery-url/v1`) of `EDGE_DELIVERY_SIGNING_SECRET`, falling back to
`PREVIEW_SIGNING_SECRET`, then `IP_HASH_SECRET`, with TTL `EDGE_DELIVERY_TTL_SECONDS` (default 3600).
`version` is the **storage-object id** (`sobj_…`), so a re-upload is a new version and therefore a new
URL. `GET /cdn/:fileId/:version` verifies the token, requires the file be servable, requires the
active object's id to equal `version` (otherwise 404 — the old bytes are genuinely gone), and then
streams through the same range machinery as D40 with `accept-ranges`, `etag` (the object checksum, or
its id), `cache-control: public, max-age=<EDGE_PUBLIC_MAX_AGE_SECONDS>, immutable`, `if-none-match` →
`304`, and `206`/`416` for ranges. Inline-safe types get `cross-origin-resource-policy: cross-origin`;
everything else keeps same-origin. `security.ts` no longer overwrites a `cache-control` a route set
for itself, and `server.ts` redacts the `token` query parameter from request logs. The route is
`hide: true`: it answers bytes, not the JSON contract.

**Why:** caching and the owner content route have opposite requirements. The owner route is
`private, no-store` because it is keyed on a bearer credential and returns private metadata; a CDN or
a browser cache must never store it. But a `<video>` that re-fetches every range through an
authorization header cannot be cached at all, and the whole point of D45 is to make the second read
cheap — including at a cache in front of the origin. A URL-borne, version-bound token is what allows
`public, immutable`: the credential is scoped to one file and one version and dies on its own, and
because `immutable` is only safe when the URL changes with the bytes, binding the token to the object
id is not optional. Keeping this surface separate from `/files/:id/content` means neither contract has
to compromise: the owner route stays uncacheable and authorization-checked, the delivery route stays
cacheable and token-checked, and they share only the provider read.

**Honest limits:** the token travels in the URL and therefore through `Referer` headers, history and
(before redaction) logs — a short TTL bounds the damage but does not remove it, and anyone who holds a
live URL can read the file until it expires. `public` means a shared proxy may serve the bytes to
anyone who presents the same URL, which is the intended trade. The URL is only as immutable as the
object-version binding: a file whose bytes are replaced gets a new object id and a new URL, but the
_old_ URL now 404s rather than redirecting, so a client holding it must re-mint. A deployment with no
delivery signing secret answers 503 at mint. And because the cache is per-host (D45), `public,
immutable` at an external CDN would still be filled by re-fetching from this origin on a cache miss.

**Guarded by:** `apps/api/src/delivery-tokens.test.ts` (mint/verify, expiry, version binding, tamper,
wrong secret, payload encoding), and `tests/integration/src/delivery.test.ts` ("streams a cacheable
delivery URL without a bearer credential", "serves the second read from the cache without touching
the provider", "answers a byte range with 206 and marks a bad range 416", "revalidates with an ETag
and answers 304", "refuses a tampered token, another file, and another version", "purges the cached
bytes when the file is deleted").
