import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, UsageError, parseCliArgs } from './args.js';

describe('parseCliArgs', () => {
  it('defaults to the documented local API', () => {
    const options = parseCliArgs(['health'], {});
    expect(options.command).toBe('health');
    expect(options.apiUrl).toBe(DEFAULT_API_URL);
    expect(options.json).toBe(false);
    expect(options.timeoutMs).toBe(10_000);
  });

  it('reads the API URL from the environment and strips trailing slashes', () => {
    expect(parseCliArgs(['health'], { OPENDRIVE_API_URL: 'https://api.example.com/' }).apiUrl).toBe(
      'https://api.example.com',
    );
  });

  it('lets --url override the environment', () => {
    const options = parseCliArgs(['health', '--url', 'http://10.0.0.5:8080'], {
      OPENDRIVE_API_URL: 'https://api.example.com',
    });
    expect(options.apiUrl).toBe('http://10.0.0.5:8080');
  });

  it('accepts every documented command', () => {
    for (const command of ['health', 'readiness', 'limits', 'version', 'help']) {
      expect(parseCliArgs([command], {}).command).toBe(command);
    }
  });

  it('treats --help and --version as commands without requiring a positional', () => {
    expect(parseCliArgs(['--help'], {}).command).toBe('help');
    expect(parseCliArgs([], {}).command).toBe('help');
    expect(parseCliArgs(['--version'], {}).command).toBe('version');
  });

  it('parses --json and --timeout', () => {
    const options = parseCliArgs(['limits', '--json', '--timeout', '2.5'], {});
    expect(options.json).toBe(true);
    expect(options.timeoutMs).toBe(2500);
  });

  it('rejects unknown commands and malformed options with a usage error', () => {
    expect(() => parseCliArgs(['upload'], {})).toThrow(UsageError);
    expect(() => parseCliArgs(['health', 'extra'], {})).toThrow(/at most one command/);
    expect(() => parseCliArgs(['health', '--url', 'ftp://example.com'], {})).toThrow(
      /http or https/,
    );
    expect(() => parseCliArgs(['health', '--url', 'not a url'], {})).toThrow(/absolute http/);
    expect(() => parseCliArgs(['health', '--timeout', '0'], {})).toThrow(/positive number/);
    expect(() => parseCliArgs(['health', '--timeout', 'soon'], {})).toThrow(/positive number/);
    expect(() => parseCliArgs(['health', '--nope'], {})).toThrow(UsageError);
  });
});
