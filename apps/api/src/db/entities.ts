import type {
  AccountStatus,
  ApiKeyScope,
  FileState,
  FileVisibility,
  PrincipalKind,
  ScanState,
  SessionStatus,
  ShareKind,
  ShareStatus,
} from '@opendrive/shared';

/**
 * Database row shapes, as the repositories return them.
 *
 * These types describe *stored* data, which is why they carry fields that must never be
 * serialised: `ownerKey`, `tokenHash`, `credentialHash` and `keyHash`. The only supported way to
 * turn one of these into a response is a function in `mappers.ts`, and the contract tests in
 * `src/mappers.test.ts` assert that no internal field survives the trip.
 *
 * Timestamps are `Date` objects because the driver returns them that way; mapping to ISO strings
 * happens once, at the edge.
 */

export interface ProfileEntity {
  readonly id: string;
  readonly displayName: string | null;
  readonly status: AccountStatus;
  readonly storageQuotaBytes: number;
  readonly maxFileSizeBytes: number;
  readonly maxFiles: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly disabledAt: Date | null;
}

export interface AnonymousSessionEntity {
  readonly id: string;
  readonly credentialHash: string;
  readonly status: SessionStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface FolderEntity {
  readonly id: string;
  readonly ownerKind: PrincipalKind;
  readonly ownerKey: string;
  readonly ownerUserId: string | null;
  readonly ownerSessionId: string | null;
  readonly parentId: string | null;
  readonly name: string;
  readonly depth: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface FileEntity {
  readonly id: string;
  readonly ownerKind: PrincipalKind;
  readonly ownerKey: string;
  readonly ownerUserId: string | null;
  readonly ownerSessionId: string | null;
  readonly folderId: string | null;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly detectedMimeType: string | null;
  readonly visibility: FileVisibility;
  readonly state: FileState;
  /**
   * The stored verdict. NULL is a real value: a fresh `pending_upload`/`uploading` row has no
   * verdict yet, and the schema's check list is deliberately nullable (see the `files.scan_state`
   * constraint). The wire contract has no null, so `mappers.ts` normalizes it.
   */
  readonly scanState: ScanState | null;
  readonly checksumSha256: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date | null;
  readonly deletedAt: Date | null;
  readonly scannedAt: Date | null;
}

export interface ShareEntity {
  readonly id: string;
  readonly fileId: string;
  readonly kind: ShareKind;
  readonly status: ShareStatus;
  readonly tokenHash: string;
  readonly createdBy: string | null;
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface ApiKeyEntity {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Result of `opendrive_quota_summary`, validated at the boundary before use. */
export interface QuotaSummaryEntity {
  readonly principalKind: PrincipalKind;
  readonly accountStatus: AccountStatus;
  readonly storageLimitBytes: number;
  readonly storageUsedBytes: number;
  readonly storageRemainingBytes: number;
  /**
   * Bytes held by in-flight uploads. `storageUsedBytes` is the total; the stored part is
   * `storageUsedBytes - heldReservationBytes`, computed in the mapper rather than returned twice
   * by SQL where the two could disagree.
   */
  readonly heldReservationBytes: number;
  readonly fileCount: number;
  readonly maxFiles: number;
  readonly maxFileSizeBytes: number;
  readonly uploadBytesPerDay: number | null;
  readonly uploadBytesUsedToday: number;
  readonly downloadBytesPerDay: number | null;
  readonly downloadBytesUsedToday: number;
  readonly fileExpiresAfterHours: number | null;
}

export interface ReservationEntity {
  readonly ok: true;
  readonly reservationId: string;
  readonly storageLimitBytes: number;
  readonly storageUsedBytes: number;
  readonly storageRemainingBytes: number;
  readonly expiresAt: Date;
}

export interface ReservationRefusal {
  readonly ok: false;
  readonly reason: string;
  readonly message?: string;
}

export type ReservationOutcome = ReservationEntity | ReservationRefusal;

export interface CommitOutcome {
  readonly ok: boolean;
  readonly alreadyCommitted?: boolean;
  readonly fileId?: string;
  readonly committedBytes?: number;
  readonly reason?: string;
}

export interface ReleaseOutcome {
  readonly ok: boolean;
  readonly alreadyReleased?: boolean;
  readonly releasedBytes?: number;
  readonly reason?: string;
}
