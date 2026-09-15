import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLaneFloorCoordinator,
  type LaneFloorCoordinator,
} from '../../../../src/components/DriveMode/voiceLanes';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { clearBrowserDiagnostics, getRecentBrowserEvents } from '../../../../src/lib/browserDiagnostics';

/**
 * ONE FLOOR ACROSS LANES (multi-lane work, 2026-09-15; MULTILANE-DESIGN §4.4).
 *
 * All lanes live in ONE page, so there is exactly one arbiter and one
 * operator floor. The coordinator is the single writer of the arbiter's
 * floor signal: no lane's unmount or capture change may clobber another
 * lane's floor. Capture handoff keeps at most one lane capturing. Speech
 * attribution maps an arbiter intent id back to its lane (§4.2: the strip
 * shows which lane is talking). Every scheduling decision stays observable
 * in the browser diagnostic ring.
 */

const LANE_A = '/pi/worker-a.jsonl';
const LANE_B = '/pi/worker-b.jsonl';

function makeBlockedPlayer(): ArbiterPlayer {
  return {
    playChunk: () => new Promise<void>(() => {}),
    setVolume: () => {},
    stopCurrent: () => {},
  };
}

let coordinator: LaneFloorCoordinator;

beforeEach(() => {
  speechArbiter.stopAll();
  speechArbiter.attachPlayer(makeBlockedPlayer());
  clearBrowserDiagnostics();
  coordinator = createLaneFloorCoordinator(speechArbiter);
});

afterEach(() => {
  coordinator.dispose();
  speechArbiter.stopAll();
});

describe('lane floor — one writer for the operator floor', () => {
  it('one lane capturing holds the arbiter floor — the single-lane signal, unchanged', () => {
    coordinator.registerLane(LANE_A);
    coordinator.setLaneCapture(LANE_A, true);
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);
    coordinator.setLaneCapture(LANE_A, false);
    expect(speechArbiter.isOperatorSpeaking()).toBe(false);
  });

  it('a lane going idle or unmounting never releases ANOTHER lane\'s floor', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    coordinator.setLaneCapture(LANE_A, true);
    // Lane B's effect cycle (mount/unmount/idle) writes false for itself…
    coordinator.setLaneCapture(LANE_B, false);
    coordinator.unregisterLane(LANE_B);
    // …and lane A's floor survives — today's per-instance cleanup clobbers it.
    expect(speechArbiter.isOperatorSpeaking()).toBe(true);
    expect(coordinator.capturingLaneId()).toBe(LANE_A);
  });

  it('at most one lane captures; the second capture after a handoff is the new owner', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    coordinator.setLaneCapture(LANE_A, true);
    expect(coordinator.isAnyCapturing()).toBe(true);
    coordinator.setLaneCapture(LANE_A, false);
    coordinator.setLaneCapture(LANE_B, true);
    expect(coordinator.capturingLaneId()).toBe(LANE_B);
  });
});

describe('lane floor — capture handoff (the operator addresses another lane)', () => {
  it('finaliseCapture commands one named lane to stop (closing a capturing lane)', () => {
    coordinator.registerLane(LANE_A);
    const stopA = vi.fn();
    coordinator.setCaptureControls(LANE_A, { stopCapture: stopA });
    coordinator.setLaneCapture(LANE_A, true);
    expect(coordinator.finaliseCapture(LANE_A)).toBe(true);
    expect(stopA).toHaveBeenCalledTimes(1);
    // A lane with no controls registered still reports honestly.
    coordinator.registerLane(LANE_B);
    expect(coordinator.finaliseCapture(LANE_B)).toBe(false);
  });

  it('taking the mic on another lane stops the current lane\'s capture first', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    const stopA = vi.fn();
    coordinator.setCaptureControls(LANE_A, { stopCapture: stopA });

    coordinator.setLaneCapture(LANE_A, true);
    const stopped = coordinator.yieldFloorTo(LANE_B);

    expect(stopped).toBe(true);
    expect(stopA).toHaveBeenCalledTimes(1);
  });

  it('taking the mic with nobody capturing stops nothing and reports it', () => {
    coordinator.registerLane(LANE_B);
    expect(coordinator.yieldFloorTo(LANE_B)).toBe(false);
  });

  it('unregistering a capturing lane releases the floor entirely', () => {
    coordinator.registerLane(LANE_A);
    coordinator.setLaneCapture(LANE_A, true);
    coordinator.unregisterLane(LANE_A);
    expect(speechArbiter.isOperatorSpeaking()).toBe(false);
    expect(coordinator.capturingLaneId()).toBeNull();
  });
});

describe('lane floor — cross-lane queueing: tier, then waiting-time fairness (§4.4 rule 3)', () => {
  /** A player whose chunks resolve only when the test advances the boundary. */
  let advance: () => void;
  beforeEach(() => {
    const resolvers: Array<() => void> = [];
    advance = () => {
      while (resolvers.length) resolvers.shift()?.();
    };
    speechArbiter.attachPlayer({
      playChunk: () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
      setVolume: () => {},
      stopCurrent: () => advance(),
    });
  });

  it('two lanes wanting the floor at the same tier: the one that waited longest speaks first', async () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    // Two answers (same tier) from DIFFERENT lanes, B first.
    speechArbiter.submit({ id: `answer-${LANE_B}`, tier: 3, text: 'B first.' });
    speechArbiter.submit({ id: `answer-${LANE_A}`, tier: 3, text: 'A waits.' });
    // The shared arbiter orders by tier then arrival — arrival order IS
    // waiting-time fairness; nothing overlaps and nothing is dropped.
    await Promise.resolve();
    await Promise.resolve();
    expect(speechArbiter.getState().current?.id).toBe(`answer-${LANE_B}`);
    expect(coordinator.laneOfSpeechIntent()).toBe(LANE_B);
  });

  it('a higher tier from another lane preempts at the chunk boundary — never mid-word', async () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    speechArbiter.submit({ id: `chat-${LANE_A}-9`, tier: 4, text: 'A chatter. More chatter.' });
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.laneOfSpeechIntent()).toBe(LANE_A);
    // Another lane's tier-2 receipt queues; the in-flight chunk still finishes…
    speechArbiter.submit({ id: `receipt-${LANE_B}`, tier: 2, text: 'Noted.' });
    expect(speechArbiter.getState().current?.id).toBe(`chat-${LANE_A}-9`);
    // …and at the boundary the receipt takes over.
    advance();
    await Promise.resolve();
    await Promise.resolve();
    expect(speechArbiter.getState().current?.id).toBe(`receipt-${LANE_B}`);
    expect(coordinator.laneOfSpeechIntent()).toBe(LANE_B);
  });
});

describe('lane floor — which lane is talking (§4.2 strip attribution)', () => {
  it('maps an arbiter intent id to its lane by the session-scoped id prefix', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    speechArbiter.submit({ id: `receipt-${LANE_B}`, tier: 2, text: 'Noted.' });
    expect(coordinator.laneOfSpeechIntent()).toBe(LANE_B);
  });

  it('an intent belonging to no lane (a plain read-aloud) attributes to none', () => {
    coordinator.registerLane(LANE_A);
    speechArbiter.submit({ id: 'answer-auto-0', tier: 3, text: 'Reading.' });
    expect(coordinator.laneOfSpeechIntent()).toBeNull();
  });

  it('an answer from another lane queues behind a live capture — never over it (§4.4 rule 1)', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    coordinator.setLaneCapture(LANE_A, true); // capture in ANY lane gates speech
    const outcome = speechArbiter.submit({ id: `answer-${LANE_B}`, tier: 3, text: 'Worker B speaks.' });
    expect(outcome).toBe('queued');
    expect(speechArbiter.getState().playing).toBe(false);
  });

  it('chatter from another lane is dropped under a capture — the frozen rule 4, unchanged', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    coordinator.setLaneCapture(LANE_A, true);
    const outcome = speechArbiter.submit({ id: `chat-${LANE_B}-5`, tier: 4, text: 'Worker B chatter.' });
    expect(outcome).toBe('dropped');
    expect(speechArbiter.getState().playing).toBe(false);
  });
});

describe('lane floor — observable in the diagnostic ring', () => {
  it('records capture and handoff decisions without session ids', () => {
    coordinator.registerLane(LANE_A);
    coordinator.registerLane(LANE_B);
    coordinator.setCaptureControls(LANE_A, { stopCapture: vi.fn() });
    coordinator.setLaneCapture(LANE_A, true);
    coordinator.yieldFloorTo(LANE_B);
    coordinator.setLaneCapture(LANE_A, false);

    const operations = getRecentBrowserEvents(20).map((e) => e.operation);
    expect(operations).toContain('lane_floor_held');
    expect(operations).toContain('lane_floor_released');
    expect(operations).toContain('lane_capture_handoff');
    // Privacy rule of the bundle: no worker session ids in diagnostics.
    const ring = JSON.stringify(getRecentBrowserEvents(20));
    expect(ring).not.toContain(LANE_A);
    expect(ring).not.toContain(LANE_B);
  });
});
