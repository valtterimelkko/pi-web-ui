import { describe, expect, it } from 'vitest';
import { soakRuntimeMaxSec, supervisorEnvPassthrough, viewOnlySubscribeServerEnv, redactEnvironmentForEvidence } from '../../../src/live-validation/heap-soak/launch-env.js';

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

describe('supervisorEnvPassthrough (runtime env the supervisor unit must inherit)', () => {
  it('copies exactly the keys the supervisor/driver read at runtime, when set', () => {
    const passthrough = supervisorEnvPassthrough({
      HEAP_SOAK_LANES: 'A',
      HEAP_SOAK_MAX_CONCURRENT: '4',
      HEAP_SOAK_FORCE_BAD_LANE: 'B',
      HEAP_SOAK_INJECT_QUOTA_SEQUENCE: '[{"percentLeft":10}]',
      HEAP_SOAK_KEEP_SERVER: '1',
      HEAP_SOAK_UNIT_PREFIX: 'e2a-1', // launcher-only: must NOT propagate
      HEAP_SOAK_CREDENTIAL_PROVIDERS: 'zai', // launcher-only: must NOT propagate
      PATH: '/usr/bin',
    });
    expect(passthrough).toEqual({
      HEAP_SOAK_LANES: 'A',
      HEAP_SOAK_MAX_CONCURRENT: '4',
      HEAP_SOAK_FORCE_BAD_LANE: 'B',
      HEAP_SOAK_INJECT_QUOTA_SEQUENCE: '[{"percentLeft":10}]',
      HEAP_SOAK_KEEP_SERVER: '1',
    });
  });

  it('returns empty when none are set', () => {
    expect(supervisorEnvPassthrough({})).toEqual({});
    expect(supervisorEnvPassthrough({ HEAP_SOAK_UNIT_PREFIX: 'e2a-1' })).toEqual({});
  });
});

describe('redactEnvironmentForEvidence (correction 02: capture BOTH units’ properties, secrets redacted)', () => {
  it('redacts values of credential-ish keys in KEY=value and systemd Environment shapes', () => {
    const text = 'FOO=bar API_TOKEN=abc123 PI_WEB_UI_WATCH_WAKE_TOKEN_FILE=/run/some/token JWT_SECRET=hush Path=/usr/bin';
    const red = redactEnvironmentForEvidence(text);
    expect(red).toContain('FOO=bar');
    expect(red).toContain('API_TOKEN=REDACTED');
    expect(red).toContain('JWT_SECRET=REDACTED');
    expect(red).toContain('Path=/usr/bin');
    expect(red).not.toContain('abc123');
    expect(red).not.toContain('hush');
  });

  it('keeps non-credential path variables intact (token FILE paths are not secret values)', () => {
    const text = 'PI_WEB_UI_WATCH_WAKE_TOKEN_FILE=/run/x/internal-api-token HOME=/root';
    expect(redactEnvironmentForEvidence(text)).toContain('PI_WEB_UI_WATCH_WAKE_TOKEN_FILE=/run/x/internal-api-token');
  });
});

describe('redactEnvironmentForEvidence — exact systemctl show shape (parent FINAL correction 03, Luna r2)', () => {
  it('redacts the FIRST assignment after the Environment= prefix too', () => {
    const red = redactEnvironmentForEvidence('Environment=API_TOKEN=FAKE_FIRST_SECRET HOME=/tmp JWT_SECRET=FAKE_LATER');
    expect(red).not.toContain('FAKE_FIRST_SECRET');
    expect(red).not.toContain('FAKE_LATER');
    expect(red).toContain('Environment=API_TOKEN=REDACTED');
    expect(red).toContain('HOME=/tmp');
  });

  it('handles several property lines, only redacting credential-ish keys', () => {
    const red = redactEnvironmentForEvidence('MemoryMax=8589934592\nEnvironment=AUTH_PASSWORD=FAKE_PW NODE_ENV=test\nMainPID=42');
    expect(red).not.toContain('FAKE_PW');
    expect(red).toContain('MemoryMax=8589934592');
    expect(red).toContain('NODE_ENV=test');
    expect(red).toContain('MainPID=42');
  });
});

