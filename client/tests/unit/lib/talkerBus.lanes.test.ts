import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitTalkerTurnResult,
  getLastTalkerTurnResult,
  getLastTalkerTurnResultFor,
  noteTalkerRequestIssued,
  resetTalkerTurnBus,
  subscribeTalkerTurnResults,
  type TalkerTurnResult,
} from '../../../src/lib/talkerBus';

/**
 * Multi-lane correlation (lane work, 2026-09-15).
 *
 * With several voice lanes in ONE tab, every lane's hook instance subscribes
 * to the same module-level bus. Results are global and (before this work)
 * filtered only by worker session — ignoring the request id and the runtime —
 * which is exactly how lane A's card could appear in lane B, and how a late
 * result from a previous request could overwrite a newer card.
 *
 * The contract under test: carry and match on requestId PLUS lane identity
 * (worker session + runtime). A lane accepts a result only when the result
 * carries a requestId this lane issued, it has not been applied yet, and it
 * is not OLDER than the newest result already applied.
 */

const LANE_A = { workerSessionId: '/pi/worker-a.jsonl', runtime: 'pi' as const };
const LANE_B = { workerSessionId: '/pi/worker-b.jsonl', runtime: 'pi' as const };

const makeResult = (over: Record<string, unknown> = {}): TalkerTurnResult =>
  ({
    type: 'talker_turn_result',
    workerSessionId: LANE_A.workerSessionId,
    runtime: 'pi',
    reply: 'sending that now',
    phase: 'released',
    released: {
      utteranceId: 3,
      text: 'please add a smoke test',
      delivery: { outcome: 'delivered', mechanism: 'prompt' },
    },
    cancelled: false,
    ...over,
  }) as TalkerTurnResult;

describe('talkerBus lane correlation — request issuance', () => {
  beforeEach(() => resetTalkerTurnBus());

  it('issues distinct, non-empty correlation ids per send', () => {
    const r1 = noteTalkerRequestIssued(LANE_A);
    const r2 = noteTalkerRequestIssued(LANE_A);
    const r3 = noteTalkerRequestIssued(LANE_B);
    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
    expect(r3).toBeTruthy();
    expect(r1).not.toBe(r2);
    expect(r2).not.toBe(r3);
  });

  it('accepts an explicit correlation id (the hook sends it; the server echoes it)', () => {
    expect(noteTalkerRequestIssued(LANE_A, 'fixed-req-1')).toBe('fixed-req-1');
  });
});

describe('talkerBus lane correlation — which lane may apply a result', () => {
  beforeEach(() => resetTalkerTurnBus());

  it('delivers a result to its own lane only, and never to a foreign lane', () => {
    const seenByA: TalkerTurnResult[] = [];
    const seenByB: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);
    subscribeTalkerTurnResults((r) => seenByB.push(r), LANE_B);

    const reqA = noteTalkerRequestIssued(LANE_A);
    const resultA = makeResult({ requestId: reqA });
    expect(emitTalkerTurnResult(resultA)).toBe(true);

    expect(seenByA).toEqual([resultA]);
    expect(seenByB).toEqual([]);
    expect(getLastTalkerTurnResultFor(LANE_A)?.requestId).toBe(reqA);
    expect(getLastTalkerTurnResultFor(LANE_B)).toBeNull();
  });

  it('rejects a result whose requestId the lane never issued (foreign/stale replay)', () => {
    const seenByA: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);

    const foreign = makeResult({ requestId: 'never-issued-by-A' });
    expect(emitTalkerTurnResult(foreign)).toBe(true); // consumed from the wire…
    expect(seenByA).toEqual([]); // …but not applied by the lane
    expect(getLastTalkerTurnResultFor(LANE_A)).toBeNull();
    expect(getLastTalkerTurnResult()).toBeNull();
  });

  it('matches the runtime too: the same session id on another runtime is a different lane', () => {
    const seenByA: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);

    const laneClaude = { workerSessionId: LANE_A.workerSessionId, runtime: 'claude' as const };
    const reqC = noteTalkerRequestIssued(laneClaude);
    subscribeTalkerTurnResults(() => {}, laneClaude);
    const resultClaude = makeResult({ requestId: reqC, runtime: 'claude' });
    expect(emitTalkerTurnResult(resultClaude)).toBe(true);

    expect(seenByA).toEqual([]);
    expect(getLastTalkerTurnResultFor(LANE_A)).toBeNull();
    expect(getLastTalkerTurnResultFor(laneClaude)?.requestId).toBe(reqC);
  });

  it('a lane with no runtime filter still matches by normalised runtime (server default is pi)', () => {
    // A caller that omitted runtime (the server default 'pi') and a result
    // that names 'pi' are the same lane.
    const seen: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seen.push(r), { workerSessionId: LANE_A.workerSessionId });
    const req = noteTalkerRequestIssued({ workerSessionId: LANE_A.workerSessionId });
    const result = makeResult({ requestId: req, runtime: 'pi' });
    expect(emitTalkerTurnResult(result)).toBe(true);
    expect(seen).toEqual([result]);
  });
});

describe('talkerBus lane correlation — staleness and duplicates', () => {
  beforeEach(() => resetTalkerTurnBus());

  it('never applies the same requestId twice (duplicate delivery)', () => {
    const seenByA: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);
    const req = noteTalkerRequestIssued(LANE_A);
    const result = makeResult({ requestId: req, reply: 'first' });

    expect(emitTalkerTurnResult(result)).toBe(true);
    expect(emitTalkerTurnResult({ ...result, reply: 'duplicate' })).toBe(true);

    expect(seenByA).toEqual([result]);
    expect(getLastTalkerTurnResultFor(LANE_A)?.reply).toBe('first');
  });

  it('a late result from a PREVIOUS request never overwrites a newer card (out-of-order)', () => {
    const seenByA: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);
    const r1 = noteTalkerRequestIssued(LANE_A);
    const r2 = noteTalkerRequestIssued(LANE_A);

    // The newer turn's answer lands first…
    const newer = makeResult({ requestId: r2, reply: 'newer card', phase: 'proposed', released: null });
    expect(emitTalkerTurnResult(newer)).toBe(true);
    // …then the OLDER request's result straggles in.
    const older = makeResult({ requestId: r1, reply: 'stale card' });
    expect(emitTalkerTurnResult(older)).toBe(true);

    expect(seenByA).toEqual([newer]);
    expect(getLastTalkerTurnResultFor(LANE_A)?.reply).toBe('newer card');
  });

  it('an in-order sequence still applies every turn (no false staleness)', () => {
    const seenByA: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);
    const r1 = noteTalkerRequestIssued(LANE_A);
    const r2 = noteTalkerRequestIssued(LANE_A);

    const first = makeResult({ requestId: r1, reply: 'first' });
    const second = makeResult({ requestId: r2, reply: 'second' });
    expect(emitTalkerTurnResult(first)).toBe(true);
    expect(emitTalkerTurnResult(second)).toBe(true);
    expect(seenByA.map((r) => r.reply)).toEqual(['first', 'second']);
  });

  it('a legacy result without a requestId is accepted while the lane has nothing in flight', () => {
    const seenByA: TalkerTurnResult[] = [];
    subscribeTalkerTurnResults((r) => seenByA.push(r), LANE_A);
    const legacy = makeResult({ requestId: undefined });
    expect(emitTalkerTurnResult(legacy)).toBe(true);
    expect(seenByA).toEqual([legacy]);
    expect(getLastTalkerTurnResultFor(LANE_A)?.reply).toBe('sending that now');
  });

  it('a legacy result is NOT applied while an issued request is still awaiting its echo', () => {
    subscribeTalkerTurnResults(() => {}, LANE_A);
    noteTalkerRequestIssued(LANE_A); // in flight — its echo has not arrived
    const legacy = makeResult({ requestId: undefined, reply: 'un attributable' });
    emitTalkerTurnResult(legacy);
    expect(getLastTalkerTurnResultFor(LANE_A)).toBeNull();
  });

  it('a legacy result never overwrites an id-correlated card', () => {
    subscribeTalkerTurnResults(() => {}, LANE_A);
    const req = noteTalkerRequestIssued(LANE_A);
    emitTalkerTurnResult(makeResult({ requestId: req, reply: 'correlated' }));
    emitTalkerTurnResult(makeResult({ requestId: undefined, reply: 'legacy straggler' }));
    expect(getLastTalkerTurnResultFor(LANE_A)?.reply).toBe('correlated');
  });

  it('resetTalkerTurnBus clears lane records: a fresh lane accepts again', () => {
    const req = noteTalkerRequestIssued(LANE_A);
    emitTalkerTurnResult(makeResult({ requestId: req }));
    resetTalkerTurnBus();
    // A new bus: the old id is unknown again…
    expect(emitTalkerTurnResult(makeResult({ requestId: req, reply: 'after reset' }))).toBe(true);
    // …and rejected as foreign, because nothing was issued on the fresh bus.
    expect(getLastTalkerTurnResultFor(LANE_A)).toBeNull();
  });
});
