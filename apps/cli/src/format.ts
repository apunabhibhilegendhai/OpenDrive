const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Formats a byte count for humans. Uses binary units and keeps two decimals. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = UNITS[unitIndex] ?? 'B';
  if (unitIndex === 0) return `${value} ${unit}`;
  return `${value.toFixed(2)} ${unit}`;
}

/** Formats a whole number of seconds as `1h 02m 03s`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'unknown';
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => value.toString().padStart(2, '0');
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
