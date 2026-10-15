import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: '@opendrive/shared', replacement: sharedSrc }],
  },
  test: {
    // The data layer runs in node; component tests opt into jsdom with a
    // `/** @vitest-environment jsdom */` docblock, so a fast suite stays fast.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    // `pnpm -r test` runs every package's suite at once and the jsdom files run in parallel
    // workers, so a render that takes tens of milliseconds alone can take seconds under that
    // contention. This bounds a hung test; it relaxes no assertion.
    testTimeout: 20_000,
  },
});
