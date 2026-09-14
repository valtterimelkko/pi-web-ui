import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceTurn } from '../../../../src/components/DriveMode/useVoiceTurn';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import {
  speechArbiter,
  TIER_ANSWER,
  TIER_CHATTER,
  TIER_RECEIPT_ACK,
  type ArbiterPlayer,
} from '../../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../../src/lib/spokenLedger';

/**
 * P18 package C, deliverable 3 — the tier-4 split.
 *
 * A reply to a question the operator just asked is not chatter: it is the
 * conversation, and it must hold its ground. An unprompted reaction (a
 * "shall I send that?" after an instruction, a transition line) stays at the
 * bottom of the ladder, where it is dropped rather than deferring anything
 * that matters.
 *
 * `speechArbiter.ts` is read-only here: the split is expressed by choosing the
 * existing tiers correctly, not by adding one. TIER_ANSWER (3) keeps its
 * meaning — the answer — and TIER_CHATTER (4) keeps its.
 */

const sendMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock })),
}));

const WORKER = '/pi/worker.jsonl';

function makeBlockedPlayer() {
  const played: string[] = [];
  const resolvers: Array<() => void> = [];
  const player: ArbiterPlayer = {
    playChunk: (chunk: string) => {
      played.push(chunk);
      return new Promise<void>((resolve) => {
        resolvers.push(resolve);
      });
    },
    setVolume: () => {},
    stopCurrent: () => {
      while (resolvers.length) resolvers.shift()?.();
    },
  };
  const drain = () => {
    while (resolvers.length) resolvers.shift()?.();
  };
  return { player, played, drain };
}

function emit(over: Record<string, unknown>) {
  return emitTalkerTurnResult({
    type: 'talker_turn_result',
    workerSessionId: WORKER,
    runtime: 'pi',
    reply: '',
    phase: 'answered',
    released: null,
    cancelled: false,
    ...over,
  });
}

describe('P18/3 — an elicited reply is the conversation; unprompted commentary is not', () => {
  let fake: ReturnType<typeof makeBlockedPlayer>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTalkerTurnBus();
    sendMock.mockReturnValue('sent');
    spokenLedger.clear();
    speechArbiter.stopAll();
    fake = makeBlockedPlayer();
    speechArbiter.attachPlayer(fake.player);
  });

  afterEach(() => {
    speechArbiter.stopAll();
    fake.drain();
  });

  it('a reply to the operator’s question speaks at TIER_ANSWER (3), not as chatter', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('what did the worker find about the retry bug?');
    });
    act(() => {
      emit({
        reply: 'I cannot tell from what I hold — shall I ask the worker?',
        phase: 'answered',
        utteranceClass: 'question',
      });
    });
    expect(speechArbiter.getState().current?.tier).toBe(TIER_ANSWER);
    expect(fake.played[0]).toBe('I cannot tell from what I hold — shall I ask the worker?');
  });

  it('an unprompted reaction to an instruction stays at TIER_CHATTER (4)', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('tell the worker to rebase');
    });
    act(() => {
      emit({
        reply: 'Shall I send that to the worker?',
        phase: 'proposed',
        utteranceClass: 'statement',
      });
    });
    expect(speechArbiter.getState().current?.tier).toBe(TIER_CHATTER);
  });

  it('when both compete, the elicited reply holds its ground and the chatter is the one dropped', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    // The operator is owed an answer at tier 3 already in flight…
    act(() => {
      speechArbiter.submit({ id: 'worker-answer', tier: TIER_ANSWER, text: 'The worker finished the migration.' });
    });
    // …an unprompted line arriving now would defer that answer, so it is dropped…
    act(() => {
      result.current.sendText('tell the worker to rebase');
    });
    act(() => {
      emit({ reply: 'Shall I send that to the worker?', phase: 'proposed', utteranceClass: 'statement' });
    });
    expect(fake.played).not.toContain('Shall I send that to the worker?');
    expect(speechArbiter.getState().queued.some((q) => q.tier === TIER_CHATTER)).toBe(false);

    // …while the answer to the question the operator just asked is QUEUED
    // behind the answer in flight, never dropped.
    act(() => {
      result.current.sendText('and what about the schema?');
    });
    act(() => {
      emit({ reply: 'The schema change is staged, not applied.', phase: 'answered', utteranceClass: 'question' });
    });
    const queued = speechArbiter.getState().queued;
    expect(queued.some((q) => q.tier === TIER_ANSWER)).toBe(true);
  });

  it('the mechanical acks keep their own tier-2 slot — the split moves nothing else', async () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('tell the worker to rebase');
    });
    act(() => {
      emit({ reply: 'Noted.', phase: 'proposed', utteranceClass: 'statement' });
    });
    expect(speechArbiter.getState().current?.tier).toBe(TIER_CHATTER);

    act(() => {
      emit({
        reply: 'sending that now',
        phase: 'released',
        utteranceClass: 'confirm',
        released: { utteranceId: 1, text: 'tell the worker to rebase', delivery: { outcome: 'delivered', mechanism: 'steer' } },
      });
    });
    // The ack preempts at a CHUNK BOUNDARY, never mid-word (frozen ladder).
    await act(async () => {
      fake.drain();
    });
    expect(speechArbiter.getState().current?.tier).toBe(TIER_RECEIPT_ACK);
  });

  it('a result without a class (older server) falls back to chatter, never to a guess', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('how is it going?');
    });
    act(() => {
      emit({ reply: 'Still running.', phase: 'answered' });
    });
    expect(speechArbiter.getState().current?.tier).toBe(TIER_CHATTER);
  });

  it('an OFFER turn surfaces the operator’s own question in the confirmation card, and speaks at the answer tier', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    const QUESTION = 'what did the worker find about the retry bug in the March refactor?';
    act(() => {
      result.current.sendText(QUESTION);
    });
    act(() => {
      emit({
        reply: 'I can’t tell from what I hold — shall I ask the worker?',
        phase: 'proposed',
        utteranceClass: 'question',
      });
    });
    // The candidate the confirmation would release is the operator's question
    // — never the model's wording of it (the server holds the same text by id).
    expect(result.current.pendingProposal?.text).toBe(QUESTION);
    expect(speechArbiter.getState().current?.tier).toBe(TIER_ANSWER);
  });
});
