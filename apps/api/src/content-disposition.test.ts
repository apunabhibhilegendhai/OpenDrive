import { describe, expect, it } from 'vitest';
import { contentDisposition } from './content-disposition.js';

/**
 * Disposition is the difference between a browser rendering a file and saving it. These cases pin
 * the two decisions that matter: an inline-safe type stays inline, and an explicit download (or an
 * unsafe type) never becomes a document.
 */
describe('contentDisposition', () => {
  it('serves an inline-previewable video inline', () => {
    expect(contentDisposition('clip.mp4', 'video/mp4')).toMatch(/^inline;/);
  });

  it('forces an attachment when the delivery URL asks for a download', () => {
    expect(contentDisposition('clip.mp4', 'video/mp4', { forceAttachment: true })).toMatch(
      /^attachment;/,
    );
  });

  it('never inlines a scriptable SVG, even though a browser can render one', () => {
    expect(contentDisposition('drawing.svg', 'image/svg+xml')).toMatch(/^attachment;/);
  });

  it('keeps the filename header-safe while preserving the UTF-8 form', () => {
    const value = contentDisposition('na"me\r\n.txt', 'text/plain');
    expect(value).toContain('filename="na_me__.txt"');
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent('na"me\r\n.txt')}`);
  });
});
