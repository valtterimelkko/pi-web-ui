import { describe, expect, it } from 'vitest';
import { resolveValidationTarget, PRODUCTION_VALIDATION_ERROR } from '../../../src/live-validation/validation-safety.js';

describe('validation safety guardrails', () => {
  it('refuses to target the default production Internal API unless explicitly allowed', () => {
    expect(() => resolveValidationTarget({})).toThrow(PRODUCTION_VALIDATION_ERROR);
  });

  it('allows the default production Internal API only with explicit override', () => {
    const target = resolveValidationTarget({ allowProduction: true });

    expect(target.socketPath).toBeUndefined();
    expect(target.tokenPath).toBeUndefined();
    expect(target.usingProductionServer).toBe(true);
  });

  it('accepts an isolated validation socket and token path without production override', () => {
    const target = resolveValidationTarget({
      socketPath: '/tmp/pi-validation/internal-api.sock',
      tokenPath: '/tmp/pi-validation/internal-api-token',
    });

    expect(target.socketPath).toBe('/tmp/pi-validation/internal-api.sock');
    expect(target.tokenPath).toBe('/tmp/pi-validation/internal-api-token');
    expect(target.usingProductionServer).toBe(false);
  });

  it('rejects partial isolated target configuration', () => {
    expect(() => resolveValidationTarget({ socketPath: '/tmp/pi-validation/internal-api.sock' })).toThrow(/both --socket and --token-path/i);
    expect(() => resolveValidationTarget({ tokenPath: '/tmp/pi-validation/internal-api-token' })).toThrow(/both --socket and --token-path/i);
  });
});
