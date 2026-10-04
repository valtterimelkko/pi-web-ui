import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';

const { configState } = vi.hoisted(() => ({
  configState: {
    openrouterApiKey: 'test-or-key' as string | undefined,
    ttsModel: 'google/gemini-3.8-flash-lite-tts' as string,
    ttsOpenaiApiKey: 'test-oai-key' as string | undefined,
    ttsOpenaiFallbackModel: 'gpt-4o-mini-tts' as string,
  },
}));

vi.mock('../../../src/config.js', () => ({
  config: new Proxy(configState, {
    get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : undefined),
  }),
}));

import {
  resolveVoice,
  pcmToWav,
  synthesizeSpeech,
  TtsNotConfiguredError,
  GEMINI_VOICES,
} from '../../../src/tts/speech.js';

interface CapturedRequest {
  url: string;
  auth: string;
  body: string;
  contentType: string;
}

function fakeServer(
  status: number,
  responseBody: Buffer,
  responseContentType: string
) {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        auth: req.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      res.writeHead(status, { 'Content-Type': responseContentType });
      res.end(responseBody);
    });
  });
  return new Promise<{ url: string; requests: CapturedRequest[]; close: () => void }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          requests,
          close: () => server.close(),
        });
      });
    }
  );
}

describe('TTS voice resolution', () => {
  it('passes the 30 Gemini studio voices through, case-insensitively', () => {
    expect(GEMINI_VOICES).toHaveLength(30);
    expect(resolveVoice('Kore')).toBe('Kore');
    expect(resolveVoice('kore')).toBe('Kore');
    expect(resolveVoice('zephyr')).toBe('Zephyr');
  });

  it('maps legacy OpenAI voice names onto Gemini voices so saved prefs keep working', () => {
    expect(resolveVoice('alloy')).toBe('Kore');
    expect(resolveVoice('echo')).toBe('Puck');
    expect(resolveVoice('shimmer')).toBe('Zephyr');
  });

  it('falls back to the default voice for unknown or missing values', () => {
    expect(resolveVoice(undefined)).toBe('Kore');
    expect(resolveVoice(42)).toBe('Kore');
    expect(resolveVoice('not-a-voice')).toBe('Kore');
  });
});

describe('pcmToWav', () => {
  it('wraps raw s16le PCM in a valid 44-byte RIFF header at 24 kHz mono', () => {
    const pcm = Buffer.alloc(4800, 0x01);
    const wav = pcmToWav(pcm, 24000, 1);
    expect(wav.length).toBe(4800 + 44);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 4800);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(4800);
  });

  it('handles 16 kHz mono for other pcm sources', () => {
    const wav = pcmToWav(Buffer.alloc(2), 16000, 1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
  });
});

describe('synthesizeSpeech', () => {
  let primary: Awaited<ReturnType<typeof fakeServer>>;
  let fallback: Awaited<ReturnType<typeof fakeServer>>;

  beforeEach(async () => {
    configState.openrouterApiKey = 'test-or-key';
    configState.ttsOpenaiApiKey = 'test-oai-key';
    configState.ttsModel = 'google/gemini-3.8-flash-lite-tts';
    configState.ttsOpenaiFallbackModel = 'gpt-4o-mini-tts';
    primary = await fakeServer(
      200,
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      'audio/pcm;rate=24000;channels=1'
    );
    fallback = await fakeServer(200, Buffer.from([0x0a, 0x0b]), 'audio/mpeg');
    process.env.OPENROUTER_TTS_URL = `${primary.url}/audio/speech`;
    process.env.OPENAI_TTS_URL = `${fallback.url}/audio/speech`;
  });

  afterAll(async () => {
    delete process.env.OPENROUTER_TTS_URL;
    delete process.env.OPENAI_TTS_URL;
  });

  it('synthesises through OpenRouter Gemini, wrapping pcm in a WAV container', async () => {
    const result = await synthesizeSpeech('Good evening.', 'Kore');
    expect(result.usedFallback).toBe(false);
    expect(result.model).toBe('google/gemini-3.8-flash-lite-tts');
    expect(result.contentType).toBe('audio/wav');
    expect(result.audio.length).toBe(4 + 44);
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF');

    expect(primary.requests).toHaveLength(1);
    const req = primary.requests[0];
    expect(req.auth).toBe('Bearer test-or-key');
    expect(req.url).toBe('/audio/speech');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'google/gemini-3.8-flash-lite-tts',
      input: 'Good evening.',
      voice: 'Kore',
      response_format: 'pcm',
    });
  });

  it('resolves legacy voice names before calling the provider', async () => {
    await synthesizeSpeech('Hello.', 'alloy');
    const body = JSON.parse(primary.requests[0].body) as Record<string, unknown>;
    expect(body.voice).toBe('Kore');
  });

  it('falls back to the OpenAI leg, serving mp3, when the primary fails', async () => {
    await primary.close();
    primary = await fakeServer(400, Buffer.from(JSON.stringify({ error: { message: 'bad' } })), 'application/json');
    process.env.OPENROUTER_TTS_URL = `${primary.url}/audio/speech`;

    const result = await synthesizeSpeech('Fallback please.', 'Kore');
    expect(result.usedFallback).toBe(true);
    expect(result.model).toBe('gpt-4o-mini-tts');
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.audio.length).toBe(2);

    expect(fallback.requests).toHaveLength(1);
    const req = fallback.requests[0];
    expect(req.auth).toBe('Bearer test-oai-key');
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      response_format: 'mp3',
    });
  });

  it('throws with provider detail when both tiers fail', async () => {
    await primary.close();
    await fallback.close();
    primary = await fakeServer(500, Buffer.from('nope'), 'text/plain');
    fallback = await fakeServer(502, Buffer.from('nope'), 'text/plain');
    process.env.OPENROUTER_TTS_URL = `${primary.url}/audio/speech`;
    process.env.OPENAI_TTS_URL = `${fallback.url}/audio/speech`;

    await expect(synthesizeSpeech('doomed', 'Kore')).rejects.toThrow(/OpenAI TTS HTTP 502/);
  });

  it('raises TtsNotConfiguredError when neither key is configured', async () => {
    configState.openrouterApiKey = undefined;
    configState.ttsOpenaiApiKey = undefined;
    await expect(synthesizeSpeech('unconfigured', 'Kore')).rejects.toBeInstanceOf(TtsNotConfiguredError);
  });
});
