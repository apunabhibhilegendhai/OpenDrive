import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findNearestEnvFile } from './env-path.js';

describe('findNearestEnvFile', () => {
  const roots: string[] = [];

  const makeTree = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'opendrive-env-'));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds a .env in the start directory', () => {
    const root = makeTree();
    const envFile = join(root, '.env');
    writeFileSync(envFile, 'OD_TEST=1\n');

    expect(findNearestEnvFile(root)).toBe(envFile);
  });

  it('walks up to a .env in an ancestor directory', () => {
    const root = makeTree();
    const envFile = join(root, '.env');
    writeFileSync(envFile, 'OD_TEST=1\n');
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });

    expect(findNearestEnvFile(nested)).toBe(envFile);
  });

  it('prefers the closest .env when several exist', () => {
    const root = makeTree();
    writeFileSync(join(root, '.env'), 'OD_TEST=root\n');
    const child = join(root, 'child');
    mkdirSync(child);
    const childEnv = join(child, '.env');
    writeFileSync(childEnv, 'OD_TEST=child\n');

    expect(findNearestEnvFile(child)).toBe(childEnv);
  });

  it('returns null when no .env exists at or above the start directory', () => {
    const root = makeTree();
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });

    // Nothing under the OS temp directory is expected to hold a `.env`; if this ever becomes
    // flaky the lookup should grow an explicit stop directory rather than this assertion.
    expect(findNearestEnvFile(nested)).toBeNull();
  });
});
