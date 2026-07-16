import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the pi-coding-agent module
vi.mock('@earendil-works/pi-coding-agent', () => {
  const mockSetModel = vi.fn();
  const mockSession = {
    sessionId: 'test-session-id',
    sessionFile: '/tmp/sessions/test.jsonl',
    setModel: mockSetModel,
    model: null as { id: string; provider: string } | null,
    subscribe: vi.fn(),
    dispose: vi.fn(),
    bindExtensions: vi.fn().mockResolvedValue(undefined),
    sessionManager: {},
  };
  
  const models = [
    { id: 'gpt-4', name: 'GPT-4', provider: 'openai' },
    { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'github-copilot' },
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'github-copilot' },
  ];
  const mockModelRuntime = {
    setRuntimeApiKey: vi.fn().mockResolvedValue(undefined),
    getError: vi.fn().mockReturnValue(undefined),
    getModels: vi.fn().mockReturnValue(models),
    getAvailable: vi.fn().mockResolvedValue(models),
    getModel: vi.fn((provider: string, modelName: string) => (
      models.find(m => m.provider === provider && m.id === modelName) || undefined
    )),
    hasConfiguredAuth: vi.fn().mockReturnValue(false),
    registerProvider: vi.fn(),
  };

  return {
    createAgentSession: vi.fn().mockResolvedValue({
      session: mockSession,
    }),
    SessionManager: {
      create: vi.fn().mockReturnValue({ _rewriteFile: vi.fn() }),
      open: vi.fn().mockReturnValue({ _rewriteFile: vi.fn() }),
      inMemory: vi.fn().mockReturnValue({ _rewriteFile: vi.fn() }),
      continueRecent: vi.fn().mockResolvedValue({ _rewriteFile: vi.fn() }),
      list: vi.fn().mockResolvedValue([]),
      listAll: vi.fn().mockResolvedValue([]),
    },
    ModelRuntime: {
      create: vi.fn().mockResolvedValue(mockModelRuntime),
    },
    DefaultResourceLoader: vi.fn().mockImplementation(() => ({
      reload: vi.fn().mockResolvedValue(undefined),
      getExtensions: vi.fn().mockReturnValue({ extensions: [], errors: [] }),
    })),
    __mockSession: mockSession,
    __mockSetModel: mockSetModel,
    __mockModelRuntime: mockModelRuntime,
  };
});

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    jwtSecret: 'test-secret',
    jwtExpiresIn: '15m',
    jwtRefreshExpiresIn: '7d',
    piAgentDir: '/tmp/pi-agent',
    sessionDir: '/tmp/sessions',
  },
}));

import { PiService } from '../../src/pi/pi-service.js';
import * as mockModule from '@earendil-works/pi-coding-agent';

describe('PiService.setModel', () => {
  let service: PiService;
  let mockSession: { 
    sessionId: string; 
    sessionFile: string; 
    setModel: ReturnType<typeof vi.fn>; 
    model: { id: string; provider: string } | null;
    subscribe: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    bindExtensions: ReturnType<typeof vi.fn>;
    sessionManager: Record<string, unknown>;
  };
  let mockSetModel: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = mockModule as unknown as {
      __mockSession: typeof mockSession;
      __mockSetModel: typeof mockSetModel;
      __mockModelRuntime: { getModel: ReturnType<typeof vi.fn> };
    };
    mockSession = mod.__mockSession;
    mockSetModel = mod.__mockSetModel;
    
    service = new PiService();
    // Create a session first to populate the sessions map
    await service.createSession({ clientId: 'test-client' });
    
    // Reset the mock model
    mockSession.model = { id: 'gpt-5.4', provider: 'github-copilot' };
    mockSetModel.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('setModel with verification', () => {
    it('should successfully set model when verification passes', async () => {
      // Mock setModel to update the session model
      mockSetModel.mockImplementation(async (model: { id: string; provider: string }) => {
        mockSession.model = model;
      });

      await service.setModel('test-session-id', 'github-copilot/claude-sonnet-4.6');

      expect(mockSetModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'claude-sonnet-4.6',
          provider: 'github-copilot',
        })
      );
    });

    it('should throw error when session is not found', async () => {
      await expect(service.setModel('non-existent-session', 'github-copilot/gpt-5.4'))
        .rejects.toThrow('Session not found: non-existent-session');
    });

    it('should throw error for invalid model ID format', async () => {
      await expect(service.setModel('test-session-id', 'invalid-no-slash'))
        .rejects.toThrow('Invalid model ID format');
    });

    it('should throw error when model is not found in registry', async () => {
      await expect(service.setModel('test-session-id', 'unknown-provider/unknown-model'))
        .rejects.toThrow('Model not found: unknown-provider/unknown-model');
    });

    it('should throw error when verification fails (model not set)', async () => {
      // First set model to null to simulate the case where setModel doesn't work
      mockSession.model = null;
      
      // Mock setModel to NOT update the session model (simulating a failure)
      mockSetModel.mockImplementation(async () => {
        // Don't update mockSession.model - leave it null
      });

      await expect(service.setModel('test-session-id', 'github-copilot/claude-sonnet-4.6'))
        .rejects.toThrow('Model change verification failed: session.model is null after setModel');
    });

    it('should throw error when verification fails (wrong model set)', async () => {
      // Mock setModel to set a different model than requested
      mockSetModel.mockImplementation(async () => {
        mockSession.model = { id: 'gpt-5.4', provider: 'github-copilot' }; // Wrong model
      });

      await expect(service.setModel('test-session-id', 'github-copilot/claude-sonnet-4.6'))
        .rejects.toThrow('Model change verification failed: expected github-copilot/claude-sonnet-4.6');
    });

    it('should handle model IDs with multiple slashes in name', async () => {
      // Update the mock runtime to include a multi-slash model.
      const mod = mockModule as unknown as {
        __mockModelRuntime: { getModel: ReturnType<typeof vi.fn> };
      };
      mod.__mockModelRuntime.getModel.mockImplementation((provider: string, modelName: string) => {
        if (provider === 'custom' && modelName === 'provider/model-name-v2') {
          return { id: 'provider/model-name-v2', name: 'Provider Model V2', provider: 'custom' };
        }
        const models = [
          { id: 'gpt-4', name: 'GPT-4', provider: 'openai' },
          { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'github-copilot' },
          { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6', provider: 'github-copilot' },
        ];
        return models.find(m => m.provider === provider && m.id === modelName);
      });

      mockSetModel.mockImplementation(async (model: { id: string; provider: string }) => {
        mockSession.model = model;
      });

      await service.setModel('test-session-id', 'custom/provider/model-name-v2');

      expect(mockSetModel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'provider/model-name-v2',
          provider: 'custom',
        })
      );
    });

    it('should propagate errors from session.setModel', async () => {
      mockSetModel.mockRejectedValue(new Error('API rate limit exceeded'));

      await expect(service.setModel('test-session-id', 'github-copilot/gpt-5.4'))
        .rejects.toThrow('API rate limit exceeded');
    });
  });

  describe('getAvailableModels', () => {
    it('should return available models from the model runtime', async () => {
      const models = await service.getAvailableModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });
});
