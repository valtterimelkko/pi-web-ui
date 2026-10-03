import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeletedSessionCessation } from '../../../src/internal-api/run-receipts/deletion-cessation.js';

/**
 * Correction 01 (Luna r1 finding 2): a missing registry entry — or
 * `isRunning() === false` straight after a DELETE — is not positive cessation
 * evidence for runtimes whose deletion does not await termination (Claude,
 * OpenCode, Antigravity). The deletion tracker gates the missing-session
 * branch of the quiescence wiring:
 *   - positive cessation needs either an awaited per-runtime termination
 *     acknowledgement (Pi's awaited dispose, Command Code's awaited delete),
 *   - or a bounded grace (default 15 min) after the deletion was observed,
 *     released exactly once with a `grace-release` log naming the runtime.
 */
describe('DeletedSessionCessation (correction 01)', () => {
  let now: number;
  let logLines: string[];
  let tracker: DeletedSessionCessation;

  const make = (graceMs = 15 * 60_000): void => {
    now = Date.parse('2026-10-03T15:00:00.000Z');
    logLines = [];
    tracker = new DeletedSessionCessation({ now: () => now, graceMs, log: (l) => logLines.push(l) });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats an awaited termination ack (Pi dispose, Command Code delete) as immediately quiescent', () => {
    make();
    tracker.record('pi-1', 'pi', true);
    expect(tracker.isQuiescent('pi-1')).toBe(true);
    tracker.record('cc-1', 'commandcode', true);
    expect(tracker.isQuiescent('cc-1')).toBe(true);
    expect(logLines.filter((l) => l.includes('grace-release'))).toEqual([]);
  });

  it('holds a non-awaiting runtime (Claude) until the grace elapses, then releases exactly once with a grace-release log naming the runtime', () => {
    make();
    tracker.record('claude-1', 'claude', false);
    expect(tracker.isQuiescent('claude-1')).toBe(false);
    now += 5 * 60_000;
    expect(tracker.isQuiescent('claude-1')).toBe(false); // inside the 15 min grace
    now += 10 * 60_000 + 1;
    expect(tracker.isQuiescent('claude-1')).toBe(true); // grace elapsed
    expect(tracker.isQuiescent('claude-1')).toBe(true); // repeated checks…
    const graceLines = logLines.filter((l) => l.includes('grace-release'));
    expect(graceLines.length).toBe(1); // …log exactly once
    expect(graceLines[0]).toMatch(/runtime=claude/);
    expect(graceLines[0]).toMatch(/claude-1/);
  });

  it('fails closed for a missing session that was never observed deleted', () => {
    make();
    expect(tracker.isQuiescent('never-seen')).toBe(false);
  });

  it('re-recording a session (delete then re-create then delete) restarts the grace', () => {
    make();
    tracker.record('agy-1', 'antigravity', false);
    now += 14 * 60_000;
    tracker.record('agy-1', 'antigravity', false); // re-created and deleted again
    now += 60_000; // 15 min since the FIRST delete, 1 min since the second
    expect(tracker.isQuiescent('agy-1')).toBe(false); // grace restarted
    now += 14 * 60_000 + 1; // now 15 min + 1 ms since the SECOND delete
    expect(tracker.isQuiescent('agy-1')).toBe(true);
  });

  it('does not log a grace release for an acked runtime when re-checked', () => {
    make();
    tracker.record('pi-2', 'pi', true);
    expect(tracker.isQuiescent('pi-2')).toBe(true);
    expect(tracker.isQuiescent('pi-2')).toBe(true);
    expect(logLines).toEqual([]);
  });

  // Correction 02 (Luna r2 new finding 1): the tracker is process-lifetime and
  // every delete records — records must be RETIRED once no active or draining
  // receipt can still consult them (and any required grace has elapsed), or
  // routine child cleanup grows the map for the server's whole lifetime.
  describe('record retirement (correction 02)', () => {
    it('retires acked deletes at once when no receipt can consult them (100 acked deletes → 0 records)', () => {
      make();
      const unowned = new DeletedSessionCessation({
        now: () => now,
        graceMs: 15 * 60_000,
        log: (l) => logLines.push(l),
        hasConsultant: () => false, // no non-terminal receipt, no draining/quarantined entry
      });
      for (let i = 0; i < 100; i += 1) unowned.record(`deleted-${i}`, 'pi', true);
      expect(unowned.retainedCount()).toBe(0);
      expect(unowned.has('deleted-0')).toBe(false);
      expect(unowned.has('deleted-99')).toBe(false);
    });

    it('keeps an acked record while a receipt can still consult it, retires it when the consultant clears', () => {
      make();
      let consultant = true;
      const t = new DeletedSessionCessation({
        now: () => now,
        graceMs: 15 * 60_000,
        log: (l) => logLines.push(l),
        hasConsultant: () => consultant,
      });
      t.record('pi-live', 'pi', true);
      expect(t.isQuiescent('pi-live')).toBe(true); // releases the quarantined run
      expect(t.has('pi-live')).toBe(true); // a second run of the same session may still consult
      consultant = false; // the last quarantined/draining run released
      expect(t.isQuiescent('pi-live')).toBe(true); // answers once more…
      expect(t.has('pi-live')).toBe(false); // …and the record is gone
    });

    it('keeps a grace-pending record until its release, then removes it after the release', () => {
      make();
      let consultant = true;
      const t = new DeletedSessionCessation({
        now: () => now,
        graceMs: 60_000,
        log: (l) => logLines.push(l),
        hasConsultant: () => consultant,
      });
      t.record('claude-g', 'claude', false);
      now += 30_000;
      expect(t.isQuiescent('claude-g')).toBe(false); // inside the grace
      expect(t.has('claude-g')).toBe(true); // survives: a receipt can still consult it
      now += 31_000;
      expect(t.isQuiescent('claude-g')).toBe(true); // grace-release
      expect(t.has('claude-g')).toBe(true); // the consultant (quarantined run) has not released yet
      consultant = false;
      expect(t.isQuiescent('claude-g')).toBe(true); // answers…
      expect(t.has('claude-g')).toBe(false); // …and the record is retired after the release
      expect(logLines.filter((l) => l.includes('grace-release')).length).toBe(1); // logged exactly once
    });

    it('retires an unacked record once the grace has elapsed and no receipt can consult it (answer stays a release, logged once)', () => {
      make();
      const unowned = new DeletedSessionCessation({
        now: () => now,
        graceMs: 60_000,
        log: (l) => logLines.push(l),
        hasConsultant: () => false,
      });
      unowned.record('claude-x', 'claude', false);
      now += 30_000;
      expect(unowned.isQuiescent('claude-x')).toBe(false); // inside the grace: held, record kept
      now += 31_000;
      expect(unowned.isQuiescent('claude-x')).toBe(true); // past the grace: a release decision
      expect(unowned.has('claude-x')).toBe(false); // retired: no receipt can consult it any more
      expect(unowned.isQuiescent('claude-x')).toBe(false); // retired records fail closed (never re-release)
      expect(logLines.filter((l) => l.includes('grace-release')).length).toBe(1);
    });
  });
});
