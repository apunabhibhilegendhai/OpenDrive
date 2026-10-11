import { describe, expect, it } from 'vitest';
import {
  API_KEY_PATTERN,
  API_KEY_PREFIX_PATTERN,
  classifyCredential,
  credentialDigest,
  newAnonymousSessionCredential,
  newApiKeyMaterial,
  parseApiKey,
} from './credentials.js';
import { errorCodeForQuotaRefusal, isQuotaRefusalExplainable } from './domain/quota.js';
import { missingScopes, normalizeScopes } from './domain/api-keys.js';

describe('credential formats', () => {
  it('mints an anonymous session credential that matches the documented shape', () => {
    const credential = newAnonymousSessionCredential();
    expect(credential).toMatch(/^ods_[A-Za-z0-9_-]{43}$/);
    expect(classifyCredential(credential)).toBe('anonymous_session');
  });

  it('mints distinct credentials with 256 bits of entropy', () => {
    const values = new Set(Array.from({ length: 200 }, () => newAnonymousSessionCredential()));
    expect(values.size).toBe(200);
  });

  it('mints an API key whose public prefix matches the SQL check constraint', () => {
    const material = newApiKeyMaterial();
    expect(material.keyPrefix).toMatch(API_KEY_PREFIX_PATTERN);
    expect(material.key).toMatch(API_KEY_PATTERN);
    expect(parseApiKey(material.key)).toEqual({
      keyPrefix: material.keyPrefix,
      secret: material.key.slice(material.keyPrefix.length + 1),
    });
    expect(classifyCredential(material.key)).toBe('api_key');
  });

  it('classifies a Supabase access token as a JWT, not as an API key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl';
    expect(classifyCredential(jwt)).toBe('supabase_access_token');
  });

  it('refuses to parse a malformed API key', () => {
    for (const value of [
      '',
      '   ',
      'ods_short',
      'odk_ABCDEFGH_secret',
      'odk_0123456789abcdefghjkmnpqrs_secret-too-short',
      'not-a-credential',
    ]) {
      expect(parseApiKey(value), value).toBeNull();
    }
  });

  it('classifies anything unrecognised as unknown rather than guessing', () => {
    for (const value of [
      '',
      '   ',
      'ods_short',
      'not-a-credential',
      'a.b',
      'a.b.c.d',
      'odk_ABCDEFGH_secret',
    ]) {
      expect(classifyCredential(value), value).toBe('unknown');
    }
  });

  it('hashes the whole presented credential, so a leaked digest is not a credential', async () => {
    const credential = newAnonymousSessionCredential();
    const digest = await credentialDigest(credential);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await credentialDigest(credential)).toBe(digest);
    expect(await credentialDigest(digest)).not.toBe(digest);
  });
});

describe('quota refusal mapping', () => {
  it('maps each refusal to the status the API answers with', () => {
    expect(errorCodeForQuotaRefusal('storage_quota_exceeded')).toBe('QUOTA_EXCEEDED');
    expect(errorCodeForQuotaRefusal('file_count_exceeded')).toBe('QUOTA_EXCEEDED');
    expect(errorCodeForQuotaRefusal('upload_bandwidth_exceeded')).toBe('RATE_LIMITED');
    expect(errorCodeForQuotaRefusal('file_too_large')).toBe('PAYLOAD_TOO_LARGE');
    expect(errorCodeForQuotaRefusal('owner_mismatch')).toBe('FORBIDDEN');
    expect(errorCodeForQuotaRefusal('session_expired')).toBe('UNAUTHENTICATED');
    expect(errorCodeForQuotaRefusal('session_revoked')).toBe('UNAUTHENTICATED');
    expect(errorCodeForQuotaRefusal('owner_not_active')).toBe('FORBIDDEN');
    expect(errorCodeForQuotaRefusal('already_reserved')).toBe('CONFLICT');
    expect(errorCodeForQuotaRefusal('size_mismatch')).toBe('INTEGRITY_CHECK_FAILED');
    expect(errorCodeForQuotaRefusal('policy_missing')).toBe('INTERNAL');
  });

  it('only explains refusals the caller can act on', () => {
    expect(isQuotaRefusalExplainable('storage_quota_exceeded')).toBe(true);
    expect(isQuotaRefusalExplainable('file_too_large')).toBe(true);
    expect(isQuotaRefusalExplainable('invalid_principal')).toBe(false);
    expect(isQuotaRefusalExplainable('policy_missing')).toBe(false);
  });
});

describe('api key scopes', () => {
  it('treats an empty scope list as no permissions', () => {
    expect(missingScopes([], ['files:read'])).toEqual(['files:read']);
    expect(missingScopes(['files:read'], ['files:read'])).toEqual([]);
    expect(missingScopes(['files:read'], ['files:read', 'shares:write'])).toEqual(['shares:write']);
  });

  it('drops unknown scopes instead of storing something the database would reject', () => {
    expect(normalizeScopes(['files:read', 'files:read', 'admin:*', ''])).toEqual({
      accepted: ['files:read'],
      rejected: ['admin:*', ''],
    });
  });
});
