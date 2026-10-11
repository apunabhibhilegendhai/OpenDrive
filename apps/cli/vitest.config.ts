import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@opendrive\/shared$/, replacement: `${sharedSrc}/index.ts` }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
