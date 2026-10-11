import { describe, expect, it } from 'vitest';
import { isAppError } from '../errors.js';
import {
  FILE_STATES,
  allowedTransitions,
  assertTransition,
  canTransition,
  countsAsStored,
  isServable,
  isTerminalState,
} from './file-states.js';

const scanningOn = { scanningEnabled: true };
const scanningOff = { scanningEnabled: false };

describe('file lifecycle', () => {
  it('keeps every state in the database enum', () => {
    // Mirrors `create type file_status` plus the Phase 1 renames in
    // supabase/migrations/20261011000001_phase1_identity_ownership_quota.sql.
    expect([...FILE_STATES].sort()).toEqual(
      [
        'deleted',
        'deleting',
        'failed',
        'pending_upload',
        'quarantined',
        'ready',
        'scanning',
        'uploaded',
        'uploading',
      ].sort(),
    );
  });

  it('walks the happy path from metadata row to servable file', () => {
    expect(canTransition('pending_upload', 'uploading', scanningOn)).toBe(true);
    expect(canTransition('uploading', 'uploaded', scanningOn)).toBe(true);
    expect(canTransition('uploaded', 'scanning', scanningOn)).toBe(true);
    expect(canTransition('scanning', 'ready', scanningOn)).toBe(true);
  });

  it('refuses to skip the scanner when scanning is enabled', () => {
    // The whole point of the state machine: durable bytes are not yet safe bytes.
    expect(canTransition('uploaded', 'ready', scanningOn)).toBe(false);
    expect(allowedTransitions('uploaded', scanningOn)).not.toContain('ready');
  });

  it('lets uploaded files be served directly only when scanning is disabled', () => {
    expect(canTransition('uploaded', 'ready', scanningOff)).toBe(true);
    expect(allowedTransitions('uploaded', scanningOff)).not.toContain('scanning');
    expect(allowedTransitions('ready', scanningOff)).not.toContain('scanning');
  });

  it('treats deleted as terminal', () => {
    expect(isTerminalState('deleted')).toBe(true);
    expect(allowedTransitions('deleted', scanningOn)).toEqual([]);
  });

  it('allows quarantine to be lifted only through an explicit state', () => {
    expect(canTransition('quarantined', 'ready', scanningOn)).toBe(true);
    expect(canTransition('quarantined', 'uploaded', scanningOn)).toBe(false);
  });

  it('reports a refused transition as a 409 conflict without leaking internals', () => {
    try {
      assertTransition('quarantined', 'uploaded', scanningOn);
      throw new Error('expected assertTransition to throw');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('CONFLICT');
      expect(error.status).toBe(409);
      expect(error.detail).toBe('A file in state "quarantined" cannot move to "uploaded".');
    }
  });

  it('serves bytes only from ready, or from uploaded without a scanner', () => {
    expect(isServable('ready', scanningOn)).toBe(true);
    expect(isServable('ready', scanningOff)).toBe(true);
    for (const state of [
      'pending_upload',
      'uploading',
      'scanning',
      'failed',
      'deleting',
      'deleted',
      'quarantined',
    ] as const) {
      expect(isServable(state, scanningOn), state).toBe(false);
      expect(isServable(state, scanningOff), state).toBe(false);
    }
    expect(isServable('uploaded', scanningOn)).toBe(false);
    expect(isServable('uploaded', scanningOff)).toBe(true);
  });

  it('counts exactly the states whose bytes are on disk', () => {
    // Must stay identical to `opendrive_used_storage` in SQL.
    expect(countsAsStored('pending_upload')).toBe(false);
    expect(countsAsStored('uploading')).toBe(false);
    expect(countsAsStored('failed')).toBe(false);
    expect(countsAsStored('deleted')).toBe(false);
    for (const state of ['uploaded', 'scanning', 'ready', 'quarantined', 'deleting'] as const) {
      expect(countsAsStored(state), state).toBe(true);
    }
  });
});
