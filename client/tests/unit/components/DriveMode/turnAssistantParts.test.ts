import { describe, it, expect } from 'vitest';
import {
  getTurnAssistantParts,
  getTurnAssistantText,
} from '../../../../src/components/DriveMode/useAnswerReader';
import type { Message } from '../../../../src/store/sessionStore';

/**
 * P19 (package B) — the whole-turn input.
 *
 * The auto-speak path used to plan on the LAST assistant message only, which
 * is why mid-turn detail was reachable only by clicking read-aloud. The digest
 * input becomes the TURN: every assistant message since the operator's last
 * message, interim updates included. These tests pin the pure scan that
 * defines "the turn"; the surface-level behaviours are pinned in
 * DriveModeDictate.whole-turn.test.tsx.
 */

function msg(id: string, role: Message['role'], content: Message['content']): Message {
  return { id, role, content, timestamp: Date.now() };
}

describe('getTurnAssistantParts — the whole-turn scan (P19)', () => {
  it('collects every assistant message back to the operator’s last message, oldest first', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'ship it'),
      msg('a1', 'assistant', 'Working through the checklist now.'),
      msg('t1', 'tool', 'tool output is not the worker’s voice'),
      msg('a2', 'assistant', 'Done. The release is tagged.'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1', 'a2']);
    expect(parts.text).toBe(
      'Working through the checklist now.\n\nDone. The release is tagged.'
    );
  });

  it('stops at the operator’s message — their words are never part of the digest input', () => {
    const messages: Message[] = [
      msg('a0', 'assistant', 'an older turn the operator already heard'),
      msg('u1', 'user', 'and now this'),
      msg('a1', 'assistant', 'fresh output'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1']);
    expect(parts.text).toBe('fresh output');
  });

  it('skips tool messages without stopping — activity is not the worker’s voice, but it is not a turn boundary', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'before the tool'),
      msg('t1', 'tool', 'raw tool output'),
      msg('a2', 'assistant', 'after the tool'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.text).toBe('before the tool\n\nafter the tool');
    expect(parts.text).not.toContain('raw tool output');
  });

  it('keeps only the text parts of an assistant message — thinking is never spoken', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      {
        ...msg('a1', 'assistant', [
          { type: 'thinking', thinking: 'secret reasoning' },
          { type: 'text', text: 'the visible part' },
        ]),
      },
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.text).toBe('the visible part');
    expect(parts.text).not.toContain('secret reasoning');
  });

  it('stops at already-accounted content (same id, same words) even with no operator message between runs', () => {
    // Two unprompted runs (goal loop / watch wake): no user message separates
    // the turns, so the accounted boundary is what keeps run 2 from
    // re-digesting run 1's content.
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'first run output'),
      msg('a2', 'assistant', 'second run output'),
    ];
    const accounted = new Map([['a1', 'first run output']]);
    const parts = getTurnAssistantParts(messages, accounted);
    expect(parts.ids).toEqual(['a2']);
    expect(parts.text).toBe('second run output');
  });

  it('content arriving under a reused id with NEW words is new content — it is never silenced by bookkeeping', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('m1', 'assistant', 'first run output'),
      msg('m1', 'assistant', 'a brand new answer'),
    ];
    const accounted = new Map([['m1', 'first run output']]);
    const parts = getTurnAssistantParts(messages, accounted);
    expect(parts.ids).toEqual(['m1']);
    expect(parts.text).toBe('a brand new answer');
  });

  it('returns null text (and no ids) when the tail has no assistant words', () => {
    expect(getTurnAssistantParts([]).text).toBeNull();
    expect(getTurnAssistantParts([msg('u1', 'user', 'hi')]).text).toBeNull();
    expect(
      getTurnAssistantParts([
        msg('u1', 'user', 'hi'),
        msg('t1', 'tool', 'activity only'),
      ]).text
    ).toBeNull();
    // An assistant message with no text parts contributes nothing.
    expect(
      getTurnAssistantParts([
        msg('u1', 'user', 'hi'),
        msg('a1', 'assistant', [{ type: 'thinking', thinking: 'only thoughts' }]),
      ]).text
    ).toBeNull();
  });

  it('trims each message so blank interim messages never reach the digest', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', '   '),
      msg('a2', 'assistant', '  real words  '),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a2']);
    expect(parts.text).toBe('real words');
  });

  it('getTurnAssistantText is the text-only convenience the surface reads from', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'interim'),
      msg('a2', 'assistant', 'final'),
    ];
    expect(getTurnAssistantText(messages)).toBe('interim\n\nfinal');
    expect(getTurnAssistantText([msg('u1', 'user', 'hi')])).toBeNull();
  });
});
