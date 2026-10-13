# OpenDrive — Phase 3 completion report (web app and file manager)

**Date:** 2026-10-12
**Repository:** `C:/Users/basud/OneDrive/Desktop/New folder` (branch `main`, work uncommitted)
**Phase prompt answered:** `PHASE3-WEB-APP-PROMPT-ONE-PIECE-BRUTALIST.md`

---

## 1. Phase gate result

Phase 2 was **not re-run as a gate** in this phase; the gate items were checked against the repository
and the two that cannot be closed from here are recorded as carried-over environment blockers rather
than claimed as done:

| Gate item | Result | Evidence |
|---|---|---|
| Migrations applied to the real Supabase project | **not done (environment blocker)** | `supabase/migrations/*.sql` verified against a local reconstruction only (`pnpm db:verify`, 335 checks). Not run in this phase: no Supabase credentials in this environment and applying migrations needs explicit approval. |
| Storage provider enabled and measured to the 2 GiB target | **not done (environment blocker)** | `STORAGE_PROVIDER=none` by default; `telegram-experimental` attaches only with `TELEGRAM_BOT_TOKEN` + `TELEGRAM_STORAGE_CHAT_ID`. `/readyz` reports `storage: not_configured`, and the interface reflects that instead of hiding it. |
| Byte transfer (upload/download/delete) implemented for the product path | **verified in code + tests** | `apps/api/src/routes/files.ts` (content stream, owner delete, deletion-token delete), `apps/api/src/routes/uploads.ts` (initiate/part/complete/abort); web client is wired to those exact routes and contract-tested against them. |
| Web client work | **delivered this phase** | everything in section 4 below |

Consequence for this phase: the UI shows uploads as **unavailable with the reason** whenever
`/readyz` reports the storage provider as not configured, and it never presents the 2 GiB/5 GiB
ceiling as verified while `maxFileSizeVerified` is false.

---

## 2. Capability map (audited from source, then verified by test)

State vocabulary: `verified` (endpoint exists and the web app's use of it is covered by a passing
test), `implemented-but-unverified`, `missing`, `blocked`.

| UI capability | API endpoint / schema | State | Notes |
|---|---|---|---|
| Sign in / create account | Supabase Auth client SDK → `Authorization: Bearer`; API verifies | verified | `apps/web/src/lib/auth/supabase.ts` (lazy-loaded), `session.tsx`; API-side verification covered by existing `apps/api` tests. Real Supabase instance not available here → **no live sign-in was performed** (environment blocker). |
| Anonymous session upload | `POST /api/v1/anonymous-sessions` (`anonymousSessionResponseSchema`) | verified | `SignInRoute` → `startAnonymousSession`; credential in memory only. |
| List files (paged) | `GET /api/v1/files` (`filePageSchema`, `?folder=root\|fold_…`, `?cursor`, `?limit`) | verified | `useFileList`; a slow answer for folder A cannot populate folder B (abort on change). |
| Folder navigation / breadcrumbs | `GET /api/v1/folders?parent=…` (`folderPageSchema`, no single-folder route) | verified | `useFolderIndex` + `DriveRoute`; a name missing from the index renders as a short id, never a wrong name. |
| Create folder | `POST /api/v1/folders` (`createFolderRequestSchema`) | verified | `DriveRoute` dialog. |
| Rename / move folder | `PATCH /api/v1/folders/:id` (`updateFolderRequestSchema`) | implemented-but-unverified | Route exists; **no control is exposed** because the drive has no rename affordance that has been tested end-to-end. Stated as a gap on System status. |
| File metadata / inspector | `GET /api/v1/files/:id` (`fileRecordSchema`) | verified | Inspector reads only fields the schema carries. |
| Upload initiation | `POST /api/v1/uploads` (`initiateUploadResponseSchema`) | verified | `uploadQueue` uses the server's `chunkSizeBytes`, not the configured one. |
| Upload part | `PUT /api/v1/uploads/:id/parts/:n` + `x-part-checksum-sha256` (`uploadPartResponseSchema`) | verified | Sent through `XMLHttpRequest` for real progress; per-part SHA-256 when WebCrypto is available. |
| Complete upload | `POST /api/v1/uploads/:id/complete` (`completeUploadResponseSchema`) | verified | `ready` is only ever set after this answers. |
| Abort upload | `DELETE /api/v1/uploads/:id` | verified | Failure of the cancel is reported as "Cancel requested (not confirmed)". |
| Upload limits | `GET /api/v1/limits` (`limitsResponseSchema`) | verified | Client-side pre-flight; server remains authoritative. |
| Drag-and-drop / file picker | — (client-side) | verified | `DropOverlay`, hidden file input; disabled with the blocker text when uploads are unavailable. |
| Download content | `GET /api/v1/files/:id/content` | verified | Streams to disk via File System Access API when present, otherwise buffers and says so. |
| Delete file (owner) | `DELETE /api/v1/files/:id` | verified | Confirmation dialog states the Telegram caveat. |
| Delete anonymous file | `DELETE /api/v1/files/:id` + `x-deletion-token` | verified | Token shown once, in the upload tray. |
| Create share link | `POST /api/v1/shares` (`createdShareRecordSchema`) | verified | From the file inspector; token returned once. |
| Revoke share link | `DELETE /api/v1/shares/:id` | verified | From the file inspector (tab-scoped list). |
| Resolve a share token | `POST /api/v1/shares/resolve` + `X-Share-Token` | verified | Shares page. Refusals are reported as identical, as the API guarantees. |
| List existing share links | — | **missing** | No listing route; the Shares page and System status say so explicitly. |
| Share landing page `/s/:token` | — | **missing** | Same; stated in the interface, not faked. |
| API keys (list/create/revoke) | `/api/v1/api-keys*` | verified | Account page; the created key is shown once with a copy action. |
| Quota / usage | `GET /api/v1/me` (`meResponseSchema`) | verified | `StorageMeter`; shows `unknown` rather than an invented bar when there is no answer. |
| Readiness / limits / health | `/healthz`, `/readyz`, `/api/v1/limits` | verified | System status page. |
| Abuse report | `POST /api/v1/abuse-reports` → `501` | blocked | No control is offered; listed as a known gap. |
| Preview / search / trash / favorites / versions | — | missing | No controls, no commands, no placeholder copy. |

---

## 3. What the web app now does, and what it deliberately does not

**Shipped and user-visible**

- **Sign-in screen** with three real paths: Supabase account, account creation (including the
  "confirm your email" answer), and an anonymous session. When the deployment has no auth service
  configured it says so instead of offering a form that cannot work.
- **My Drive**: folder in the URL (`?folder=`), breadcrumbs from the API's folder tree, density-aware
  list/grid views, filter (labelled as "this page only"), sort notice, pagination ("Load more"),
  multi-select with shift-range and Ctrl/Cmd toggle, per-file overflow menu, bulk delete and bulk
  download with per-file results.
- **Upload tray** ("the log pose") docked at the bottom: one row per transfer, real byte counts,
  phase words (`queued`/`uploading`/`finalizing`/`ready`/`failed`/`aborted`), cancel that calls the
  API, and a one-time deletion token for anonymous uploads.
- **File inspector** ("field notes") with metadata, download, delete and share actions, plus
  revoke for links created in this tab.
- **Share dialog** and **Shares page** (resolve a token; explicit statements that listing and a
  landing page do not exist yet).
- **Account page** (API keys: create, one-time reveal, revoke) and **System status** ("ship status")
  with readiness chips, enforced limits, the capacity ruler and a "known gaps in this build" list.
- **Command palette** (`Ctrl/Cmd+K`) built only from capabilities that exist, theme toggle ("Chart
  Paper" / "Night Voyage"), and keyboard-reachable menus and dialogs with focus return.

**Deliberately unavailable, and stated in the interface**

- Upload when no storage provider is attached: the control is disabled with the API's own reason,
  and the palette command reports the blocker instead of opening a picker.
- Share listing, `/s/:token` landing page, file rename/move, abuse reporting, previews, search,
  trash, favorites and version history: nothing in the interface implies they exist.

**Design system**

- One token layer (`apps/web/src/styles/tokens.css`): semantic colours, brutalist geometry (thick
  ink borders, hard offset shadows, near-square controls), typography (condensed display face for
  headings, Segoe UI for body, Cascadia Mono for ids/sizes/timestamps) and motion durations. No
  webfont requests, no remote assets, no images: textures are CSS gradients and the icons are local
  SVG (`Icon.tsx`, `Mark.tsx`).
- Two themes designed separately rather than inverted; **contrast is enforced by a test**, not by a
  comment (`src/styles/tokens.test.ts` resolves the pairs the UI paints and requires ≥4.5:1 in both
  themes). That test found a real defect during this phase: the dark accent `#e4573f` was 4.46:1 on
  the dark panel and was lightened to `#ea6248` (4.93:1).
- `prefers-reduced-motion` collapses the motion tokens to `0ms`; no essential information is carried
  by animation or colour alone (file state is always a word plus a tone).

---

## 4. Files created or changed (relative to repository root)

**Changed**

- `.prettierignore` — the root planning/report documents are excluded from formatting.
- `apps/web/package.json` — added `@supabase/supabase-js`, `react-router`; dev: `@testing-library/dom`,
  `@testing-library/react`, `jsdom`.
- `apps/web/vitest.config.ts` — jsdom is opt-in per file (`@vitest-environment jsdom`), shared package
  aliased to source, `src/test/setup.ts` preloaded.
- `apps/web/src/main.tsx` — provider composition, theme applied before first render, Supabase adapter
  only when configured.
- `apps/web/src/App.tsx` — route table with a session guard.
- `pnpm-lock.yaml`, `tests/integration/src/quota.test.ts` (from the earlier size-ceiling work).
- **Removed:** `apps/web/src/styles.css`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/api.test.ts`,
  `apps/web/src/components/LedgerSection.tsx` (superseded by the token stylesheets and the typed
  client; the status console moved to `routes/StatusRoute.tsx`).

**Created — app**

`apps/web/src/components/`: `CommandPalette.tsx`, `ConfirmDialog.tsx`, `Icon.tsx`, `Mark.tsx`,
`Menu.tsx`, `ToastRegion.tsx`, `CapacityRuler.tsx`, `StatusChip.tsx`
`apps/web/src/files/`: `EmptyState.tsx`, `FileGrid.tsx`, `FileInspector.tsx`, `FileTable.tsx`,
`FileToolbar.tsx`, `FileTypeGlyph.tsx`, `presentation.ts`
`apps/web/src/lib/api/`: `client.ts`, `errors.ts`
`apps/web/src/lib/auth/`: `config.ts`, `session.tsx`, `supabase.ts`
`apps/web/src/lib/files/`: `download.ts`, `kind.ts`
`apps/web/src/lib/upload/`: `checksum.ts`, `plan.ts`
`apps/web/src/lib/`: `prefs.ts`
`apps/web/src/routes/`: `AccountRoute.tsx`, `DriveRoute.tsx`, `SharesRoute.tsx`, `SignInRoute.tsx`,
`StatusRoute.tsx`
`apps/web/src/shares/ShareDialog.tsx`
`apps/web/src/shell/`: `Shell.tsx`, `Sidebar.tsx`, `StorageMeter.tsx`
`apps/web/src/state/`: `prefs.tsx`, `system.tsx`, `uploadQueue.tsx`, `useFiles.ts`, `useSelection.ts`
`apps/web/src/styles/`: `tokens.css`, `base.css`, `shell.css`, `files.css`, `upload.css`,
`dialogs.css`, `auth.css`, `status.css`
`apps/web/src/upload/`: `DropOverlay.tsx`, `UploadTray.tsx`

**Created — tests**

`apps/web/src/App.test.tsx`, `apps/web/src/routes/DriveRoute.test.tsx`,
`apps/web/src/shell/Shell.test.tsx`, `apps/web/src/lib/api/client.test.ts`,
`apps/web/src/lib/upload/plan.test.ts`, `apps/web/src/styles/tokens.test.ts`,
`apps/web/src/test/setup.ts`, `apps/web/src/test/fakeServer.ts`, `apps/web/src/test/harness.tsx`.

**Created — documentation:** this report, and the updated `CURRENT-STAGE.md`.

---

## 5. Verification commands, exit codes and outcomes

Run from the repository root, Node 24.13.0, pnpm 12.11.2 (`export PATH="/c/Users/basud/.local/node24:$PATH"`).

| Command | Exit | Outcome |
|---|---|---|
| `pnpm format:check` | 0 | "All matched files use Prettier code style!" (35 files were reformatted to get there). |
| `pnpm lint` | 0 | ESLint clean. Fixing it removed 39 real findings in the new code (no suppressions): detached method references in context values, floating `navigate()` promises, a `import()` type, an unnecessary assertion, unused imports, an implementation-only DOM shim. |
| `pnpm typecheck` | 0 | All 7 workspace projects. |
| `pnpm build:libs` | 0 | `@opendrive/shared` built. |
| `pnpm --filter @opendrive/api build` | 0 | API compiled. |
| `pnpm --filter @opendrive/web build` | 0 | 295 modules, `dist/assets/index-*.js` 449.23 kB raw / 135.24 kB gzip, CSS 33.34 kB / 6.44 kB gzip, built in ~0.4 s. |
| `pnpm test` | 0 | **389 passed, 1 skipped** across the workspace: shared 92, api 171 (+1 skipped), worker 20, cli 20, web 86. |
| `pnpm test:e2e` | 0 | 9 tests against the compiled API over a real socket. |
| `npx vitest run` (web, ×5 consecutive runs) | 0 | 86/86 each run; this is what closed a real flake described in section 6. |

**Not run in this phase, with the reason:**

| Command | Reason |
|---|---|
| `pnpm db:verify` (335 pgTAP checks) | Needs a local PostgreSQL and `psql`/`createdb`/`dropdb`; no database was started in this environment. Unchanged by this phase (no migration was edited), but **not re-run**. |
| `pnpm db:test:integration` (61 tests) | Same environment requirement. |
| Live Supabase sign-in / live Telegram round-trip | No credentials; the UI's behaviour with `storage: not_configured` and with no auth service is tested instead. |
| Real-browser (Playwright) drive of sign-in → upload → download → share | Not available in this environment. Browser-level behaviour is covered with jsdom + Testing Library instead, which is a weaker guarantee and is described as such. |

---

## 6. Tests added

**Unit / data layer (node environment)**

- `apps/web/src/lib/upload/plan.test.ts` (9): contiguous parts, part numbering from one, the part
  ceiling, the file ceiling (a 4 GiB object at the provider's 2,000,000,000-byte part ceiling → three
  parts), empty files, a part size outside the API's own range, part-count overflow.
- `apps/web/src/lib/api/client.test.ts` (12): the credential travels in the header and never in the
  URL, no header when signed out, exactly one retry after a 401 with a refreshed token, the session
  layer is told when a 401 survives the refresh, problem bodies keep code/status/detail, an unreadable
  body does not get an invented code, contract drift becomes `ContractError`, transport failure becomes
  `NetworkError`, `/readyz` is read even at 503, and part upload through the injected
  `XMLHttpRequest` (checksum header, progress, refusal, already-aborted signal).
- `apps/web/src/styles/tokens.test.ts` (29): WCAG contrast for 13 text pairs in each theme, the two
  themes are not inversions of each other, **no component stylesheet contains a literal colour**, and
  `prefers-reduced-motion` zeroes the motion tokens.

**Component / behaviour (jsdom through the real providers and HTTP client)**

- `apps/web/src/App.test.tsx` (7): signed-out visitors are redirected and the file route is never
  called; sign-in unavailable without an auth service; a refused sign-in shows the auth service's
  message; a successful sign-in lands on the drive; a 401 that survives the refresh returns to
  sign-in and drops the credential; sign-out clears the rows; and an account switch never leaves the
  previous account's file on screen.
- `apps/web/src/routes/DriveRoute.test.tsx` (16): listing with a truthful count, empty state with the
  real next action, load failure + retry, filter scope stated in the UI, upload disabled with the
  provider blocker, an over-ceiling file refused before any byte moves, a part uploaded with its
  checksum and `ready` only after `/complete`, a refused part reported with the API's reason, cancel
  that calls the API and cannot be resurrected by a late part answer, a cancel that never reached the
  API admitting it, download success (with the buffering caveat) and a non-servable file, delete
  confirmation containing the Telegram caveat, a refused deletion keeping the row, and an anonymous
  upload surfacing its one-time deletion token.
- `apps/web/src/shell/Shell.test.tsx` (10): palette opens with Ctrl+K, focus is inside it, Escape
  returns focus to the opener, filtering + arrow keys + Enter run a command, no unsupported command
  exists, upload reports the storage blocker, the stored preference holds three harmless keys and no
  credential, list/grid and density switch real classes, bulk delete reports per-file outcomes, single
  selection and clearing, and Escape closing the delete dialog without deleting.

**Harness** (`src/test/fakeServer.ts`, `src/test/harness.tsx`): a fake API that answers the real routes
with real shapes, records every request, can fail a route with a real problem body, can hold a route
open (deferred answers) and can answer `XMLHttpRequest` part uploads including progress. The
component tests therefore exercise the production client, session provider, upload queue and routes;
only the server and the auth backend are doubles.

**Two defects the tests found and this phase fixed**

1. Dark-theme accent text below 4.5:1 (`--primary` on `--surface`, 4.46:1) — token lightened.
2. A 401 that survived the refresh left the app on a drive that could not load. `ApiClient` now
   reports an auth failure once the retry is exhausted and the session layer drops the credential, so
   every screen behaves the same way.

**One test-side flake found and fixed (not hidden):** React mounts the file table and removes the
loading skeleton across more than one commit, so a query that resolves on the first of those commits
can return a row React is about to replace — clicking a detached node silently does nothing, which
made the row-menu tests fail roughly one run in three. `settle()` in the harness yields one macrotask
so interaction targets the settled tree; five consecutive full runs are now green. The app's DOM is
stable once the listing has rendered.

---

## 7. Limitations that affect user-visible behaviour

1. **Storage provider unconfigured by default.** With `STORAGE_PROVIDER=none`, `/api/v1/limits` and
   `/readyz` say so, and the UI disables upload with that reason. No fake storage exists.
2. **Telegram is experimental.** Copy states that deletion removes OpenDrive access and is not
   guaranteed to erase Telegram-side copies; it never promises durability, permanent retention,
   ranged reads or resumable uploads. `accept-ranges: none` is honest, and the download path says when
   the browser had to buffer the object in memory.
3. **File-size ceiling is "configured, not verified"** until `maxFileSizeVerified` is true; the drive
   hint, the capacity ruler and the System status tag all say unverified.
4. **Upload sessions are process-local.** Nothing in the interface offers to resume after a refresh or
   a tab close, because the server cannot.
5. **No share listing, no `/s/:token` landing page, no rename/move, no abuse report control**, all
   stated on screen rather than implied.
6. **Checkout of a link is not usable in a browser yet** (`/s/:token` is not served).
7. **Real Supabase sign-in was not exercised**: the Supabase adapter is configured only from
   `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (public values, documented as such) and the code
   path is covered by a stub adapter, not by a live identity provider.
8. **No Redis dependency in the web app**; rate-limit behaviour is the API's, and the UI shows the
   API's own 429 copy.

---

## 8. Remaining blockers

- **environment blocker** — migrations not applied to the real Supabase project; `pnpm db:verify` and
  `pnpm db:test:integration` were not run in this session (no PostgreSQL started).
- **environment blocker** — no Telegram credentials, so no live upload/download round-trip was driven
  through the web app.
- **environment blocker** — no real browser automation available; browser-level verification is jsdom
  plus Testing Library.
- **decision blocker** — whether to add a share-listing endpoint (`GET /api/v1/shares`) and a
  `/s/:token` landing page. Both are needed for shares to be a complete product flow, and both are
  backend work this phase deliberately did not start.
- **decision blocker** — whether file rename/move should get a UI once `PATCH /files/:id` exists.

---

## 9. Recommended next step (from the evidence)

Finish the two halves a file product cannot ship without, in this order:

1. **Serve shares end to end**: a token landing page (`/s/:token`) and a listing route, so a link
   created in the interface can actually be opened by the person it was sent to.
2. **Make the storage path real and measured**: attach a provider, then drive one upload and one
   download through the web app against it and record the measured object size, so
   `maxFileSizeVerified` can truthfully become `true` — which is the single value that changes what
   the interface is allowed to promise.

Everything in the interface is already written to react to that: the day `/readyz` reports the
provider as `ok` and `/limits` reports the ceiling as verified, uploads enable themselves and the
capacity ruler fills in, with no copy to rewrite.
