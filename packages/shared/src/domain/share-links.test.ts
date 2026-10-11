import { describe, expect, it } from 'vitest';
import { isShareRefusalIndistinguishable, resolveShareLink } from './share-links.js';
import type { ShareLinkState, SharedFileState } from './share-links.js';

const now = new Date('2026-10-11T12:00:00.000Z');

const activeLink: ShareLinkState = {
  status: 'active',
  expiresAt: null,
  revokedAt: null,
  maxDownloads: null,
  downloadCount: 0,
};

const readyFile: SharedFileState = {
  state: 'ready',
  visibility: 'unlisted',
  deletedAt: null,
  scanState: 'clean',
};

const options = { now, scanningEnabled: true };

describe('share link resolution', () => {
  it('resolves a valid unexpired link for a ready file', () => {
    expect(resolveShareLink(activeLink, readyFile, options)).toEqual({
      ok: true,
      visibility: 'unlisted',
    });
  });

  it('refuses an expired link, including one expiring exactly now', () => {
    expect(
      resolveShareLink(
        { ...activeLink, expiresAt: new Date(now.getTime() - 1) },
        readyFile,
        options,
      ),
    ).toEqual({
      ok: false,
      reason: 'link_expired',
    });
    expect(resolveShareLink({ ...activeLink, expiresAt: now }, readyFile, options)).toEqual({
      ok: false,
      reason: 'link_expired',
    });
  });

  it('refuses a revoked link even when its status column claims otherwise', () => {
    // Belt and braces: a revocation record that ever existed must win over the status column.
    expect(
      resolveShareLink({ ...activeLink, revokedAt: new Date(now) }, readyFile, options),
    ).toEqual({
      ok: false,
      reason: 'link_revoked',
    });
    expect(resolveShareLink({ ...activeLink, status: 'revoked' }, readyFile, options)).toEqual({
      ok: false,
      reason: 'link_revoked',
    });
  });

  it('refuses a link whose download allowance is used up', () => {
    expect(
      resolveShareLink({ ...activeLink, maxDownloads: 3, downloadCount: 3 }, readyFile, options),
    ).toEqual({ ok: false, reason: 'download_limit_reached' });
    expect(
      resolveShareLink({ ...activeLink, maxDownloads: 3, downloadCount: 2 }, readyFile, options).ok,
    ).toBe(true);
    // A caller that counts downloads elsewhere may pass its own figure.
    expect(
      resolveShareLink({ ...activeLink, maxDownloads: 1 }, readyFile, {
        ...options,
        downloadCount: 1,
      }),
    ).toEqual({ ok: false, reason: 'download_limit_reached' });
  });

  it('refuses a link to a file that is not ready', () => {
    for (const state of [
      'pending_upload',
      'uploading',
      'failed',
      'quarantined',
      'deleting',
      'deleted',
    ] as const) {
      expect(resolveShareLink(activeLink, { ...readyFile, state }, options), state).toEqual({
        ok: false,
        reason: 'file_not_servable',
      });
    }
    expect(resolveShareLink(activeLink, { ...readyFile, state: 'uploaded' }, options)).toEqual({
      ok: false,
      reason: 'file_not_servable',
    });
  });

  it('refuses a quarantined-again file even when its state still says ready', () => {
    expect(resolveShareLink(activeLink, { ...readyFile, scanState: 'infected' }, options)).toEqual({
      ok: false,
      reason: 'file_scan_not_clean',
    });
    expect(resolveShareLink(activeLink, { ...readyFile, scanState: null }, options)).toEqual({
      ok: false,
      reason: 'file_scan_not_clean',
    });
    // With no scanner configured there is no verdict to wait for, so the state alone decides.
    expect(
      resolveShareLink(
        activeLink,
        { ...readyFile, scanState: null },
        { now, scanningEnabled: false },
      ).ok,
    ).toBe(true);
  });

  it('refuses a soft-deleted file before it considers anything else about it', () => {
    expect(
      resolveShareLink(activeLink, { ...readyFile, deletedAt: now, state: 'deleting' }, options),
    ).toEqual({ ok: false, reason: 'file_deleted' });
  });

  it('keeps refusals indistinguishable from an unknown token', () => {
    expect(isShareRefusalIndistinguishable('link_revoked')).toBe(true);
    expect(isShareRefusalIndistinguishable('link_expired')).toBe(true);
    expect(isShareRefusalIndistinguishable('file_not_servable')).toBe(true);
    // A download cap is the one refusal that is about the caller's own usage, so it is explainable.
    expect(isShareRefusalIndistinguishable('download_limit_reached')).toBe(false);
  });

  it('serves a clean ready file regardless of the scanner configuration', () => {
    expect(resolveShareLink(activeLink, readyFile, { now, scanningEnabled: false }).ok).toBe(true);
  });
});
