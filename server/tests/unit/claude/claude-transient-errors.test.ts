import { describe, it, expect } from 'vitest';
import {
  isTransientClaudeError,
  getTransientRetryConfig,
  computeBackoffMs,
} from '../../../src/claude/claude-transient-errors.js';

describe('isTransientClaudeError', () => {
  it('matches the real "temporarily unavailable" capacity message', () => {
    expect(isTransientClaudeError('claude-opus-4-8 is temporarily unavailable, so auto mode cannot determine...')).toBe(true);
  });

  it('matches overload / rate-limit / gateway phrasings (case-insensitive)', () => {
    for (const msg of [
      'Overloaded',
      'API Error: 529 {"type":"overloaded_error"}',
      'Too Many Requests',
      'rate limit exceeded',
      'Service Unavailable',
      'Bad Gateway',
      'Gateway Timeout',
      'Internal Server Error',
    ]) {
      expect(isTransientClaudeError(msg), msg).toBe(true);
    }
  });

  it('matches network-level failures', () => {
    for (const msg of ['socket hang up', 'ECONNRESET', 'fetch failed', 'request timed out', 'ETIMEDOUT']) {
      expect(isTransientClaudeError(msg), msg).toBe(true);
    }
  });

  it('matches retryable HTTP status codes as whole words', () => {
    expect(isTransientClaudeError('HTTP 503 from upstream')).toBe(true);
    expect(isTransientClaudeError('status=429')).toBe(true);
  });

  it('does NOT match permanent errors', () => {
    for (const msg of [
      'Invalid API key',
      'model not found',
      'permission denied: tool Bash is not allowed',
      'prompt was blocked by the safety filter',
      'Session ID 1234 is already in use',
    ]) {
      expect(isTransientClaudeError(msg), msg).toBe(false);
    }
  });

  it('does NOT false-positive on bare 500 or unrelated numbers', () => {
    expect(isTransientClaudeError('wrote 5000 tokens to file')).toBe(false);
    expect(isTransientClaudeError('exited with code 1')).toBe(false);
    expect(isTransientClaudeError('')).toBe(false);
    expect(isTransientClaudeError(null)).toBe(false);
    expect(isTransientClaudeError(undefined)).toBe(false);
  });
});

describe('getTransientRetryConfig', () => {
  it('defaults to 2 retries, 1000ms base, 15000ms cap', () => {
    expect(getTransientRetryConfig({})).toEqual({ maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 15000 });
  });

  it('reads overrides from env and hard-caps maxRetries at 5', () => {
    expect(getTransientRetryConfig({
      CLAUDE_TRANSIENT_MAX_RETRIES: '99',
      CLAUDE_TRANSIENT_BASE_DELAY_MS: '250',
      CLAUDE_TRANSIENT_MAX_DELAY_MS: '5000',
    })).toEqual({ maxRetries: 5, baseDelayMs: 250, maxDelayMs: 5000 });
  });

  it('allows disabling retries with 0 and ignores garbage values', () => {
    expect(getTransientRetryConfig({ CLAUDE_TRANSIENT_MAX_RETRIES: '0' }).maxRetries).toBe(0);
    expect(getTransientRetryConfig({ CLAUDE_TRANSIENT_MAX_RETRIES: 'abc' }).maxRetries).toBe(2);
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(computeBackoffMs(1, 1000, 15000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 15000)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 15000)).toBe(4000);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffMs(10, 1000, 15000)).toBe(15000);
  });

  it('returns 0 for non-positive retry numbers', () => {
    expect(computeBackoffMs(0, 1000, 15000)).toBe(0);
  });
});
