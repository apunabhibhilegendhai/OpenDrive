import { isInlinePreviewable } from './mime.js';

/**
 * A conservative `Content-Disposition` that never lets a filename break out of the header.
 *
 * A safe-to-render image/audio/video is served `inline` so the browser shows it rather than saving
 * it; everything else — HTML and SVG included, which could execute — keeps downloading. The
 * `Content-Type` is already the sanitised effective type, and `x-content-type-options: nosniff` is
 * set globally, so the browser will not reinterpret a served body.
 *
 * Lives here rather than beside one route because two routes now stream stored bytes — the owner
 * content route and the public share download — and a header this sharp should have exactly one
 * definition.
 */
export function contentDisposition(
  filename: string,
  mimeType: string,
  options: { forceAttachment?: boolean } = {},
): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const disposition =
    options.forceAttachment === true || !isInlinePreviewable(mimeType, filename)
      ? 'attachment'
      : 'inline';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
