import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Finds the nearest `.env` file at or above `startDir`, or `null` when none exists.
 *
 * `process.loadEnvFile()` with no argument reads `<cwd>/.env`. That is wrong for this
 * repository: pnpm runs `@opendrive/api`'s scripts with cwd set to `apps/api`, but the
 * documented location of the file is the repository root, so the default silently misses it.
 * Walking up from a known directory (the calling module's own directory) finds the same file
 * regardless of cwd, and in both source (`apps/api/src`) and build (`apps/api/dist`) layouts.
 *
 * Extracted into its own module so the lookup can be unit-tested without the side effect of
 * actually loading whatever file happens to be found.
 */
export function findNearestEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
