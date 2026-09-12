import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTalkerTurn } from '../../../src/hooks/useTalkerTurn';
import { emitTalkerTurnResult, resetTalkerTurnBus } from '../../../src/lib/talkerBus';

// Mock useWebSocket: capture the outgoing message, return send success.
const sendMock = vi.fn();
vi.mock('../../../src/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(() => ({ sendMessage: sendMock })),
}));

describe('useTalkerTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTalkerTurnBus();
    sendMock.mockReturnValue(true);
  });

  it('sends a talker_turn message and marks a reply as awaited', () => {
    const { result } = renderHook(() => useTalkerTurn());
    let sent = false;
    act(() => {
      sent = result.current.sendTalkerTurn({
        workerSessionId: '/pi/worker.jsonl',
        utterance: 'please add a smoke test',
      });
    });
    expect(sent).toBe(true);
    expect(sendMock).toHaveBeenCalledWith({
      type: 'talker_turn',
      workerSessionId: '/pi/worker.jsonl',
      utterance: 'please add a smoke test',
    });
    expect(result.current.awaitingReply).toBe(true);
  });

  it('refuses to send an empty utterance', () => {
    const { result } = renderHook(() => useTalkerTurn());
    expect(result.current.sendTalkerTurn({ workerSessionId: 'x', utterance: '   ' })).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('receives the reply through the bus and clears awaitingReply', () => {
    const { result } = renderHook(() => useTalkerTurn());
    result.current.sendTalkerTurn({ workerSessionId: '/pi/worker.jsonl', utterance: 'hello?' });

    act(() => {
      emitTalkerTurnResult({
        type: 'talker_turn_result',
        requestId: 'r9',
        workerSessionId: '/pi/worker.jsonl',
        runtime: 'pi',
        reply: 'all quiet — still running step 3',
        phase: 'answered',
        released: null,
        cancelled: false,
      });
    });

    expect(result.current.lastResult?.reply).toBe('all quiet — still running step 3');
    expect(result.current.lastResult?.phase).toBe('answered');
    expect(result.current.awaitingReply).toBe(false);
  });

  it('surfaces a released turn so the caller knows the worker was touched', () => {
    const { result } = renderHook(() => useTalkerTurn());
    act(() => {
      emitTalkerTurnResult({
        type: 'talker_turn_result',
        workerSessionId: '/pi/worker.jsonl',
        runtime: 'pi',
        reply: 'sending that now',
        phase: 'released',
        released: {
          utteranceId: 2,
          text: 'please add a smoke test',
          delivery: { outcome: 'delivered', mechanism: 'steer' },
        },
        cancelled: false,
      });
    });
    expect(result.current.lastResult?.phase).toBe('released');
    expect(result.current.lastResult?.released?.text).toBe('please add a smoke test');
    expect(result.current.lastResult?.released?.delivery.outcome).toBe('delivered');
  });
});
