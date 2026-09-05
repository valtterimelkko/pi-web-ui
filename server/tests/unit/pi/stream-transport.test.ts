import { describe, expect, it } from 'vitest';
import { projectStreamingEventForTransport } from '../../../src/pi/stream-transport.js';

/**
 * WS-path memory robustness (2026-09-05 plan, F1): streaming events that
 * cross a transport boundary must not carry the provider's accumulated
 * mutable output. The incident shape: one assistant message with tens of KB
 * of thinking produced 162 MB of cumulative serialised traffic because every
 * `message_update` carried the full accumulated `message` AND a nested
 * `assistantMessageEvent.partial` alias of the same growing object.
 */
describe('projectStreamingEventForTransport', () => {
  it('slims message_update: message keeps only id/role/stopReason/errorMessage and assistantMessageEvent loses partial', () => {
    const partial = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'x'.repeat(40_000) }],
    };
    const event = {
      type: 'message_update',
      message: { ...partial, id: 'msg-1', stopReason: null },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'x', partial },
    };

    const projected = projectStreamingEventForTransport(event as any);

    expect(projected).not.toBe(event);
    expect(projected.type).toBe('message_update');
    // message is reduced to small identity/status fields only
    expect((projected.message as Record<string, unknown>).id).toBe('msg-1');
    expect((projected.message as Record<string, unknown>).role).toBe('assistant');
    expect((projected.message as Record<string, unknown>).content).toBeUndefined();
    // assistantMessageEvent keeps delta semantics but never the accumulated partial
    const ame = projected.assistantMessageEvent as Record<string, unknown>;
    expect(ame.type).toBe('thinking_delta');
    expect(ame.delta).toBe('x');
    expect(ame.partial).toBeUndefined();
  });

  it('keeps message_update small even when the provider object grows afterwards (no live alias retained)', () => {
    const partial = { role: 'assistant', content: [{ type: 'text', text: 'seed' }] };
    const event = {
      type: 'message_update',
      message: { ...partial },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'seed', partial },
    };
    const projected = projectStreamingEventForTransport(event as any);

    // Simulate the provider appending to the same mutable objects afterwards
    (partial.content[0] as { text: string }).text += 'y'.repeat(100_000);

    const serialized = JSON.stringify(projected);
    expect(Buffer.byteLength(serialized)).toBeLessThan(2_000);
  });

  it('retains stopReason and errorMessage on message_update (api-error surfacing depends on them)', () => {
    const event = {
      type: 'message_update',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limited' },
      assistantMessageEvent: { type: 'text_delta', delta: 'x' },
    };
    const projected = projectStreamingEventForTransport(event as any);
    expect((projected.message as Record<string, unknown>).stopReason).toBe('error');
    expect((projected.message as Record<string, unknown>).errorMessage).toBe('429 rate limited');
  });

  it('detaches message_start content from later mutation (content array and blocks are copies)', () => {
    const block = { type: 'text', text: '' };
    const content = [block];
    const event = { type: 'message_start', message: { role: 'assistant', content } };

    const projected = projectStreamingEventForTransport(event as any);
    const projectedContent = (projected.message as { content: Array<{ text: string }> }).content;

    expect(projectedContent).not.toBe(content);
    expect(projectedContent[0]).not.toBe(block);
    expect(projectedContent[0].text).toBe('');

    // Later provider mutation of the original must not change what we already sent
    block.text = 'grown'.repeat(10_000);
    expect(projectedContent[0].text).toBe('');
  });

  it('preserves message_start skill placeholder content (client renders it)', () => {
    const event = {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: '📚 **Skill loaded: demo**' }] },
    };
    const projected = projectStreamingEventForTransport(event as any);
    expect((projected.message as { content: Array<{ text: string }> }).content[0].text)
      .toContain('Skill loaded: demo');
  });

  it('passes terminal and tool events through unchanged (same reference, full fidelity)', () => {
    const finalMessage = { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] };
    for (const event of [
      { type: 'message_end', message: finalMessage },
      { type: 'agent_end', messages: [finalMessage] },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: '/x' } },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: { content: [] } },
      { type: 'agent_start' },
      { type: 'compaction_start', reason: 'auto' },
    ]) {
      expect(projectStreamingEventForTransport(event as any)).toBe(event);
    }
  });
});
