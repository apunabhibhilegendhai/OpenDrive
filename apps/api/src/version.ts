/**
 * Service version reported by GET /healthz.
 *
 * Kept as an explicit constant rather than read from package.json: reading a file
 * outside `rootDir` would break the compiled layout, and this value is part of the
 * API response contract.
 */
export const SERVICE_VERSION = '0.1.0';
