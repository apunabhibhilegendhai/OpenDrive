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
  },
});
