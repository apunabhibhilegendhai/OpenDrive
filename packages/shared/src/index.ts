export {
  ERROR_DEFINITIONS,
  AppError,
  errorCodeSchema,
  httpStatusFor,
  isAppError,
  notFound,
  notImplemented,
  problemDetailsSchema,
  validationFailed,
} from './errors.js';
export type { AppErrorOptions, ErrorCode, ProblemDetails } from './errors.js';

export { ID_KINDS, isIdOfKind, newBase32Suffix, newId, parseId } from './ids.js';
export type { IdKind, IdPrefix, ParsedId } from './ids.js';

export { newOpaqueToken, sha256Hex, sha256HexOfBytes, tokensEqual } from './tokens.js';

export {
  ANONYMOUS_CREDENTIAL_HEADER,
  ANONYMOUS_SESSION_CREDENTIAL_PATTERN,
  ANONYMOUS_SESSION_CREDENTIAL_PREFIX,
  API_KEY_HEADER,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_PREFIX_PATTERN,
  AUTHORIZATION_HEADER,
  SHARE_TOKEN_HEADER,
  classifyCredential,
  credentialDigest,
  newAnonymousSessionCredential,
  newApiKeyMaterial,
  parseApiKey,
} from './credentials.js';
export type { ApiKeyMaterial, CredentialKind, ParsedApiKey } from './credentials.js';

// Vocabulary and rules. These modules are the single definition of the states, visibility
// levels, principals and scopes that the database, the API and the tests all refer to.
export * from './domain/api-keys.js';
export * from './domain/file-states.js';
export * from './domain/principals.js';
export * from './domain/quota.js';
export * from './domain/share-links.js';
export * from './domain/visibility.js';

export * from './api.js';
export * from './limits.js';
export * from './storage/index.js';
