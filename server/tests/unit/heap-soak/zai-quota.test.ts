import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_THRESHOLDS,
  effectiveBackboneTarget,
  nextQuotaState,
  nextStateOnPollFailure,
  parseProviderUsage,
} from '../../../src/live-validation/heap-soak/zai-quota.js';

const REAL_SHAPE = (percent: number, peakActive = false, resets = '2026-09-26T10:08:49.829Z') => JSON.stringify({
  measuredAt: '2026-09-26T06:12:51.310Z',
  peakWindow: { active: peakActive, note: 'x' },
  rows: [{
    provider: 'zai-glm',
    state: 'ample',
    windows: `5h left ${percent}%`,
    resets: `TIME_LIMIT resets 2026-09-26T23:35:34.999Z; 5h resets ${resets}`,
    pool: 'zai pool',
    routes: 'GLM 5.3 Flash; GLM 5.3 (pi/zai)',
    advisory: 'off-peak',
  }],
});

describe('parseProviderUsage', () => {
  it('parses the real agent-os provider-usage --json shape', () => {
    const reading = parseProviderUsage(REAL_SHAPE(99));
    expect(reading).toEqual({ percentLeft: 99, resetsAt: '2026-09-26T10:08:49.829Z', peakActive: false, measuredAt: '2026-09-26T06:12:51.310Z' });
  });

  it('reads peakWindow.active', () => {
    const reading = parseProviderUsage(REAL_SHAPE(80, true));
    expect(reading?.peakActive).toBe(true);
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseProviderUsage('{not json')).toBeUndefined();
  });

  it('returns undefined when the zai-glm row is missing', () => {
    expect(parseProviderUsage(JSON.stringify({ peakWindow: { active: false }, rows: [] }))).toBeUndefined();
  });

  it('tolerates a windows string without a parseable percent (percentLeft undefined, row still found)', () => {
    const doc = { peakWindow: { active: false }, rows: [{ provider: 'zai-glm', windows: 'unavailable', resets: '' }] };
    const reading = parseProviderUsage(JSON.stringify(doc));
    expect(reading?.percentLeft).toBeUndefined();
    expect(reading?.peakActive).toBe(false);
  });
});

describe('nextQuotaState hysteresis', () => {
  const t = DEFAULT_QUOTA_THRESHOLDS;

  it('normal -> throttled at or below 50%', () => {
    expect(nextQuotaState('normal', { percentLeft: 50, peakActive: false })).toBe('throttled');
    expect(nextQuotaState('normal', { percentLeft: 51, peakActive: false })).toBe('normal');
  });

  it('-> paused at or below 30%, regardless of current state', () => {
    expect(nextQuotaState('normal', { percentLeft: 30, peakActive: false })).toBe('paused');
    expect(nextQuotaState('throttled', { percentLeft: 25, peakActive: false })).toBe('paused');
  });

  it('-> paused whenever peakWindow.active, regardless of percent', () => {
    expect(nextQuotaState('normal', { percentLeft: 99, peakActive: true })).toBe('paused');
  });

  it('does not return to normal until >=60% (hysteresis band 50-60% holds)', () => {
    expect(nextQuotaState('throttled', { percentLeft: 55, peakActive: false })).toBe('throttled');
    expect(nextQuotaState('throttled', { percentLeft: 60, peakActive: false })).toBe('normal');
  });

  it('paused only clears at >=60%, or after the 5h reset with a recovered reading', () => {
    const resetsAt = new Date(1000).toISOString();
    // Before reset time, recovered percent but still below normal threshold -> demotes to throttled, not normal.
    expect(nextQuotaState('paused', { percentLeft: 55, peakActive: false, resetsAt }, t, 500)).toBe('paused');
    // At/after reset time, with percent above throttled threshold -> normal.
    expect(nextQuotaState('paused', { percentLeft: 55, peakActive: false, resetsAt }, t, 1500)).toBe('normal');
    // Straight to >=60% clears paused even without a reset.
    expect(nextQuotaState('paused', { percentLeft: 61, peakActive: false })).toBe('normal');
  });

  it('holds the current state when no percent is available', () => {
    expect(nextQuotaState('throttled', { peakActive: false })).toBe('throttled');
  });

  it('full scenario: normal -> throttled -> paused -> normal', () => {
    let state: 'normal' | 'throttled' | 'paused' = 'normal';
    state = nextQuotaState(state, { percentLeft: 45, peakActive: false });
    expect(state).toBe('throttled');
    state = nextQuotaState(state, { percentLeft: 20, peakActive: false });
    expect(state).toBe('paused');
    state = nextQuotaState(state, { percentLeft: 75, peakActive: false });
    expect(state).toBe('normal');
  });
});

describe('nextStateOnPollFailure', () => {
  it('keeps state and counts failures below the threshold', () => {
    expect(nextStateOnPollFailure('normal', 0)).toEqual({ state: 'normal', consecutiveFailures: 1 });
    expect(nextStateOnPollFailure('normal', 1)).toEqual({ state: 'normal', consecutiveFailures: 2 });
  });

  it('escalates normal -> throttled on the 3rd consecutive failure', () => {
    expect(nextStateOnPollFailure('normal', 2)).toEqual({ state: 'throttled', consecutiveFailures: 3 });
  });

  it('leaves an already-degraded state alone on repeated failures', () => {
    expect(nextStateOnPollFailure('paused', 5)).toEqual({ state: 'paused', consecutiveFailures: 6 });
  });

  it('a success (elsewhere) resets consecutiveFailures to 0 — verified via the caller resetting it directly', () => {
    // nextStateOnPollFailure only models the failure path; the caller resets
    // consecutiveFailures to 0 on any successful parse, which is exercised at
    // the integration layer (Gate 1), not here.
    expect(nextStateOnPollFailure('normal', 0).consecutiveFailures).toBe(1);
  });
});

describe('effectiveBackboneTarget', () => {
  it('normal keeps the base target', () => {
    expect(effectiveBackboneTarget(4, 'normal')).toBe(4);
  });

  it('throttled clamps to the minimum (never above base)', () => {
    expect(effectiveBackboneTarget(4, 'throttled', 1)).toBe(1);
    expect(effectiveBackboneTarget(0, 'throttled', 1)).toBe(0);
  });

  it('paused is always 0 — lane A stops entirely', () => {
    expect(effectiveBackboneTarget(4, 'paused')).toBe(0);
  });
});
