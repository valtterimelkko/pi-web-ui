import { describe, expect, it } from 'vitest';
import { soakRuntimeMaxSec, viewOnlySubscribeServerEnv } from '../../../src/live-validation/heap-soak/launch-env.js';

/**
 * E2a-1: two launcher switches the brief needs, both env-driven so the
 * launch command carries them and no CLI surface changes.
 *
 * - HEAP_SOAK_RUNTIME_MAX_SEC: the E2 containment rule wants a RuntimeMaxSec
 *   backstop on long-lived units so an arm cannot outlive its window.
 * - HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: the soak server must boot with
 *   PI_WEB_UI_VIEW_ONLY_SUBSCRIBE=on, exactly as production runs since wave J.
 */
describe('soakRuntimeMaxSec (HEAP_SOAK_RUNTIME_MAX_SEC)', () => {
  it('is undefined when unset or blank (no RuntimeMaxSec property, today’s behaviour)', () => {
    expect(soakRuntimeMaxSec({})).toBeUndefined();
    expect(soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: '' })).toBeUndefined();
    expect(soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: '  ' })).toBeUndefined();
  });

  it('parses a valid whole-second bound', () => {
    expect(soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: '300' })).toBe(300);
    expect(soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: ' 14400 ' })).toBe(14400);
  });

  it('refuses values that cannot act as a backstop', () => {
    expect(() => soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: '59' })).toThrow(/at least 60/);
    expect(() => soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: '0' })).toThrow(/at least 60/);
    expect(() => soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: '2.5' })).toThrow(/whole number/);
    expect(() => soakRuntimeMaxSec({ HEAP_SOAK_RUNTIME_MAX_SEC: 'soon' })).toThrow(/whole number/);
  });
});

describe('viewOnlySubscribeServerEnv (HEAP_SOAK_VIEW_ONLY_SUBSCRIBE)', () => {
  it('contributes nothing when unset or blank', () => {
    expect(viewOnlySubscribeServerEnv({})).toEqual({});
    expect(viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: '' })).toEqual({});
  });

  it('maps on/true/1 (any case) to the production server flag', () => {
    expect(viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: 'on' })).toEqual({ PI_WEB_UI_VIEW_ONLY_SUBSCRIBE: 'on' });
    expect(viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: 'ON' })).toEqual({ PI_WEB_UI_VIEW_ONLY_SUBSCRIBE: 'on' });
    expect(viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: 'true' })).toEqual({ PI_WEB_UI_VIEW_ONLY_SUBSCRIBE: 'on' });
    expect(viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: '1' })).toEqual({ PI_WEB_UI_VIEW_ONLY_SUBSCRIBE: 'on' });
  });

  it('refuses any other value (a typo must not silently boot with the flag off)', () => {
    expect(() => viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: 'off' })).toThrow(/HEAP_SOAK_VIEW_ONLY_SUBSCRIBE/);
    expect(() => viewOnlySubscribeServerEnv({ HEAP_SOAK_VIEW_ONLY_SUBSCRIBE: 'yes' })).toThrow(/HEAP_SOAK_VIEW_ONLY_SUBSCRIBE/);
  });
});
