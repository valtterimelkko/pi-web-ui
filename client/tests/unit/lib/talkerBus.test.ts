import { describe, it, expect, beforeEach } from 'vitest';
import {
  emitTalkerTurnResult,
  getLastTalkerTurnResult,
  isTalkerTurnResultMessage,
  resetTalkerTurnBus,
  subscribeTalkerTurnResults,
} from '../../../src/lib/talkerBus';

const makeResult = (overrides: Record<string, unknown> = {}) => ({
  type: 'talker_turn_result',
  requestId: 'r1',
  workerSessionId: '/pi/worker.jsonl',
  runtime: 'pi',
  reply: 'sending that now',
  phase: 'released',
  released: {
    utteranceId: 3,
    text: 'please add a smoke test',
    delivery: { outcome: 'delivered', mechanism: 'prompt' },
  },
  cancelled: false,
  ...overrides,
});

describe('talkerBus', () => {
  beforeEach(() => resetTalkerTurnBus());

  it('consumes only talker_turn_result messages', () => {
    expect(isTalkerTurnResultMessage(makeResult())).toBe(true);
    expect(isTalkerTurnResultMessage({ type: 'session_event', sessionId: 'x' })).toBe(false);
    expect(isTalkerTurnResultMessage({ type: 'talker_turn_result', reply: 42 })).toBe(false);
    expect(isTalkerTurnResultMessage(null)).toBe(false);
    expect(emitTalkerTurnResult({ type: 'pong' })).toBe(false);
  });

  it('delivers a result to subscribers and keeps the last one', () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeTalkerTurnResults((r) => seen.push(r));
    const result = makeResult();
    expect(emitTalkerTurnResult(result)).toBe(true);
    expect(seen).toEqual([result]);
    expect(getLastTalkerTurnResult()).toEqual(result);
    unsubscribe();
  });

  it('carries a proposed result\'s card payload through intact — cleaned, removed fragments, original (D1/D2 mirror)', () => {
    const proposal = {
      text: 'rerun the suite',
      cleaned: true,
      removed: 'Um, tell the worker to',
      original: 'Um, tell the worker to rerun the suite',
    };
    const result = makeResult({ phase: 'proposed', released: null, proposal });
    expect(emitTalkerTurnResult(result)).toBe(true);
    // The mirror adds no interpretation: the server's own account arrives as sent.
    expect((getLastTalkerTurnResult() as { proposal?: unknown }).proposal).toEqual(proposal);
  });

  it('stops delivering after unsubscribe and keeps lastResult for late hydration', () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeTalkerTurnResults((r) => seen.push(r));
    unsubscribe();
    emitTalkerTurnResult(makeResult({ phase: 'answered', reply: 'all quiet' }));
    expect(seen).toEqual([]);
    expect(getLastTalkerTurnResult()?.reply).toBe('all quiet');
  });

  it('a throwing listener does not block the others', () => {
    const seen: string[] = [];
    subscribeTalkerTurnResults(() => {
      throw new Error('listener boom');
    });
    subscribeTalkerTurnResults((r) => seen.push(r.reply));
    expect(() => emitTalkerTurnResult(makeResult())).not.toThrow();
    expect(seen).toEqual(['sending that now']);
  });
});
