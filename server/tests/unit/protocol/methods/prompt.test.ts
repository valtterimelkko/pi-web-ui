import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prompt } from '../../../../src/protocol/methods/prompt.js';
import type { MethodContext, PromptParams } from '../../../../src/protocol/methods/types.js';
import type { MultiSessionManager } from '../../../../src/pi/multi-session-manager.js';
import WebSocket from 'ws';

// Mock agent session
const mockAgentSession = {
  prompt: vi.fn(),
  sessionId: 'agent-session-id',
  sessionFile: '/path/to/session.jsonl',
};

// Mock MultiSessionManager
const mockMultiSessionManager = {
  getAgentSession: vi.fn().mockReturnValue(mockAgentSession),
} as unknown as MultiSessionManager;

// Mock WebSocket
const mockWs = {} as WebSocket;

// Create test context
const createTestContext = (): MethodContext => ({
  sessionId: 'test-session-id',
  sessionPath: '/path/to/session.jsonl',
  ws: mockWs,
  multiSessionManager: mockMultiSessionManager,
  requestId: 'test-request-id',
  clientId: 'test-client-id',
});

describe('Prompt Method Handler', () => {
  let context: MethodContext;

  beforeEach(() => {
    context = createTestContext();
    vi.clearAllMocks();
    mockAgentSession.prompt.mockResolvedValue(undefined);
    mockMultiSessionManager.getAgentSession.mockReturnValue(mockAgentSession);
  });

  describe('Validation', () => {
    it('should reject empty content', async () => {
      const params: PromptParams = { content: '' };

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: content must be a non-empty string'
      );
    });

    it('should reject whitespace-only content', async () => {
      const params: PromptParams = { content: '   ' };

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: content cannot be empty or whitespace only'
      );
    });

    it('should reject non-string content', async () => {
      const params = { content: 123 } as unknown as PromptParams;

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: content must be a non-empty string'
      );
    });

    it('should reject missing content', async () => {
      const params = {} as PromptParams;

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: content must be a non-empty string'
      );
    });
  });

  describe('Image Validation', () => {
    it('should reject non-array images', async () => {
      const params = {
        content: 'test',
        images: 'not-an-array',
      } as unknown as PromptParams;

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: images must be an array'
      );
    });

    it('should reject invalid image type', async () => {
      const params: PromptParams = {
        content: 'test',
        images: [{ type: 'video', data: 'base64', mimeType: 'video/mp4' }],
      };

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: image type must be "image"'
      );
    });

    it('should reject missing image data', async () => {
      const params: PromptParams = {
        content: 'test',
        images: [{ type: 'image', data: '', mimeType: 'image/png' }],
      };

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: image data must be a base64 string'
      );
    });

    it('should reject missing mime type', async () => {
      const params: PromptParams = {
        content: 'test',
        images: [{ type: 'image', data: 'base64data', mimeType: '' }],
      };

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: image mimeType must be specified'
      );
    });

    it('should reject unsupported mime type', async () => {
      const params: PromptParams = {
        content: 'test',
        images: [{ type: 'image', data: 'base64data', mimeType: 'image/bmp' }],
      };

      await expect(prompt(params, context)).rejects.toThrow(
        'Invalid prompt: unsupported image mimeType "image/bmp"'
      );
    });

    it('should accept valid image with jpeg mime type', async () => {
      const params: PromptParams = {
        content: 'test',
        images: [{ type: 'image', data: 'base64data', mimeType: 'image/jpeg' }],
      };

      const result = await prompt(params, context);

      expect(result.accepted).toBe(true);
      expect(result.requestId).toBeDefined();
    });

    it('should accept valid image with png mime type', async () => {
      const params: PromptParams = {
        content: 'test',
        images: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      };

      const result = await prompt(params, context);

      expect(result.accepted).toBe(true);
    });
  });

  describe('Session Handling', () => {
    it('should reject when session not found', async () => {
      mockMultiSessionManager.getAgentSession.mockReturnValue(undefined);

      const params: PromptParams = { content: 'test message' };

      await expect(prompt(params, context)).rejects.toThrow(
        'Session not found: /path/to/session.jsonl'
      );
    });

    it('should call agent session prompt with content', async () => {
      const params: PromptParams = { content: 'Hello, agent!' };

      await prompt(params, context);

      expect(mockAgentSession.prompt).toHaveBeenCalledWith('Hello, agent!', {
        images: undefined,
      });
    });

    it('should call agent session prompt with images', async () => {
      const images = [{ type: 'image' as const, data: 'base64data', mimeType: 'image/png' }];
      const params: PromptParams = { content: 'Analyze this', images };

      await prompt(params, context);

      expect(mockAgentSession.prompt).toHaveBeenCalledWith('Analyze this', {
        images,
      });
    });
  });

  describe('Request ID', () => {
    it('should generate a request ID if not provided', async () => {
      const params: PromptParams = { content: 'test' };

      const result = await prompt(params, context);

      expect(result.requestId).toBeDefined();
      expect(typeof result.requestId).toBe('string');
      expect(result.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('should use provided request ID', async () => {
      const params: PromptParams = { content: 'test', requestId: 'custom-id' };

      const result = await prompt(params, context);

      expect(result.requestId).toBe('custom-id');
    });

    it('should return accepted status', async () => {
      const params: PromptParams = { content: 'test' };

      const result = await prompt(params, context);

      expect(result.accepted).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle agent session errors', async () => {
      mockAgentSession.prompt.mockRejectedValue(new Error('Agent error'));

      const params: PromptParams = { content: 'test' };

      await expect(prompt(params, context)).rejects.toThrow(
        'Failed to create prompt: Agent error'
      );
    });
  });
});
