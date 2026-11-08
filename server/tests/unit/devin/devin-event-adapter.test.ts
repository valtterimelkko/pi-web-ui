import { describe, it, expect } from 'vitest';
import { AcpEventAdapter, type AcpSessionUpdate } from '../../../src/devin/devin-event-adapter.js';

/**
 * Event adapter shapes mirrored from the live probe transcripts
 * (/root/devin-trial/acp-basic.jsonl, brass-akubra). All content synthetic;
 * field names faithful to the wire (ACP session/update payloads).
 */

const SID = 'brass-akubra';

function update(u: Record<string, unknown>, sessionId = SID): AcpSessionUpdate {
  return { params: { sessionId, update: u } } as unknown as AcpSessionUpdate;
}

describe('devin event adapter (ACP → NormalizedEvent)', () => {
  it('maps agent_message_chunk to text_delta message_update events', () => {
    const adapter = new AcpEventAdapter(SID);
    const events = adapter.onSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'CAPTURED' },
    }), 1000);
    const deltas = events.filter((e) => e.type === 'message_update');
    expect(deltas.length).toBe(1);
    const data = deltas[0].data as { assistantMessageEvent?: { type?: string; delta?: string } };
    expect(data.assistantMessageEvent?.type).toBe('text_delta');
    expect(data.assistantMessageEvent?.delta).toBe('CAPTURED');
  });

  it('maps agent_thought_chunk to thinking_delta events', () => {
    const adapter = new AcpEventAdapter(SID);
    const events = adapter.onSessionUpdate(update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'We need answer user.' },
    }), 1000);
    const thoughts = events.filter((e) => e.type === 'message_update');
    const data = thoughts[0].data as { assistantMessageEvent?: { type?: string; delta?: string } };
    expect(data.assistantMessageEvent?.type).toBe('thinking_delta');
    expect(data.assistantMessageEvent?.delta).toBe('We need answer user.');
  });

  it('maps tool_call to tool_execution_start with title, kind and rawInput', () => {
    const adapter = new AcpEventAdapter(SID);
    const events = adapter.onSessionUpdate(update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_a401a070807cfe93',
      title: 'Listed ./',
      kind: 'execute',
      rawInput: { command: 'ls -la' },
    }), 1000);
    const starts = events.filter((e) => e.type === 'tool_execution_start');
    expect(starts.length).toBe(1);
    const data = starts[0].data as { toolCallId?: string; toolName?: string; args?: unknown };
    expect(data.toolCallId).toBe('call_a401a070807cfe93');
    expect(data.toolName).toBe('Listed ./');
    expect(data.args).toEqual({ command: 'ls -la' });
  });

  it('maps tool_call_update output content to tool_execution_end with output text', () => {
    const adapter = new AcpEventAdapter(SID);
    adapter.onSessionUpdate(update({
      sessionUpdate: 'tool_call', toolCallId: 'call_x', title: 'Listed ./', kind: 'execute',
    }), 1000);
    const events = adapter.onSessionUpdate(update({
      sessionUpdate: 'tool_call_update', toolCallId: 'call_x', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'total 16\n-rw-r-- 1 root root 8 Nov 8 file' } }],
    }), 1100);
    const ends = events.filter((e) => e.type === 'tool_execution_end');
    expect(ends.length).toBe(1);
    const data = ends[0].data as { toolCallId?: string; result?: unknown };
    expect(data.toolCallId).toBe('call_x');
    expect(String(data.result)).toContain('total 16');
  });

  it('maps usage_update to usage events carrying input/output tokens', () => {
    const adapter = new AcpEventAdapter(SID);
    const events = adapter.onSessionUpdate(update({
      sessionUpdate: 'usage_update', used: 11424, size: 262144,
      _meta: { 'cognition.ai/inputTokens': 11048, 'cognition.ai/outputTokens': 376 },
    }), 1000);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect((usage!.data as { usage?: { input?: number } }).usage?.input).toBe(11048);
    expect((usage!.data as { usage?: { output?: number } }).usage?.output).toBe(376);
  });

  it('emits message_start on the first assistant content and message_end when the turn closes', () => {
    const adapter = new AcpEventAdapter(SID);
    const first = adapter.onSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' },
    }), 1000);
    expect(first.some((e) => e.type === 'message_start')).toBe(true);
    const closed = adapter.closeTurn({ usage: { input: 100, output: 5 }, stopReason: 'end_turn' }, 2000);
    expect(closed.some((e) => e.type === 'message_end')).toBe(true);
    const end = closed.find((e) => e.type === 'agent_end');
    expect(end).toBeDefined();
    expect((end!.data as { usage?: { input?: number } }).usage?.input).toBe(100);
  });

  it('ALWAYS emits agent_end on cancel', () => {
    const adapter = new AcpEventAdapter(SID);
    adapter.onSessionUpdate(update({
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' },
    }), 1000);
    const closed = adapter.closeTurn({ cancelled: true, usage: { input: 1, output: 1 } }, 2000);
    expect(closed.filter((e) => e.type === 'agent_end').length).toBe(1);
    const end = closed.find((e) => e.type === 'agent_end')!;
    expect((end.data as { cancelled?: boolean }).cancelled).toBe(true);
  });

  it('ALWAYS emits agent_end on error even with nothing streamed', () => {
    const adapter = new AcpEventAdapter(SID);
    const closed = adapter.closeTurn({ error: 'connection reset', usage: {} }, 2000);
    expect(closed.filter((e) => e.type === 'agent_end').length).toBe(1);
    const end = closed.find((e) => e.type === 'agent_end')!;
    expect((end.data as { error?: string }).error).toBe('connection reset');
    // A failure is never blank: an error-body assistant message is emitted.
    expect(closed.some((e) => e.type === 'message_start')).toBe(true);
    expect(closed.some((e) => e.type === 'message_end')).toBe(true);
  });

  it('ignores unknown cognition.ai notifications safely (no events, no throw)', () => {
    const adapter = new AcpEventAdapter(SID);
    const events = adapter.onNotification('_cognition.ai/mcp/serversChanged', {});
    expect(events).toEqual([]);
    const stats = adapter.onNotification('_cognition.ai/turn_stats', { sessionId: SID, responseDimensions: [] });
    expect(stats).toEqual([]);
  });

  it('maps replay user_message_chunk to user message events during session/load', () => {
    const adapter = new AcpEventAdapter(SID, { replay: true });
    const events = adapter.onSessionUpdate(update({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'What is the secret word?' },
    }, 'brass-akubra'), 1000);
    // Replay user content must render as a user bubble (message_start role user).
    expect(events.some((e) => e.type === 'message_start')).toBe(true);
    const start = events.find((e) => e.type === 'message_start')!;
    expect((start.data as { role?: string }).role).toBe('user');
  });
});
