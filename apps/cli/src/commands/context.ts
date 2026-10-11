import type { CliOptions } from '../args.js';

/**
 * Output sink. Commands never write to `process.stdout` directly so that tests can
 * capture output and so `--json` output can be kept strictly machine-readable
 * (diagnostics always go to stderr, never mixed into stdout).
 */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface CommandContext {
  options: CliOptions;
  io: Io;
}

export function createProcessIo(): Io {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
}
