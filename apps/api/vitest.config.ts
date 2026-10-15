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
    // Several suites build a real Fastify server (swagger + zod compilers) before asserting, which
    // is a second or two of work. `pnpm -r test` runs every package's suite at once, so the default
    // 5s budget is a coin toss on a loaded machine. This bounds a hung test, not a slow assertion.
    testTimeout: 20_000,
  },
});
