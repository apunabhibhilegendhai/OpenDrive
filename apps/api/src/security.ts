import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Baseline security headers.
 *
 * The API returns JSON and never serves user-supplied HTML. These headers make that
 * guarantee explicit so a future mistake (reflecting a filename into an HTML error
 * page, for example) cannot turn into script execution in a client's browser.
 *
 * HSTS is deliberately NOT set here: it belongs at the TLS terminator, and setting it
 * on plain-HTTP local development would poison browsers for the host.
 */

const DOCS_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Policy for a byte response a browser may open as a document of its own.
 *
 * Navigating straight to an image, audio or video URL makes the browser synthesize a document
 * whose only content is an `<img>`/`<video>` pointing back at the same URL. Under the strict
 * `default-src 'none'` policy that nested load is blocked, so the tab reports "Unable to play
 * media" even though the bytes and the range support are perfectly fine. Allowing same-origin
 * image and media loads is the smallest relaxation that lets the generated document render.
 *
 * Only routes that already decided the body is inline-previewable set this header; every other
 * response keeps {@link STRICT_CSP}.
 */
export const INLINE_PREVIEW_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'";

function isDocsRoute(url: string, docsPrefix: string): boolean {
  return url.startsWith(docsPrefix);
}

function isCacheableAsset(url: string, docsPrefix: string): boolean {
  // Documentation assets are static and contain no user data.
  return isDocsRoute(url, docsPrefix);
}

export function applySecurityHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  docsPrefix: string,
): void {
  const url = request.url;
  const docs = isDocsRoute(url, docsPrefix);

  void reply.header('x-content-type-options', 'nosniff');
  void reply.header('referrer-policy', 'no-referrer');
  // The default forbids cross-origin embedding. A route that intentionally serves an embeddable
  // resource (an inline preview link) sets its own value first; respect it rather than overwrite.
  if (reply.getHeader('cross-origin-resource-policy') === undefined) {
    void reply.header('cross-origin-resource-policy', 'same-origin');
  }
  void reply.header('x-frame-options', 'DENY');
  // Swagger UI relies on inline script/style, so it gets a relaxed but still
  // self-only policy. A route that intentionally serves HTML (the share landing page) sets its own
  // policy first, and it is respected rather than overwritten. Every other response forbids all
  // resource loading.
  if (reply.getHeader('content-security-policy') === undefined) {
    void reply.header('content-security-policy', docs ? DOCS_CSP : STRICT_CSP);
  }

  if (!isCacheableAsset(url, docsPrefix)) {
    // API responses include private metadata; never let a cache store them. A route that
    // *intentionally* serves cacheable bytes (the `/cdn` delivery surface) sets its own policy
    // first — either an explicit `private, no-store` or a deliberate `public, immutable` — and is
    // respected rather than overwritten, exactly like the CORP and CSP headers above.
    if (reply.getHeader('cache-control') === undefined) {
      void reply.header('cache-control', 'no-store');
    }
  }
}
