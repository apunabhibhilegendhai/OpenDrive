import { describe, expect, it } from 'vitest';
import { FALLBACK_MIME_TYPE, effectiveMimeType, isSafeMimeType, sanitizeMimeType } from './mime.js';

describe('mime handling', () => {
  it('accepts ordinary media types, with parameters', () => {
    for (const value of [
      'application/pdf',
      'text/plain',
      'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain; charset=utf-8',
    ]) {
      expect(isSafeMimeType(value), value).toBe(true);
    }
  });

  it('refuses values that could break a header or smuggle a document type', () => {
    for (const value of [
      '',
      'not-a-type',
      'text/plain\r\nX-Injected: yes',
      'text/plain\n',
      'text/html\u0000',
      `<script>alert(1)</script>`,
      'a'.repeat(300) + '/plain',
    ]) {
      expect(isSafeMimeType(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('normalises case and whitespace', () => {
    expect(sanitizeMimeType('  APPLICATION/PDF  ')).toBe('application/pdf');
    expect(sanitizeMimeType('text/plain; charset=UTF-8')).toBe('text/plain; charset=utf-8');
    expect(sanitizeMimeType(null)).toBeNull();
    expect(sanitizeMimeType('nonsense')).toBeNull();
  });

  it('prefers the detected type over the declared one', () => {
    // The declaration is a claim; the detection describes the bytes.
    expect(effectiveMimeType('text/plain', 'application/pdf')).toBe('application/pdf');
    expect(effectiveMimeType('text/plain', null)).toBe('text/plain');
  });

  it('falls back to a binary type instead of echoing an unusable one', () => {
    expect(effectiveMimeType('nonsense', null)).toBe(FALLBACK_MIME_TYPE);
    expect(effectiveMimeType('nonsense', 'text/html\r\n')).toBe(FALLBACK_MIME_TYPE);
    expect(effectiveMimeType('text/plain', 'also nonsense')).toBe('text/plain');
  });
});
