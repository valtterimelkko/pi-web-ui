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

// ---------------------------------------------------------------------------
// INJECTION MARKING (2026-09-16) — routine Agent OS capture injections are
// structurally marked at the emitter (custom message, customType
// 'agent-os-capture'). The scan must exclude ONLY what the injection produced:
// assistant output more recent than the last marked injection — with no
// operator message after it — is housekeeping and is never the turn; the work
// below the injection still is. The match is structural (entry role + custom
// type), never a text heuristic.
// ---------------------------------------------------------------------------

import { AGENT_OS_CAPTURE_CUSTOM_TYPE, isAgentOsCaptureInjection } from '../../../../src/components/DriveMode/useAnswerReader';

function injection(id: string, customType: string = AGENT_OS_CAPTURE_CUSTOM_TYPE): Message {
  return {
    id,
    role: 'custom',
    customType,
    content: 'Agent OS session-end memory capture (automated delivery). Run your capture flow now.',
    timestamp: Date.now(),
  };
}

describe('getTurnAssistantParts — marked capture injections bound the spoken turn (2026-09-16)', () => {
  it('the housekeeping answer after a marked injection is never the turn; the work below it still is', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'ship the release'),
      msg('a1', 'assistant', 'The release is tagged and deployed.'),
      injection('c1'),
      msg('a2', 'assistant', 'Two memory candidates were extracted and evidence written.'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1'], 'the operator’s work, not the housekeeping');
    expect(parts.text).toBe('The release is tagged and deployed.');
    expect(parts.text).not.toContain('candidates were extracted');
  });

  it('a real operator message after the injection restores the ordinary turn — everything since their words', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'ship the release'),
      msg('a1', 'assistant', 'work one'),
      injection('c1'),
      msg('a2', 'assistant', 'housekeeping'),
      msg('u2', 'user', 'now update the changelog'),
      msg('a3', 'assistant', 'Changelog updated.'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a3']);
    expect(parts.text).toBe('Changelog updated.');
  });

  it('every assistant message of the housekeeping turn is excluded, tools included in the skip', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'real work'),
      injection('c1'),
      msg('a2', 'assistant', 'capture step one'),
      msg('t1', 'tool', 'capture tool output'),
      msg('a3', 'assistant', 'capture step two'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1']);
    expect(parts.text).toBe('real work');
  });

  it('the LAST marked injection wins — only output after it is housekeeping', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'work one'),
      injection('c1'),
      msg('a2', 'assistant', 'housekeeping one'),
      msg('u2', 'user', 'more'),
      msg('a3', 'assistant', 'work two'),
      injection('c2'),
      msg('a4', 'assistant', 'housekeeping two'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a3']);
    expect(parts.text).toBe('work two');
  });

  it('other custom messages are not boundaries — another extension’s injection never silences the turn', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'real work'),
      injection('c-other', 'bg-shell-tasks-reminder'),
      msg('a2', 'assistant', 'still the operator’s turn'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1', 'a2']);
    expect(parts.text).toBe('real work\n\nstill the operator’s turn');
  });

  it('STRUCTURAL, not textual: an operator prompt quoting the injection wording verbatim is a user message and still bounds the turn', () => {
    const injectionWords = 'Agent OS session-end memory capture (automated delivery). Run your capture flow now.';
    const messages: Message[] = [
      msg('u1', 'user', injectionWords),
      msg('a1', 'assistant', 'the answer to the operator’s own words'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1']);
    expect(parts.text).toBe('the answer to the operator’s own words');
    expect(isAgentOsCaptureInjection(messages[0])).toBe(false,
      'a USER message is never an injection, whatever it quotes');
  });

  it('the packet lane type (agent-os) is not a capture boundary — it rides inside the operator’s turn', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      injection('c-pkt', 'agent-os'),
      msg('a1', 'assistant', 'the first answer is real work'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1']);
    expect(parts.text).toBe('the first answer is real work');
  });

  it('an injection with no work below it yields no turn at all — housekeeping is never spoken alone', () => {
    const messages: Message[] = [
      injection('c1'),
      msg('a2', 'assistant', 'housekeeping'),
    ];
    expect(getTurnAssistantParts(messages).text).toBeNull();
  });

  it('sessions with no injections behave exactly as before (regression guard)', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'interim'),
      msg('t1', 'tool', 'out'),
      msg('a2', 'assistant', 'final'),
    ];
    const parts = getTurnAssistantParts(messages);
    expect(parts.ids).toEqual(['a1', 'a2']);
    expect(parts.text).toBe('interim\n\nfinal');
  });

  it('accounted bookkeeping still applies below the injection boundary', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'go'),
      msg('a1', 'assistant', 'work'),
      injection('c1'),
      msg('a2', 'assistant', 'housekeeping'),
    ];
    const accounted = new Map([['a1', 'work']]);
    const parts = getTurnAssistantParts(messages, accounted);
    expect(parts.text, 'accounted work is not re-collected').toBeNull();
  });

  it('the marker predicate is exported so every consumer shares one structural rule', () => {
    expect(AGENT_OS_CAPTURE_CUSTOM_TYPE).toBe('agent-os-capture');
    expect(isAgentOsCaptureInjection(injection('x'))).toBe(true);
    expect(isAgentOsCaptureInjection(injection('x', 'agent-os'))).toBe(false);
    expect(isAgentOsCaptureInjection(msg('x', 'user', 'anything'))).toBe(false);
    expect(isAgentOsCaptureInjection(msg('x', 'assistant', 'anything'))).toBe(false);
  });
});
