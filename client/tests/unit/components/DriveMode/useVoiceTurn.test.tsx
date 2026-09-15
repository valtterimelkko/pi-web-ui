import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceTurn, CONFIRM_UTTERANCE, CANCEL_UTTERANCE } from '../../../../src/components/DriveMode/useVoiceTurn';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../../src/lib/talkerBus';
import { speechArbiter, type ArbiterPlayer } from '../../../../src/lib/speechArbiter';
import { lastSentTalkerRequestId } from '../../helpers/talkerEcho';

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
    // The server echoes the correlation id the send carried; without one this
    // is a result this surface never sent (and would rightly refuse).
    requestId: lastSentTalkerRequestId(sendMock),
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
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'talker_turn',
        workerSessionId: WORKER,
        utterance: 'tell the worker to rebase on main',
        runtime: 'pi',
      })
    );
    // The send carries the client correlation id the server echoes back.
    expect(typeof sendMock.mock.calls[0][0].requestId).toBe('string');
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
    // The release is the answer to the CONFIRM gesture — a second send, whose
    // echo identifies its result (one requestId per turn).
    act(() => {
      result.current.confirmPending();
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
    // The cancellation is the answer to the CANCEL gesture — a second send,
    // whose echo identifies its result.
    act(() => {
      result.current.cancelPending();
    });
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

  it('a proposed result carrying the harness proposal prefers the exact outgoing text and passes the cleaning facts through', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('okay um ask the worker if it has enough materials');
    });
    act(() => {
      emit({
        reply: 'Shall I send the tidied version?',
        phase: 'proposed',
        proposal: {
          text: 'if it has enough materials',
          cleaned: true,
          removed: 'okay, um, ask the worker',
        },
      });
    });
    // The card must show the EXACT bytes that will be released (P25's
    // invariant), not the raw spoken words.
    expect(result.current.pendingProposal).toEqual({
      text: 'if it has enough materials',
      cleaned: true,
      removed: 'okay, um, ask the worker',
    });
  });

  it('an old server (no proposal on the result) keeps the verbatim record with NO cleaning claim — never a guessed one', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    const WORDS = 'rebase the auth branch';
    act(() => {
      result.current.sendText(WORDS);
    });
    act(() => {
      emit({ reply: 'Shall I send that?', phase: 'proposed' });
    });
    expect(result.current.pendingProposal).toEqual({ text: WORDS });
    expect(result.current.pendingProposal?.cleaned).toBeUndefined();
    expect(result.current.pendingProposal?.removed).toBeUndefined();
  });

  it('a partial proposal (flag without text) falls back to the spoken record but keeps the flag honest', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    const WORDS = 'deploy the fix to staging';
    act(() => {
      result.current.sendText(WORDS);
    });
    act(() => {
      emit({ reply: 'Holding.', phase: 'proposed', proposal: { cleaned: true } });
    });
    expect(result.current.pendingProposal?.text).toBe(WORDS);
    expect(result.current.pendingProposal?.cleaned).toBe(true);
  });

  it('a proposed result carrying the raw original surfaces it for the card — and only when the server sent one', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('Um, tell the worker to rerun the suite');
    });
    act(() => {
      emit({
        reply: 'Shall I send the tidied version?',
        phase: 'proposed',
        proposal: {
          text: 'rerun the suite',
          cleaned: true,
          removed: 'Um, tell the worker to',
          original: 'Um, tell the worker to rerun the suite',
        },
      });
    });
    expect(result.current.pendingProposal).toEqual({
      text: 'rerun the suite',
      cleaned: true,
      removed: 'Um, tell the worker to',
      original: 'Um, tell the worker to rerun the suite',
    });
  });

  it('an old server sending no proposal fields surfaces no original — never an invented one', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('rebase the auth branch');
    });
    act(() => {
      emit({ reply: 'Shall I send that?', phase: 'proposed' });
    });
    expect(result.current.pendingProposal?.original).toBeUndefined();
  });

  it('junk on the original field is ignored, like every other proposal field', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('run the smoke tests');
    });
    act(() => {
      emit({ reply: 'Holding.', phase: 'proposed', proposal: { text: 'run tests', cleaned: true, original: 7 } });
    });
    expect(result.current.pendingProposal?.text).toBe('run tests');
    expect(result.current.pendingProposal?.original).toBeUndefined();
  });

  it("releaseOriginal sends the confirm gesture with releaseVariant 'original' — and no-ops without a proposal", () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    expect(result.current.releaseOriginal()).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();

    act(() => {
      result.current.sendText('Um, tell the worker to rerun the suite');
    });
    act(() => {
      emit({
        reply: 'Send it?',
        phase: 'proposed',
        proposal: {
          text: 'rerun the suite',
          cleaned: true,
          removed: 'Um, tell the worker to',
          original: 'Um, tell the worker to rerun the suite',
        },
      });
    });
    act(() => {
      expect(result.current.releaseOriginal()).toBe(true);
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'talker_turn',
        workerSessionId: WORKER,
        utterance: CONFIRM_UTTERANCE,
        runtime: 'pi',
        releaseVariant: 'original',
      })
    );
  });

  it('the default confirm gesture sends NO releaseVariant — the tidied path is unchanged', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    act(() => {
      result.current.sendText('deploy the fix');
    });
    act(() => {
      emit({ reply: 'Send it?', phase: 'proposed' });
    });
    act(() => {
      expect(result.current.confirmPending()).toBe(true);
    });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'talker_turn',
        workerSessionId: WORKER,
        utterance: CONFIRM_UTTERANCE,
        runtime: 'pi',
      })
    );
  });

  it('junk shapes on the proposal field are ignored, not trusted', () => {
    const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
    const WORDS = 'run the smoke tests';
    act(() => {
      result.current.sendText(WORDS);
    });
    act(() => {
      emit({ reply: 'Holding.', phase: 'proposed', proposal: { text: 42, cleaned: 'yes', removed: 7 } });
    });
    // A malformed proposal must not overwrite the operator's words with
    // garbage on the card — fall back to the verbatim record.
    expect(result.current.pendingProposal).toEqual({ text: WORDS });
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

describe('useVoiceTurn — the ack producer consults the shared spoken ledger (P16)', () => {
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

  it('the constant receipt ack still speaks for every new turn — rule 2 is not deduped away', () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    try {
      const { result } = renderHook(() => useVoiceTurn(WORKER, 'pi'));
      act(() => {
        result.current.sendText('first held utterance');
      });
      act(() => {
        emit({ receiptAck: 'Noted — still holding that.' });
      });
      // A second TURN: one send, one echoed result. (Re-emitting the same
      // requestId would be the same event — the bus rejects it as a
      // duplicate, which is the correlation rule working.)
      act(() => {
        result.current.sendText('second held utterance');
      });
      act(() => {
        emit({ receiptAck: 'Noted — still holding that.' });
      });

      const acks = submitSpy.mock.calls.filter(
        ([input]) => input.text === 'Noted — still holding that.'
      );
      // Two distinct turns, two receipts: the words repeat because the
      // EVENT repeats, and the operator is owed an ack for each held utterance.
      expect(acks).toHaveLength(2);
    } finally {
      submitSpy.mockRestore();
    }
  });

  it('a remount replaying the retained turn result does not speak that same event twice', () => {
    const submitSpy = vi.spyOn(speechArbiter, 'submit');
    try {
      const first = renderHook(() => useVoiceTurn(WORKER, 'pi'));
      act(() => {
        first.result.current.sendText('held utterance');
      });
      act(() => {
        emit({ receiptAck: 'Noted — still holding that.' });
      });
      const ackSubmissions = () =>
        submitSpy.mock.calls.filter(([input]) => input.text === 'Noted — still holding that.');
      expect(ackSubmissions()).toHaveLength(1);
      first.unmount();

      // A late-mounting surface hydrates the SAME retained result object…
      renderHook(() => useVoiceTurn(WORKER, 'pi'));

      // …and the event-scoped claim suppresses the replay.
      expect(ackSubmissions()).toHaveLength(1);
    } finally {
      submitSpy.mockRestore();
    }
  });
});
