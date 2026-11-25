import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  ALL_ERROR_CODES,
  ERROR_CODE_INFO,
  buildErrorBody,
  enrichedErrorBody,
  providerErrorCodeFor,
} from '../../../src/internal-api/error-codes.js';

describe('Internal API error-code catalog (Task 9)', () => {
  it('every code constant equals its own wire string (values must never change)', () => {
    // Consumers switch on these exact strings; renaming is a breaking change.
    for (const key of Object.keys(ErrorCode) as Array<keyof typeof ErrorCode>) {
      expect(ErrorCode[key]).toBe(key);
    }
  });

  it('includes every code that exists in the codebase', () => {
    const codes = new Set(ALL_ERROR_CODES);
    for (const expected of [
      'UNAUTHORIZED',
      'METHOD_NOT_ALLOWED',
      'NOT_FOUND',
      'INVALID_REQUEST',
      'SESSION_NOT_FOUND',
      'SESSION_BUSY',
      'SESSION_CREATE_FAILED',
      'RUNTIME_UNAVAILABLE',
      'OPENCODE_UNAVAILABLE',
      'RUNTIME_ERROR',
      'PROMPT_INJECTION',
      'UNSUPPORTED_OPERATION',
      'NOT_IMPLEMENTED',
      'INTERNAL_ERROR',
      'WATCH_NOT_FOUND',
      'TRANSFER_DISPATCH_FAILED',
      'EMPTY_TRANSCRIPT',
      'PROVIDER_NOT_ALLOWED',
      'RUN_BUDGET_EXCEEDED',
    ]) {
      expect(codes.has(expected as never)).toBe(true);
    }
  });

  it('has metadata for every code', () => {
    for (const code of ALL_ERROR_CODES) {
      const info = ERROR_CODE_INFO[code];
      expect(info, `missing info for ${code}`).toBeDefined();
      expect(typeof info.httpStatus).toBe('number');
      expect(info.httpStatus).toBeGreaterThanOrEqual(400);
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.cause.length).toBeGreaterThan(0);
    }
  });

  it('buildErrorBody preserves the base { error, code } shape', () => {
    const body = buildErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
    expect(body).toEqual({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    // no extra keys by default (additive only)
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
  });

  it('buildErrorBody layers hint/docs only when requested and present', () => {
    const withHint = buildErrorBody(ErrorCode.SESSION_NOT_FOUND, 'x', { hint: true });
    expect(withHint.code).toBe('SESSION_NOT_FOUND');
    expect(typeof withHint.hint).toBe('string');
    expect((withHint.hint as string).length).toBeGreaterThan(0);

    // hint suppressed when not requested
    const bare = buildErrorBody(ErrorCode.SESSION_NOT_FOUND, 'x');
    expect(bare.hint).toBeUndefined();
  });

  it('enrichedErrorBody keeps base {error, code} shape and adds hint (Task 11)', () => {
    const body = enrichedErrorBody(ErrorCode.SESSION_NOT_FOUND, 'Session not found');
    // base shape preserved (additive only)
    expect(body.error).toBe('Session not found');
    expect(body.code).toBe('SESSION_NOT_FOUND');
    // hint + docs present for this actionable code
    expect(typeof body.hint).toBe('string');
    expect((body.hint as string).length).toBeGreaterThan(0);
    expect(typeof body.docs).toBe('string');
  });

  it('every targeted actionable code carries a non-empty hint via enrichedErrorBody', () => {
    for (const code of [
      ErrorCode.RUNTIME_UNAVAILABLE,
      ErrorCode.SESSION_NOT_FOUND,
      ErrorCode.PROMPT_INJECTION,
      ErrorCode.SESSION_BUSY,
      ErrorCode.UNSUPPORTED_OPERATION,
    ]) {
      const body = enrichedErrorBody(code, 'x');
      expect(body.code, code).toBe(code);
      expect(typeof body.hint, `${code} hint`).toBe('string');
      expect((body.hint as string).length, `${code} hint empty`).toBeGreaterThan(0);
    }
  });
});

/**
 * Lane C (agy-post-turn): a failed Antigravity turn is classified as quota /
 * transient / other. The first two get their own wire code so a parent can tell
 * "stop until the quota resets" from "wait, then retry"; `other` keeps the
 * pre-existing generic `RUNTIME_ERROR`.
 */
describe('provider-error codes (lane C)', () => {
  it('maps a classified provider failure to its own code', () => {
    expect(providerErrorCodeFor('quota')).toBe('PROVIDER_QUOTA_EXHAUSTED');
    expect(providerErrorCodeFor('transient')).toBe('PROVIDER_TRANSIENT');
  });

  it('catalogs both codes as additive entries with their own status and guidance', () => {
    for (const code of ['PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_TRANSIENT'] as const) {
      expect(ALL_ERROR_CODES).toContain(code);
      const info = ERROR_CODE_INFO[code];
      expect(info.httpStatus).toBe(code === 'PROVIDER_QUOTA_EXHAUSTED' ? 429 : 503);
      expect(info.description.length).toBeGreaterThan(0);
      expect(info.cause.length).toBeGreaterThan(0);
      expect((info.hint ?? '').length).toBeGreaterThan(0);
    }
  });
});

/**
 * Lane A (W1) — the public NEVER_STARTED hint must not tell callers to retry
 * work the receipt cannot prove was never delivered.
 *
 * Root cause (audit §2B): the vocabulary asserted "The message never ran;
 * re-dispatch it" for a state that only means "no runtime activity was
 * observed". Eight Devin wakes matched that state while still sitting in a FIFO
 * queue, and later executed — so the hint's advice could duplicate real work.
 * Absence of observed activity is not proof of non-delivery.
 */
describe('NEVER_STARTED public vocabulary (lane A)', () => {
  it('does not assert non-execution or advise an unconditional re-dispatch', () => {
    const info = ERROR_CODE_INFO[ErrorCode.NEVER_STARTED];
    expect(info).toBeDefined();
    const hint = info!.hint ?? '';

    // The audit-disproved claim.
    expect(hint).not.toMatch(/never ran; re-dispatch/i);
    expect(hint).not.toMatch(/^the message never ran/i);
    // Actionable, but honest about what must be checked first.
    expect(hint).toMatch(/delivery|unconfirmed|held in a .*queue/i);
    expect(hint).toMatch(/transcript|inspect|check|verify/i);
    // The direction must not be "just send it again".
    expect(hint).not.toMatch(/^\s*re-dispatch it\.?\s*$/i);
  });

  it('keeps the runNeverStarted watcher evidence note (parents depend on it)', () => {
    const hint = ERROR_CODE_INFO[ErrorCode.NEVER_STARTED]!.hint ?? '';
    expect(hint).toMatch(/watch|runNeverStarted/i);
  });

  it('does not overstate the cause: absence of activity is what was observed', () => {
    const cause = ERROR_CODE_INFO[ErrorCode.NEVER_STARTED]!.cause ?? '';
    // "The runtime never began the work" is the same unproven inference.
    expect(cause).not.toMatch(/never began the work/i);
    expect(cause).toMatch(/no .*activity|observed/i);
  });
});
