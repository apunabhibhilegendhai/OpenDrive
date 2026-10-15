import { webcrypto } from 'node:crypto';
import { configure } from '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Test environment shims.
 *
 * jsdom does not implement `matchMedia`, WebCrypto or object URLs, and these tests deliberately
 * exercise code that uses them (the theme default, per-part checksums, the buffered-download
 * fallback). The shims are minimal and only installed when a DOM exists, so the node-environment
 * data-layer tests are unaffected.
 */
if (typeof window !== 'undefined') {
  // `findBy*`/`waitFor` poll for one second by default. The whole web suite runs in parallel
  // workers, and a screen that settles well inside a second on its own can take longer while
  // twelve jsdom files compete for one machine. Raising the wait ceiling keeps the same query and
  // the same assertion; it only stops contention from being reported as a missing element.
  configure({ asyncUtilTimeout: 5_000 });

  // The shims are installed through a plain record of the globals: assigning an unbound method
  // reference is exactly the kind of detached-`this` call the production code is kept clear of.
  const globals = window as unknown as Record<string, unknown>;
  const elements = Element.prototype as unknown as Record<string, unknown>;

  globals.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
  globals.scrollTo ??= () => undefined;
  elements.scrollIntoView ??= () => undefined;

  if (window.crypto?.subtle === undefined) {
    Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
  }

  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => undefined;
  }

  if (navigator.clipboard === undefined) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => undefined },
      configurable: true,
    });
  }

  // The testing library only auto-registers cleanup when it finds a global `afterEach`; Vitest
  // does not install globals by default, so it is registered here. Preferences are cleared too:
  // jsdom shares one localStorage across a file, and a stored theme must not leak between tests.
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });
}
