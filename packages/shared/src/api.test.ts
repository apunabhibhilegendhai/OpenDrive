import { describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  API_VERSION,
  createdShareRecordSchema,
  fileRecordSchema,
  initiateUploadRequestSchema,
  shareRecordSchema,
} from './api.js';

const fileId = 'file_0123456789012345678901234a';

const storedFile = {
  id: fileId,
  owner: { kind: 'user' },
  folderId: null,
  filename: 'report.pdf',
  sizeBytes: 1024,
  mimeType: 'application/pdf',
  detectedMimeType: 'application/pdf',
  visibility: 'private',
  status: 'ready',
  scanState: 'clean',
  checksumSha256: 'a'.repeat(64),
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  expiresAt: null,
};

describe('API schema guarantees', () => {
  it('exposes a single versioned prefix', () => {
    expect(API_VERSION).toBe('v1');
    expect(API_PREFIX).toBe('/api/v1');
  });

  it('keeps storage-provider internals out of public file records', () => {
    const parsed = fileRecordSchema.parse({
      ...storedFile,
      // Fields that must never reach a client: unknown keys are stripped, not passed through.
      storageProviderRef: 'telegram:file_id:BAACAgQAAxkB',
      telegramFileId: 'BAACAgQAAxkB',
      internalPath: '/srv/opendrive/staging/1.part',
      deletionToken: 'ods_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(Object.keys(parsed)).not.toContain('telegramFileId');
    expect(Object.keys(parsed)).not.toContain('internalPath');
    expect(JSON.stringify(parsed)).not.toContain('BAACAgQAAxkB');
  });

  it('describes ownership by kind, never by an id a client supplied', () => {
    expect(
      fileRecordSchema.safeParse({ ...storedFile, owner: { kind: 'anonymous' } }).success,
    ).toBe(true);
    expect(fileRecordSchema.safeParse({ ...storedFile, owner: { kind: 'admin' } }).success).toBe(
      false,
    );
    // The Phase 0 shape had a nullable ownerId; that field is gone on purpose.
    expect(Object.keys(fileRecordSchema.shape)).not.toContain('ownerId');
  });

  it('rejects an unknown file state from the wire', () => {
    expect(fileRecordSchema.safeParse({ ...storedFile, status: 'available' }).success).toBe(false);
    expect(fileRecordSchema.safeParse({ ...storedFile, status: 'downloading' }).success).toBe(
      false,
    );
  });

  it('defaults uploads to private and rejects nonsensical requests', () => {
    const request = initiateUploadRequestSchema.parse({
      filename: 'notes.txt',
      sizeBytes: 10,
      mimeType: 'text/plain',
    });
    expect(request.visibility).toBe('private');
    expect(request.folderId).toBeNull();
    expect(
      initiateUploadRequestSchema.safeParse({ filename: 'x', sizeBytes: 0, mimeType: 'text/plain' })
        .success,
    ).toBe(false);
    expect(
      initiateUploadRequestSchema.safeParse({ filename: '', sizeBytes: 1, mimeType: 'text/plain' })
        .success,
    ).toBe(false);
    expect(
      initiateUploadRequestSchema.safeParse({
        filename: 'x',
        sizeBytes: 1,
        mimeType: 'text/plain',
        checksumSha256: 'too-short',
      }).success,
    ).toBe(false);
  });

  it('stores shares without their token and only hands the token out at creation', () => {
    const stored = {
      id: 'shr_0123456789012345678901234a',
      fileId,
      kind: 'unlisted',
      status: 'active',
      expiresAt: null,
      revokedAt: null,
      maxDownloads: null,
      downloadCount: 0,
      createdAt: '2026-10-10T00:00:00.000Z',
    };
    expect(Object.keys(shareRecordSchema.shape)).not.toContain('token');
    const parsed = shareRecordSchema.parse({ ...stored, token: 'leaked-token-value' });
    expect(JSON.stringify(parsed)).not.toContain('leaked-token-value');

    const created = createdShareRecordSchema.parse({
      ...stored,
      token: 'b'.repeat(43),
      url: `https://opendrive.example/s/${'b'.repeat(43)}`,
    });
    expect(created.token).toBe('b'.repeat(43));
    expect(
      createdShareRecordSchema.safeParse({ ...stored, token: 'short', url: 'nope' }).success,
    ).toBe(false);
  });
});
