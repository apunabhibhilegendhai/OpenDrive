#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  EXIT_INTERNAL,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  HELP_TEXT,
  UsageError,
  parseCliArgs,
} from './args.js';
import { createProcessIo } from './commands/context.js';
import type { Io } from './commands/context.js';
import { runHealth, runLimits, runReadiness } from './commands/system.js';
import { CliNetworkError } from './http.js';
import { CLI_VERSION } from './version.js';

/**
 * CLI entry point.
 *
 * Exit codes (documented in `--help`; 0/1/2/3 are stable):
 *   0 success · 1 usage error · 2 API answered but unhealthy · 3 unreachable · 4 internal bug
 *
 * Phase 0 scope: system commands only. Upload, download, share and delete commands are
 * deliberately absent until the API implements them — a client that faked them would be
 * worse than one that does not have them.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const options = parseCliArgs(argv);

  switch (options.command) {
    case 'help':
      io.out(HELP_TEXT.trimEnd());
      return 0;
    case 'version':
      io.out(options.json ? JSON.stringify({ cli: CLI_VERSION }) : `opendrive cli ${CLI_VERSION}`);
      return 0;
    case 'health':
      return runHealth({ options, io });
    case 'readiness':
      return runReadiness({ options, io });
    case 'limits':
      return runLimits({ options, io });
    default: {
      const exhaustive: never = options.command;
      io.err(`internal: unhandled command ${String(exhaustive)}`);
      return EXIT_INTERNAL;
    }
  }
}

async function main(): Promise<void> {
  const io = createProcessIo();
  try {
    process.exitCode = await run(process.argv.slice(2), io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`);
      io.err('run "opendrive --help" for usage');
      process.exitCode = EXIT_USAGE;
      return;
    }
    if (error instanceof CliNetworkError) {
      io.err(`error: ${error.message}`);
      process.exitCode = EXIT_UNREACHABLE;
      return;
    }
    io.err(`error: unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_INTERNAL;
  }
}

// Only execute when this file is the process entry point. Importing it (tests, future
// programmatic use) must not run the CLI or touch process.argv.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
