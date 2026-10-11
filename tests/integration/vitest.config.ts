import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // The workspace source is exercised directly so these tests run without a build step. The
      // compiled artefact is covered by tests/e2e, which boots the built server over a socket.
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
    // Every file opens its own pool and creates its own principals, so files can run together; the
    // timeout is generous because a cold connection to a scratch database is slow on CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
