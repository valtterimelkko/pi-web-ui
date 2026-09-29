import { describe, it, expect, vi } from 'vitest';
import { wireWebSocketDrainFence } from '../../../src/websocket/connection.js';

/**
 * B4.1 correction 02 (finding 1): the browser prompt fence must be installed
 * as a STABLE LATE-BOUND accessor.
 *
 * The pre-correction wiring read `internalApiServer?.getDrainFence()` inside a
 * `queueMicrotask` that ran before the server's drain controller existed —
 * `getDrainFence()` returned null and `wsManager.drainFence` was NEVER set, so
 * no browser prompt was ever fenced. The wiring installs once and resolves the
 * live server on every call, so startup order and an Internal API restart
 * cannot leave a stale or missing fence.
 */

interface FenceState {
  active: boolean;
  retryAfterSeconds: number;
}

function makeHarness() {
  let server: { getDrainFence?: () => (() => FenceState) | null } | null | undefined;
  const target: { drainFence?: () => FenceState } = {};
  wireWebSocketDrainFence(target, () => server);
  return {
    target,
    setServer(next: { getDrainFence?: () => (() => FenceState) | null } | null | undefined) { server = next; },
  };
}

describe('wireWebSocketDrainFence (correction 02 — late-bound installation)', () => {
  it('is inactive before the Internal API server exists (wiring may run first)', () => {
    const { target, setServer } = makeHarness();
    setServer(undefined);
    expect(target.drainFence).toBeDefined();
    expect(target.drainFence?.()).toEqual({ active: false, retryAfterSeconds: 30 });
    setServer(null);
    expect(target.drainFence?.()).toEqual({ active: false, retryAfterSeconds: 30 });
  });

  it('is inactive while the server exists but its drain controller is not built yet (the bug shape)', () => {
    const { target, setServer } = makeHarness();
    // InternalApiServer.getDrainFence() returns null until start() built the
    // controller — the exact moment the pre-correction microtask read it.
    setServer({ getDrainFence: () => null });
    expect(target.drainFence?.()).toEqual({ active: false, retryAfterSeconds: 30 });
  });

  it('reads the LIVE controller once start() built it, with its live values', () => {
    const { target, setServer } = makeHarness();
    let verdict: FenceState = { active: true, retryAfterSeconds: 45 };
    setServer({ getDrainFence: () => () => verdict });
    expect(target.drainFence?.()).toEqual({ active: true, retryAfterSeconds: 45 });
    // The fence is late-bound: the same installed accessor reflects the
    // controller's CURRENT verdict on the next call.
    verdict = { active: false, retryAfterSeconds: 30 };
    expect(target.drainFence?.()).toEqual({ active: false, retryAfterSeconds: 30 });
  });

  it('never goes stale across an Internal API restart (a new server instance is read)', () => {
    const { target, setServer } = makeHarness();
    setServer({ getDrainFence: () => () => ({ active: true, retryAfterSeconds: 30 }) });
    expect(target.drainFence?.()?.active).toBe(true);
    // The old server is gone; a fresh one answers.
    setServer({ getDrainFence: () => () => ({ active: false, retryAfterSeconds: 30 }) });
    expect(target.drainFence?.()?.active).toBe(false);
  });

  it('is installed exactly once and never throws when the resolver throws', () => {
    const target: { drainFence?: () => FenceState } = {};
    wireWebSocketDrainFence(target, () => { throw new Error('boom'); });
    expect(() => target.drainFence?.()).not.toThrow();
  });
});
