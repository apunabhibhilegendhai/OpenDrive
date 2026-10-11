import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Tests exercise the workspace source directly so `pnpm test` works without a build.
      // The built artefact is covered by tests/e2e, which runs the compiled server.
      {
        find: /^@opendrive\/shared\/storage\/testing$/,
        replacement: `${sharedSrc}/storage/testing/index.ts`,
      },
      { find: /^@opendrive\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
