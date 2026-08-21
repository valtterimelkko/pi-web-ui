import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  resolveRateLimitMax,
  resolveAutoArchiveDays,
  resolveCleanupDryRun,
  resolveRetentionMinDwellDays,
} from '../../src/config.js';

/**
 * Regression tests for the 2026-08-21 rate-limit incident (see
 * PIWEBUIRATELIMITANDSESSIONHYGIENEFIXES.md):
 *
 * - The global limiter used to sit BEFORE express.static and the SPA fallback,
 *   charging every asset request against the same budget as API calls. It must
 *   apply to /api only.
 * - The 429 response used to carry no RateLimit-* headers, so clients could
 *   not back off correctly.
 * - RATE_LIMIT_MAX_REQUESTS (set in every env file) was never read — only the
 *   undocumented RATE_LIMIT_MAX name was.
 */

describe('rate limit env resolution', () => {
  it('accepts both RATE_LIMIT_MAX and RATE_LIMIT_MAX_REQUESTS, preferring RATE_LIMIT_MAX', () => {
    expect(resolveRateLimitMax({})).toBe(100);
    expect(resolveRateLimitMax({ RATE_LIMIT_MAX_REQUESTS: '250' })).toBe(250);
    expect(resolveRateLimitMax({ RATE_LIMIT_MAX: '300' })).toBe(300);
    expect(resolveRateLimitMax({ RATE_LIMIT_MAX: '300', RATE_LIMIT_MAX_REQUESTS: '250' })).toBe(300);
    expect(() => resolveRateLimitMax({ RATE_LIMIT_MAX: 'junk' })).toThrow(/RATE_LIMIT/);
  });
});

describe('session cleanup env resolution', () => {
  it('auto-archive defaults to 30 days and accepts overrides incl. 0=disabled', () => {
    expect(resolveAutoArchiveDays({})).toBe(30);
    expect(resolveAutoArchiveDays({ SESSION_AUTO_ARCHIVE_DAYS: '14' })).toBe(14);
    expect(resolveAutoArchiveDays({ SESSION_AUTO_ARCHIVE_DAYS: '0' })).toBe(0);
    expect(() => resolveAutoArchiveDays({ SESSION_AUTO_ARCHIVE_DAYS: '-1' })).toThrow(/AUTO_ARCHIVE/);
  });

  it('cleanup dry-run defaults to true and only the literal false disables it', () => {
    expect(resolveCleanupDryRun({})).toBe(true);
    expect(resolveCleanupDryRun({ SESSION_CLEANUP_DRY_RUN: 'false' })).toBe(false);
    expect(resolveCleanupDryRun({ SESSION_CLEANUP_DRY_RUN: 'true' })).toBe(true);
    expect(resolveCleanupDryRun({ SESSION_CLEANUP_DRY_RUN: '' })).toBe(true);
  });

  it('retention min dwell defaults to 7 days', () => {
    expect(resolveRetentionMinDwellDays({})).toBe(7);
    expect(resolveRetentionMinDwellDays({ SESSION_RETENTION_MIN_DWELL_DAYS: '3' })).toBe(3);
    expect(() => resolveRetentionMinDwellDays({ SESSION_RETENTION_MIN_DWELL_DAYS: 'x' })).toThrow(/DWELL/);
  });
});

describe('limiter scope in createApp()', () => {
  it('non-/api paths are never rate limited (static/SPA traffic is free)', async () => {
    const app = createApp();
    // /health is unthrottled; hammer it well past any small test cap.
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }
  });

  it('/api requests are limited and carry standard RateLimit headers on rejection', async () => {
    const app = createApp();
    // Unauthenticated /api request: auth middleware rejects with 401, but the
    // limiter still counts the request and eventually answers 429 itself.
    let sawHeaders = false;
    let got429 = false;
    for (let i = 0; i < 250; i++) {
      const res = await request(app).get('/api/sessions');
      if (res.headers['ratelimit-limit'] !== undefined) sawHeaders = true;
      if (res.status === 429) { got429 = true; break; }
    }
    expect(got429).toBe(true);
    expect(sawHeaders).toBe(true);
  });
});
