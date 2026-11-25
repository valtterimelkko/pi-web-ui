import { describe, it, expect } from 'vitest';
import { AcpEventAdapter, type AcpSessionUpdate } from '../../../src/devin/devin-event-adapter.js';

/**
 * Devin broker `agent_end` provider-error annotations (lane C phase 1).
 *
 * The keys are the ALREADY-SHIPPED vocabulary from the Antigravity provider-error
 * work (contract 1.70.0): additive `errorClass` ("quota" | "transient" | "other")
 * and, only when the provider text stated one, `resetAt` (ISO 8601). No new key
 * name is introduced and no provider text is copied into either field.
 */

const SID = 'brass-akubra';

function agentEndOf(events: Array<{ type: string; data?: unknown }>): { data: Record<string, unknown> } {
  const ends = events.filter((e) => e.type === 'agent_end');
  expect(ends).toHaveLength(1);
  return ends[0] as unknown as { data: Record<string, unknown> };
}

describe('devin agent_end provider-error annotations', () => {
  it('carries errorClass and resetAt additively alongside the existing keys', () => {
    const adapter = new AcpEventAdapter(SID);
    const closed = adapter.closeTurn({
      error: 'provider refused the turn',
      usage: { input: 3, output: 0 },
      errorClass: 'quota',
      resetAt: '2026-11-24T21:19:00.000Z',
    }, 2000);
    const end = agentEndOf(closed);
    expect(end.data.errorClass).toBe('quota');
    expect(end.data.resetAt).toBe('2026-11-24T21:19:00.000Z');
    // Pre-existing keys are untouched.
    expect(end.data.error).toBe('provider refused the turn');
    expect(end.data.result).toBeNull();
    expect((end.data.usage as { input?: number }).input).toBe(3);
  });

  it('omits resetAt entirely when no instant was established (unknown stays unknown)', () => {
    const adapter = new AcpEventAdapter(SID);
    const end = agentEndOf(adapter.closeTurn({ error: 'provider refused the turn', errorClass: 'quota' }, 2000));
    expect(end.data.errorClass).toBe('quota');
    expect('resetAt' in end.data).toBe(false);
  });

  it('omits both keys for an unannotated close (other failures keep today\'s shape)', () => {
    const adapter = new AcpEventAdapter(SID);
    adapter.onSessionUpdate({
      params: { sessionId: SID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } },
    } as unknown as AcpSessionUpdate, 1000);
    const end = agentEndOf(adapter.closeTurn({ usage: { input: 1, output: 1 }, stopReason: 'end_turn' }, 2000));
    expect('errorClass' in end.data).toBe(false);
    expect('resetAt' in end.data).toBe(false);
    expect(end.data.stopReason).toBe('end_turn');
  });

  it('emits errorClass "other" only when the caller explicitly says so', () => {
    const adapter = new AcpEventAdapter(SID);
    const end = agentEndOf(adapter.closeTurn({ error: 'timeout', errorClass: 'other' }, 2000));
    expect(end.data.errorClass).toBe('other');
    expect('resetAt' in end.data).toBe(false);
  });
});
