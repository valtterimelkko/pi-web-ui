import { describe, it, expect, vi } from 'vitest';

// RED: module does not exist yet.
import { OpenRouterTalkerClient, resolveTalkerModelConfig } from '../../../src/talker/model-client.js';

function sseResponse(chunks: string[], opts?: { firstChunkDelayMs?: number }) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            const chunk = chunks[i++];
            const delay = i === 1 ? (opts?.firstChunkDelayMs ?? 0) : 0;
            return new Promise(resolve => setTimeout(() => resolve({ done: false, value: encoder.encode(chunk) }), delay));
          },
        };
      },
    },
  } as unknown as Response;
}

const BASE_BODY = {
  model: 'google/gemma-4-26b-a4b-it',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
  temperature: 0.3,
  max_tokens: 400,
  reasoning: { enabled: false },
};

describe('resolveTalkerModelConfig', () => {
  it('defaults to the selected production talker with thinking off shape', () => {
    const cfg = resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' });
    expect(cfg.model).toBe('google/gemma-4-26b-a4b-it');
    expect(cfg.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.temperature).toBe(0.3);
    expect(cfg.maxTokens).toBe(400);
  });

  it('reads the key from TALKER_API_KEY, falling back to OPENROUTER_API_KEY', () => {
    expect(resolveTalkerModelConfig({ TALKER_API_KEY: 'a' }).apiKey).toBe('a');
    expect(resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'b' }).apiKey).toBe('b');
    expect(resolveTalkerModelConfig({ TALKER_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }).apiKey).toBe('a');
  });

  it('throws an honest error when no key is configured', () => {
    expect(() => resolveTalkerModelConfig({})).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('OpenRouterTalkerClient', () => {
  it('reproduces the validated spot-check call shape exactly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    const client = new OpenRouterTalkerClient(resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }), fetchImpl as unknown as typeof fetch);
    const result = await client.completeTurn([{ role: 'user', content: 'hello' }]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer k');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body).toEqual(BASE_BODY);
    expect(result.text).toBe('Hi');
    expect(result.ttftMs).toBeTypeOf('number');
    expect(result.totalMs).toBeTypeOf('number');
  });

  it('measures first-token latency (non-zero when the first chunk is delayed)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ], { firstChunkDelayMs: 60 }));
    const client = new OpenRouterTalkerClient(resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }), fetchImpl as unknown as typeof fetch);
    const result = await client.completeTurn([{ role: 'user', content: 'hello' }]);
    expect(result.ttftMs).toBeGreaterThanOrEqual(50);
  });

  it('surfaces provider errors honestly instead of fabricating a reply', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') } as unknown as Response);
    const client = new OpenRouterTalkerClient(resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }), fetchImpl as unknown as typeof fetch);
    await expect(client.completeTurn([{ role: 'user', content: 'hello' }])).rejects.toThrow(/502/);
  });
});
