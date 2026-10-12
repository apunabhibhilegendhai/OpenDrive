import type {
  ApiKeyRecord,
  FileRecord,
  FolderRecord,
  QuotaSummary,
  ShareRecord,
} from '@opendrive/shared';
import type {
  ApiKeyEntity,
  FileEntity,
  FolderEntity,
  QuotaSummaryEntity,
  ShareEntity,
} from './entities.js';
import { effectiveMimeType } from '../mime.js';

/**
 * The single place where stored data becomes wire data.
 *
 * Every function here is deliberately total and explicit: it lists the fields that leave the
 * server, so adding a column to a table cannot silently add it to a response. Internal fields
 * (`ownerKey`, `tokenHash`, `keyHash`, `credentialHash`, provider references) have no mapping at
 * all, and `src/db/mappers.test.ts` asserts they never appear in the output.
 */

export function toFileRecord(entity: FileEntity): FileRecord {
  return {
    id: entity.id,
    owner: { kind: entity.ownerKind },
    folderId: entity.folderId,
    filename: entity.originalFilename,
    sizeBytes: entity.sizeBytes,
    mimeType: effectiveMimeType(entity.mimeType, entity.detectedMimeType),
    detectedMimeType: entity.detectedMimeType,
    visibility: entity.visibility,
    status: entity.state,
    // The column is nullable and a file that no scanner has touched stores NULL; the published
    // contract has a single, non-null vocabulary, and `not_scanned` is that vocabulary's own word
    // for "no scanner has looked at this file" (see SCAN_STATES). Normalizing here keeps the wire
    // shape total without pretending the database column is.
    scanState: entity.scanState ?? 'not_scanned',
    checksumSha256: entity.checksumSha256,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    expiresAt: entity.expiresAt === null ? null : entity.expiresAt.toISOString(),
  };
}

export function toFolderRecord(entity: FolderEntity): FolderRecord {
  return {
    id: entity.id,
    owner: { kind: entity.ownerKind },
    parentId: entity.parentId,
    name: entity.name,
    depth: entity.depth,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

/** Stored share. There is no token field to forget: only its digest was ever persisted. */
export function toShareRecord(entity: ShareEntity): ShareRecord {
  return {
    id: entity.id,
    fileId: entity.fileId,
    kind: entity.kind,
    status: entity.status,
    expiresAt: entity.expiresAt === null ? null : entity.expiresAt.toISOString(),
    revokedAt: entity.revokedAt === null ? null : entity.revokedAt.toISOString(),
    maxDownloads: entity.maxDownloads,
    downloadCount: entity.downloadCount,
    createdAt: entity.createdAt.toISOString(),
  };
}

export function toApiKeyRecord(entity: ApiKeyEntity): ApiKeyRecord {
  return {
    id: entity.id,
    name: entity.name,
    keyPrefix: entity.keyPrefix,
    scopes: [...entity.scopes],
    createdAt: entity.createdAt.toISOString(),
    lastUsedAt: entity.lastUsedAt === null ? null : entity.lastUsedAt.toISOString(),
    expiresAt: entity.expiresAt === null ? null : entity.expiresAt.toISOString(),
    revokedAt: entity.revokedAt === null ? null : entity.revokedAt.toISOString(),
  };
}

export function toQuotaSummary(entity: QuotaSummaryEntity): QuotaSummary {
  return {
    principalKind: entity.principalKind,
    accountStatus: entity.accountStatus,
    limits: {
      storageBytes: entity.storageLimitBytes,
      maxFileSizeBytes: entity.maxFileSizeBytes,
      maxFiles: entity.maxFiles,
      uploadBytesPerDay: entity.uploadBytesPerDay,
      downloadBytesPerDay: entity.downloadBytesPerDay,
      fileExpiresAfterHours: entity.fileExpiresAfterHours,
    },
    usage: {
      storageBytes: entity.storageUsedBytes,
      storedBytes: Math.max(entity.storageUsedBytes - entity.heldReservationBytes, 0),
      heldBytes: entity.heldReservationBytes,
      storedFiles: entity.fileCount,
      uploadBytesToday: entity.uploadBytesUsedToday,
      downloadBytesToday: entity.downloadBytesUsedToday,
    },
    remaining: {
      storageBytes: entity.storageRemainingBytes,
      files: Math.max(entity.maxFiles - entity.fileCount, 0),
      uploadBytesToday:
        entity.uploadBytesPerDay === null
          ? null
          : Math.max(entity.uploadBytesPerDay - entity.uploadBytesUsedToday, 0),
      downloadBytesToday:
        entity.downloadBytesPerDay === null
          ? null
          : Math.max(entity.downloadBytesPerDay - entity.downloadBytesUsedToday, 0),
    },
  };
}
