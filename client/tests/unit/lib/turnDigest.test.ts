import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DIGEST_TIMEOUT_MS,
  awaitTurnDigest,
  emitTurnDigestResult,
  isTurnDigestResultMessage,
  nextTurnDigestRequestId,
  resetTurnDigestBus,
  type TurnDigestResultMessage,
} from '../../../src/lib/turnDigest';

/**
 * P17 — the digest transport, client side.
 *
 * The reading levels need the TALKER to digest a turn, which means a request
 * that carries the worker's text to the talker's model and returns words for
 * the operator. It is deliberately NOT the operator-turn channel: nothing here
 * can reach the operator's draft or the relay gate, because nothing here
 * produces an utterance at all.
 *
 * The promise always settles: a talker that never answers must not leave the
 * surface silent forever — the caller falls back to reading the turn verbatim.
 */

const result = (over: Partial<TurnDigestResultMessage> = {}): TurnDigestResultMessage => ({
  type: 'talker_digest_result',
  requestId: 'req-1',
  workerSessionId: '/pi/worker.jsonl',
  kind: 'summary',
  digest: 'the build is green',
  ...over,
});

beforeEach(() => {
  resetTurnDigestBus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('turnDigest bus', () => {
  it('resolves the waiting request with the digest', async () => {
    const pending = awaitTurnDigest('req-1');
    expect(emitTurnDigestResult(result())).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, digest: 'the build is green' });
  });

  it('reports an honest refusal rather than a silent empty answer', async () => {
    const pending = awaitTurnDigest('req-1');
    emitTurnDigestResult(result({ digest: null, refused: 'model_unconfigured' }));
    await expect(pending).resolves.toEqual({ ok: false, reason: 'refused' });
  });

  it('reports a failed model call as a failure, not as speech', async () => {
    const pending = awaitTurnDigest('req-1');
    emitTurnDigestResult(result({ digest: null, error: 'boom' }));
    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed' });
  });

  it('does not hand one request another request’s answer', async () => {
    const first = awaitTurnDigest('req-1');
    const second = awaitTurnDigest('req-2');
    emitTurnDigestResult(result({ requestId: 'req-2', digest: 'second answer' }));
    await expect(second).resolves.toEqual({ ok: true, digest: 'second answer' });

    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitTurnDigestResult(result({ requestId: 'req-1', digest: 'first answer' }));
    await expect(first).resolves.toEqual({ ok: true, digest: 'first answer' });
  });

  it('times out instead of leaving the surface silent forever', async () => {
    vi.useFakeTimers();
    const pending = awaitTurnDigest('req-1', 1234);
    await vi.advanceTimersByTimeAsync(1234);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
  });

  it('gives every request a distinct id', () => {
    const ids = new Set([nextTurnDigestRequestId(), nextTurnDigestRequestId(), nextTurnDigestRequestId()]);
    expect(ids.size).toBe(3);
  });

  it('has a bounded default wait — the raw answer is the fallback, so the wait cannot be unbounded', () => {
    expect(DIGEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DIGEST_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it('consumes only its own message type, so the session store still sees everything else', () => {
    expect(emitTurnDigestResult({ type: 'assistant_message', content: 'hi' })).toBe(false);
    expect(emitTurnDigestResult(result())).toBe(true);
  });

  it('recognises the wire shape structurally (a malformed frame is never mistaken for a digest)', () => {
    expect(isTurnDigestResultMessage({ type: 'talker_digest_result' })).toBe(false);
    expect(isTurnDigestResultMessage({ type: 'talker_digest_result', requestId: 1, digest: 'x' })).toBe(false);
    expect(isTurnDigestResultMessage(result())).toBe(true);
  });

  it('consumes a result with no request id without resolving anyone', async () => {
    const pending = awaitTurnDigest('req-1');
    // Consumed (the session store must never see this frame)…
    expect(emitTurnDigestResult({ type: 'talker_digest_result', digest: 'orphan' })).toBe(true);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    emitTurnDigestResult(result({ digest: 'the real one' }));
    await expect(pending).resolves.toEqual({ ok: true, digest: 'the real one' });
  });

  it('drops a late answer for a request nobody is waiting for', async () => {
    const pending = awaitTurnDigest('req-1');
    resetTurnDigestBus();
    expect(emitTurnDigestResult(result())).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed' });
  });
});
