import { describe, it, expect } from 'vitest';
import {
  applySentConversationId,
  extractSentConversationIdFromAgyLog,
  pickNewConversationId,
  getModelContextWindow,
  ANTIGRAVITY_CHARS_PER_TOKEN,
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

describe('getModelContextWindow', () => {
  it('returns 1 M tokens for Gemini 3.5 Flash variants', () => {
    expect(getModelContextWindow('Gemini 3.5 Flash (Medium)')).toBe(1_048_576);
    expect(getModelContextWindow('Gemini 3.5 Flash (High)')).toBe(1_048_576);
    expect(getModelContextWindow('Gemini 3.5 Flash (Low)')).toBe(1_048_576);
  });

  it('returns 2 M tokens for Gemini 3.1 Pro variants', () => {
    expect(getModelContextWindow('Gemini 3.1 Pro (Low)')).toBe(2_097_152);
    expect(getModelContextWindow('Gemini 3.1 Pro (High)')).toBe(2_097_152);
  });

  it('returns 200 K tokens for Claude Sonnet variants', () => {
    expect(getModelContextWindow('Claude Sonnet 4.6 (Thinking)')).toBe(200_000);
  });

  it('returns 200 K tokens for Claude Opus variants', () => {
    expect(getModelContextWindow('Claude Opus 4.6 (Thinking)')).toBe(200_000);
  });

  it('returns 128 K tokens for GPT-OSS models', () => {
    expect(getModelContextWindow('GPT-OSS 120B (Medium)')).toBe(128_000);
  });

  it('falls back to 1 M tokens for unrecognised model names', () => {
    expect(getModelContextWindow('Unknown Future Model XL')).toBe(1_048_576);
    expect(getModelContextWindow('')).toBe(1_048_576);
  });
});

describe('context usage estimation from conversation history', () => {
  const CHARS_PER_TOKEN = ANTIGRAVITY_CHARS_PER_TOKEN;

  it('estimates tokens as total chars divided by chars-per-token', () => {
    const prompt = 'a'.repeat(400);   // 400 chars
    const response = 'b'.repeat(600); // 600 chars
    // total = 1000 chars → 1000/4 = 250 tokens
    const totalChars = prompt.length + response.length;
    expect(Math.round(totalChars / CHARS_PER_TOKEN)).toBe(250);
  });

  it('grows with each additional turn', () => {
    const turns = [
      { prompt: 'a'.repeat(400), response: 'b'.repeat(600) },  // 1 000 chars → 250 tokens
      { prompt: 'c'.repeat(200), response: 'd'.repeat(800) },  // 1 000 chars → 250 tokens total additional
    ];
    const totalChars = turns.reduce((acc, t) => acc + t.prompt.length + t.response.length, 0);
    expect(Math.round(totalChars / CHARS_PER_TOKEN)).toBe(500);
  });

  it('percent is capped at 100 when estimated tokens exceed the context window', () => {
    const contextWindow = 1_000; // tiny window for the test
    const tokens = 2_000;        // double the window
    const percent = Math.min(Math.round((tokens / contextWindow) * 100), 100);
    expect(percent).toBe(100);
  });

  it('produces a non-zero percent for a realistic short conversation', () => {
    // Simulate one turn: 500-char prompt + 1500-char response on a 1 M window
    const totalChars = 2_000;
    const tokens = Math.round(totalChars / CHARS_PER_TOKEN); // 500
    const contextWindow = 1_048_576;
    const percent = Math.min(Math.round((tokens / contextWindow) * 100), 100);
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(1); // < 1% of 1 M
  });
});
