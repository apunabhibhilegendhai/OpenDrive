import { z } from 'zod';
import { accountStatusSchema, principalKindSchema } from './domain/principals.js';
import { fileStateSchema } from './domain/file-states.js';
import { fileVisibilitySchema, scanStateSchema, shareKindSchema } from './domain/visibility.js';
import { shareStatusSchema } from './domain/share-links.js';
import { API_KEY_PREFIX_PATTERN, ANONYMOUS_SESSION_CREDENTIAL_PATTERN } from './credentials.js';
import { apiKeyScopeSchema } from './domain/api-keys.js';

/**
 * API surface contracts for OpenDrive v1.
 *
 * These schemas are the single source of truth shared by the API (validation and OpenAPI
 * generation), the web client and the CLI. Keep every field documented: these objects are
 * published as the public API contract.
 *
 * The vocabulary lives in `./domain/*` (states, visibility, principals, scopes) so that the same
 * definitions are used by the database rules, the authorization layer and the wire contract.
 *
 * Two rules govern everything below:
 *   1. A public schema never contains a secret. Share tokens, session credentials and API-key
 *      hashes appear only in the one response that hands them out for the first time.
 *   2. Nothing here is authorization. A schema says what a message looks like; the server still
 *      decides whether the caller may send it. Runtime validation happens at the boundary even
 *      though TypeScript also checks these shapes.
 */

export const API_VERSION = 'v1' as const;
export const API_PREFIX = `/api/${API_VERSION}` as const;

/** Id shapes, mirroring the SQL check constraints on each table. */
const ID_PATTERN = {
  file: /^file_[0-9a-hjkmnp-tv-z]{26}$/,
  folder: /^fold_[0-9a-hjkmnp-tv-z]{26}$/,
  share: /^shr_[0-9a-hjkmnp-tv-z]{26}$/,
  apiKey: /^key_[0-9a-hjkmnp-tv-z]{26}$/,
  session: /^sess_[0-9a-hjkmnp-tv-z]{26}$/,
  upload: /^upl_[0-9a-hjkmnp-tv-z]{26}$/,
} as const;

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest');

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Human-reported categories for an abuse report. */
export const abuseReasonSchema = z.enum([
  'copyright',
  'malware',
  'illegal_content',
  'spam',
  'other',
]);

// ---------------------------------------------------------------------------
// Problems and envelopes
// ---------------------------------------------------------------------------

export const problemDetailsResponseSchema = z.object({
  type: z.string().describe('Stable URI identifying the problem type.'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  code: z.string().describe('Machine-readable error code. See docs/SECURITY.md.'),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

/**
 * Every collection response uses this envelope. `nextCursor` is opaque to clients and is the only
 * supported way to continue: an offset would both be slower and allow enumerating rows.
 */
export function createPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable().describe('Opaque cursor; null when the page is the last.'),
  });
}

// ---------------------------------------------------------------------------
// System endpoints (implemented in Phase 0)
// ---------------------------------------------------------------------------

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('opendrive-api'),
  version: z.string(),
  apiVersion: z.literal(API_VERSION),
  uptimeSeconds: z.number().nonnegative(),
  timestamp: z.iso.datetime(),
});

export const dependencyStatusSchema = z.enum(['ok', 'degraded', 'unavailable', 'not_configured']);

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  checkedAt: z.iso.datetime(),
  dependencies: z.array(
    z.object({
      /**
       * `auth` is a first-class dependency: without a verifiable token issuer the API cannot
       * establish identity, and every protected route must fail closed rather than guess.
       */
      name: z.enum(['postgres', 'redis', 'storage', 'auth']),
      status: dependencyStatusSchema,
      required: z.boolean().describe('When true, this dependency must be `ok` for readiness.'),
      detail: z.string(),
    }),
  ),
});

export const limitsResponseSchema = z.object({
  maxFileSizeBytes: z.number().int().positive(),
  /** False until a storage provider has passed capability verification (see docs/STORAGE-PROVIDERS.md). */
  maxFileSizeVerified: z.boolean(),
  chunkSizeBytes: z.number().int().positive(),
  minChunkSizeBytes: z.number().int().positive(),
  maxChunkSizeBytes: z.number().int().positive(),
  maxPartsPerUpload: z.number().int().positive(),
  anonymousUploadsPerDay: z.number().int().positive(),
  registeredUploadsPerDay: z.number().int().positive(),
  malwareScanEnabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Authentication and identity
// ---------------------------------------------------------------------------

/**
 * The resolved identity behind a request, as the API sees it.
 *
 * This object is produced by the server's authentication module and is never accepted from a
 * client. `userId` and `sessionId` are what the server proved, which is why no request schema in
 * this file contains a user id the caller could set.
 */
export const authContextSchema = z.object({
  principalKind: principalKindSchema,
  userId: z.uuid().nullable().describe('Proved Supabase user id. Null for an anonymous session.'),
  sessionId: z.string().regex(ID_PATTERN.session).nullable(),
  displayName: z.string().nullable(),
  accountStatus: accountStatusSchema.nullable(),
  /** Expiry of the presented credential (session expiry, or the API key/token expiry). */
  credentialExpiresAt: z.iso.datetime().nullable(),
  /** Scopes granted by the credential. A session credential carries all of its owner's scopes. */
  scopes: z.array(apiKeyScopeSchema),
  apiKeyId: z.string().regex(ID_PATTERN.apiKey).nullable(),
  apiKeyPrefix: z.string().regex(API_KEY_PREFIX_PATTERN).nullable(),
});

export const quotaLimitsSchema = z.object({
  storageBytes: z.number().int().positive(),
  maxFileSizeBytes: z.number().int().positive(),
  maxFiles: z.number().int().positive(),
  uploadBytesPerDay: z.number().int().positive().nullable(),
  downloadBytesPerDay: z.number().int().positive().nullable(),
  fileExpiresAfterHours: z.number().int().positive().nullable(),
});

export const quotaUsageSchema = z.object({
  /** Stored bytes plus bytes held for in-flight uploads. Integer bytes only. */
  storageBytes: z.number().int().nonnegative(),
  storedBytes: z.number().int().nonnegative(),
  heldBytes: z.number().int().nonnegative(),
  storedFiles: z.number().int().nonnegative(),
  uploadBytesToday: z.number().int().nonnegative(),
  downloadBytesToday: z.number().int().nonnegative(),
});

export const quotaSummarySchema = z.object({
  principalKind: principalKindSchema,
  accountStatus: accountStatusSchema,
  limits: quotaLimitsSchema,
  usage: quotaUsageSchema,
  remaining: z.object({
    storageBytes: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    uploadBytesToday: z.number().int().nonnegative().nullable(),
    downloadBytesToday: z.number().int().nonnegative().nullable(),
  }),
});

export const meResponseSchema = z.object({
  identity: authContextSchema,
  quota: quotaSummarySchema,
});

/**
 * A newly created anonymous session. `credential` is the only time the plaintext is ever
 * returned; the server stores a digest, so a lost credential is replaced, never recovered.
 */
export const anonymousSessionResponseSchema = z.object({
  sessionId: z.string().regex(ID_PATTERN.session),
  credential: z.string().regex(ANONYMOUS_SESSION_CREDENTIAL_PATTERN),
  expiresAt: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Files and folders
// ---------------------------------------------------------------------------

export const fileOwnerSchema = z.object({
  kind: principalKindSchema.describe(
    'Whether the owner is a registered user or an anonymous session. Never used as authorization.',
  ),
});

/**
 * Public representation of a file. Deliberately excludes storage-provider identifiers, provider
 * references, deletion-token hashes and internal paths — those never leave the server.
 */
export const fileRecordSchema = z.object({
  id: z.string().regex(ID_PATTERN.file),
  owner: fileOwnerSchema,
  folderId: z.string().regex(ID_PATTERN.folder).nullable(),
  filename: z.string().min(1).max(255).describe('Original display name, as supplied by the owner.'),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(255).describe('Effective type used when serving the file.'),
  detectedMimeType: z.string().min(1).max(255).nullable(),
  visibility: fileVisibilitySchema,
  status: fileStateSchema,
  scanState: scanStateSchema,
  checksumSha256: sha256HexSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  /** Present only on the response that first served the bytes; never on stored metadata. */
  servedAt: z.iso.datetime().optional(),
});

export const filePageSchema = createPageSchema(fileRecordSchema);

export const folderRecordSchema = z.object({
  id: z.string().regex(ID_PATTERN.folder),
  owner: fileOwnerSchema,
  parentId: z.string().regex(ID_PATTERN.folder).nullable().describe('Null for a root folder.'),
  name: z.string().min(1).max(255),
  depth: z.number().int().nonnegative().max(32),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const folderPageSchema = createPageSchema(folderRecordSchema);

export const createFolderRequestSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().regex(ID_PATTERN.folder).nullable().default(null),
});

export const updateFolderRequestSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    parentId: z.string().regex(ID_PATTERN.folder).nullable().optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.parentId !== undefined,
    'provide at least one of name or parentId',
  );

// ---------------------------------------------------------------------------
// Uploads and shares (published contract; handlers arrive with the upload engine)
// ---------------------------------------------------------------------------

export const initiateUploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().min(1).max(255),
  visibility: fileVisibilitySchema.default('private'),
  folderId: z.string().regex(ID_PATTERN.folder).nullable().default(null),
  checksumSha256: sha256HexSchema
    .optional()
    .describe('Optional whole-file SHA-256, verified at finalize when provided.'),
});

export const initiateUploadResponseSchema = z.object({
  uploadId: z.string().regex(ID_PATTERN.upload),
  fileId: z.string().regex(ID_PATTERN.file),
  chunkSizeBytes: z.number().int().positive(),
  /** Only present for anonymous uploads: the sole credential for later management. */
  deletionToken: z.string().optional(),
  expiresAt: z.iso.datetime(),
});

export const uploadPartResponseSchema = z.object({
  partNumber: z.number().int().positive(),
  receivedBytes: z.number().int().nonnegative(),
  checksumSha256: sha256HexSchema.optional(),
});

export const completeUploadResponseSchema = z.object({
  file: fileRecordSchema,
});

export const createShareRequestSchema = z.object({
  fileId: z.string().regex(ID_PATTERN.file),
  kind: shareKindSchema,
  expiresAt: z.iso.datetime().nullable().default(null),
  maxDownloads: z.number().int().positive().nullable().default(null),
});

/**
 * A share link as stored. There is no `token` field: the token is returned exactly once, by
 * {@link createdShareRecordSchema}, and the list/read shapes cannot carry it because the database
 * only ever held its digest.
 */
export const shareRecordSchema = z.object({
  id: z.string().regex(ID_PATTERN.share),
  fileId: z.string().regex(ID_PATTERN.file),
  kind: shareKindSchema,
  status: shareStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  maxDownloads: z.number().int().positive().nullable(),
  downloadCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

/** Creation response only. `url` embeds the token, so this shape is never stored or logged. */
export const createdShareRecordSchema = shareRecordSchema.extend({
  token: z.string().min(32),
  url: z.url(),
});

export const resolveShareRequestSchema = z.object({
  /**
   * The share token. May be omitted when it is sent in the `X-Share-Token` header instead — but
   * sending it in both places is refused rather than resolved, so a request never carries two
   * answers to the same question.
   */
  token: z.string().min(32).max(256).optional(),
});

export const resolveShareResponseSchema = z.object({
  share: shareRecordSchema,
  file: fileRecordSchema,
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const apiKeyRecordSchema = z.object({
  id: z.string().regex(ID_PATTERN.apiKey),
  name: z.string().min(1).max(80),
  keyPrefix: z
    .string()
    .regex(API_KEY_PREFIX_PATTERN)
    .describe('Public half of the key: safe to display and to search logs for.'),
  scopes: z.array(apiKeyScopeSchema),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const createApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(apiKeyScopeSchema).max(16).default([]),
  expiresAt: z.iso.datetime().nullable().default(null),
});

/** Creation response only: the secret half is never retrievable again. */
export const createdApiKeyRecordSchema = apiKeyRecordSchema.extend({
  key: z.string(),
});

export const apiKeyPageSchema = createPageSchema(apiKeyRecordSchema);

export const abuseReportRequestSchema = z.object({
  fileId: z.string().regex(ID_PATTERN.file),
  reason: abuseReasonSchema,
  details: z.string().max(4000).optional(),
  reporterEmail: z.email().optional(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type FileRecord = z.infer<typeof fileRecordSchema>;
export type FolderRecord = z.infer<typeof folderRecordSchema>;
export type CreateFolderRequest = z.infer<typeof createFolderRequestSchema>;
export type UpdateFolderRequest = z.infer<typeof updateFolderRequestSchema>;
export type AuthContext = z.infer<typeof authContextSchema>;
export type QuotaSummary = z.infer<typeof quotaSummarySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type AnonymousSessionResponse = z.infer<typeof anonymousSessionResponseSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type LimitsResponse = z.infer<typeof limitsResponseSchema>;
export type InitiateUploadRequest = z.infer<typeof initiateUploadRequestSchema>;
export type InitiateUploadResponse = z.infer<typeof initiateUploadResponseSchema>;
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;
export type ShareRecord = z.infer<typeof shareRecordSchema>;
export type CreatedShareRecord = z.infer<typeof createdShareRecordSchema>;
export type ResolveShareRequest = z.infer<typeof resolveShareRequestSchema>;
export type ResolveShareResponse = z.infer<typeof resolveShareResponseSchema>;
export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreatedApiKeyRecord = z.infer<typeof createdApiKeyRecordSchema>;
export type ApiKeyPage = z.infer<typeof apiKeyPageSchema>;
export type AbuseReportRequest = z.infer<typeof abuseReportRequestSchema>;
export type ProblemDetailsResponse = z.infer<typeof problemDetailsResponseSchema>;
