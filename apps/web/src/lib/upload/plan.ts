/**
 * Client-side upload planning.
 *
 * The server is authoritative: it re-checks the declared size, the part ceiling and the part
 * count. This module exists so a person learns a file will be refused *before* a byte moves,
 * with the same numbers the API publishes in `GET /api/v1/limits`.
 */

export interface PartPlan {
  partNumber: number;
  start: number;
  end: number;
  sizeBytes: number;
}

export interface UploadLimits {
  maxFileSizeBytes: number;
  chunkSizeBytes: number;
  minChunkSizeBytes: number;
  maxChunkSizeBytes: number;
  maxPartsPerUpload: number;
}

export type UploadPlan = { ok: true; parts: PartPlan[] } | { ok: false; reason: string };

export function planParts(sizeBytes: number, chunkSizeBytes: number, maxParts: number): PartPlan[] {
  const parts: PartPlan[] = [];
  let offset = 0;
  let partNumber = 1;
  while (offset < sizeBytes && partNumber <= maxParts) {
    const end = Math.min(offset + chunkSizeBytes, sizeBytes);
    parts.push({ partNumber, start: offset, end, sizeBytes: end - offset });
    offset = end;
    partNumber += 1;
  }
  return parts;
}

export function planForFile(sizeBytes: number, limits: UploadLimits): UploadPlan {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: 'An empty file has nothing to upload.' };
  }
  if (sizeBytes > limits.maxFileSizeBytes) {
    return {
      ok: false,
      reason: `This deployment accepts files up to ${formatBytesShort(limits.maxFileSizeBytes)}.`,
    };
  }
  if (
    limits.chunkSizeBytes > limits.maxChunkSizeBytes ||
    limits.chunkSizeBytes < limits.minChunkSizeBytes
  ) {
    return {
      ok: false,
      reason: 'The API reported a part size outside its own allowed range; uploads are paused.',
    };
  }
  const parts = planParts(sizeBytes, limits.chunkSizeBytes, limits.maxPartsPerUpload);
  const covered = parts.reduce((total, part) => total + part.sizeBytes, 0);
  if (covered !== sizeBytes) {
    return {
      ok: false,
      reason: `This file needs ${Math.ceil(sizeBytes / limits.chunkSizeBytes)} parts, more than the ${limits.maxPartsPerUpload} this deployment accepts.`,
    };
  }
  return { ok: true, parts };
}

function formatBytesShort(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? String(value) : value.toFixed(value >= 10 ? 1 : 2);
  return `${rounded} ${units[index]}`;
}
