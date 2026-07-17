import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { decideWsUpgrade } from '../../../src/security/websocket.js';
import { generateSessionToken } from '../../../src/security/auth.js';
import { wsUpgradeLimiter } from '../../../src/security/rate-limit.js';
import { config } from '../../../src/config.js';

// Use the real configured allowed origin so the test is environment-independent.
const ALLOWED = config.allowedOrigins[0];
const DISALLOWED = 'http://evil.example';

function makeReq(opts: { origin?: string; cookie?: string }): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  return { headers } as unknown as IncomingMessage;
}

function authedReq(origin: string = ALLOWED): IncomingMessage {
  return makeReq({ origin, cookie: `accessToken=${generateSessionToken('test-user')}` });
}

describe('wsUpgradeLimiter', () => {
  beforeEach(() => wsUpgradeLimiter.reset());

  it('allows up to the configured limit then denies', () => {
    const max = wsUpgradeLimiter.max;
    for (let i = 0; i < max; i++) {
      expect(wsUpgradeLimiter.check('client-key')).toBe(true);
    }
    expect(wsUpgradeLimiter.check('client-key')).toBe(false);
  });

  it('reset() clears the window', () => {
    const max = wsUpgradeLimiter.max;
    for (let i = 0; i < max; i++) wsUpgradeLimiter.check('client-key');
    expect(wsUpgradeLimiter.check('client-key')).toBe(false);
    wsUpgradeLimiter.reset();
    expect(wsUpgradeLimiter.check('client-key')).toBe(true);
  });
});

describe('decideWsUpgrade — central pre-upgrade guard', () => {
  beforeEach(() => wsUpgradeLimiter.reset());

  it('allows a valid origin + valid cookie', () => {
    const d = decideWsUpgrade(authedReq());
    expect(d.allowed).toBe(true);
    expect(d.user?.userId).toBe('test-user');
  });

  it('rejects a missing origin (403 / origin)', () => {
    const d = decideWsUpgrade(makeReq({ cookie: `accessToken=${generateSessionToken('u')}` }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('origin');
    expect(d.statusCode).toBe(403);
  });

  it('rejects a disallowed origin (403 / origin)', () => {
    const d = decideWsUpgrade(authedReq(DISALLOWED));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('origin');
    expect(d.statusCode).toBe(403);
  });

  it('rejects a missing cookie (401 / auth)', () => {
    const d = decideWsUpgrade(makeReq({ origin: ALLOWED }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('auth');
    expect(d.statusCode).toBe(401);
  });

  it('rejects an invalid cookie (401 / auth)', () => {
    const d = decideWsUpgrade(makeReq({ origin: ALLOWED, cookie: 'accessToken=bogus.token.here' }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('auth');
    expect(d.statusCode).toBe(401);
  });

  it('rejects when the upgrade rate limit is exceeded (429 / rate)', () => {
    vi.spyOn(wsUpgradeLimiter, 'check').mockReturnValue(false);
    const d = decideWsUpgrade(authedReq());
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('rate');
    expect(d.statusCode).toBe(429);
    vi.restoreAllMocks();
  });

  it('does not consume the rate limit for an unauthenticated request', () => {
    const spy = vi.spyOn(wsUpgradeLimiter, 'check');
    decideWsUpgrade(makeReq({ origin: ALLOWED })); // no cookie -> auth fails first
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
