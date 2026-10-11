import { parseArgs } from 'node:util';

/**
 * Argument parsing.
 *
 * Deliberately built on Node's `util.parseArgs` rather than a CLI framework: the Phase 0
 * surface is four flags, and every dependency in a client that ships to users is a
 * supply-chain liability. Revisit only when commands need nested subcommands.
 */

export const CLI_COMMANDS = ['health', 'readiness', 'limits', 'version', 'help'] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

export const DEFAULT_API_URL = 'http://127.0.0.1:3000';
export const DEFAULT_TIMEOUT_MS = 10_000;

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
/** The API answered, but reported a state that needs attention (for example degraded readiness). */
export const EXIT_UNHEALTHY = 2;
/** The API could not be reached or did not answer in time. */
export const EXIT_UNREACHABLE = 3;
/** A bug in the CLI itself: an unhandled error, never a deliberate outcome. */
export const EXIT_INTERNAL = 4;

export class UsageError extends Error {}

export interface CliOptions {
  command: CliCommand;
  apiUrl: string;
  json: boolean;
  timeoutMs: number;
}

export function isCliCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

function normaliseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UsageError(`--url must be an absolute http(s) URL, received "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`--url must use http or https, received "${parsed.protocol}"`);
  }
  // Trailing slash removal keeps request paths predictable.
  return parsed.toString().replace(/\/+$/, '');
}

/** Wraps parseArgs so a malformed command line reports as a usage error, not a crash. */
function parseStrict(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        json: { type: 'boolean', default: false },
        timeout: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'invalid arguments');
  }
}

export function parseCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): CliOptions {
  const { values, positionals } = parseStrict(argv);
  const apiUrl = normaliseUrl(values.url ?? env.OPENDRIVE_API_URL ?? DEFAULT_API_URL);
  const json = values.json === true;

  // --version and --help short-circuit command resolution and do not require a command.
  if (values.version === true) {
    return { command: 'version', apiUrl, json, timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  if (values.help === true) {
    return { command: 'help', apiUrl, json, timeoutMs: DEFAULT_TIMEOUT_MS };
  }

  if (positionals.length > 1) {
    throw new UsageError(`expected at most one command, received ${positionals.length}`);
  }

  const rawCommand = positionals[0] ?? 'help';
  if (!isCliCommand(rawCommand)) {
    throw new UsageError(`unknown command "${rawCommand}"`);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new UsageError(
        `--timeout must be a positive number of seconds, received "${values.timeout}"`,
      );
    }
    timeoutMs = Math.round(seconds * 1000);
  }

  return { command: rawCommand, apiUrl, json, timeoutMs };
}

export const HELP_TEXT = `opendrive — OpenDrive command-line client

Usage
  opendrive <command> [options]

Commands
  health      Check API liveness (GET /healthz)
  readiness   Report dependency readiness (GET /readyz, exit 2 while degraded)
  limits      Show the upload limits this deployment enforces
  version     Print the CLI version
  help        Show this help

Options
  --url <url>       API base URL (default: $OPENDRIVE_API_URL or ${DEFAULT_API_URL})
  --json            Machine-readable output
  --timeout <secs>  Request timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000})
  -h, --help        Show this help
  -v, --version     Print the CLI version

Exit codes
  0  success
  1  usage error
  2  the API answered but reported an unhealthy state
  3  the API could not be reached
  4  internal error in this client

Phase 0 note: file, upload and share commands do not exist yet. The API endpoints that
would back them answer 501 NOT_IMPLEMENTED, and this client does not pretend otherwise.
`;
