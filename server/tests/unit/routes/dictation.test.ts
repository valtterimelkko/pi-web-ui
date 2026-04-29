import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../../../src/dictation/stt.js', () => ({
  transcribeWithFallback: vi.fn().mockResolvedValue({
    text: 'Hello world this is a test',
    model: 'gpt-4o-mini-transcribe',
    usedFallback: false,
  }),
  startSpeculativeTranscription: vi.fn().mockReturnValue(null),
  shouldUseSpeculative: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/dictation/cleanup.js', () => ({
  cleanupTranscript: vi.fn().mockResolvedValue({
    cleanedText: 'Hello world. This is a test.',
  }),
}));

vi.mock('../../../src/dictation/connectionPool.js', () => ({
  warmupConnections: vi.fn().mockResolvedValue(undefined),
}));

import dictationRoutes, { getActiveRecordingCount } from '../../../src/routes/dictation.js';
import { transcribeWithFallback, shouldUseSpeculative } from '../../../src/dictation/stt.js';
import { cleanupTranscript } from '../../../src/dictation/cleanup.js';
import { warmupConnections } from '../../../src/dictation/connectionPool.js';
import request from 'supertest';

describe('Dictation Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
    app.use('/api/dictation', dictationRoutes);
  });

  describe('POST /api/dictation/warmup', () => {
    it('should warm up connections', async () => {
      const res = await request(app).post('/api/dictation/warmup');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(warmupConnections).toHaveBeenCalledOnce();
    });
  });

  describe('POST /api/dictation/start', () => {
    it('should create a recording session and return an id', async () => {
      const res = await request(app).post('/api/dictation/start');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('id');
      expect(typeof res.body.id).toBe('string');
      expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('should track active recordings', async () => {
      const countBefore = getActiveRecordingCount();
      await request(app).post('/api/dictation/start');
      expect(getActiveRecordingCount()).toBe(countBefore + 1);
    });
  });

  describe('POST /api/dictation/:id/stream', () => {
    it('should accept binary audio chunks', async () => {
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      const audioChunk = Buffer.from('fake-audio-data');
      const streamRes = await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(audioChunk);

      expect(streamRes.status).toBe(200);
      expect(streamRes.body).toEqual({ ok: true });
    });

    it('should return 404 for unknown recording id', async () => {
      const res = await request(app)
        .post('/api/dictation/nonexistent-id/stream')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('data'));

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Recording session not found' });
    });

    it('should return 400 for empty chunk', async () => {
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      const res = await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(0));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Empty or invalid audio chunk' });
    });
  });

  describe('POST /api/dictation/:id/finish', () => {
    it('should transcribe and clean up audio', async () => {
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('fake-audio-chunk-1'));

      const finishRes = await request(app).post(`/api/dictation/${id}/finish`);

      expect(finishRes.status).toBe(200);
      expect(finishRes.body).toHaveProperty('text', 'Hello world. This is a test.');
      expect(finishRes.body).toHaveProperty('duration_ms');
      expect(typeof finishRes.body.duration_ms).toBe('number');

      expect(transcribeWithFallback).toHaveBeenCalledOnce();
      expect(cleanupTranscript).toHaveBeenCalledWith('Hello world this is a test');
    });

    it('should remove recording from active set after finish', async () => {
      const countBefore = getActiveRecordingCount();
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      expect(getActiveRecordingCount()).toBe(countBefore + 1);

      await request(app).post(`/api/dictation/${id}/finish`);

      expect(getActiveRecordingCount()).toBe(countBefore);
    });

    it('should return 404 for unknown recording id', async () => {
      const res = await request(app).post('/api/dictation/nonexistent-id/finish');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Recording session not found' });
    });

    it('should return raw text if cleanup fails', async () => {
      vi.mocked(cleanupTranscript).mockRejectedValueOnce(new Error('cleanup failed'));

      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('fake-audio'));

      const finishRes = await request(app).post(`/api/dictation/${id}/finish`);

      expect(finishRes.status).toBe(200);
      expect(finishRes.body).toHaveProperty('text', 'Hello world this is a test');
    });

    it('should return empty text if STT fails', async () => {
      vi.mocked(transcribeWithFallback).mockRejectedValueOnce(new Error('stt failed'));
      vi.mocked(shouldUseSpeculative).mockReturnValueOnce(false);

      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      const finishRes = await request(app).post(`/api/dictation/${id}/finish`);

      expect(finishRes.status).toBe(200);
      expect(finishRes.body).toHaveProperty('text', '');
    });
  });

  describe('Full recording lifecycle', () => {
    it('should handle start -> stream -> stream -> finish', async () => {
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('chunk-1'));

      await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('chunk-2'));

      const finishRes = await request(app).post(`/api/dictation/${id}/finish`);

      expect(finishRes.status).toBe(200);
      expect(finishRes.body).toHaveProperty('text', 'Hello world. This is a test.');

      const audioChunks = vi.mocked(transcribeWithFallback).mock.calls[0][0] as Buffer[];
      expect(audioChunks.length).toBe(2);
    });

    it('should not allow streaming to a finished recording', async () => {
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      await request(app).post(`/api/dictation/${id}/finish`);

      const streamRes = await request(app)
        .post(`/api/dictation/${id}/stream`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('late-chunk'));

      expect(streamRes.status).toBe(404);
    });

    it('should not allow finishing a recording twice', async () => {
      const startRes = await request(app).post('/api/dictation/start');
      const id = startRes.body.id;

      await request(app).post(`/api/dictation/${id}/finish`);
      const secondFinish = await request(app).post(`/api/dictation/${id}/finish`);

      expect(secondFinish.status).toBe(404);
    });
  });
});
