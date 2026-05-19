import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/dictation/connectionPool.js', () => ({
  getSharedOpenAIClient: vi.fn(),
}));

import { getSharedOpenAIClient } from '../../../src/dictation/connectionPool.js';
import { streamTranscribe, batchTranscribe, transcribeWithFallback, startSpeculativeTranscription, shouldUseSpeculative } from '../../../src/dictation/stt.js';

function mockClient(transcriptionResult: string) {
  return {
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue(transcriptionResult),
      },
    },
  };
}

describe('STT Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('streamTranscribe', () => {
    it('should call OpenAI with correct model and return text', async () => {
      const client = mockClient('Hello world');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      const result = await streamTranscribe([Buffer.from('audio')]);

      expect(result.text).toBe('Hello world');
      expect(result.model).toBe('gpt-4o-mini-transcribe');
      expect(result.usedFallback).toBe(false);
      expect(client.audio.transcriptions.create).toHaveBeenCalledWith({
        model: 'gpt-4o-mini-transcribe',
        file: expect.any(File),
        response_format: 'text',
      });
    });

    it('should pass prompt when provided', async () => {
      const client = mockClient('Hello Claude');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      await streamTranscribe([Buffer.from('audio')], 'Claude, Anthropic');

      expect(client.audio.transcriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini-transcribe',
          prompt: 'Claude, Anthropic',
        })
      );
    });

    it('should not include prompt key when undefined', async () => {
      const client = mockClient('Hello world');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      await streamTranscribe([Buffer.from('audio')]);

      const callArgs = client.audio.transcriptions.create.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs).not.toHaveProperty('prompt');
    });

    it('should concatenate multiple chunks', async () => {
      const client = mockClient('full transcript');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      await streamTranscribe([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);

      const call = client.audio.transcriptions.create.mock.calls[0][0] as { file: File };
      expect(call.file).toBeInstanceOf(File);
      expect(call.file.name).toBe('audio.webm');
    });
  });

  describe('batchTranscribe', () => {
    it('should mark as fallback', async () => {
      const client = mockClient('batch result');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      const result = await batchTranscribe(Buffer.from('audio'));

      expect(result.text).toBe('batch result');
      expect(result.usedFallback).toBe(true);
    });
  });

  describe('transcribeWithFallback', () => {
    it('should use stream first', async () => {
      const client = mockClient('primary');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      const result = await transcribeWithFallback([Buffer.from('audio')]);

      expect(result.text).toBe('primary');
      expect(result.usedFallback).toBe(false);
    });

    it('should fall back to batch on stream failure', async () => {
      const client = {
        audio: {
          transcriptions: {
            create: vi.fn()
              .mockRejectedValueOnce(new Error('stream failed'))
              .mockResolvedValueOnce('fallback result'),
          },
        },
      };
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      const result = await transcribeWithFallback([Buffer.from('audio')]);

      expect(result.text).toBe('fallback result');
      expect(result.usedFallback).toBe(true);
      expect(client.audio.transcriptions.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('startSpeculativeTranscription', () => {
    it('should return a promise with metadata', () => {
      const client = mockClient('speculative');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      const chunks = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
      const result = startSpeculativeTranscription(chunks);

      expect(result.chunkCount).toBe(3);
      expect(result.startedAt).toBeLessThanOrEqual(Date.now());
      expect(result.promise).toBeInstanceOf(Promise);
    });

    it('should copy chunks to avoid mutation', async () => {
      const client = mockClient('ok');
      vi.mocked(getSharedOpenAIClient).mockReturnValue(client as never);

      const original = [Buffer.from('hello')];
      const result = startSpeculativeTranscription(original);

      // The speculative transcription should work on copies, not the originals
      // Verify it completes successfully
      const sttResult = await result.promise;
      expect(sttResult.text).toBe('ok');
      expect(result.chunkCount).toBe(1);
    });
  });

  describe('shouldUseSpeculative', () => {
    it('should use speculative if no new chunks', () => {
      const spec = { promise: Promise.resolve({ text: '', model: '', usedFallback: false }), chunkCount: 5, startedAt: 0 };
      expect(shouldUseSpeculative(spec, 5)).toBe(true);
      expect(shouldUseSpeculative(spec, 4)).toBe(true);
    });

    it('should use speculative if new chunks are less than 30%', () => {
      const spec = { promise: Promise.resolve({ text: '', model: '', usedFallback: false }), chunkCount: 8, startedAt: 0 };
      expect(shouldUseSpeculative(spec, 10)).toBe(true); // 2/10 = 20% < 30%
    });

    it('should not use speculative if new chunks are 30% or more', () => {
      const spec = { promise: Promise.resolve({ text: '', model: '', usedFallback: false }), chunkCount: 5, startedAt: 0 };
      expect(shouldUseSpeculative(spec, 10)).toBe(false); // 5/10 = 50% >= 30%
    });
  });
});
