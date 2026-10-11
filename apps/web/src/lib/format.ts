const UNITS = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Human-readable byte size, binary units. Values are shown, never rounded to a lie. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = UNITS[unitIndex] ?? 'bytes';
  if (unitIndex === 0) return `${value} ${unit}`;
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2);
  return `${rounded} ${unit}`;
}

/** Local clock time for "checked at" lines. */
export function formatClockTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Percentage of the configured file-size ceiling that has been verified against a
 * storage provider. Zero until a provider passes capability verification.
 */
export function verifiedShare(limits: {
  maxFileSizeBytes: number;
  maxFileSizeVerified: boolean;
}): number {
  if (!limits.maxFileSizeVerified) return 0;
  return 100;
}
