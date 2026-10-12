import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNearestEnvFile } from './env-path.js';

/**
 * Loads the nearest `.env` into `process.env`.
 *
 * `process.loadEnvFile()` with no argument reads `<cwd>/.env`, but this package's scripts run
 * with cwd `apps/api` (pnpm runs package scripts in the package directory) while the
 * documented file lives at the repository root. Resolving from this module's own directory
 * finds the same file in source (`apps/api/src`) and after build (`apps/api/dist`), so local
 * development picks up the root `.env` no matter where the process is started from.
 *
 * A missing file is not an error. Real environment variables always win: Node's loader never
 * overwrites a variable that is already set, so a deployment's environment takes precedence
 * over anything in the file.
 *
 * Import order matters: this module must be imported before `config.ts` runs.
 */
const startDir = dirname(fileURLToPath(import.meta.url));
const envFile = findNearestEnvFile(startDir);
if (envFile !== null) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    throw new Error(
      `Found ${envFile} but could not read it: ${error instanceof Error ? error.message : 'unknown error'}`,
      { cause: error },
    );
  }
}
