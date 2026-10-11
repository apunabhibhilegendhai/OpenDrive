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
