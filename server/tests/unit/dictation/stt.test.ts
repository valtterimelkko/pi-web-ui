import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';

const { configState } = vi.hoisted(() => ({
  configState: { openrouterApiKey: 'test-or-key' as string | undefined },
}));

vi.mock('../../../src/config.js', () => ({
  config: new Proxy(configState, {
    get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : undefined),
  }),
}));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/logging/logger.js', () => ({
  createLogger: () => mockLogger,
}));

vi.mock('../../../src/dictation/connectionPool.js', () => ({
  getSharedOpenAIClient: vi.fn(),
}));

import { getSharedOpenAIClient } from '../../../src/dictation/connectionPool.js';
import { transcribeWithFallback, startSpeculativeTranscription, shouldUseSpeculative } from '../../../src/dictation/stt.js';

function mockOpenAIClient(transcriptionResult: string) {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue(transcriptionResult),
      },
    },
  };
}

interface CapturedRequest {
  auth: string;
  body: Buffer;
  contentType: string;
}

function fakeSttServer(status: number, responseBody: object) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        auth: req.headers.authorization ?? '',
        body: Buffer.concat(chunks),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  return new Promise<{ url: string; requests: CapturedRequest[]; close: () => void }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({
          url: `http://127.0.0.1:${port}/x`,
          requests,
          close: () => server.close(),
        });
      });
    },
  );
}

type Step = { status: number; body: object } | 'hang';

/** Serves the given steps in order (the last step repeats); 'hang' never answers. */
function sequenceSttServer(steps: Step[]) {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        auth: req.headers.authorization ?? '',
        body: Buffer.concat(chunks),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      if (step === 'hang') return;
      res.writeHead(step.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(step.body));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise<{ url: string; requests: CapturedRequest[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/x`,
        requests,
        close: () => { for (const s of sockets) s.destroy(); server.close(); },
      });
    });
  });
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined) {
  savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('STT Service (three-tier, Benchmark 6 selection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configState.openrouterApiKey = 'test-or-key';
    setEnv('OPENROUTER_STT_URL', undefined);
    setEnv('LOCAL_ASR_URL', undefined);
    setEnv('STT_REQUEST_TIMEOUT_MS', undefined);
    setEnv('STT_RETRY_DELAY_MS', '10');
  });

  it('uses the OpenRouter whisper-turbo tier first (DeepInfra pin, webm body)', async () => {
    const fake = await fakeSttServer(200, { text: 'Hello world' });
    setEnv('OPENROUTER_STT_URL', fake.url);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')], 'Claude, Anthropic');
      expect(result.text).toBe('Hello world');
      expect(result.model).toBe('openai/whisper-large-v3-turbo');
      expect(result.usedFallback).toBe(false);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].auth).toBe('Bearer test-or-key');
      const payload = JSON.parse(fake.requests[0].body.toString('utf8'));
      expect(payload.model).toBe('openai/whisper-large-v3-turbo');
      expect(payload.provider).toEqual({ order: ['DeepInfra'], allow_fallbacks: false });
      expect(payload.input_audio.format).toBe('webm');
      expect(Buffer.from(payload.input_audio.data, 'base64').toString()).toBe('audio');
      expect(payload.prompt).toBe('Claude, Anthropic');
      expect(getSharedOpenAIClient).not.toHaveBeenCalled();
    } finally {
      fake.close();
    }
  });

  it('falls back to the local Parakeet service when OpenRouter fails', async () => {
    const orFail = await fakeSttServer(500, { error: 'down' });
    const local = await fakeSttServer(200, { text: 'local text' });
    setEnv('OPENROUTER_STT_URL', orFail.url);
    setEnv('LOCAL_ASR_URL', local.url);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')]);
      expect(result.text).toBe('local text');
      expect(result.usedFallback).toBe(true);
      expect(result.model).toContain('parakeet');
      expect(local.requests[0].contentType).toContain('multipart/form-data');
      expect(local.requests[0].body.toString('utf8')).toContain('name="audio_file"');
      expect(getSharedOpenAIClient).not.toHaveBeenCalled();
    } finally {
      orFail.close(); local.close();
    }
  });

  it('uses OpenAI gpt-transcribe as the last resort when both tiers fail', async () => {
    const orFail = await fakeSttServer(500, { error: 'down' });
    setEnv('OPENROUTER_STT_URL', orFail.url);
    setEnv('LOCAL_ASR_URL', 'http://127.0.0.1:9/asr');
    const client = mockOpenAIClient('openai last resort');
    vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')], 'vocab');
      expect(result.text).toBe('openai last resort');
      expect(result.usedFallback).toBe(true);
      expect(result.model).toBe('gpt-transcribe');
      expect(client.audio.transcriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-transcribe', prompt: 'vocab' }),
      );
    } finally {
      orFail.close();
    }
  });

  it('skips the OpenRouter tier entirely when no key is configured', async () => {
    configState.openrouterApiKey = undefined;
    const orFail = await fakeSttServer(200, { text: 'should not be reached' });
    const local = await fakeSttServer(200, { text: 'local text' });
    setEnv('OPENROUTER_STT_URL', orFail.url);
    setEnv('LOCAL_ASR_URL', local.url);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')]);
      expect(result.text).toBe('local text');
      expect(orFail.requests).toHaveLength(0);
    } finally {
      orFail.close(); local.close();
    }
  });

  it('startSpeculativeTranscription snapshots chunks and resolves via the tiers', async () => {
    const fake = await fakeSttServer(200, { text: 'speculative text' });
    setEnv('OPENROUTER_STT_URL', fake.url);
    try {
      const spec = startSpeculativeTranscription([Buffer.from('a'), Buffer.from('b')]);
      expect(spec.chunkCount).toBe(2);
      const result = await spec.promise;
      expect(result.text).toBe('speculative text');
    } finally {
      fake.close();
    }
  });

  it('shouldUseSpeculative keeps the reuse-ratio rule', () => {
    const spec = { promise: Promise.resolve({ text: '', model: '', usedFallback: false }), chunkCount: 10, startedAt: 0 };
    expect(shouldUseSpeculative(spec, 8)).toBe(true);
    expect(shouldUseSpeculative(spec, 10)).toBe(true);
    expect(shouldUseSpeculative(spec, 11)).toBe(true);   // 1/11 new < 0.3
    expect(shouldUseSpeculative(spec, 20)).toBe(false);  // 10/20 new >= 0.3
  });

  it('retries the OpenRouter tier once on a transient 5xx and stays on the primary tier', async () => {
    const or = await sequenceSttServer([{ status: 503, body: { error: 'busy' } }, { status: 200, body: { text: 'second try' } }]);
    setEnv('OPENROUTER_STT_URL', or.url);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')]);
      expect(result.text).toBe('second try');
      expect(result.usedFallback).toBe(false);
      expect(or.requests).toHaveLength(2);
    } finally {
      or.close();
    }
  });

  it('does not retry a non-transient 4xx and falls through to the local tier', async () => {
    const or = await sequenceSttServer([{ status: 401, body: { error: 'bad key' } }]);
    const local = await fakeSttServer(200, { text: 'local text' });
    setEnv('OPENROUTER_STT_URL', or.url);
    setEnv('LOCAL_ASR_URL', local.url);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')]);
      expect(result.text).toBe('local text');
      expect(or.requests).toHaveLength(1);
    } finally {
      or.close(); local.close();
    }
  });

  it('does not retry an empty transcript but logs enough to diagnose it', async () => {
    const or = await sequenceSttServer([{ status: 200, body: { text: '   ', usage: { seconds: 3 } } }]);
    const local = await fakeSttServer(200, { text: 'local text' });
    setEnv('OPENROUTER_STT_URL', or.url);
    setEnv('LOCAL_ASR_URL', local.url);
    try {
      const result = await transcribeWithFallback([Buffer.alloc(1234)]);
      expect(result.text).toBe('local text');
      expect(or.requests).toHaveLength(1);
      const lines = mockLogger.error.mock.calls.map((c) => c.map(String).join(' '));
      const line = lines.find((l) => l.includes('tier=openrouter') && l.includes('outcome=empty'));
      expect(line).toBeDefined();
      expect(line).toContain('bytes=1234');
      expect(line).toContain('seconds');
    } finally {
      or.close(); local.close();
    }
  });

  it('times out a hung OpenRouter request, retries once, then uses the local tier', async () => {
    setEnv('STT_REQUEST_TIMEOUT_MS', '150');
    const or = await sequenceSttServer(['hang']);
    const local = await fakeSttServer(200, { text: 'local text' });
    setEnv('OPENROUTER_STT_URL', or.url);
    setEnv('LOCAL_ASR_URL', local.url);
    try {
      const started = Date.now();
      const result = await transcribeWithFallback([Buffer.from('audio')]);
      expect(result.text).toBe('local text');
      expect(or.requests).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(3000);
      const lines = mockLogger.error.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines.some((l) => l.includes('tier=openrouter') && l.includes('outcome=timeout'))).toBe(true);
    } finally {
      or.close(); local.close();
    }
  });

  it('times out a hung local tier and reaches OpenAI', async () => {
    setEnv('STT_REQUEST_TIMEOUT_MS', '150');
    const or = await sequenceSttServer([{ status: 401, body: {} }]);
    const local = await sequenceSttServer(['hang']);
    setEnv('OPENROUTER_STT_URL', or.url);
    setEnv('LOCAL_ASR_URL', local.url);
    vi.mocked(getSharedOpenAIClient).mockReturnValue(mockOpenAIClient('openai text') as never);
    try {
      const result = await transcribeWithFallback([Buffer.from('audio')]);
      expect(result.text).toBe('openai text');
    } finally {
      or.close(); local.close();
    }
  });

  it('logs one structured info line per successful attempt so tier usage can be counted', async () => {
    const fake = await fakeSttServer(200, { text: 'Hello world' });
    setEnv('OPENROUTER_STT_URL', fake.url);
    try {
      await transcribeWithFallback([Buffer.from('audio')]);
      const lines = mockLogger.info.mock.calls.map((c) => c.map(String).join(' '));
      const line = lines.find((l) => l.includes('tier=openrouter') && l.includes('outcome=ok'));
      expect(line).toBeDefined();
      expect(line).toMatch(/ms=\d+/);
      expect(line).toContain('bytes=5');
    } finally {
      fake.close();
    }
  });

  it('logs the final failure when every tier fails', async () => {
    const or = await sequenceSttServer([{ status: 401, body: {} }]);
    setEnv('OPENROUTER_STT_URL', or.url);
    setEnv('LOCAL_ASR_URL', 'http://127.0.0.1:9/asr');
    const client = { audio: { transcriptions: { create: vi.fn().mockRejectedValue(new Error('openai down')) } } };
    vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);
    try {
      await expect(transcribeWithFallback([Buffer.from('audio')])).rejects.toThrow('openai down');
      const lines = mockLogger.error.mock.calls.map((c) => c.map(String).join(' '));
      expect(lines.some((l) => l.includes('tier=openai') && l.includes('outcome=error'))).toBe(true);
    } finally {
      or.close();
    }
  });
});
