import { describe, expect, it } from 'vitest';
import { createRuntimeQuiescencePredicate, type RuntimeQuiescencePredicateDeps } from '../../../src/internal-api/server.js';
import { DeletedSessionCessation } from '../../../src/internal-api/run-receipts/deletion-cessation.js';

/**
 * Correction 02 (Luna r2, finding 2 remainder): the deletion tracker must be
 * consulted FIRST in the server's quiescence callback — before any
 * `!service.isRunning()` truth — because abort-only runtimes (OpenCode among
 * them) flip `isRunning()` to false before remote cessation is acknowledged,
 * and the DELETE window (abort → registry removal) must hold through the
 * tracker's grace. These tests drive the REAL exported predicate factory, not
 * a copy of its ordering.
 */
describe('server quiescence callback ordering (correction 02)', () => {
  let now: number;
  let tracker: DeletedSessionCessation;
  let registryEntry: { sdkType: string; path: string } | undefined;
  let opencodeRunning: boolean;
  let deps: RuntimeQuiescencePredicateDeps;

  const make = (): (sessionId: string) => Promise<boolean> => {
    now = Date.parse('2026-10-03T16:00:00.000Z');
    tracker = new DeletedSessionCessation({ now: () => now, graceMs: 60_000, log: () => undefined });
    registryEntry = { sdkType: 'opencode', path: 'session-1' };
    opencodeRunning = true;
    deps = {
      deletedSessionCessation: tracker,
      commandCodeService: undefined,
      sessionRegistry: { get: async () => registryEntry },
      claudeService: { isRunning: () => false },
      opencodeService: { isRunning: () => opencodeRunning },
      antigravityService: { isRunning: () => false },
      readPiStatus: () => undefined,
    };
    return createRuntimeQuiescencePredicate(deps);
  };

  it('a DELETE of an abort-only session with a quarantined run is not released while the entry exists and isRunning() already flipped false; it waits for the grace', async () => {
    const isQuiescent = make();
    await expect(isQuiescent('session-1')).resolves.toBe(false); // mid-turn: running

    // DELETE begins: the route records the deletion BEFORE abort; OpenCode's
    // abort clears isRunning() immediately while the remote abort is still
    // in flight — the registry entry still exists.
    tracker.record('session-1', 'opencode', false);
    opencodeRunning = false;
    await expect(isQuiescent('session-1')).resolves.toBe(false); // tracker decides — NOT the flipped isRunning()

    now += 61_000; // past the 60 s grace
    await expect(isQuiescent('session-1')).resolves.toBe(true); // grace-release
  });

  it('without a deletion record the found-entry branches behave as before', async () => {
    const isQuiescent = make();
    // OpenCode idle, never deleted → quiescent (existing truth preserved).
    opencodeRunning = false;
    await expect(isQuiescent('session-1')).resolves.toBe(true);
  });

  it('a missing entry consults the tracker and fails closed when never recorded', async () => {
    const isQuiescent = make();
    registryEntry = undefined;
    await expect(isQuiescent('session-1')).resolves.toBe(false); // never recorded → fail closed
    tracker.record('session-1', 'claude', true); // awaited ack (pi/commandcode shape)
    await expect(isQuiescent('session-1')).resolves.toBe(true);
  });

  it('a recorded deletion gates before the pi branch too (stale streaming cannot leak a delete)', async () => {
    const isQuiescent = make();
    registryEntry = { sdkType: 'pi', path: 'session-1' };
    tracker.record('session-1', 'pi', false); // pi recorded but NOT yet acked in this scenario
    deps.readPiStatus = () => ({ status: 'idle' }); // manager idle…
    await expect(isQuiescent('session-1')).resolves.toBe(false); // …but the recorded deletion holds the grace
  });
});
