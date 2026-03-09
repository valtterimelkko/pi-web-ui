import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebSocketConnection, activeConnections } from '../../../src/websocket/connection.js';
import type { WebSocket } from 'ws';

// Mock dependencies
vi.mock('../../../src/pi/pi-service.js', () => ({
  getPiService: vi.fn().mockReturnValue({
    createSession: vi.fn().mockResolvedValue({
      sessionId: 'test-session',
      subscribe: vi.fn(),
      dispose: vi.fn(),
    }),
    getSessionByClientId: vi.fn(),
    setEventHandler: vi.fn(),
    removeClient: vi.fn(),
  }),
}));

vi.mock('../../../src/websocket/handlers.js', () => ({
  handleMessage: vi.fn().mockResolvedValue(undefined),
}));

describe('WebSocket Connection', () => {
  let mockWs: WebSocket;
  let mockReq: any;

  beforeEach(() => {
    mockWs = {
      on: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1, // OPEN
    } as unknown as WebSocket;

    mockReq = {
      url: '/ws',
      headers: {},
    };

    // Clear active connections
    activeConnections.clear();
  });

  describe('handleWebSocketConnection', () => {
    it('should handle new WebSocket connection', () => {
      handleWebSocketConnection(mockWs, mockReq);
      expect(activeConnections.size).toBe(1);
    });

    it('should set up message handler', () => {
      handleWebSocketConnection(mockWs, mockReq);
      expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should set up close handler', () => {
      handleWebSocketConnection(mockWs, mockReq);
      expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should set up error handler', () => {
      handleWebSocketConnection(mockWs, mockReq);
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  describe('activeConnections', () => {
    it('should track active connections', () => {
      handleWebSocketConnection(mockWs, mockReq);
      expect(activeConnections.size).toBeGreaterThan(0);
    });
  });
});
