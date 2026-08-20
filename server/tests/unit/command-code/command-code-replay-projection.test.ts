import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { coalesceCommandCodeReplayEvents } from '../../../src/command-code/command-code-replay-projection.js';
import { CommandCodeEventJournal } from '../../../src/command-code/command-code-event-journal.js';

function messageUpdate(sessionId: string, id: string, kind: 'text_delta' | 'thinking_delta', delta: string): NormalizedEvent {
  return {
    type: 'message_update',
    sessionId,
    timestamp: 1,
    data: { id, assistantMessageEvent: { type: kind, delta } },
  };
}

function event(sessionId: string, type: NormalizedEvent['type'], data: Record<string, unknown> = {}): NormalizedEvent {
  return { type, sessionId, timestamp: 1, data };
}

describe('coalesceCommandCodeReplayEvents', () => {
  it('coalesces consecutive text deltas for one message into a single event', () => {
    const input = [
      messageUpdate('s', 'm1', 'text_delta', 'Hel'),
      messageUpdate('s', 'm1', 'text_delta', 'lo '),
      messageUpdate('s', 'm1', 'text_delta', 'world'),
    ];
    const output = coalesceCommandCodeReplayEvents(input);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: 'message_update',
      data: { id: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'Hello world' } },
    });
  });

  it('coalesces consecutive thinking deltas separately and preserves interleaving order', () => {
    const input = [
      messageUpdate('s', 'm1', 'text_delta', 'a'),
      messageUpdate('s', 'm1', 'thinking_delta', 't1'),
      messageUpdate('s', 'm1', 'thinking_delta', 't2'),
      messageUpdate('s', 'm1', 'text_delta', 'b'),
    ];
    const output = coalesceCommandCodeReplayEvents(input);
    expect(output.map((e) => (e.data as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta))
      .toEqual(['a', 't1t2', 'b']);
  });

  it('never merges deltas across different message ids', () => {
    const input = [
      messageUpdate('s', 'm1', 'text_delta', 'a'),
      messageUpdate('s', 'm2', 'text_delta', 'b'),
    ];
    const output = coalesceCommandCodeReplayEvents(input);
    expect(output).toHaveLength(2);
    expect((output[0].data as { id: string }).id).toBe('m1');
    expect((output[1].data as { id: string }).id).toBe('m2');
  });

  it('passes non-delta events through unchanged and in order', () => {
    const input: NormalizedEvent[] = [
      event('s', 'agent_start', { runtime: 'commandcode' }),
      event('s', 'message_start', { id: 'u1', role: 'user', content: 'hi' }),
      event('s', 'message_end', { id: 'u1' }),
      event('s', 'message_start', { id: 'm1', role: 'assistant' }),
      event('s', 'model_request_start', {}),
      messageUpdate('s', 'm1', 'text_delta', 'x'),
      messageUpdate('s', 'm1', 'text_delta', 'y'),
      event('s', 'tool_execution_start', { toolCallId: 't1', toolName: 'bash', args: {} }),
      event('s', 'tool_execution_end', { toolCallId: 't1', result: 'ok', isError: false }),
      event('s', 'message_end', { id: 'm1' }),
      event('s', 'model_request_end', { effort: 'high' }),
      event('s', 'agent_end', { subtype: 'success' }),
    ];
    const output = coalesceCommandCodeReplayEvents(input);
    expect(output.map((e) => e.type)).toEqual([
      'agent_start', 'message_start', 'message_end', 'message_start', 'model_request_start',
      'message_update', 'tool_execution_start', 'tool_execution_end', 'message_end',
      'model_request_end', 'agent_end',
    ]);
    const coalesced = output[5].data as { assistantMessageEvent: { delta: string } };
    expect(coalesced.assistantMessageEvent.delta).toBe('xy');
    expect(output[5].timestamp).toBe(input[5].timestamp);
  });

  it('preserves the concatenated visible text exactly (no loss, no duplication)', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const input = letters.map((c, i) => messageUpdate('s', 'm1', i % 7 === 3 ? 'thinking_delta' : 'text_delta', c));
    const output = coalesceCommandCodeReplayEvents(input);
    const rebuiltText = output
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.data as { assistantMessageEvent: { type: string; delta: string } }).assistantMessageEvent)
      .filter((a) => a.type === 'text_delta')
      .map((a) => a.delta)
      .join('');
    const rebuiltThinking = output
      .filter((e) => e.type === 'message_update')
      .map((e) => (e.data as { assistantMessageEvent: { type: string; delta: string } }).assistantMessageEvent)
      .filter((a) => a.type === 'thinking_delta')
      .map((a) => a.delta)
      .join('');
    const expectedText = letters.filter((_, i) => i % 7 !== 3).join('');
    const expectedThinking = letters.filter((_, i) => i % 7 === 3).join('');
    expect(rebuiltText).toBe(expectedText);
    expect(rebuiltThinking).toBe(expectedThinking);
    expect(output.length).toBeLessThan(input.length);
  });

  it('handles empty input and unknown message_update payloads without touching them', () => {
    expect(coalesceCommandCodeReplayEvents([])).toEqual([]);
    const passthrough = [{ type: 'message_update', sessionId: 's', timestamp: 1, data: { id: 'm1' } } as unknown as NormalizedEvent];
    expect(coalesceCommandCodeReplayEvents(passthrough)).toEqual(passthrough);
  });

  it('collapses a realistic per-token journal by three orders of magnitude', () => {
    const input: NormalizedEvent[] = [event('s', 'agent_start', {}), event('s', 'message_start', { id: 'm1', role: 'assistant' })];
    for (let i = 0; i < 5_000; i++) input.push(messageUpdate('s', 'm1', 'text_delta', 'x'));
    input.push(event('s', 'message_end', { id: 'm1' }), event('s', 'agent_end', {}));
    const output = coalesceCommandCodeReplayEvents(input);
    expect(output).toHaveLength(5);
  });
});

describe('Command Code journal read durability', () => {
  it('serializes reads behind in-flight appends for the same session', async () => {
    // A read issued while appends are queued must observe the fully settled
    // journal, never a half-written trailing line. Without queue-joined reads
    // this returns a partial snapshot (usually zero events) because the first
    // append has not even created the file yet.
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-journal-read-'));
    const journal = new CommandCodeEventJournal(root, { maxBytes: 1_000_000 });
    const appends = Array.from({ length: 25 }, (_, index) =>
      journal.append('cc-serial', { type: 'message_update', sessionId: 'cc-serial', timestamp: index, data: { id: 'm1', assistantMessageEvent: { type: 'text_delta', delta: 'x' } } }));
    const readDuringFlight = await journal.read('cc-serial');
    await Promise.all(appends);
    expect(readDuringFlight).toHaveLength(25);
    expect(readDuringFlight.every((e) => e.type === 'message_update')).toBe(true);
    expect(await journal.read('cc-serial')).toHaveLength(25);
  });

  it('tolerates a crash-truncated trailing line instead of failing the whole replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-journal-partial-'));
    const journal = new CommandCodeEventJournal(root, { maxBytes: 1_000_000 });
    await journal.append('cc-partial', { type: 'agent_start', sessionId: 'cc-partial', timestamp: 1, data: {} });
    const file = path.join(root, 'events', 'cc-partial.jsonl');
    await writeFile(file, `${await readFile(file, 'utf8')}{"type":"message_update","sessionId":"cc-partial","timestamp":3,"data":{"id":"m1","assistantM`, 'utf8');
    const events = await journal.read('cc-partial');
    expect(events.map((e) => e.type)).toEqual(['agent_start']);
  });

  it('still fails loudly on corruption in a complete, newline-terminated line', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-journal-corrupt-'));
    const journal = new CommandCodeEventJournal(root, { maxBytes: 1_000_000 });
    await journal.append('cc-corrupt', { type: 'agent_start', sessionId: 'cc-corrupt', timestamp: 1, data: {} });
    const file = path.join(root, 'events', 'cc-corrupt.jsonl');
    await writeFile(file, `${await readFile(file, 'utf8')}\n{"type":\n`, 'utf8');
    await expect(journal.read('cc-corrupt')).rejects.toThrow(/corruption/i);
  });
});
