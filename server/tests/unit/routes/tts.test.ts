import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../../../src/config.js', () => ({
  config: {
    ttsOpenaiApiKey: 'sk-test-key',
    ttsModel: 'tts-1',
  },
}));

import ttsRoutes from '../../../src/routes/tts.js';
import request from 'supertest';

describe('TTS Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/tts', ttsRoutes);
  });

  describe('POST /api/tts', () => {
    it('should return audio/mp3 for valid text', async () => {
      const fakeAudio = Buffer.from('fake-mp3-data');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
      }));

      const res = await request(app)
        .post('/api/tts')
        .send({ text: 'Hello world', voice: 'alloy' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('audio/mpeg');
      expect(res.body).toEqual(fakeAudio);
    });

    it('should use configured TTS model', async () => {
      const fakeAudio = Buffer.from('fake-mp3-data');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
      });
      vi.stubGlobal('fetch', mockFetch);

      const res = await request(app)
        .post('/api/tts')
        .send({ text: 'Hello world' });

      expect(res.status).toBe(200);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('tts-1');
    });

    it('should use default voice when voice is omitted', async () => {
      const fakeAudio = Buffer.from('fake-mp3-data');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
      });
      vi.stubGlobal('fetch', mockFetch);

      const res = await request(app)
        .post('/api/tts')
        .send({ text: 'Hello world' });

      expect(res.status).toBe(200);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.voice).toBe('alloy');
    });

    it('should reject invalid voice names', async () => {
      const fakeAudio = Buffer.from('fake-mp3-data');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeAudio.buffer.slice(fakeAudio.byteOffset, fakeAudio.byteOffset + fakeAudio.byteLength),
      });
      vi.stubGlobal('fetch', mockFetch);

      const res = await request(app)
        .post('/api/tts')
        .send({ text: 'Hello world', voice: 'invalid-voice' });

      expect(res.status).toBe(200);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.voice).toBe('alloy');
    });

    it('should return 400 for missing text', async () => {
      const res = await request(app)
        .post('/api/tts')
        .send({ voice: 'alloy' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Missing or empty text field' });
    });

    it('should return 400 for empty text', async () => {
      const res = await request(app)
        .post('/api/tts')
        .send({ text: '   ' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Missing or empty text field' });
    });

    it('should return 400 for text exceeding max length', async () => {
      const longText = 'a'.repeat(4001);
      const res = await request(app)
        .post('/api/tts')
        .send({ text: longText });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('exceeds maximum length');
    });

    it('should return 502 when OpenAI returns an error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'OpenAI rate limit' } }),
      }));

      const res = await request(app)
        .post('/api/tts')
        .send({ text: 'Hello world' });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({
        error: 'Failed to generate speech',
        detail: 'OpenAI rate limit',
      });
    });

    it('should return 502 when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const res = await request(app)
        .post('/api/tts')
        .send({ text: 'Hello world' });

      expect(res.status).toBe(502);
      expect(res.body.error).toBe('Failed to generate speech');
      expect(res.body.detail).toBe('Network error');
    });
  });
});
