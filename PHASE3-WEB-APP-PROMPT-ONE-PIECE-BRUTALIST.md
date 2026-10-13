# OpenDrive — Phase 3 prompt: Web app and file manager

**Repository:** continue in the existing OpenDrive TypeScript monorepo. Do not create a new project or regenerate the repository.
**Required context:** read `CURRENT-STAGE.md` and the final Phase 2 report first. The separate `supabase-actions/` repository hosts infrastructure and must not be confused with OpenDrive's migrations or application code.

You are continuing existing work. Your goal is to turn the current React/Vite status console into a usable, secure, visually distinctive OpenDrive web app and file manager with a modern advanced interface inspired by One Piece anime, pirate-adventure manga, and brutalist editorial design. Use only real API capabilities proven in the repository. Preserve the project's “prove before you claim” discipline. The design must feel intentionally art-directed and production-quality—not like a generic admin dashboard or a pile of decorative cards.

---

## 0. Phase gate — do this before coding

1. Read `CURRENT-STAGE.md` end to end, then read the Phase 2 completion report and its verification evidence.
2. Check the Phase 2 acceptance criteria against actual command output and tests—not just documentation claims.
3. If a critical transfer/security contract is incomplete, or the Phase 2 report is missing, **do not start user-facing UI implementation yet**. Return a concise blocker report describing the exact missing evidence and commands needed. Do not label Phase 2 complete by inference.
4. If Phase 2 has passed, continue below. If an environment-only item remains explicitly documented (for example, real Telegram credentials are unavailable), only show UI states consistent with the verified API behavior and provider capability flags; never present a blocked capability as working.

## 1. Non-negotiable rules

- Preserve the existing monorepo, pnpm workspaces, TypeScript configuration, React/Vite app, Fastify API, shared schemas, route conventions, and tests. Extend what exists; do not replace functioning modules.
- Do not begin monetization, ads, billing, paid-service integration, or public deployment in this phase.
- Do not add paid dependencies or hosted services. Use existing project dependencies where possible.
- Never access the database directly from browser code. Browser data access must go through the OpenDrive API, except the supported Supabase Auth client flow needed to sign in and obtain an access token.
- Never put Supabase service-role credentials, database URLs, Telegram bot credentials, Redis credentials, signing secrets, or any server-only secret in Vite `VITE_*` variables, frontend bundles, logs, API responses, screenshots, or documentation.
- Follow the existing identity model: Supabase access token, anonymous session credential (`ods_...`), and API key (`odk_...`) as actually supported. Inspect the current implementation before choosing the web session flow. Do not invent credentials, endpoints, scopes, or token formats.
- Every user-specific data operation must be authorized by the API. Never trust a user ID, owner ID, folder ID, visibility, file state, or permission supplied by the client as proof of access.
- Keep cross-owner resources indistinguishable from missing resources where the API contract specifies 404. Do not leak whether another user owns a file or folder.
- Telegram is experimental. UI copy must not promise permanent retention, guaranteed durability, final deletion, resumable uploads, ranged reads, or unmeasured maximum file sizes. Use the API’s actual limits/capability response and show an honest warning where appropriate.
- Do not claim that any workflow works until tests and verification commands prove it. Distinguish mock tests, local integration tests, and live external-service tests.

## 2. Audit the current UI and API before design or implementation

Inspect the existing files and discover the exact current paths rather than assuming names. At minimum inspect:

- `apps/web/` — package scripts, Vite configuration, app entry point, routing, current screens, styling, API client, tests, and environment-variable handling.
- `apps/api/src/server.ts`, `apps/api/src/routes/`, `apps/api/src/config.ts`, `apps/api/src/auth/`, `apps/api/src/authz.ts`, `apps/api/src/services.ts`, and `apps/api/src/dependencies.ts`.
- `packages/shared/src/api.ts`, relevant domain schemas/types, and generated or served OpenAPI definitions if present.
- Existing file, folder, share, API-key, upload, content-download, and deletion routes. Use exact routes and schemas found in source; do not assume all have list or mutation endpoints.
- Existing UI, API, integration, E2E, and database tests; `CURRENT-STAGE.md`; `.env.example` or equivalent templates.

Write a short capability map before coding:

| UI capability | Existing API endpoint/schema | State | Notes |
|---|---|---|---|

Use only `verified`, `implemented-but-unverified`, `missing`, or `blocked`. If the file/folder listing, folder creation/rename/move, share creation/revocation, or profile flow does not have a suitable secure API contract, mark it missing instead of faking it.

## 3. UX and visual direction — One Piece-inspired brutalist cloud cockpit

### 3.1 Overall creative direction

Design OpenDrive as a modern cloud-storage product imagined through a **pirate-adventure anime / manga lens**, with the strong graphic confidence of **brutalist editorial design**. The product should feel like a navigator's chart table, a ship's command deck, and a contemporary creative tool combined. It must remain legible, fast, trustworthy, and usable for real files—not a fan landing page or an unreadable themed demo.

Use One Piece as the inspiration for mood and graphic vocabulary: the Grand Line, nautical charts, logbooks, wanted-poster framing, hand-drawn waves, compass roses, treasure maps, ship-log stamps, manga panel rhythm, expressive motion lines, and adventurous color. Prefer original illustrations, bespoke CSS/SVG decorations, and simple original pirate-world motifs. Use official One Piece character art, logos, screenshots, or external fan-art only if the user has supplied assets or their rights/licensing are clear. Do not hotlink artwork or scrape images. Do not make characters or copyrighted art a dependency for the interface to look finished.

The result should be **bold but disciplined**: brutalist outlines and oversized headings balanced by calm reading surfaces, dense but organized file tables, and restrained animation. Avoid generic SaaS gradients, glassmorphism, excessive rounded cards, random neon, childish clip-art, and a full-screen anime wallpaper behind important text.

### 3.2 Visual system

Create a coherent token system using CSS variables/design tokens. Inspect existing styles and reuse them if useful; otherwise establish the following direction and tune contrast based on accessibility:

- **Base surfaces:** warm chart-paper / ivory (`#F3EBDD`-like), ink black / deep charcoal, and a deep ocean navy for dark surfaces.
- **Primary accent:** bold flag red / vermilion for important actions and focus moments.
- **Secondary accents:** ocean teal or weathered blue, and restrained treasure-gold for select highlights. Do not use all accent colors at once; define clear semantic roles.
- **Typography:** a highly readable sans-serif for UI body and tables, a bold condensed/display face for page headings and section labels, plus an optional mono face for IDs, sizes, timestamps, hashes, and system details. Prefer local/system or already-installed fonts; do not add external font network requests. If a font cannot be bundled legally and cheaply, choose a dependable system fallback.
- **Brutalist geometry:** thick ink borders on key surfaces, hard-edged or slightly squared controls, offset shadows, strong divider rules, numbered labels, small all-caps metadata, large editorial headings, and deliberate asymmetry. Use rounded corners sparingly and consistently rather than applying the same radius everywhere.
- **Manga texture:** very subtle halftone, paper grain, map contour lines, panel cuts, wave patterns, or ink hatching, built with CSS/SVG where practical. Keep textures away from dense table text and disable/reduce them when reduced motion or low-performance settings indicate caution.
- **Iconography:** one consistent icon set already installed in the project; otherwise use simple inline/local SVG icons drawn for the interface. Do not mix emoji with polished interface icons. Icons must have accessible names or be decorative with `aria-hidden`.
- **Light and dark themes:** implement a polished light “Chart Paper” theme and a dark “Night Voyage” theme if this can be done within the existing architecture. Persist only the user's non-sensitive theme preference. Respect `prefers-color-scheme` on first visit and offer a clear toggle. Both themes require real contrast testing; dark mode must not simply invert every color.

Use semantic tokens such as `--color-bg`, `--color-surface`, `--color-ink`, `--color-muted`, `--color-border`, `--color-primary`, `--color-danger`, `--shadow-brutal`, `--radius-control`, spacing, typography sizes, and motion durations. Avoid scattered hard-coded colors across components.

### 3.3 Signature screens and composition

**App shell / “The Deck”**
- A compact but distinctive left sidebar or rail with an original compass/flag mark for OpenDrive, current workspace/identity, and only supported navigation destinations.
- A top command bar with breadcrumb trail, contextual title, search field only when search semantics are real, and an account/session menu.
- Use a restrained nautical chart line pattern or contour texture behind shell regions, not under every content surface.
- Add one small, purposeful “system / storage status” area using real readiness/limit information. Never show fake capacity percentages or invented provider health.
- The desktop layout should feel like a real product workspace, not a marketing site. On mobile, collapse navigation cleanly and keep the main actions reachable by touch.

**My Drive / file browser**
- Build a strong editorial page header with clear title, item count only if grounded in real response data, and primary upload action when upload is available.
- Provide a deliberate **list / grid switcher**. List view should be compact and information-dense; grid view should use strong file tiles with file-type glyphs, hard outlines, consistent dimensions, selected states, and restrained shadows.
- Every row/tile should make the filename the strongest label, with size/date/state as secondary metadata when supplied by the API. Use recognizable file-type styling rather than randomly assigned colors.
- Use a “wanted poster” / bounty-poster visual metaphor only as a restrained optional style for file tiles or selected-file details (e.g., stamp, framing, paper edge). Never label real files with made-up bounties, ranks, or fake security statuses.
- Folder breadcrumbs should be prominent and reliable. Add folder artwork only as a small original motif, not a giant cartoon illustration that pushes real files below the fold.
- The empty state can feature an original hand-drawn treasure-map illustration and a direct next action. Differentiate empty, loading, filtered-no-results, error, and provider-unavailable states.

**Upload station / “Log Pose”**
- Prefer a fixed bottom upload tray or a compact side panel that can show several simultaneous uploads without blocking file browsing.
- Each item should show filename, uploaded bytes versus total bytes (where available), progress, phase (`queued`, `uploading`, `finalizing`, `processing`, `ready`, `failed`, or the actual verified states), and concise recovery action.
- Add drag-and-drop target overlay, file picker, and size/type validation based on actual limits. Avoid confetti, full-screen blocking dialogs, and noisy motion for every byte update.
- Progress must reflect real uploaded bytes/API state; never animate progress independently to make it look smoother or faster.

**Selected-file inspector / “Field Notes”**
- Where the current API supplies metadata, allow a row/tile to open a side inspector with file name, type, size, status, timestamps, folder path, and real actions. Do not request or reveal fields the API does not supply or authorize.
- The inspector should keep the underlying list visible on desktop and become a full-screen or slide-over panel on mobile.
- Destructive actions require an explicit confirmation and clear consequences. Telegram deletion language must state that OpenDrive access is removed but final erasure of all Telegram-side copies is not guaranteed.

**System status / “Ship Status”**
- Retain the existing status console as a secondary system page or compact panel rather than the default product home, if the API supports the main file manager.
- Use restrained operational typography and plain labels for readiness, storage-provider capability, and configured limits. Avoid fake gauges, fabricated uptime, and decorative “100% secure” claims.

### 3.4 Advanced interaction features — implement by priority

These are recommended improvements. First audit existing UI capabilities and backend contracts. Build local UI-only enhancements where they are safe, useful, and do not imply backend functionality. Anything requiring missing API support must stay hidden/disabled or be clearly marked as unavailable.

**Priority A — expected for this phase when compatible with current stack**
1. **Command palette** (`Ctrl/Cmd + K`): keyboard-accessible navigation and actions such as “Open My Drive,” “Toggle theme,” “Switch list/grid,” and “Upload files” only when that action is available. Include focus management, Escape-to-close, arrow-key navigation, and accessible announcements. Do not include imaginary commands.
2. **List/grid view and density options:** compact / comfortable density, persisted as harmless UI preferences. Ensure table readability and touch targets remain accessible.
3. **Keyboard shortcuts:** documented, non-conflicting shortcuts for search/focus, command palette, navigation, and upload. Do not intercept keystrokes while a user types into an input or editable control.
4. **Multi-select and bulk-action affordances:** selection, Shift-range selection, Ctrl/Cmd-click toggle, and clear selected count. Expose a bulk action only if the API supports it or if a safe sequential operation is implemented with per-item result reporting. Never present a single “all succeeded” result when some operations fail.
5. **Context menu / overflow menu:** keyboard-accessible file actions with the same permission and capability rules as visible buttons. Native browser context behavior should remain usable where appropriate.
6. **Optimistic-feeling but truthful UI:** quick selection, local view changes, and immediate loading feedback. For server mutations, reconcile with the API and roll back or show a failed state if the server rejects the action.
7. **Toasts plus a persistent upload activity panel:** short-lived feedback for noncritical results, and persistent per-file state for uploads/errors that users need to recover from.
8. **Motion system:** subtle row selection, panel transitions, hover states, and progress transitions. Honor `prefers-reduced-motion`; avoid parallax, flashing, or essential information conveyed only by animation.

**Priority B — implement only if metadata and endpoints truly support it**
- Starred/favorites, recents, trash/restore, rename/move, drag-and-drop between folders, sharing controls, file previews, storage usage breakdown, upload history, or a detailed activity log.
- Real search with clear scope (current folder versus all files), debounced server queries, cancellation of stale searches, and visible filter chips.
- Multi-file download/archive generation only if a safe API or browser-compatible supported workflow exists. Do not pretend a ZIP was created if no endpoint or real client implementation does so.
- Keyboard navigation across files and ARIA grid/table semantics where they are implemented and tested.
- User-customizable accent color only if it does not undermine contrast or expand the design system unnecessarily.

Do not build fake “AI file search,” OCR, AI tagging, duplicate detection, version history, offline sync, resumable upload, background sync, end-to-end encryption, or file-preview features unless the project has or you implement a real supported system and test it. Treat these as future product decisions, not decorative UI switches.

### 3.5 Responsive behavior and accessibility

- Desktop: target a comfortable content width with a readable main list, compact sidebar, sticky toolbar only if it does not steal viewport space, and inspector panel for file details.
- Tablet: sidebar can collapse to an icon rail; retain visible navigation labels through tooltips and accessible names.
- Mobile: use a drawer or bottom navigation only if it fits the existing router and information architecture. File actions belong in a reachable overflow menu; table columns may collapse into stacked metadata rows.
- Include a skip link, clear heading hierarchy, semantic buttons/links, proper labels, keyboard focus order, focus return after dialogs, accessible status announcements for transfer state, and reduced-motion support.
- Do not encode file status, errors, or selection with color alone. Pair color with text or iconography.
- Test both themes at common viewport widths, at 200% zoom, and with keyboard-only navigation. Do not sacrifice functionality for a screenshot-perfect desktop mockup.

### 3.6 Performance and maintainability

- Extend existing packages first. Do not add a heavyweight animation library, component library, icon library, charting package, or state manager solely for decorative polish unless the existing stack genuinely cannot meet requirements; explain any dependency addition.
- Use component boundaries that fit the project (for example: `AppShell`, `Sidebar`, `CommandPalette`, `FileToolbar`, `FileList`, `FileGrid`, `FileInspector`, `UploadTray`, `ConfirmDialog`, `ToastRegion`). These are examples, not mandatory filenames.
- Avoid monolithic one-file UI implementations. Keep UI state separate from API state and transfer state where practical.
- Prevent large file lists from making the page sluggish. Add virtualization only if list size measurements justify it and a compatible dependency is already available or an addition is justified.
- Keep textures, SVGs, and decorative assets local and lightweight. Use CSS/SVG for subtle manga/paper effects where practical. Avoid full-screen background videos and large assets that slow first load.
- Provide stable loading skeletons and avoid layout shifts when data arrives.

### 3.7 Visual acceptance checklist

Before calling the design complete, verify all of the following:
- It is visibly and consistently One Piece / nautical manga-inspired, without relying on downloaded character art to feel themed.
- Brutalist visual language is clear: strong borders, typography, panel geometry, ink/paper contrast, and deliberate shadows—yet files remain easy to scan.
- The app looks like a usable file product after sign-in, not just a landing page, dashboard, or static mockup.
- Light and dark themes are each intentionally designed; no low-contrast text, illegible metadata, or invisible focus indicators.
- File list, grid, empty state, upload tray, error states, dialogs, and mobile layout all share the same design tokens.
- Advanced interactions are real, accessible, tested, and consistent with API support; decorative mock actions are absent.
- No broken remote imagery, placeholder lorem ipsum, fake metrics, false capacity indicators, or unsupported features appear in normal operation.

### 3.8 Baseline functional requirements

In addition to the art direction above, preserve these fundamentals:
- Desktop: compact left navigation/sidebar, top toolbar, main content area, account/session menu.
- Mobile: usable narrow layout with collapsible navigation and touch-friendly controls.
- Clear page title and breadcrumbs for folders, responsive list/grid where applicable, honest loading/error/retry states, and action feedback.
- No fake data in normal app operation. Demo data must be explicitly confined to tests or a clearly labeled development-only preview.
- Suggested information architecture remains conditional on verified backend support: Files/My Drive, Folders, Shared links, Account/Settings, and System status.
- Do not show unsupported destinations as working features. Hide them or show a clear, non-deceptive unavailable state.

## 4. Authentication and session handling

1. Implement the sign-in/sign-up flow supported by the existing self-hosted Supabase configuration and frontend dependencies. First inspect current configuration and Auth endpoints; never hardcode a project URL or key.
2. Only expose the public Supabase URL and publishable/anon key to the browser if the current setup requires them. Document these as public configuration, not secrets. Never expose service-role or database credentials.
3. Send the Supabase access token to the OpenDrive API in the exact authorization format already expected (normally `Authorization: Bearer ...`, if confirmed by code).
4. Handle initial session loading, access-token refresh, sign-out, expired/revoked sessions, disabled accounts, network errors, and API 401 responses without redirect loops or exposing raw tokens.
5. Keep tokens out of URLs, DOM text, analytics, console logs, error telemetry, and user-visible error messages. Use the existing auth SDK's supported session management; do not invent insecure storage. Do not manually store long-lived credentials in `localStorage` unless current SDK/config and security rationale explicitly require it.
6. Do not create an anonymous/guest upload UI unless there is a real, verified API endpoint to create/refresh the anonymous session and a safe place to present its one-time deletion token. If supported, reveal a deletion token only at the moment the API issues it, explain that it cannot be recovered if lost, and never log or persist it unintentionally.
7. Add tests for signed-out, signed-in, expired/invalid token, sign-out, and API unauthorized states using appropriate test doubles. Do not make real users or external auth accounts part of automated tests.

## 5. API client and error handling

- Create or extend a single typed API client in the existing web app. Reuse shared request/response schemas when feasible.
- Keep API base URL configuration explicit and validated. No hardcoded production URL. Ensure local development defaults are safe and documented.
- Parse structured error responses based on the API's actual error schema. Present plain-language messages but preserve request IDs/correlation IDs if the API provides them.
- Treat `401`, `404`, `409`, `413`, `429`, `501`, and `503` distinctly where the current API defines those semantics. Do not turn any failure into a success toast or silently retry destructive actions.
- Avoid retrying upload completion, deletion, share revocation, or other mutations unless the API's idempotency contract makes retry safe.
- Add request cancellation or stale-response protection so changing folders or signing out cannot let an old response populate the wrong user's UI.

## 6. File manager and transfers

Implement only workflows backed by verified API contracts:

### File listing and navigation
- Load actual file metadata for the signed-in principal. Add pagination if the API supports it; do not fetch unbounded lists by default.
- Show loading, empty, error, and populated states.
- Search/sort only across data actually supplied or supported by server query parameters. Do not imply a global server search if only the current page is searched.
- Folder breadcrumbs and navigation must use server-verified folder IDs and ownership. Never infer authorization from a folder being visible in the browser.

### Upload
- Use the actual upload initiation, part upload, progress, completion, and abort contracts from the API.
- Display verified size limits and part-size limits from `/api/v1/limits` or the actual limits endpoint, if that contract is available. Enforce client-side checks for usability, while treating the server as authoritative.
- Support selecting files and drag-and-drop. Keep upload state per file with queued/uploading/completing/success/failure/aborted states as appropriate to the real protocol.
- Show progress honestly. Do not show 100% complete until the API confirms completion; distinguish bytes uploaded from final processing/scan readiness.
- Respect the server's part-size limit, duplicate-part rules, checksum-header contract, and upload state model. Do not invent client-side resumability when upload sessions are process-local or the API/provider doesn't support it.
- Handle tab close/network interruption clearly. Never claim a transfer can resume after refresh unless the current server design proves it.
- Never buffer an entire large file into browser memory unnecessarily. Use `Blob.slice()` or streaming support compatible with the current protocol where possible.
- Make abort/cancel call the real API and display the actual result. Do not report successful abort if the API failed.
- Treat provider unconfigured (`503`) or not implemented (`501`) responses as honest unavailable/error states; do not fall back to fake storage.

### Download
- Download only from the actual content endpoint using the current authenticated session and verified route. Use browser-safe handling that preserves filename and content type.
- Handle 409 for a non-servable file, 404 for missing/inaccessible content, and 503/501 in line with the API contract.
- Do not claim preview or range-resume support when the provider declares `rangedRead: false`.
- Avoid buffering a large download into memory if browser APIs allow a safer stream-to-download approach supported by the target browsers. Document browser limitations honestly.

### Delete
- Require a clear confirmation for permanent-looking UI actions.
- Call the real deletion endpoint; remove the row only after successful server confirmation or mark it pending while safely reconciling state.
- If Telegram is the provider, UI copy must explain that application deletion prevents normal OpenDrive access but is not guaranteed to erase all Telegram-side copies or provide permanent deletion. Use wording aligned with the real provider capability flags.

### Folders and shares
- Implement folder creation/navigation/rename/move and share management only where endpoints and schemas already exist and have been verified.
- If a required endpoint is missing, do not fabricate one. Decide whether a minimal API addition belongs in this phase based on current route conventions and authorization tests. If added, include server-side owner checks, input validation, rate limits where appropriate, and contract/integration tests before exposing the control.
- Share download links, if implemented, must use the actual token format and destination route. Never leak owner-only metadata, deletion tokens, token hashes, internal `ownerKey`, or credential digests.

## 7. API changes, only when essential to the real UI

Do not widen Phase 3 into a backend rewrite. If the UI cannot function because a foundational metadata endpoint is absent:

1. State precisely which user action requires it and confirm no existing endpoint covers it.
2. Add the smallest endpoint consistent with existing Fastify, validation, error mapping, repository, and shared-schema conventions.
3. Enforce identity and authorization server-side; derive owner identity from the verified request principal, never from client-supplied owner fields.
4. Include pagination/limits for list operations and ensure queries are owner-scoped in the database layer.
5. Add integration tests proving normal use, malformed input rejection, and that another principal cannot enumerate or access the resource.
6. Update OpenAPI/shared contracts, tests, and `CURRENT-STAGE.md`.
7. Do not expose an endpoint to the UI until its authorization and behavior have evidence.

## 8. Security and privacy checks

The visual theme must never make security states ambiguous: destructive actions, unavailable capabilities, upload failures, owner-only areas, and provider warnings must remain explicit in every theme. Decorative “wanted poster” styling must not imply a file is public, dangerous, or legally restricted.

- No raw access tokens, API keys, anonymous credentials, deletion tokens, or share tokens in logs or exception output.
- Do not render filenames, error text, or server-supplied metadata as raw HTML. Use normal escaped rendering.
- Validate filenames and show safe text; avoid unsafe inline SVG or dynamic script injection.
- Do not put private file metadata into public cache or persist it across sign-out. Use suitable no-store behavior for sensitive API responses where applicable.
- Clear user-specific React/query/cache state on sign-out and account change.
- Test that account switching cannot briefly show the previous user's file list or metadata.
- Do not weaken server-side ownership checks to make the frontend appear to work.
- Avoid adding analytics, external telemetry, third-party fonts, or remote asset dependencies unless already present and approved.

## 9. Tests and verification

Add or update UI tests using existing test tooling. Prefer accessible queries and behavior tests rather than implementation-detail snapshots.

At minimum cover:
- Initial loading and empty states.
- API error and retry behavior.
- Signed-out route protection and sign-out cleanup.
- Token expiry / 401 handling.
- File listing and folder navigation with mocked API data.
- Upload validation, progress updates, server failure, abort, and completion states.
- Download success and non-servable/missing/provider-unavailable failures.
- Delete confirmation, successful deletion, and failed deletion.
- Feature visibility follows actual API capabilities and limits.
- No prior-user metadata remains after sign-out/account switch.
- Keyboard/accessibility behavior for navigation, menus, and dialogs.
- Command palette keyboard behavior, theme toggle, list/grid toggle, density preference, multi-select, and context-menu actions where implemented.
- Reduced-motion behavior and theme contrast / visible focus checks for light and dark modes.
- Responsive layout at mobile, tablet, desktop, and 200% zoom.

Run the exact scripts that exist in the repository. At minimum, attempt and record:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build:libs && pnpm --filter @opendrive/api build`
- the existing web build command (discover it from `apps/web/package.json` and record the exact command)
- `pnpm test`
- `pnpm test:e2e`
- relevant web tests and existing API/integration tests

If a check cannot run due to environment or missing credentials/services, record the command, exit code if one exists, exact blocker, and whether it is a code/environment/decision blocker. Never report unrun tests as passing. Do not apply migrations, reset data, or deploy publicly without explicit approval.

## 10. Documentation and completion report

Update `CURRENT-STAGE.md` with the actual state and evidence. At the end, provide:

1. Phase 2 gate result and evidence checked.
2. The capability map from the initial audit, updated to show what the web app actually supports.
3. A concise summary of the user-visible flows completed and any intentionally unavailable controls.
   Include the final design-system tokens, implemented advanced interactions, responsive/accessibility checks, and any intentionally deferred visual features.
4. Exact files changed/created, relative to repository root.
5. Exact verification commands, exit codes, and outcomes.
6. Tests added, distinguishing UI mocks, local integration, and any live external-service checks.
7. Any limitations around Telegram retention/deletion, max file size, upload interruption/resumption, download streaming, real Supabase verification, Redis, or worker operation that affect user-facing behavior.
8. Remaining blockers, each tagged **code blocker**, **environment blocker**, or **decision blocker**.
9. The next phase recommendation, based on the evidence—not a generic roadmap.

**Definition of done:** a user can sign in through the supported auth flow, see only their own real file metadata, navigate only supported folders, and use every visible upload/download/delete control end to end through the API; loading/error/empty/security states are tested; all limitations are clearly communicated; and all completion claims are tied to real verification output. If the API or provider does not yet support a workflow, hide or clearly disable that control rather than faking it.
