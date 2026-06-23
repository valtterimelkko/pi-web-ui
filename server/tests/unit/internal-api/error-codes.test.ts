import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  ALL_ERROR_CODES,
  ERROR_CODE_INFO,
  buildErrorBody,
  enrichedErrorBody,
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
