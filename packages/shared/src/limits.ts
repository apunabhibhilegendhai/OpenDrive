import { z } from 'zod';

/**
 * Upload limits and their resolution from the environment.
 *
 * The 2 GiB target is a product requirement, not a verified capability. Until a
 * storage provider passes capability verification (docs/STORAGE-PROVIDERS.md), the
 * API reports `maxFileSizeVerified: false` and uploads stay disabled rather than
 * accepting bytes a provider cannot durably store.
 */

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;

/** Product target for a single file. Providers may impose a lower ceiling. */
export const TARGET_MAX_FILE_SIZE_BYTES = 2 * GIB;

export const DEFAULT_CHUNK_SIZE_BYTES = 8 * MIB;
export const MIN_CHUNK_SIZE_BYTES = MIB;
/**
 * Largest part a client may be asked to send.
 *
 * 2,000,000,000 bytes is the upload ceiling of a self-hosted Local Bot API server (`--local`),
 * which is the only backend that can store a part above the public API's ~20 MiB download limit.
 * Raising the cap is safe against the public API as well: the Telegram provider clamps the
 * *effective* part to its own `maxPartSizeBytes`, so a large configured chunk can never make the
 * provider accept a part it cannot store.
 */
export const MAX_CHUNK_SIZE_BYTES = 2_000_000_000;
export const MAX_PARTS_PER_UPLOAD = 10_000;

/**
 * Largest part that reliably clears the edge proxy in front of the API.
 *
 * A Cloudflare-proxied hostname refuses a request body over 100 MB (100,000,000 bytes, not 100
 * MiB) and gives the origin 125 seconds to start answering. A 100 MiB part sits *above* the byte
 * cap and, on an ordinary uplink, outlives the timeout, which a 2 GiB upload met as a `524` after
 * 169 seconds. 32 MiB keeps every part well inside both bounds — one request that finishes in a
 * minute or two even on a slow connection — while still needing only 64 parts for the 2 GiB
 * target.
 */
export const EDGE_SAFE_MAX_CHUNK_SIZE_BYTES = 32 * MIB;

export const limitsConfigSchema = z.object({
  maxFileSizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * GIB),
  chunkSizeBytes: z.number().int().min(MIN_CHUNK_SIZE_BYTES).max(MAX_CHUNK_SIZE_BYTES),
  anonymousUploadsPerDay: z.number().int().positive(),
  registeredUploadsPerDay: z.number().int().positive(),
  malwareScanEnabled: z.boolean(),
  /** Set only after a provider passes capability verification for the target size. */
  maxFileSizeVerified: z.boolean(),
});

export type LimitsConfig = z.infer<typeof limitsConfigSchema>;

export const DEFAULT_LIMITS: LimitsConfig = {
  maxFileSizeBytes: TARGET_MAX_FILE_SIZE_BYTES,
  chunkSizeBytes: DEFAULT_CHUNK_SIZE_BYTES,
  anonymousUploadsPerDay: 20,
  registeredUploadsPerDay: 500,
  malwareScanEnabled: false,
  maxFileSizeVerified: false,
};

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer, received "${raw}"`);
  }
  return parsed;
}

function readBoolean(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Environment variable ${key} must be "true" or "false", received "${raw}"`);
}

/**
 * Resolves limits from environment variables, rejecting invalid configuration
 * instead of silently falling back to a default.
 */
export function resolveLimits(env: Record<string, string | undefined>): LimitsConfig {
  const candidate: LimitsConfig = {
    maxFileSizeBytes: readPositiveInt(
      env,
      'STORAGE_MAX_FILE_SIZE_BYTES',
      DEFAULT_LIMITS.maxFileSizeBytes,
    ),
    chunkSizeBytes: readPositiveInt(env, 'STORAGE_CHUNK_SIZE_BYTES', DEFAULT_LIMITS.chunkSizeBytes),
    anonymousUploadsPerDay: readPositiveInt(
      env,
      'ANONYMOUS_UPLOADS_PER_DAY',
      DEFAULT_LIMITS.anonymousUploadsPerDay,
    ),
    registeredUploadsPerDay: readPositiveInt(
      env,
      'REGISTERED_UPLOADS_PER_DAY',
      DEFAULT_LIMITS.registeredUploadsPerDay,
    ),
    malwareScanEnabled: readBoolean(env, 'MALWARE_SCAN_ENABLED', DEFAULT_LIMITS.malwareScanEnabled),
    maxFileSizeVerified: false,
  };

  const result = limitsConfigSchema.safeParse(candidate);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid limits configuration — ${detail}`);
  }
  return result.data;
}

/** Number of parts a file of `sizeBytes` will occupy at `chunkSizeBytes`. */
export function partCount(sizeBytes: number, chunkSizeBytes: number): number {
  if (sizeBytes <= 0) return 0;
  return Math.ceil(sizeBytes / chunkSizeBytes);
}

export interface ChunkSizeCheck {
  ok: boolean;
  reason?: string;
}

/** Validates a single upload part against the configured limits. */
export function checkChunkSize(sizeBytes: number, limits: LimitsConfig): ChunkSizeCheck {
  if (sizeBytes > limits.chunkSizeBytes) {
    return {
      ok: false,
      reason: `Part size ${sizeBytes} exceeds the configured chunk size ${limits.chunkSizeBytes}`,
    };
  }
  if (sizeBytes > limits.maxFileSizeBytes) {
    return { ok: false, reason: `Part size ${sizeBytes} exceeds the maximum file size` };
  }
  return { ok: true };
}

/** Validates a whole-file declaration before an upload session is created. */
export function checkFileSize(sizeBytes: number, limits: LimitsConfig): ChunkSizeCheck {
  if (sizeBytes <= 0) {
    return { ok: false, reason: 'File size must be greater than zero' };
  }
  if (sizeBytes > limits.maxFileSizeBytes) {
    return {
      ok: false,
      reason: `File size ${sizeBytes} exceeds the maximum of ${limits.maxFileSizeBytes} bytes`,
    };
  }
  const parts = partCount(sizeBytes, limits.chunkSizeBytes);
  if (parts > MAX_PARTS_PER_UPLOAD) {
    return {
      ok: false,
      reason: `File would require ${parts} parts, above the ${MAX_PARTS_PER_UPLOAD} part ceiling`,
    };
  }
  return { ok: true };
}
