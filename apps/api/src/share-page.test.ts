import { describe, expect, it } from 'vitest';
import {
  SHARE_PAGE_CSP,
  escapeHtml,
  formatBytes,
  previewKindFor,
  renderSharePage,
  renderShareUnavailablePage,
} from './share-page.js';

/**
 * The landing page is the one response that reflects user-controlled text into HTML, so these
 * tests are about the two things that could go wrong: an unescaped value, and a media element for
 * a type the byte route would not serve inline (which would render as a broken player).
 */

const base = {
  token: 'tok.ABC-123_xyz',
  filename: 'notes.txt',
  sizeBytes: 2048,
  mimeType: 'text/plain',
  previewKind: null,
  expiresAt: null,
  maxDownloads: null,
  downloadCount: 0,
} as const;

describe('escapeHtml', () => {
  it('escapes every character that can end a node or an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script> & '`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;',
    );
  });
});

describe('formatBytes', () => {
  it('uses binary units and rounds to a readable precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MiB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3 GiB');
  });
});

describe('previewKindFor', () => {
  it('matches the inline allow-list and nothing else', () => {
    expect(previewKindFor('image/png')).toBe('image');
    expect(previewKindFor('video/mp4')).toBe('video');
    expect(previewKindFor('audio/mpeg')).toBe('audio');
    // An image type the allow-list excludes, and non-media that must download.
    expect(previewKindFor('image/svg+xml')).toBeNull();
    expect(previewKindFor('application/pdf')).toBeNull();
    expect(previewKindFor('text/html')).toBeNull();
    expect(previewKindFor('application/octet-stream')).toBeNull();
  });
});

describe('renderSharePage', () => {
  it('escapes a hostile filename instead of reflecting it', () => {
    const html = renderSharePage({
      ...base,
      filename: '<img src=x onerror=alert(1)>.txt',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.txt');
  });

  it('offers a download button that points at the byte route', () => {
    const html = renderSharePage(base);
    expect(html).toContain('href="/s/tok.ABC-123_xyz/download"');
    expect(html).toContain('download');
    // A text file gets no player.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<video');
  });

  it('embeds a player only for the type it was told is previewable', () => {
    const image = renderSharePage({ ...base, filename: 'a.png', previewKind: 'image' });
    expect(image).toContain(
      '<img class="preview preview--image" src="/s/tok.ABC-123_xyz/download"',
    );
    const video = renderSharePage({ ...base, filename: 'a.mp4', previewKind: 'video' });
    expect(video).toContain('<video');
    const audio = renderSharePage({ ...base, filename: 'a.mp3', previewKind: 'audio' });
    expect(audio).toContain('<audio');
  });

  it('states the terms it was given', () => {
    const html = renderSharePage({
      ...base,
      maxDownloads: 3,
      downloadCount: 2,
      expiresAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(html).toContain('2 of 3 opens used');
    expect(html).toContain('expires 2026-11-01');
  });

  it('ships no scripts and references no external origin', () => {
    const html = renderSharePage(base);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(SHARE_PAGE_CSP).toContain("default-src 'none'");
  });
});

describe('renderShareUnavailablePage', () => {
  it('carries no detail of a file, only the message it was handed', () => {
    const html = renderShareUnavailablePage({
      heading: 'Link not available',
      message: 'This link is not available.',
    });
    expect(html).toContain('Link not available');
    expect(html).not.toContain('download');
    expect(html).not.toContain('/s/');
  });
});
