import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initialize,
  PROTOCOL_VERSION,
  SERVER_NAME,
  DEFAULT_CAPABILITIES,
} from '../../../../src/protocol/methods/initialize.js';
import type { MethodContext, InitializeParams } from '../../../../src/protocol/methods/types.js';
import type { MultiSessionManager } from '../../../../src/pi/multi-session-manager.js';
import WebSocket from 'ws';

// Mock MultiSessionManager
const mockMultiSessionManager = {} as MultiSessionManager;

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

describe('Initialize Method Handler', () => {
  let context: MethodContext;

  beforeEach(() => {
    context = createTestContext();
    vi.clearAllMocks();
  });

  describe('Constants', () => {
    it('should export protocol version', () => {
      expect(PROTOCOL_VERSION).toBe('1.0.0');
    });

    it('should export server name', () => {
      expect(SERVER_NAME).toBe('pi-web-ui');
    });

    it('should export default capabilities', () => {
      expect(DEFAULT_CAPABILITIES).toBeDefined();
      expect(DEFAULT_CAPABILITIES.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(DEFAULT_CAPABILITIES.name).toBe(SERVER_NAME);
      expect(DEFAULT_CAPABILITIES.features).toBeDefined();
    });
  });

  describe('initialize', () => {
    it('should return session ID and server capabilities', async () => {
      const params: InitializeParams = {};
      const result = await initialize(params, context);

      expect(result.sessionId).toBe('test-session-id');
      expect(result.capabilities).toBeDefined();
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it('should return all expected features in capabilities', async () => {
      const params: InitializeParams = {};
      const result = await initialize(params, context);

      expect(result.capabilities.features.streaming).toBe(true);
      expect(result.capabilities.features.steering).toBe(true);
      expect(result.capabilities.features.planMode).toBe(true);
      expect(result.capabilities.features.replay).toBe(true);
      expect(result.capabilities.features.multiSession).toBe(true);
      expect(result.capabilities.features.thinkingLevels).toEqual([
        'off',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
    });

    it('should accept client capabilities', async () => {
      const params: InitializeParams = {
        capabilities: {
          name: 'test-client',
          version: '1.0.0',
          features: {
            streaming: true,
            steering: true,
          },
        },
      };

      const result = await initialize(params, context);

      expect(result.sessionId).toBe('test-session-id');
      expect(result.capabilities).toBeDefined();
    });

    it('should accept protocol version from client', async () => {
      const params: InitializeParams = {
        protocolVersion: '1.0.0',
      };

      const result = await initialize(params, context);

      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it('should handle different protocol version from client', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const params: InitializeParams = {
        protocolVersion: '2.0.0',
      };

      const result = await initialize(params, context);

      // Should still return our version
      expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
      
      // Should log about version mismatch
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Client requested protocol version'),
        '2.0.0',
        expect.stringContaining(PROTOCOL_VERSION)
      );

      consoleSpy.mockRestore();
    });

    it('should work with empty params', async () => {
      const result = await initialize({}, context);

      expect(result.sessionId).toBe('test-session-id');
      expect(result.capabilities).toBeDefined();
    });
  });
});
