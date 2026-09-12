import { describe, it, expect, vi } from 'vitest';

// RED: the H5 pieces (provider preference, isDegenerateReply, bounded retry) do not exist yet.
import { OpenRouterTalkerClient, isDegenerateReply, resolveTalkerModelConfig } from '../../../src/talker/model-client.js';

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
  // H5: several of the 11 inference providers serving this model return
  // degenerate output; the request must ask OpenRouter to prefer the
  // measured-good ones while keeping fallbacks allowed.
  provider: { order: ['deepinfra', 'darkbloom', 'novita'], allow_fallbacks: true },
};

const CHANNEL_LEAK_REPLY = '<|channel>thought\n<channel|>';
const REPETITION_REPLY = Array(12).fill('thought').join(' ');

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

  // H3's retest proved this is a real defect, not a hypothetical: some OpenRouter
  // endpoints reject a disabled-reasoning request outright with HTTP 400
  // "Reasoning is mandatory for this endpoint and cannot be disabled"
  // (google/gemini-3.6-flash and openai/gpt-5-nano among the tested candidates).
  // A hardcoded `reasoning: { enabled: false }` therefore makes the talker unable
  // to run on those models at all.
  describe('configurable reasoning (H3 defect)', () => {
    it('defaults to disabled reasoning so the selected production model is unchanged', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const client = new OpenRouterTalkerClient(resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }), fetchImpl as unknown as typeof fetch);
      await client.completeTurn([{ role: 'user', content: 'hello' }]);
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.reasoning).toEqual({ enabled: false });
    });

    it('sends a configured reasoning effort instead of disabling it', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const cfg = { ...resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }), reasoningEffort: 'minimal' as const };
      const client = new OpenRouterTalkerClient(cfg, fetchImpl as unknown as typeof fetch);
      await client.completeTurn([{ role: 'user', content: 'hello' }]);
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.reasoning).toEqual({ effort: 'minimal' });
    });

    it('omits the reasoning field entirely when configured to', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]));
      const cfg = { ...resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }), reasoningEffort: 'omit' as const };
      const client = new OpenRouterTalkerClient(cfg, fetchImpl as unknown as typeof fetch);
      await client.completeTurn([{ role: 'user', content: 'hello' }]);
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body).not.toHaveProperty('reasoning');
    });
  });

  // H5: measured inference-provider defect. The model is fine; several of the
  // 11 providers serving it return (a) raw thought-channel markers in the
  // content field, (b) HTTP 200 with empty content, or (c) runaway repetition.
  // Detection is for RETRYING, not salvaging: the leak replies are entirely
  // channel noise, so stripping markers would leave an empty string.
  describe('H5: provider preference + degenerate-output guard + bounded retry', () => {
    const GOOD_REPLY = 'Holding phase 3 for your review.';

    function goodSse() {
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: GOOD_REPLY } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }

    function degenerateSse(text: string) {
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }

    function emptySse() {
      return sseResponse(['data: [DONE]\n\n']);
    }

    function makeClient(fetchImpl: ReturnType<typeof vi.fn>) {
      return new OpenRouterTalkerClient(
        resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k' }),
        fetchImpl as unknown as typeof fetch,
      );
    }

    describe('part 1: provider preference', () => {
      it('asks OpenRouter to prefer the measured-good providers while allowing fallbacks', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(goodSse());
        await makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }]);
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.provider).toEqual({ order: ['deepinfra', 'darkbloom', 'novita'], allow_fallbacks: true });
      });

      it('honours a TALKER_PROVIDER_ORDER override so the preference can be re-targeted when the provider set changes', () => {
        const cfg = resolveTalkerModelConfig({ OPENROUTER_API_KEY: 'k', TALKER_PROVIDER_ORDER: 'novita, deepinfra' });
        expect(cfg.providerOrder).toEqual(['novita', 'deepinfra']);
      });
    });

    describe('part 2: degenerate-output detection', () => {
      it('flags the empty reply', () => {
        expect(isDegenerateReply('')).toBe(true);
        expect(isDegenerateReply('   \n  ')).toBe(true);
      });

      it('flags the thought-channel leak', () => {
        expect(isDegenerateReply(CHANNEL_LEAK_REPLY)).toBe(true);
        expect(isDegenerateReply(`<|channel>thought\nsome leaked text<channel|>`)).toBe(true);
      });

      it('flags runaway repetition (very low unique-word ratio)', () => {
        expect(isDegenerateReply(REPETITION_REPLY)).toBe(true);
        expect(isDegenerateReply('the worker is waiting the worker is waiting the worker is waiting the worker')).toBe(true);
      });

      it('flags a reply dominated by the word "thought"', () => {
        expect(isDegenerateReply('thought said thought the thought worker thought is thought waiting')).toBe(true);
      });

      it('passes normal replies through untouched', () => {
        expect(isDegenerateReply(GOOD_REPLY)).toBe(false);
        expect(isDegenerateReply('Done — both workers are running, phase 3 is held for you.')).toBe(false);
        expect(isDegenerateReply(' worker 1 finished the transfer handler; worker 2 stays held until your review. ')).toBe(false);
      });

      it('does not flag short replies below the repetition thresholds', () => {
        // < 8 words: the ratio heuristics must not fire on natural short speech.
        expect(isDegenerateReply('no no no, hold that')).toBe(false);
        expect(isDegenerateReply('thought about it, it is fine')).toBe(false);
      });
    });

    describe('part 3: one bounded retry on a degenerate reply', () => {
      it.each([
        ['thought-channel leak', () => degenerateSse(CHANNEL_LEAK_REPLY)],
        ['empty content', () => emptySse()],
        ['runaway repetition', () => degenerateSse(REPETITION_REPLY)],
      ])('retries once on %s and returns the good reply', async (_label, bad) => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(bad()).mockResolvedValueOnce(goodSse());
        const result = await makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }]);
        expect(result.text).toBe(GOOD_REPLY);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(result.retries).toBe(1);
      });

      it('carries the provider preference on the retry as well', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(degenerateSse(CHANNEL_LEAK_REPLY)).mockResolvedValueOnce(goodSse());
        await makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }]);
        expect(JSON.parse(fetchImpl.mock.calls[1][1].body).provider).toEqual(BASE_BODY.provider);
      });

      it('stops at exactly two calls and throws an honest failure when the reply is still degenerate — never a loop, never a fabricated reply', async () => {
        const fetchImpl = vi.fn()
          .mockResolvedValueOnce(sseResponse([
            `data: ${JSON.stringify({ provider: 'makora', choices: [{ delta: { content: CHANNEL_LEAK_REPLY } }] })}\n\n`,
            'data: [DONE]\n\n',
          ]))
          .mockResolvedValueOnce(sseResponse([
            `data: ${JSON.stringify({ provider: 'siliconflow', choices: [{ delta: { content: '' } }] })}\n\n`,
            'data: [DONE]\n\n',
          ]));
        await expect(makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }]))
          .rejects.toThrow(/degenerate output after 2 attempts.*makora.*siliconflow/s);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      });

      it('reports which inference provider served the kept reply (OpenRouter names it per chunk)', async () => {
        const fetchImpl = vi.fn()
          .mockResolvedValueOnce(sseResponse([
            `data: ${JSON.stringify({ provider: 'makora', choices: [{ delta: { content: CHANNEL_LEAK_REPLY } }] })}\n\n`,
            'data: [DONE]\n\n',
          ]))
          .mockResolvedValueOnce(sseResponse([
            `data: ${JSON.stringify({ provider: 'deepinfra', choices: [{ delta: { content: GOOD_REPLY } }] })}\n\n`,
            'data: [DONE]\n\n',
          ]));
        const result = await makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }]);
        expect(result.provider).toBe('deepinfra');
      });
    });

    it('does NOT retry a good reply (regression guard against retry storms)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(goodSse());
      const result = await makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }]);
      expect(result.text).toBe(GOOD_REPLY);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.retries).toBe(0);
    });

    it('still surfaces provider HTTP errors honestly without a content retry', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') } as unknown as Response);
      await expect(makeClient(fetchImpl).completeTurn([{ role: 'user', content: 'hello' }])).rejects.toThrow(/502/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
