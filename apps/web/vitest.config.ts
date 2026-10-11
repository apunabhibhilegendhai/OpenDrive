import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: '@opendrive/shared', replacement: sharedSrc }],
  },
  test: {
    // Data-layer tests only: they exercise fetch handling and response validation.
    // Rendering is verified in a real browser (docs/DEVELOPMENT.md).
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
