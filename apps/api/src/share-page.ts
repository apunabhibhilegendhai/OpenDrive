import { isInlinePreviewable } from './mime.js';

/**
 * The public share landing page.
 *
 * A share URL points at a *person*, not at an API client, so `/s/:token` answers with a small
 * self-contained HTML document instead of problem JSON: the file's name, size and type, an inline
 * player for the types a browser can safely render, and a download button. The raw bytes stay on a
 * separate route (`/s/:token/download`) so a click, a range request and an `<img>`/`<video>` embed
 * all resolve to the same streaming handler.
 *
 * Everything interpolated here is user-supplied — most of all the filename — so every value passes
 * through {@link escapeHtml}. The page also ships the tightest policy it can: no scripts at all, and
 * only same-origin images/media/styles (see {@link SHARE_PAGE_CSP}), which the security hook applies
 * because the route set the header first.
 *
 * Rendering is deliberately a pure function of the data: it is the piece worth unit-testing, and it
 * must never depend on the database or the request.
 */

/** The Content-Security-Policy for the landing page. No scripts; the page needs none. */
export const SHARE_PAGE_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes the five characters that can end a text node or an attribute value early. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** A compact, locale-independent size, matching the units the web client shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export type SharePreviewKind = 'image' | 'video' | 'audio';

/**
 * Which media element can render this type, if any.
 *
 * Shares the inline allow-list with the content route, so the page never embeds a type the download
 * route would refuse to serve inline — the element would simply break.
 */
export function previewKindFor(mimeType: string): SharePreviewKind | null {
  if (!isInlinePreviewable(mimeType)) return null;
  const bare = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (bare.startsWith('image/')) return 'image';
  if (bare.startsWith('video/')) return 'video';
  if (bare.startsWith('audio/')) return 'audio';
  return null;
}

export interface SharePageInput {
  /** The link token, echoed only into same-origin subresource URLs. */
  readonly token: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly previewKind: SharePreviewKind | null;
  readonly expiresAt: Date | null;
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
}

/**
 * The page is styled to the app's own design system — "grand-line chart table" — so a share link
 * lands on the same product the signed-in app shows: chart paper (or Night Voyage when the reader
 * prefers dark), a 2px rule with hard offsets instead of blur, condensed display headings, and mono
 * for the terms. Every value mirrors `apps/web/src/styles/tokens.css`, copied as a literal: this
 * document is rendered by the API with no build step, so it can neither import the web app's
 * stylesheet nor make a request for one. The theme follows the operating system rather than a
 * toggle, because a toggle needs the script this page deliberately does not ship.
 */
const STYLES = `
:root {
  color-scheme: light;

  --paper: #f2ead9;
  --surface: #fffdf6;
  --surface-sunken: #f7f1e4;
  --ink: #14120e;
  --ink-soft: #4a4436;
  --muted: #6d6553;
  --primary: #c02d1b;
  --primary-ink: #fffdf6;
  --rule: #14120e;
  --rule-hairline: #ded3ba;
  --chartline-soft: rgba(20, 18, 14, 0.07);

  --radius-control: 2px;
  --radius-panel: 3px;
  --border-rule: 2px;
  --shadow-brutal: 4px 4px 0 var(--ink);
  --shadow-plate: 7px 7px 0 var(--ink);

  --font-display: Bahnschrift, 'Arial Narrow', 'Helvetica Neue', system-ui, sans-serif;
  --font-body: 'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif;
  --font-mono: 'Cascadia Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace;
  --tracking-label: 0.08em;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;

    --paper: #0b1620;
    --surface: #122130;
    --surface-sunken: #0e1b26;
    --ink: #e9eef2;
    --ink-soft: #b3c1cd;
    --muted: #8fa1b0;
    --primary: #ea6248;
    --primary-ink: #0b1620;
    --rule: #e9eef2;
    --rule-hairline: #22394a;
    --chartline-soft: rgba(233, 238, 242, 0.08);
  }
}

* { box-sizing: border-box; }

body {
  margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background-color: var(--paper);
  /* The chart table itself, drawn with gradients the way the app draws it: no image requests. */
  background-image:
    repeating-linear-gradient(0deg, transparent 0 39px, var(--chartline-soft) 39px 40px),
    repeating-linear-gradient(90deg, transparent 0 39px, var(--chartline-soft) 39px 40px);
  color: var(--ink);
  font: 15px/1.5 var(--font-body);
}

.card {
  width: min(640px, 100%); background: var(--surface);
  border: var(--border-rule) solid var(--rule); border-radius: var(--radius-panel);
  padding: 28px; box-shadow: var(--shadow-plate);
}

.eyebrow {
  margin: 0 0 6px; font-family: var(--font-display); font-stretch: condensed;
  font-size: 11px; font-weight: 600; letter-spacing: var(--tracking-label);
  text-transform: uppercase; color: var(--ink-soft);
}

h1 {
  margin: 0 0 6px; font-family: var(--font-display); font-stretch: condensed;
  font-size: clamp(22px, 5vw, 30px); font-weight: 600; letter-spacing: -0.01em;
  line-height: 1.08; text-wrap: balance; word-break: break-word;
}

/* The terms are ids, sizes and timestamps — the app prints those in the mono face. */
.meta {
  margin: 0 0 20px; color: var(--muted); font-family: var(--font-mono);
  font-size: 12.5px; word-break: break-word;
}

.preview {
  display: block; width: 100%; max-height: 60vh; margin: 0 0 20px;
  border: var(--border-rule) solid var(--rule); border-radius: var(--radius-control);
  background: var(--surface-sunken);
}
.preview--image { object-fit: contain; }

.button {
  display: inline-block; padding: 11px 18px;
  border: var(--border-rule) solid var(--ink); border-radius: var(--radius-control);
  background: var(--primary); color: var(--primary-ink);
  font-weight: 600; text-decoration: none; box-shadow: var(--shadow-brutal);
  transition: transform 120ms ease-out, box-shadow 120ms ease-out;
}
.button:hover { filter: brightness(1.06); }
.button:active { transform: translate(4px, 4px); box-shadow: none; }
.button:focus-visible { outline: 3px solid var(--primary); outline-offset: 2px; }

.note {
  margin: 18px 0 0; padding-top: 14px;
  border-top: var(--border-rule) solid var(--rule-hairline);
  color: var(--muted); font-size: 12.5px;
}

@media (prefers-reduced-motion: reduce) {
  .button { transition: none; }
}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>
`;
}

/** A relative URL that carries the token in the path, exactly as the link itself does. */
function downloadPath(token: string): string {
  return `/s/${encodeURIComponent(token)}/download`;
}

function previewElement(kind: SharePreviewKind, src: string, filename: string): string {
  const escapedSrc = escapeHtml(src);
  switch (kind) {
    case 'image':
      return `<img class="preview preview--image" src="${escapedSrc}" alt="${escapeHtml(filename)}">`;
    case 'video':
      return `<video class="preview" src="${escapedSrc}" controls preload="metadata"></video>`;
    case 'audio':
      return `<audio class="preview" src="${escapedSrc}" controls preload="metadata"></audio>`;
  }
}

function describeTerms(input: SharePageInput): string {
  const parts = [formatBytes(input.sizeBytes), input.mimeType];
  if (input.maxDownloads !== null) {
    parts.push(`${input.downloadCount} of ${input.maxDownloads} opens used`);
  }
  if (input.expiresAt !== null) {
    parts.push(`expires ${input.expiresAt.toISOString().slice(0, 10)}`);
  }
  return parts.map(escapeHtml).join(' · ');
}

export function renderSharePage(input: SharePageInput): string {
  const src = downloadPath(input.token);
  const preview =
    input.previewKind === null ? '' : `${previewElement(input.previewKind, src, input.filename)}\n`;
  const body = `<p class="eyebrow">Shared file</p>
<h1>${escapeHtml(input.filename)}</h1>
<p class="meta">${describeTerms(input)}</p>
${preview}<a class="button" href="${escapeHtml(src)}" download>Download</a>
<p class="note">Anyone with this link can read the file for as long as it stays active. Revoking the link or letting it expire stops it immediately.</p>`;
  return layout(`${input.filename} · OpenDrive`, body);
}

export interface ShareUnavailableInput {
  readonly heading: string;
  readonly message: string;
}

/**
 * The page for a dead link.
 *
 * It never mentions the filename or any other detail of a file: a refusal must stay as opaque as a
 * URL that never existed, so the same page is used for a revoked, expired, missing or spent link.
 */
export function renderShareUnavailablePage(input: ShareUnavailableInput): string {
  const body = `<p class="eyebrow">OpenDrive</p>
<h1>${escapeHtml(input.heading)}</h1>
<p class="meta">${escapeHtml(input.message)}</p>`;
  return layout(`${input.heading} · OpenDrive`, body);
}
