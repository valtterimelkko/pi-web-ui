import { describe, expect, it } from 'vitest';
import { expectedEchoIndexFor, removeDeliveredQueuedChips, type QueuedStreamingMessage } from './MessageInput';

// Hb6 correction 02: queued-streaming chips (steer/follow-up sent while a run
// is streaming) stayed visible after their prompt was delivered because the
// delivered-check required `typeof content === 'string'` while the echoed user
// message carries a text-block array. The check must use the same text
// extraction as the optimistic-echo reconciliation (messageTextOf).

function chip(text: string, id = `q_${text.slice(0, 8)}`): QueuedStreamingMessage {
  return { id, mode: 'steer', text };
}

function user(content: unknown): { role: string; content: unknown } {
  return { role: 'user', content };
}

const blockOf = (text: string) => [{ type: 'text', text }];

describe('removeDeliveredQueuedChips (Hb6 correction 02)', () => {
  it('clears a chip whose prompt was echoed as a text-block array', () => {
    const queue = [chip('Run the tool then reply: HB6T-3')];
    const transcript = [user(blockOf('Run the tool then reply: HB6T-3'))];
    expect(removeDeliveredQueuedChips(queue, transcript)).toHaveLength(0);
  });

  it('still clears a chip whose prompt was echoed as a plain string (old behaviour preserved)', () => {
    const queue = [chip('Steer as plain text')];
    const transcript = [user('Steer as plain text')];
    expect(removeDeliveredQueuedChips(queue, transcript)).toHaveLength(0);
  });

  it('keeps a chip whose prompt has not been echoed', () => {
    const queue = [chip('Not delivered yet')];
    const transcript = [user(blockOf('A different message'))];
    expect(removeDeliveredQueuedChips(queue, transcript)).toEqual(queue);
  });

  it('matches trimmed text on both sides', () => {
    const queue = [chip('  padded prompt  ')];
    const transcript = [user(blockOf('padded prompt'))];
    expect(removeDeliveredQueuedChips(queue, transcript)).toHaveLength(0);
  });

  it('keeps the matched chip when the transcript text merely contains the chip text', () => {
    const queue = [chip('HB6-1')];
    const transcript = [user(blockOf('Reply with exactly one line: HB6-1 and nothing else.'))];
    expect(removeDeliveredQueuedChips(queue, transcript)).toEqual(queue);
  });

  it('filters only delivered chips and preserves queue order', () => {
    const queue = [chip('delivered-one', 'q1'), chip('pending', 'q2'), chip('delivered-two', 'q3')];
    const transcript = [
      user(blockOf('delivered-one')),
      user(blockOf('delivered-two')),
    ];
    const remaining = removeDeliveredQueuedChips(queue, transcript);
    expect(remaining.map((c) => c.id)).toEqual(['q2']);
  });

  it('ignores assistant messages and non-text content when matching', () => {
    const queue = [chip('Only this exact text')];
    const transcript = [
      { role: 'assistant', content: blockOf('Only this exact text') },
      user([{ type: 'thinking', thinking: 'Only this exact text' }]),
    ];
    expect(removeDeliveredQueuedChips(queue, transcript)).toEqual(queue);
  });

  it('a chip queued after an identical earlier prompt is not cleared by that earlier echo (review: one-to-one)', () => {
    const history = [user(blockOf('same text'))];
    const queue = [{ ...chip('same text', 'q-new'), expectedEchoIndex: 1 }];
    expect(removeDeliveredQueuedChips(queue, history).map((c) => c.id)).toEqual(['q-new']);
    expect(removeDeliveredQueuedChips(queue, [...history, user(blockOf('same text'))])).toHaveLength(0);
  });

  it('one echo clears exactly one of two identical queued chips, in queue order', () => {
    const queue = [
      { ...chip('dup', 'q-a'), expectedEchoIndex: 0 },
      { ...chip('dup', 'q-b'), expectedEchoIndex: 1 },
    ];
    expect(removeDeliveredQueuedChips(queue, [user(blockOf('dup'))]).map((c) => c.id)).toEqual(['q-b']);
    expect(removeDeliveredQueuedChips(queue, [user(blockOf('dup')), user(blockOf('dup'))])).toHaveLength(0);
  });

  it('expectedEchoIndexFor counts prior identical user messages and identical chips still pending', () => {
    const history = [user(blockOf('x')), user('x'), user(blockOf('y'))];
    const pending = [chip('x', 'q1'), chip('z', 'q2')];
    expect(expectedEchoIndexFor('x', history, pending)).toBe(3);
    expect(expectedEchoIndexFor('y', history, pending)).toBe(1);
    expect(expectedEchoIndexFor('new', history, pending)).toBe(0);
  });
});
