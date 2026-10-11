import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These tests build nothing; they spawn the compiled server. Give startup room on a
    // cold Windows machine but fail rather than hang if the process never answers.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
