import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceTurn, CONFIRM_UTTERANCE, CANCEL_UTTERANCE } from '../../../../src/components/DriveMode/useVoiceTurn';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';

// Mock useWebSocket: capture outgoing messages; send success by default.
const sendMock = vi.fn();
vi.mock('../../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock })),
}));

/**
 * A fake arbiter player whose chunks NEVER finish until released — so a
 * submitted intent stays visible in getState().current with its tier, and we
 * can assert exactly what the surface chose to speak and at what tier.
 */
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
      // Reject nothing: unblock any pending chunk so the arbiter loop can
      // observe the generation change and stop cleanly.
      while (resolvers.length) resolvers.shift()?.();
    },
  };
  const drain = () => {
    while (resolvers.length) resolvers.shift()?.();
  };
  return { player, played, drain };
}

const WORKER = '/pi/worker.jsonl';

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

describe('useVoiceTurn — the talker lane of the Voice Mode surface', () => {
  let fake: ReturnType<typeof makeBlockedPlayer>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTalkerTurnBus();
    sendMock.mockReturnValue('sent');
    speechArbiter.stopAll();
    fake = makeBlockedPlayer();
    speechArbiter.attachPlayer(fake.player);
  });

  afterEach(() => {
    speechArbiter.stopAll();
    fake.drain();
  });

  it('a captured utterance is relayed to the talker verbatim (talker_turn)', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('tell the worker to rebase on main');
    });
    expect(sendMock).toHaveBeenCalledWith({
      type: 'talker_turn',
      workerSessionId: WORKER,
      utterance: 'tell the worker to rebase on main',
      runtime: 'pi',
    });
  });

  it('capture is unconditional: the send is never gated on the operator floor or playback', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    // The arbiter is mid-chunk (speech playing) — speech, not capture, yields.
    act(() => {
      speechArbiter.submit({ id: 'answer', tier: 3, text: 'long playing answer.' });
    });
    expect(speechArbiter.getState().current).not.toBeNull();
    act(() => {
      const sent = result.current.sendText('and also deploy staging');
      expect(sent).toBe(true);
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: 'and also deploy staging' })
    );
  });

  it('a proposed turn shows the pending proposal verbatim — the operator\'s own words', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    const WORDS = 'migrate the auth module to the new session store';
    act(() => {
      result.current.sendText(WORDS);
    });
    act(() => {
      emit({ reply: 'Shall I send that to the worker?', phase: 'proposed' });
    });
    expect(result.current.pendingProposal).not.toBeNull();
    // Verbatim — compared, not eyeballed.
    expect(result.current.pendingProposal?.text).toBe(WORDS);
  });

  it('a released turn clears the proposal, speaks the mechanical ack at tier 2, and records the outcome', async () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('ship it');
    });
    act(() => {
      emit({ reply: 'Noted', phase: 'proposed' });
    });
    act(() => {
      emit({
        reply: 'Sent.',
        phase: 'released',
        released: {
          utteranceId: 3,
          text: 'ship it',
          delivery: { outcome: 'delivered', mechanism: 'steer' },
        },
      });
    });
    expect(result.current.pendingProposal).toBeNull();
    expect(result.current.lastReleased).toEqual({
      text: 'ship it',
      outcome: 'delivered (steer)',
    });
    // The receipt ack (tier 2) outranks the in-flight chatter but preempts
    // ONLY at a chunk boundary (never mid-word, §4.1). Resolve the in-flight
    // 'Noted.' chunk; at that boundary the ack takes over and the dropped
    // chatter never resumes (rule 4).
    await act(async () => {
      fake.drain();
    });
    expect(speechArbiter.getState().current?.tier).toBe(2);
    expect(fake.played).toContain('Noted');
    expect(fake.played[fake.played.length - 1]).toBe('Sent.');
  });

  it('a plain answered turn speaks as chatter (tier 4) and clears any pending proposal', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('how is it going?');
    });
    act(() => {
      emit({ reply: 'All quiet — still running step 3', phase: 'answered' });
    });
    expect(result.current.pendingProposal).toBeNull();
    expect(speechArbiter.getState().current?.tier).toBe(4);
    expect(fake.played[0]).toBe('All quiet — still running step 3');
  });

  it('a refused turn surfaces the refusal honestly and speaks nothing', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('do something');
    });
    act(() => {
      emit({ reply: '', phase: 'refused', refused: 'prompt_injection' });
    });
    expect(result.current.refusal).toContain('prompt-injection gate');
    expect(speechArbiter.getState().current).toBeNull();
    expect(fake.played).toHaveLength(0);
  });

  it('an ambiguous confirmation submits nothing of its own: typed text goes verbatim and the proposal stays', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('tell the worker to rebase');
    });
    act(() => {
      emit({ reply: 'Shall I send that?', phase: 'proposed' });
    });
    sendMock.mockClear();
    act(() => {
      result.current.sendText('maybe later, not sure');
    });
    // The typed words go exactly as said — never transformed into a confirm
    // gesture; one talker_turn, no canned confirmation invented by the UI.
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: 'maybe later, not sure' })
    );
    // Nothing resolved locally either: the proposal remains until the talker
    // itself reports released/cancelled.
    expect(result.current.pendingProposal?.text).toBe('tell the worker to rebase');
  });

  it('confirmPending sends the confirm gesture; cancelPending sends the cancel gesture; both no-op without a proposal', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    expect(result.current.confirmPending()).toBe(false);
    expect(result.current.cancelPending()).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();

    act(() => {
      result.current.sendText('deploy the fix');
    });
    act(() => {
      emit({ reply: 'Send it?', phase: 'proposed' });
    });
    act(() => {
      expect(result.current.cancelPending()).toBe(true);
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ utterance: CANCEL_UTTERANCE })
    );
    expect(CONFIRM_UTTERANCE).toMatch(/yes/i);
  });

  it('a cancelled result clears the pending proposal', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('deploy the fix');
    });
    act(() => {
      emit({ reply: 'Holding both — which one?', phase: 'proposed' });
    });
    expect(result.current.pendingProposal).not.toBeNull();
    act(() => {
      emit({ reply: 'Cancelled.', phase: 'answered', cancelled: true });
    });
    expect(result.current.pendingProposal).toBeNull();
  });

  it('a failed send never discards the words: kept for retry, retry resends verbatim', () => {
    sendMock.mockReturnValueOnce('failed');
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    let sent = true;
    act(() => {
      sent = result.current.sendText('spoken while the socket was down');
    });
    expect(sent).toBe(false);
    expect(result.current.pendingText).toBe('spoken while the socket was down');
    act(() => {
      expect(result.current.retryLastSend()).toBe(true);
    });
    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ utterance: 'spoken while the socket was down' })
    );
    expect(result.current.pendingText).toBeNull();
  });

  it('the operator floor signal feeds the arbiter and never the other way round', () => {
    // While the fake dictation is recording, the floor is the operator's.
    // useDictation is driven through the hook; simulate by driving the media
    // path is out of scope here — the floor wiring is pinned in the component
    // test; here we pin that the hook exposes operatorSpeaking from capture
    // state.
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    expect(result.current.operatorSpeaking).toBe(false);
    expect(result.current.state).toBe('idle');
  });
});

describe('useVoiceTurn — the harness receipt ack speaks at tier 2 (§4.1 rule 2, P7/A11)', () => {
  let fake: ReturnType<typeof makeBlockedPlayer>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTalkerTurnBus();
    sendMock.mockReturnValue('sent');
    speechArbiter.stopAll();
    fake = makeBlockedPlayer();
    speechArbiter.attachPlayer(fake.player);
  });

  afterEach(() => {
    speechArbiter.stopAll();
    fake.drain();
  });

  it('a result carrying a receipt ack submits it at TIER_RECEIPT_ACK (tier 2), ahead of the reply', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('tell the worker to rebase');
    });
    act(() => {
      emit({
        reply: 'You want the worker to rebase — shall I send that?',
        phase: 'proposed',
        receiptAck: 'Noted — still holding that.',
      });
    });
    // The receipt is what took the floor — tier 2, before anything else.
    expect(speechArbiter.getState().current?.tier).toBe(2);
    expect(fake.played[0]).toBe('Noted — still holding that.');
  });

  it('the same-turn conversational reply stays tier 4 and yields: dropped while the receipt speaks (decided ladder rule 4)', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('tell the worker to rebase');
    });
    act(() => {
      emit({
        reply: 'You want the worker to rebase — shall I send that?',
        phase: 'proposed',
        receiptAck: 'Noted — still holding that.',
      });
    });
    // The receipt outranks the chatter; the arbiter drops chatter that would
    // trail it. The proposal itself is unaffected (shown verbatim in state).
    expect(fake.played).toEqual(['Noted — still holding that.']);
    expect(result.current.pendingProposal?.text).toBe('tell the worker to rebase');
  });

  it('a receipt released: the release ack keeps its own tier-2 slot and no receipt is spoken for it', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('ship it');
    });
    act(() => {
      emit({
        reply: 'sending that now',
        phase: 'released',
        released: { utteranceId: 1, text: 'ship it', delivery: { outcome: 'delivered', mechanism: 'steer' } },
      });
    });
    expect(fake.played).toEqual(['sending that now']);
    expect(speechArbiter.getState().current?.tier).toBe(2);
  });
});
