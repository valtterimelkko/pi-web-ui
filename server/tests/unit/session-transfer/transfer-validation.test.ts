import { describe, it, expect } from 'vitest';
import { validateTransferScope, validateSdkType, validateTransferRequest, isToolVisible, extractToolPrimaryArg } from '../../../src/session-transfer/transfer-validation.js';
import { TRANSFER_ERROR_CODES } from '../../../src/session-transfer/types.js';

describe('validateTransferScope', () => {
  it('accepts visible_recent', () => {
    expect(validateTransferScope('visible_recent')).toBe(true);
  });

  it('accepts visible_full', () => {
    expect(validateTransferScope('visible_full')).toBe(true);
  });

  it('rejects invalid scope', () => {
    expect(validateTransferScope('invalid')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validateTransferScope(undefined)).toBe(false);
  });
});

describe('validateSdkType', () => {
  it('accepts pi', () => {
    expect(validateSdkType('pi')).toBe(true);
  });

  it('accepts claude', () => {
    expect(validateSdkType('claude')).toBe(true);
  });

  it('accepts opencode', () => {
    expect(validateSdkType('opencode')).toBe(true);
  });

  it('rejects invalid', () => {
    expect(validateSdkType('invalid')).toBe(false);
  });
});

describe('validateTransferRequest', () => {
  it('accepts valid existing-target request', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts valid create-new request', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      createNew: true,
      targetSdkType: 'claude',
      targetCwd: '/home/user',
      scope: 'visible_recent',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts sourceDisplayName', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
      sourceDisplayName: 'My Session',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object', () => {
    const result = validateTransferRequest(null);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects missing sourceSessionId', () => {
    const result = validateTransferRequest({
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects empty sourceSessionId', () => {
    const result = validateTransferRequest({
      sourceSessionId: '  ',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects invalid scope', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'everything',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_SCOPE);
  });

  it('rejects create-new without targetSdkType', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      createNew: true,
      targetCwd: '/home/user',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects create-new without targetCwd', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      createNew: true,
      targetSdkType: 'claude',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects non-create without targetSessionId', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects self-transfer', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'same-1',
      targetSessionId: 'same-1',
      scope: 'visible_full',
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.SELF_TRANSFER);
  });

  it('rejects non-string sourceDisplayName', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
      sourceDisplayName: 123,
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });

  it('rejects overly long sourceDisplayName', () => {
    const result = validateTransferRequest({
      sourceSessionId: 'src-1',
      targetSessionId: 'tgt-1',
      scope: 'visible_full',
      sourceDisplayName: 'x'.repeat(201),
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(TRANSFER_ERROR_CODES.INVALID_REQUEST);
  });
});

describe('isToolVisible', () => {
  it.each(['read', 'write', 'edit', 'bash', 'glob', 'grep', 'webfetch', 'skill', 'task'])(
    'identifies %s as visible',
    (name) => {
      expect(isToolVisible(name)).toBe(true);
    },
  );

  it('is case-insensitive', () => {
    expect(isToolVisible('Read')).toBe(true);
    expect(isToolVisible('BASH')).toBe(true);
  });

  it('matches prefixed/suffixed tool names', () => {
    expect(isToolVisible('pencil_batch_read')).toBe(true);
    expect(isToolVisible('webfetch_skill')).toBe(true);
  });

  it('rejects invisible tools', () => {
    expect(isToolVisible('internal_thinking')).toBe(false);
    expect(isToolVisible('approval_handler')).toBe(false);
  });
});

describe('extractToolPrimaryArg', () => {
  it('extracts filePath from read', () => {
    expect(extractToolPrimaryArg('read', { filePath: '/foo/bar.ts' })).toBe('/foo/bar.ts');
  });

  it('extracts command from bash', () => {
    expect(extractToolPrimaryArg('bash', { command: 'npm test' })).toBe('npm test');
  });

  it('extracts pattern from glob', () => {
    expect(extractToolPrimaryArg('glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('extracts url from webfetch', () => {
    expect(extractToolPrimaryArg('webfetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('truncates long values', () => {
    const long = '/very/long/path/' + 'x'.repeat(150);
    const result = extractToolPrimaryArg('read', { filePath: long });
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(103);
    expect(result!.endsWith('...')).toBe(true);
  });

  it('returns undefined for null args', () => {
    expect(extractToolPrimaryArg('read', null)).toBeUndefined();
  });

  it('returns undefined for unknown tool', () => {
    expect(extractToolPrimaryArg('unknown_tool', { foo: 'bar' })).toBeUndefined();
  });
});
