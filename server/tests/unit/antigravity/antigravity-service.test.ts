import { describe, it, expect } from 'vitest';
import {
  applySentConversationId,
  extractSentConversationIdFromAgyLog,
  pickNewConversationId,
  type ConversationFileInfo,
} from '../../../src/antigravity/antigravity-service.js';

const PLACEHOLDER_CONVERSATION = '96ab5de0-2ac0-42b3-ba11-4ccaba820cbe';
const ACTUAL_CONVERSATION = 'a1efeb45-ca4b-4350-a97e-7feb18776438';

describe('extractSentConversationIdFromAgyLog', () => {
  it('uses the conversation that print mode actually sends to, not an earlier transient conversation', () => {
    const log = `
I0609 08:14:37.446682 server.go:753] Created conversation ${PLACEHOLDER_CONVERSATION}
I0609 08:14:38.163321 server.go:753] Created conversation ${ACTUAL_CONVERSATION}
I0609 08:14:38.165849 printmode.go:147] Print mode: conversation=${ACTUAL_CONVERSATION}, sending message
`;

    expect(extractSentConversationIdFromAgyLog(log)).toBe(ACTUAL_CONVERSATION);
  });

  it('returns the last sent conversation when the log contains multiple print-mode sends', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const log = `
I0609 08:00:00 printmode.go:147] Print mode: conversation=${first}, sending message
I0609 08:01:00 printmode.go:147] Print mode: conversation=${second}, sending message
`;

    expect(extractSentConversationIdFromAgyLog(log)).toBe(second);
  });
});

describe('applySentConversationId', () => {
  it('keeps the requested conversation when agy confirms the same sent conversation', () => {
    expect(applySentConversationId(PLACEHOLDER_CONVERSATION, PLACEHOLDER_CONVERSATION)).toBe(PLACEHOLDER_CONVERSATION);
  });

  it('uses the sent conversation on the first turn when there is no requested conversation yet', () => {
    expect(applySentConversationId(null, ACTUAL_CONVERSATION)).toBe(ACTUAL_CONVERSATION);
  });

  it('throws when agy sends a follow-up to a different conversation than requested', () => {
    expect(() => applySentConversationId(PLACEHOLDER_CONVERSATION, ACTUAL_CONVERSATION)).toThrow(/refusing to rebind/i);
  });
});

describe('pickNewConversationId', () => {
  it('chooses the largest newly-created conversation DB instead of depending on directory iteration order', () => {
    const before = new Map<string, ConversationFileInfo>();
    const after = new Map<string, ConversationFileInfo>([
      [PLACEHOLDER_CONVERSATION, { id: PLACEHOLDER_CONVERSATION, size: 49_152, mtimeMs: 1_000 }],
      [ACTUAL_CONVERSATION, { id: ACTUAL_CONVERSATION, size: 1_163_264, mtimeMs: 2_000 }],
    ]);

    expect(pickNewConversationId(before, after)).toBe(ACTUAL_CONVERSATION);
  });

  it('returns null when no new conversation DB was created', () => {
    const before = new Map<string, ConversationFileInfo>([
      [PLACEHOLDER_CONVERSATION, { id: PLACEHOLDER_CONVERSATION, size: 49_152, mtimeMs: 1_000 }],
    ]);
    const after = new Map(before);

    expect(pickNewConversationId(before, after)).toBeNull();
  });
});
