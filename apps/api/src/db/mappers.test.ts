import { describe, expect, it } from 'vitest';
import {
  apiKeyRecordSchema,
  fileRecordSchema,
  folderRecordSchema,
  quotaSummarySchema,
  shareRecordSchema,
} from '@opendrive/shared';
import {
  toApiKeyRecord,
  toFileRecord,
  toFolderRecord,
  toQuotaSummary,
  toShareRecord,
} from './mappers.js';
import type {
  ApiKeyEntity,
  FileEntity,
  FolderEntity,
  QuotaSummaryEntity,
  ShareEntity,
} from './entities.js';

/**
 * The mapping is the last place where an internal field could escape, so these tests assert both
 * directions: the published shape validates, and the raw JSON contains none of the strings that
 * only exist server-side.
 */

const TOKEN_HASH = 'a'.repeat(64);
const KEY_HASH = 'b'.repeat(64);
const OWNER_KEY = 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33';

const file: FileEntity = {
  id: 'file_0123456789012345678901234a',
  ownerKind: 'user',
  ownerKey: OWNER_KEY,
  ownerUserId: OWNER_KEY,
  ownerSessionId: null,
  folderId: 'fold_0123456789012345678901234a',
  originalFilename: 'holiday photo.jpg',
  sizeBytes: 4096,
  mimeType: 'application/octet-stream',
  detectedMimeType: 'image/jpeg',
  visibility: 'private',
  state: 'ready',
  scanState: 'clean',
  checksumSha256: 'c'.repeat(64),
  createdAt: new Date('2026-10-11T10:00:00.000Z'),
  updatedAt: new Date('2026-10-11T10:05:00.000Z'),
  expiresAt: new Date('2026-10-18T10:00:00.000Z'),
  deletedAt: null,
  scannedAt: new Date('2026-10-11T10:01:00.000Z'),
};

describe('file records', () => {
  it('publishes a shape the contract accepts', () => {
    expect(() => fileRecordSchema.parse(toFileRecord(file))).not.toThrow();
  });

  it('uses the detected type as the effective one', () => {
    expect(toFileRecord(file).mimeType).toBe('image/jpeg');
    expect(toFileRecord({ ...file, detectedMimeType: null }).mimeType).toBe(
      'application/octet-stream',
    );
  });

  it('normalizes a stored NULL scan verdict to the contract value', () => {
    // A fresh upload row has no verdict: the column is nullable, the contract is not.
    const record = toFileRecord({ ...file, state: 'uploading', scanState: null });
    expect(record.scanState).toBe('not_scanned');
    expect(() => fileRecordSchema.parse(record)).not.toThrow();
  });

  it('never publishes the owner key, the provider reference or the deletion token hash', () => {
    const raw = JSON.stringify(
      toFileRecord({
        ...file,
        ...{ providerRef: { message_id: 42 }, deletionTokenHash: TOKEN_HASH },
      }),
    );
    expect(raw).not.toContain(OWNER_KEY);
    expect(raw).not.toContain(TOKEN_HASH);
    expect(raw).not.toContain('message_id');
    expect(raw).toContain('"kind":"user"');
  });
});

describe('folder and share records', () => {
  it('publishes folders without their internal owner identity', () => {
    const folder: FolderEntity = {
      id: 'fold_0123456789012345678901234a',
      ownerKind: 'anonymous',
      ownerKey: 'sess_0123456789abcdefghjkmnpqrs',
      ownerUserId: null,
      ownerSessionId: 'sess_0123456789abcdefghjkmnpqrs',
      parentId: null,
      name: 'Uploads',
      depth: 0,
      createdAt: new Date('2026-10-11T10:00:00.000Z'),
      updatedAt: new Date('2026-10-11T10:00:00.000Z'),
      deletedAt: null,
    };
    const record = toFolderRecord(folder);
    expect(() => folderRecordSchema.parse(record)).not.toThrow();
    expect(JSON.stringify(record)).not.toContain('sess_0123456789abcdefghjkmnpqrs');
  });

  it('has no token field on a stored share, by construction', () => {
    const share: ShareEntity = {
      id: 'shr_0123456789012345678901234a',
      fileId: file.id,
      kind: 'unlisted',
      status: 'active',
      tokenHash: TOKEN_HASH,
      createdBy: OWNER_KEY,
      maxDownloads: null,
      downloadCount: 3,
      createdAt: new Date('2026-10-11T10:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
    };
    const record = toShareRecord(share);
    expect(() => shareRecordSchema.parse(record)).not.toThrow();
    const raw = JSON.stringify(record);
    expect(raw).not.toContain(TOKEN_HASH);
    expect(raw).not.toContain(OWNER_KEY);
    expect(Object.keys(record)).not.toContain('token');
    expect(record.downloadCount).toBe(3);
  });
});

describe('api key records', () => {
  it('exposes the public prefix and never the hash', () => {
    const entity: ApiKeyEntity = {
      id: 'key_0123456789012345678901234a',
      ownerUserId: OWNER_KEY,
      name: 'CI runner',
      keyPrefix: 'odk_4zrp37hg',
      keyHash: KEY_HASH,
      scopes: ['files:read'],
      createdAt: new Date('2026-10-11T10:00:00.000Z'),
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    };
    const record = toApiKeyRecord(entity);
    expect(() => apiKeyRecordSchema.parse(record)).not.toThrow();
    const raw = JSON.stringify(record);
    expect(raw).not.toContain(KEY_HASH);
    expect(raw).not.toContain(OWNER_KEY);
    expect(record.keyPrefix).toBe(entity.keyPrefix);
  });
});

describe('quota summaries', () => {
  it('splits held bytes out of the total and derives what is left', () => {
    const entity: QuotaSummaryEntity = {
      principalKind: 'anonymous',
      accountStatus: 'active',
      storageLimitBytes: 268435456,
      storageUsedBytes: 1500,
      storageRemainingBytes: 268433956,
      heldReservationBytes: 500,
      fileCount: 3,
      maxFiles: 200,
      maxFileSizeBytes: 2147483648,
      uploadBytesPerDay: 1073741824,
      uploadBytesUsedToday: 100,
      downloadBytesPerDay: null,
      downloadBytesUsedToday: 40,
      fileExpiresAfterHours: 168,
    };
    const summary = toQuotaSummary(entity);
    expect(() => quotaSummarySchema.parse(summary)).not.toThrow();
    expect(summary.usage.storageBytes).toBe(1500);
    expect(summary.usage.storedBytes).toBe(1000);
    expect(summary.usage.heldBytes).toBe(500);
    expect(summary.remaining.files).toBe(197);
    expect(summary.remaining.uploadBytesToday).toBe(1073741824 - 100);
    // A null daily limit is unlimited, which is not the same as zero remaining.
    expect(summary.remaining.downloadBytesToday).toBeNull();
  });

  it('never reports a negative remainder when usage exceeds a shrunken limit', () => {
    const summary = toQuotaSummary({
      principalKind: 'user',
      accountStatus: 'active',
      storageLimitBytes: 1000,
      storageUsedBytes: 1500,
      storageRemainingBytes: 0,
      heldReservationBytes: 0,
      fileCount: 12,
      maxFiles: 10,
      maxFileSizeBytes: 1000,
      uploadBytesPerDay: 50,
      uploadBytesUsedToday: 60,
      downloadBytesPerDay: null,
      downloadBytesUsedToday: 0,
      fileExpiresAfterHours: null,
    });
    expect(summary.remaining.files).toBe(0);
    expect(summary.remaining.uploadBytesToday).toBe(0);
  });
});
