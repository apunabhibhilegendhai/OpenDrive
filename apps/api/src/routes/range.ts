import type { ByteRange } from '@opendrive/shared';

/**
 * Outcome of parsing a single HTTP `Range` request header against a known object size.
 *
 * - a `ByteRange` means the request can be answered `206 Partial Content`;
 * - `'unsatisfiable'` means the range is syntactically valid but falls outside the object,
 *   which RFC 9110 §14.2 says to answer `416`;
 * - `null` means there is no usable range (no header, multiple ranges, a non-`bytes` unit, or a
 *   malformed value) and the whole object should be served `200`.
 */
export type RangeRequest = ByteRange | 'unsatisfiable' | null;

/**
 * Parses one `bytes=` range.
 *
 * Only a single range is understood. A multi-range request is deliberately answered with the
 * whole object (`null`) rather than `multipart/byteranges`: no client here needs it, and honouring
 * it would mean fetching a provider's parts out of order and buffering them, which is exactly the
 * whole-object cost ranges exist to avoid.
 */
export function parseRangeHeader(header: string | undefined, sizeBytes: number): RangeRequest {
  if (header === undefined) return null;
  const value = header.trim();
  // Only the `bytes` unit is defined for HTTP request ranges.
  if (!value.toLowerCase().startsWith('bytes=')) return null;
  const spec = value.slice('bytes='.length).trim();
  // A comma introduces multiple ranges, which this route does not serve.
  if (spec.includes(',')) return null;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match === null) return null;
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let endInclusive: number;
  if (rawStart === '') {
    // Suffix range `-N`: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable';
    start = Math.max(0, sizeBytes - suffixLength);
    endInclusive = sizeBytes - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start)) return null;
    endInclusive = rawEnd === '' ? sizeBytes - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(endInclusive)) return null;
  }

  // An empty object satisfies no range, and a range that starts at or past the end is invalid.
  if (sizeBytes <= 0 || start >= sizeBytes || endInclusive < start) return 'unsatisfiable';
  return { start, endInclusive: Math.min(endInclusive, sizeBytes - 1) };
}
