# Security model

Phase 1 status: this document describes the security model the platform is built around and marks
exactly which parts are implemented today. Implemented in this build: error model, identifier and
token generation, header policy, request validation, CORS allow-listing, in-process rate limiting,
request-id hygiene, the honesty controls around unimplemented features, **authentication**
(Supabase access tokens, anonymous sessions, scoped API keys), **authorization** for metadata
resources (ownership read from the database), **share tokens** with expiry and revocation,
**quota reservations**, and **audit-event emission**. Not implemented: any byte transfer
(upload, download, deletion), Redis-backed shared rate limiting, malware scanning, and
administrative takedowns.

## 1. Assets and actors

| Asset                                                                  | Why it matters                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| File contents                                                          | May be private, sensitive, or illegal; also the target of abuse |
| Metadata (filenames, sizes, owners, share links)                       | Reveals who holds what                                          |
| Bearer credentials (share tokens, deletion tokens, API keys)           | Possession grants access                                        |
| Service credentials (Supabase service role, Redis password, bot token) | Grant broad access to the platform                              |
| Availability (CPU, RAM, bandwidth, disk)                               | The platform runs on a fixed, modest VPS                        |

Actors considered: anonymous internet users, abusive uploaders, a curious or malicious
logged-in user, an attacker with a stolen bearer token, and an attacker with a database
dump (but not the application's secret key).

## 2. Authorization

- **Private by default.** `files.visibility` defaults to `private`
  (`supabase/migrations/20261010000001_initial_schema.sql`), and the published file record
  carries no provider reference.
- **Server-side decisions only.** The web client and CLI hold no authority. Every private-file
  operation must be decided in the API against the owner identity or a presented bearer token.
- **Row Level Security as a second layer.** RLS is enabled on every table. There are no
  permissive defaults; policies exist only for a user's own rows. The API uses the service
  role and performs its own checks, so a missing application check cannot be masked by an
  over-broad policy. `storage_objects`, `api_keys`, `audit_events`, `abuse_reports` and
  `moderation_actions` have no client policies at all.
- **IDOR.** Identifiers are random (`file_` + 130 bits) rather than sequential, and
  authorization never depends on the caller knowing an id. Public and unlisted access flows
  through share tokens, never through file ids.
- **Ownership is data, not a claim.** `files`, `folders`, `usage_counters` and
  `quota_reservations` carry a stored generated `owner_key` derived from the row's own principal
  columns, so a caller cannot supply it. Every access path scopes its query by the authenticated
  principal, and ownership fields in a request body are ignored
  (`apps/api/src/authz.ts`; asserted by `tests/integration/src/ownership.test.ts`).
- **Refusals disclose nothing.** Another principal's resource answers with the same `404` a
  nonexistent one produces, and each refusal is recorded as an audit event naming the reason, so
  an operator sees what the caller cannot. This also means the API cannot be used to enumerate
  other people's resources.
- **Identity is verified, then checked.** Supabase access tokens are verified for signature,
  expiry, issuer, audience and algorithm, and the Supabase `service_role` token is refused
  outright even though its signature is valid (`apps/api/src/auth/tokens.ts`). A verified user
  whose account is suspended is refused on every protected route. With no verification key
  configured, protected routes answer `503` rather than trusting anything.
- **The database role is part of the security model.** `files` does not use `FORCE ROW LEVEL
SECURITY`, so `DATABASE_URL` must connect as a **non-owner** application role; a table owner
  would bypass RLS. `supabase/tests/60_secrets_and_invariants.sql` asserts both halves of this and
  records it as a hazard rather than an assumption.

## 3. Credentials

| Credential                    | Generation                | Storage                                                          | Comparison    |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------- | ------------- |
| Share token (public/unlisted) | 256 bits CSPRNG, URL-safe | SHA-256 hash only (`shares.token_hash`, unique)                  | constant time |
| Anonymous session credential  | 256 bits CSPRNG, URL-safe | SHA-256 hash only (`anonymous_sessions.credential_hash`, unique) | constant time |
| Anonymous deletion token      | 256 bits CSPRNG           | SHA-256 hash only (`files.deletion_token_hash`)                  | constant time |
| API key                       | `odk_` + 256-bit secret   | Prefix stored for display, SHA-256 hash only                     | constant time |
| Job lease token               | 128 bits CSPRNG           | in-memory only                                                   | n/a           |

Implemented and exercised in [packages/shared/src/tokens.ts](../packages/shared/src/tokens.ts),
[ids.ts](../packages/shared/src/ids.ts) and `tests/integration`, with tests covering length,
alphabet, uniqueness and published hash vectors. The plaintext credential is returned exactly
once, at creation; it is never persisted and never logged — asserted by scanning every column of
the created row for the plaintext value, not merely by inspecting the response. Revocation is a
row update (`revoked_at`), so it takes effect on the next request rather than at the next cache
expiry, and the revoked row is retained so the files pointing at it stay attributable.

A credential is matched by hashing what the caller presented and comparing digests, so a database
dump yields no usable credential. `supabase/tests/60_secrets_and_invariants.sql` asserts the shape
of every credential column — 64 lowercase hex, no plaintext column anywhere — and the case that
would let a weak credential be used as a fallback when a strong one is invalid is covered in
`tests/integration/src/identity.test.ts`.

## 4. Secrets management

- Secrets come from the environment only. `.env` is git-ignored; `.env.example` contains
  placeholders and is the only environment file in version control.
- The API validates configuration at startup and **never logs values** — only whether a
  dependency is configured and which variable names are missing
  (`apps/api/src/config.ts`, asserted by a test that greps the resolved config for injected
  secret values).
- CI needs no secrets and receives none: the workflow's only permission is `contents: read`,
  and it performs no deployment.
- Rotating a secret must never require a code change; every credential is read from the
  environment at startup.

## 5. Abuse resistance

- **Rate limiting** is applied globally except to `/healthz`, which must stay answerable during
  a flood (`apps/api/src/server.ts`). The current limiter is in-process, so it is per-instance;
  a later phase replaces the store with Redis so limits hold across instances. This limitation is
  deliberate and documented rather than hidden.
- **Quotas** are enforced per principal in the database, not only configured: per-file size,
  storage and per-day upload allowances for anonymous and registered principals, plus a file-count
  ceiling. Usage is _reserved_ before bytes move (`quota_reservations`, with a row lock on the
  principal), so two concurrent uploads cannot each pass the same allowance check, and a hold
  counts towards the daily allowance until it is committed or released. The policy is data
  (`quota_limits`), so tightening a limit does not require a code change, and the per-file ceiling
  can never exceed the 2 GiB product target — asserted by `supabase/tests/50_quota.sql` and
  `tests/integration/src/quota.test.ts`.
- **Resource exhaustion**: chunked uploads with bounded buffers, a part-count ceiling, and
  session expiry that releases staged bytes. There is no unbounded request-body parsing path:
  file bytes are streamed, and unsupported routes reject before reading a body.
- **Validation**: every request body, parameter and documented header is validated with Zod
  before a handler runs; failures return a field-level `400` with the published problem shape.

## 6. Content handling

- **MIME and signature validation** (Phase 1): declared MIME type is a hint, never a fact. The
  stored value must be derived from inspecting the bytes, and a mismatch must be recorded
  rather than silently accepted (`files.detected_mime_type` exists for this).
- **Filenames**: the original name is preserved for display only; a separate
  `download_filename` column exists so a hostile name can never be reflected into a response
  header. Stored paths are generated by the server, never derived from user input, so path
  traversal has no input surface.
- **Safe download headers**: `Content-Disposition: attachment` with a sanitised filename,
  `X-Content-Type-Options: nosniff` (already set), and previewing only for an allow-list of
  image, audio and video types. Everything else downloads. Types that browsers may execute
  (`text/html`, `image/svg+xml`, scripts) are never served inline.
- **Malware scanning** (Phase 4): a file may become downloadable only when
  `scan_state = 'clean'`. When `MALWARE_SCAN_ENABLED` is true and no scanner is wired up, the
  correct behaviour is to keep files un-downloadable — the `scan.requested` job is declared
  precisely so that gap is visible. Scanning is currently disabled and reported as such by
  `/api/v1/limits`.

## 7. Abuse reporting and takedowns

Contract published (`POST /api/v1/abuse-reports`, answers `501` today), schema in the
migration (`abuse_reports`, `moderation_actions`). Requirements for Phase 4:

- Reports are rate limited per IP and reporter addresses are stored hashed, not raw.
- Triage is a recorded decision (`moderation_actions`), not a silent deletion.
- A takedown must disable shares and downloads immediately, without waiting for storage
  cleanup, and must be reversible in the record even if the bytes are gone.
- An abuse contact address is configuration (`ABUSE_CONTACT_EMAIL`), published where the
  platform is described.

## 8. Audit events

`audit_events` is append-only, and the API now **emits** events (authentication outcomes,
authorization refusals, share creation/resolution/revocation, quota refusals) through
`apps/api/src/db/repositories/audit.ts`. Writing an audit event never fails the request that
triggered it — the failure is logged instead, so an audit outage cannot become an availability
outage — and the reason for a refusal is recorded in the event while the caller still receives a
bare refusal. Rules:

- Client addresses are stored as an HMAC (`actor_ip_hash`), never raw, so audit data cannot
  become a location trail.
- Tokens, passwords, cookies and provider locators never enter audit metadata or logs.
- Request ids are server-generated and echoed in responses; a client-supplied `x-request-id`
  is ignored, so logs cannot be spoofed or confused (`apps/api/src/server.ts`).

## 9. Cross-cutting web risks

| Risk                   | Position                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF                   | The API authenticates with bearer tokens in headers, not cookies; CORS is an explicit allow-list with `credentials: false`. Cookie-based sessions, if ever added, must bring their own CSRF defence.                                            |
| XSS                    | The API never returns HTML from user input, and sets `Content-Security-Policy: default-src 'none'` on API responses (the docs UI gets a relaxed, self-only policy and no cookies).                                                              |
| SSRF                   | No user-supplied URL is ever fetched. The only outbound calls are to the configured storage provider and the configured Supabase instance. If provider links are proxied later, they must be validated against an allow-list of provider hosts. |
| Injection              | No raw SQL is constructed from user input; parameterised queries only. The migration uses no dynamic SQL.                                                                                                                                       |
| Clickjacking           | `X-Frame-Options: DENY` plus `frame-ancestors 'none'`.                                                                                                                                                                                          |
| Cache leakage          | API responses are `Cache-Control: no-store`; personalized responses must also be marked private.                                                                                                                                                |
| Information disclosure | Unexpected errors log server-side and return a generic `500` problem document; expected errors return a stable `code` without internals (`apps/api/src/server.ts`).                                                                             |

## 10. Encryption: what can and cannot be claimed

**OpenDrive does not implement application-level encryption at rest, and no document may claim
otherwise.** What is actually true:

| Layer               | Reality                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In transit          | TLS is the deployment's responsibility. The API sets no HSTS itself (it belongs at the TLS terminator) and refuses to guess whether it is behind one. Nothing may be described as encrypted in transit until TLS termination is configured and verified. |
| Postgres (Supabase) | Encryption at rest depends on the existing instance's configuration and its disk/storage setup. That is an operator-verifiable property of the instance, not of this codebase, and it has not been verified.                                             |
| Redis               | No encryption claim. Redis holds rate-limit counters and short-lived coordination state, never file contents, and should require authentication and not be reachable from the public internet.                                                           |
| Storage providers   | Provider-specific and unverified. Telegram publishes no encryption guarantee for stored documents; treat anything stored there as unencrypted. A future provider's claim must be documented per provider, not generalised.                               |
| Backups             | Encryption depends on how the dump is produced and where it is stored. No claim until the restore drill in [ARCHITECTURE.md](ARCHITECTURE.md) has run.                                                                                                   |
| Deletion            | Deleting a row is not proof that bytes are gone. `deleteIsFinal` is `false` for providers that cannot prove it, and user-facing deletion language must describe logical deletion, not physical erasure.                                                  |

## 11. Explicit gaps in this build

Not implemented, and not to be described as working: any byte transfer (upload, download, and the
deletion of a stored object); Redis-backed rate limiting shared across instances; malware scanning;
administrative takedowns and abuse triage; and any storage provider. Every one of those appears as
a `501` naming its phase, a `not_configured` dependency, or a `declared` job.

Two limitations are worth stating plainly rather than leaving to inference:

- **Identity is verified, not issued here.** The API has no sign-in flow, no password handling and
  no session cookie. It verifies tokens minted by the existing Supabase Auth instance; issuing them
  is that instance's job. Nothing in this build should be read as a claim about account lifecycle
  (registration, password reset, MFA).
- **Metadata protection is not content protection.** The authorization journey here is proven for
  file _metadata_, folders and shares. Until a download route exists and is tested the same way, no
  statement should be made about who can read file _bytes_.
