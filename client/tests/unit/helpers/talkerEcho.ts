import type { Mock } from 'vitest';

/**
 * The correlation id the surface's LAST talker send carried — the id the
 * server echoes back on its `talker_turn_result` (multi-lane contract:
 * results are matched on requestId plus lane identity, so a test that emits a
 * result must emit it with the id of a turn the surface actually sent).
 */
export function lastSentTalkerRequestId(sendMock: Mock): string | undefined {
  for (let i = sendMock.mock.calls.length - 1; i >= 0; i -= 1) {
    const msg = sendMock.mock.calls[i]?.[0] as { type?: string; requestId?: string } | undefined;
    if (msg && typeof msg === 'object' && msg.type === 'talker_turn') return msg.requestId;
  }
  return undefined;
}
