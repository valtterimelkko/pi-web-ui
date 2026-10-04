import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const { synthesizeSpeechMock, notConfiguredClass } = vi.hoisted(() => {
  class TtsNotConfiguredError extends Error {}
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    synthesizeSpeechMock: vi.fn() as any,
    notConfiguredClass: TtsNotConfiguredError,
  };
});

vi.mock('../../../src/tts/speech.js', () => ({
  synthesizeSpeech: synthesizeSpeechMock,
  resolveVoice: (v: unknown) => (typeof v === 'string' ? v : 'Kore'),
  GEMINI_VOICES: ['Kore', 'Puck'],
  DEFAULT_VOICE: 'Kore',
  TtsNotConfiguredError: notConfiguredClass,
}));

import ttsRoutes from '../../../src/routes/tts.js';
import request from 'supertest';

describe('TTS Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/tts', ttsRoutes);
  });

  it('returns the synthesised audio with the service content type', async () => {
    synthesizeSpeechMock.mockResolvedValue({
      audio: Buffer.from([0x01, 0x02, 0x03]),
      contentType: 'audio/wav',
      model: 'google/gemini-3.8-flash-lite-tts',
      usedFallback: false,
    });
    const res = await request(app).post('/api/tts').send({ text: 'Hello there.', voice: 'Kore' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
    expect(res.headers['content-length']).toBe('3');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(synthesizeSpeechMock).toHaveBeenCalledWith('Hello there.', 'Kore');
  });

  it('rejects missing or empty text with 400', async () => {
    const res = await request(app).post('/api/tts').send({ voice: 'Kore' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing or empty text/i);
    expect(synthesizeSpeechMock).not.toHaveBeenCalled();
  });

  it('rejects text over the maximum length with 400', async () => {
    const res = await request(app).post('/api/tts').send({ text: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum length/i);
  });

  it('maps a missing key configuration to 503', async () => {
    synthesizeSpeechMock.mockRejectedValue(new notConfiguredClass('TTS not configured'));
    const res = await request(app).post('/api/tts').send({ text: 'Hello' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('maps a synthesis failure to 502 with detail', async () => {
    synthesizeSpeechMock.mockRejectedValue(new Error('OpenRouter TTS HTTP 500'));
    const res = await request(app).post('/api/tts').send({ text: 'Hello' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Failed to generate speech');
    expect(res.body.detail).toBe('OpenRouter TTS HTTP 500');
  });
});
