/**
 * Content-type handling.
 *
 * A client declares a MIME type; that declaration is a claim, not a fact. The type the server
 * eventually serves is chosen here: the *detected* type wins when one exists (it describes the
 * bytes), the declared type is only used when it is syntactically safe, and anything else
 * degrades to `application/octet-stream`.
 *
 * The sanitising matters even though the API does not render user content: a value such as
 * `text/html; charset=utf-8` is exactly what turns a download into a stored-XSS vector on a
 * different origin, so the syntax is validated once, here, rather than remembered at every
 * call site.
 */

export const FALLBACK_MIME_TYPE = 'application/octet-stream';

/** RFC 6838 media type with optional parameters, restricted to a conservative character set. */
const MIME_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(?:; ?[a-z0-9!#$&^_.+-]{1,40}=[a-z0-9!#$&^_.+*"' -]{1,80})*$/i;

/**
 * Control characters — including CR and LF, which is what makes a header-injection attempt a
 * header-injection attempt. Scanned by code point rather than by a character class so the check
 * reads as what it is.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when the value is a syntactically acceptable media type. Leading/trailing whitespace is
 * tolerated; control characters, newlines and anything resembling a header injection are not.
 */
export function isSafeMimeType(value: string): boolean {
  if (value.length > 255) return false;
  if (hasControlCharacters(value)) return false;
  return MIME_PATTERN.test(value.trim());
}

/** Normalises case and whitespace. Returns null when the value cannot be trusted. */
export function sanitizeMimeType(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isSafeMimeType(value)) return null;
  return value.trim().toLowerCase();
}

/**
 * The type the server will serve: detected first, declared as the fallback, never an unsafe
 * string. A detected type that is itself unsafe is ignored rather than clamped, because it would
 * mean the scanner produced something unusable.
 */
export function effectiveMimeType(declared: string, detected: string | null | undefined): string {
  return sanitizeMimeType(detected) ?? sanitizeMimeType(declared) ?? FALLBACK_MIME_TYPE;
}

/**
 * Media types a browser may render in place (`Content-Disposition: inline`) instead of downloading.
 *
 * A positive allow-list, not an `image/*` wildcard: `image/svg+xml` is an image type *and* an
 * active document that can carry script, so it must keep downloading — as must HTML, PDF and
 * anything else whose bytes might execute or are simply not renderable. The choice lives here
 * rather than in the route so the "safe to show inline" decision is testable on its own, next to
 * the sanitising it depends on (docs/SECURITY.md §6).
 */
const INLINE_PREVIEW_TYPES = new Set([
  // Raster images only — never image/svg+xml.
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  // Audio.
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
  // Video.
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/mpeg',
  'video/3gpp',
]);

/**
 * True when the stored type is one a browser can safely render inline. The value is sanitised here
 * even though the caller passes the already-effective type, so an unvalidated string can never
 * widen the allow-list.
 */
export function isInlinePreviewable(mimeType: string | null | undefined): boolean {
  const normalized = sanitizeMimeType(mimeType);
  if (normalized === null) return false;
  const bare = normalized.split(';', 1)[0]!.trim();
  return INLINE_PREVIEW_TYPES.has(bare);
}
