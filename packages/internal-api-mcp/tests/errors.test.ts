import { describe, expect, it } from 'vitest';
import { asInternalApiClientError, InternalApiClientError } from '../src/errors.js';

describe('MCP client errors', () => {
  it('serializes bounded public fields without exposing causes', () => {
    const error = new InternalApiClientError('RUNTIME_UNAVAILABLE', 'Runtime unavailable.', {
      status: 503,
      hint: 'Retry later.',
      docs: 'docs/INTERNAL-API.md',
      retryable: true,
      retryAfterSeconds: 2,
      cause: new Error('secret stack'),
    });
    expect(error.toJSON()).toEqual({
      code: 'RUNTIME_UNAVAILABLE',
      message: 'Runtime unavailable.',
      status: 503,
      hint: 'Retry later.',
      docs: 'docs/INTERNAL-API.md',
      retryable: true,
      retryAfterSeconds: 2,
    });
    expect(JSON.stringify(error.toJSON())).not.toContain('secret stack');
  });

  it('serializes errors with optional fields omitted when they are not configured', () => {
    const error = new InternalApiClientError('INVALID_RESPONSE', 'Invalid response.');
    expect(error.toJSON()).toEqual({
      code: 'INVALID_RESPONSE',
      message: 'Invalid response.',
      retryable: false,
    });
  });

  it('keeps existing client errors and normalizes unknown failures', () => {
    const existing = new InternalApiClientError('REQUEST_TIMEOUT', 'Timed out.', { retryable: true });
    expect(asInternalApiClientError(existing)).toBe(existing);
    const normalized = asInternalApiClientError(new Error('raw failure'));
    expect(normalized).toMatchObject({ code: 'TRANSPORT_ERROR', retryable: true });
    expect(normalized.message).toBe('Internal API transport failed.');
  });
});
