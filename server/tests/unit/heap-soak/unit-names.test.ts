import { describe, expect, it } from 'vitest';
import { serverUnitName, soakSliceName, soakUnitPrefix, supervisorUnitName } from '../../../src/live-validation/heap-soak/unit-names.js';

/**
 * E2a-1: every systemd unit a stress or proof arm starts must be named
 * `e2a-<lane>-<what>` so the E2 host guard's `^e2a-` stop rail covers it
 * (COMMON-BRIEF-e2.md, Host safety rule 1). The harness's historic prefix
 * (`pi-web-ui-soak`) stays the default so existing runs are unchanged; the
 * E2a-1 run sets HEAP_SOAK_UNIT_PREFIX=e2a-1.
 */
describe('soak unit names (HEAP_SOAK_UNIT_PREFIX)', () => {
  it('defaults to the historic pi-web-ui-soak prefix', () => {
    expect(soakUnitPrefix({})).toBe('pi-web-ui-soak');
    expect(serverUnitName('run-1', {})).toBe('pi-web-ui-soak-server-run-1');
    expect(supervisorUnitName('run-1', {})).toBe('pi-web-ui-soak-supervisor-run-1');
    expect(soakSliceName({})).toBe('pi-web-ui-soak.slice');
  });

  it('derives unit and slice names from the prefix env', () => {
    const env = { HEAP_SOAK_UNIT_PREFIX: 'e2a-1' };
    expect(soakUnitPrefix(env)).toBe('e2a-1');
    expect(serverUnitName('run-1', env)).toBe('e2a-1-server-run-1');
    expect(supervisorUnitName('run-1', env)).toBe('e2a-1-supervisor-run-1');
    expect(soakSliceName(env)).toBe('e2a-1.slice');
  });

  it('accepts the prefixes a lane needs (multi-segment)', () => {
    const env = { HEAP_SOAK_UNIT_PREFIX: 'e2a-1-smoke' };
    expect(serverUnitName('x', env)).toBe('e2a-1-smoke-server-x');
    expect(soakSliceName(env)).toBe('e2a-1-smoke.slice');
  });

  it('refuses a prefix that is not a safe systemd unit-name fragment', () => {
    expect(() => soakUnitPrefix({ HEAP_SOAK_UNIT_PREFIX: '-leads-with-dash' })).toThrow(/HEAP_SOAK_UNIT_PREFIX/);
    expect(() => soakUnitPrefix({ HEAP_SOAK_UNIT_PREFIX: 'has spaces' })).toThrow(/HEAP_SOAK_UNIT_PREFIX/);
    expect(() => soakUnitPrefix({ HEAP_SOAK_UNIT_PREFIX: 'a'.repeat(65) })).toThrow(/HEAP_SOAK_UNIT_PREFIX/);
  });

  it('ignores a blank prefix and uses the default', () => {
    expect(soakUnitPrefix({ HEAP_SOAK_UNIT_PREFIX: '' })).toBe('pi-web-ui-soak');
    expect(soakUnitPrefix({ HEAP_SOAK_UNIT_PREFIX: '  ' })).toBe('pi-web-ui-soak');
  });
});
