/**
 * The extracted HISTORY fold reproduces the step-1a goldens that were recorded
 * through the client store before extraction (same timestamps via the
 * injectable clock), and the message adapter reproduces the LiveMessage view.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { foldEvents, foldSessionEvents } from '../src/fold.js';
import { messagesToLiveMessages } from '../src/message-adapter.js';

const GOLDEN = new URL('../../../fixtures/session-render/__golden__/', import.meta.url);
const RUNTIMES = ['pi', 'claude', 'antigravity', 'commandcode'] as const;
const FIXED_NOW = 1_700_000_000_000;
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, GOLDEN), 'utf8'));

describe('foldEvents against the session-render goldens', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime}: folds to the golden messages and live view`, () => {
      const events = read(`${runtime}.pi-events.json`) as Array<Record<string, unknown>>;
      const golden = read(`${runtime}.messages.json`) as { messages: unknown; live: unknown };
      const { messages, leftovers } = foldEvents(events, { now: () => FIXED_NOW });
      expect(messages).toEqual(golden.messages);
      expect(messagesToLiveMessages(messages)).toEqual(golden.live);
      // Everything the fold does not own is handed back, in order.
      const foldable = new Set(['message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_end']);
      expect(leftovers).toEqual(events.filter((event) => !foldable.has(event.type as string)));
    });
  }

  it('continues from a base without mutating it and suffixes reused wire ids', () => {
    const base = foldEvents([
      { type: 'message_start', message: { id: 'm-1', role: 'assistant' } },
      { type: 'message_update', message: { id: 'm-1' }, assistantMessageEvent: { type: 'text_delta', delta: 'one' } },
    ], { now: () => 1 }).messages;
    const snapshot = JSON.parse(JSON.stringify(base));
    const { messages, diagnostics } = foldEvents([
      { type: 'message_start', message: { id: 'm-1', role: 'assistant' } },
      { type: 'message_update', message: { id: 'm-1' }, assistantMessageEvent: { type: 'text_delta', delta: 'two' } },
    ], { base, now: () => 2 });
    expect(base).toEqual(snapshot);
    expect(messages.map((m) => [m.id, m.content])).toEqual([
      ['m-1', [{ type: 'text', text: 'one' }]],
      ['m-1#2', [{ type: 'text', text: 'two' }]],
    ]);
    expect(diagnostics.storageIdAllocationCollisions).toBe(1);
  });

  it('returns non-event buffer items as leftovers unchanged', () => {
    const item = { type: 'history_meta', note: 'x' };
    expect(foldSessionEvents([item]).leftovers).toEqual([item]);
  });
});
