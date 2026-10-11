/**
 * Loads `.env` into `process.env` when the file exists.
 *
 * Deployments provide real environment variables; the file is a local-development
 * convenience. A missing file is not an error, and a malformed file is surfaced rather
 * than ignored silently.
 *
 * Import order matters: this module must be imported before `config.ts` runs.
 */
try {
  process.loadEnvFile();
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT') {
    throw new Error(
      `Found a .env file but could not read it: ${error instanceof Error ? error.message : 'unknown error'}`,
      { cause: error },
    );
  }
}
