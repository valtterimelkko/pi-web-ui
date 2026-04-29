import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/dictation/connectionPool.js', () => ({
  getSharedOpenAIClient: vi.fn(),
}));

import { getSharedOpenAIClient } from '../../../src/dictation/connectionPool.js';
import { cleanupTranscript } from '../../../src/dictation/cleanup.js';

describe('Cleanup Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call OpenAI with gpt-5-nano and return cleaned text', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'Cleaned up transcript here.' } }],
          }),
        },
      },
    };
    vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

    const result = await cleanupTranscript('raw transcript here');

    expect(result.cleanedText).toBe('Cleaned up transcript here.');
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-nano',
        temperature: 0.3,
      })
    );
  });

  it('should include system prompt about British English', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'cleaned' } }],
          }),
        },
      },
    };
    vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

    await cleanupTranscript('organize the color');

    const call = client.chat.completions.create.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const systemMsg = call.messages.find(m => m.role === 'system');
    expect(systemMsg?.content).toContain('British');
    expect(systemMsg?.content).toContain('color→colour');
  });

  it('should fall back to raw text if cleanup returns empty', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '' } }],
          }),
        },
      },
    };
    vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

    const result = await cleanupTranscript('raw text here');

    expect(result.cleanedText).toBe('raw text here');
  });

  it('should fall back to raw text if API returns no choices', async () => {
    const client = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [],
          }),
        },
      },
    };
    vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

    const result = await cleanupTranscript('raw text here');

    expect(result.cleanedText).toBe('raw text here');
  });
});
