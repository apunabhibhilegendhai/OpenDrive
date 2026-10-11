import { describe, expect, it } from 'vitest';
import {
  anonymousPrincipal,
  isAccountUsable,
  isSessionValid,
  parseOwnerKey,
  principalOwnerKey,
  requireOwnerKey,
  samePrincipal,
  userPrincipal,
} from './principals.js';

const USER_ID = 'b1f0f5a4-6d4d-4f0c-9f4a-1d0a2f7c9e33';
const SESSION_ID = 'sess_0123456789abcdefghjkmnpqrs';

describe('ownership principals', () => {
  it('mirrors the SQL owner_key: a lower-cased user id or the session id', () => {
    // `coalesce(owner_user_id::text, owner_session_id)` — Postgres renders a uuid lower-case, so
    // the JavaScript side must normalise before comparing.
    expect(principalOwnerKey(userPrincipal(USER_ID.toUpperCase()))).toBe(USER_ID);
    expect(principalOwnerKey(anonymousPrincipal(SESSION_ID))).toBe(SESSION_ID);
  });

  it('round-trips an owner key back to the principal that produced it', () => {
    expect(parseOwnerKey(USER_ID)).toEqual(userPrincipal(USER_ID));
    expect(parseOwnerKey(SESSION_ID)).toEqual(anonymousPrincipal(SESSION_ID));
  });

  it('refuses to invent an owner key for a malformed identity', () => {
    expect(principalOwnerKey(userPrincipal('not-a-uuid'))).toBeNull();
    expect(principalOwnerKey(anonymousPrincipal('sess_tooshort'))).toBeNull();
    expect(principalOwnerKey(userPrincipal(''))).toBeNull();
    expect(parseOwnerKey('')).toBeNull();
    expect(parseOwnerKey('file_0123456789abcdefghjkmnpqrs')).toBeNull();
    expect(() => requireOwnerKey(userPrincipal('42'))).toThrow(TypeError);
  });

  it('compares principals without treating two anonymous sessions as one owner', () => {
    expect(samePrincipal(userPrincipal(USER_ID), userPrincipal(USER_ID.toUpperCase()))).toBe(true);
    expect(
      samePrincipal(
        anonymousPrincipal(SESSION_ID),
        anonymousPrincipal('sess_0123456789abcdefghjkmnpqrt'),
      ),
    ).toBe(false);
    expect(samePrincipal(userPrincipal('not-a-uuid'), userPrincipal('not-a-uuid'))).toBe(false);
  });

  it('accepts only an active account, and only an unexpired active session', () => {
    expect(isAccountUsable('active')).toBe(true);
    expect(isAccountUsable('suspended')).toBe(false);
    expect(isAccountUsable('closed')).toBe(false);

    const now = new Date('2026-10-11T12:00:00.000Z');
    const future = new Date('2026-10-11T13:00:00.000Z');
    const past = new Date('2026-10-11T11:00:00.000Z');
    expect(isSessionValid({ status: 'active', expiresAt: future, now })).toBe(true);
    expect(isSessionValid({ status: 'active', expiresAt: past, now })).toBe(false);
    expect(isSessionValid({ status: 'revoked', expiresAt: future, now })).toBe(false);
    // A session expiring exactly now is expired: the boundary belongs to the server's clock.
    expect(isSessionValid({ status: 'active', expiresAt: now, now })).toBe(false);
  });
});
