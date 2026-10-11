import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));
const apiTarget = process.env.OPENDRIVE_API_URL ?? 'http://127.0.0.1:3000';

/**
 * Dev server proxies the API so the browser makes same-origin requests and no CORS
 * configuration is needed locally. A deployed build points at the API with
 * `VITE_API_BASE_URL` (see docs/DEVELOPMENT.md).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: '@opendrive/shared', replacement: sharedSrc }],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/healthz': { target: apiTarget, changeOrigin: false },
      '/readyz': { target: apiTarget, changeOrigin: false },
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
