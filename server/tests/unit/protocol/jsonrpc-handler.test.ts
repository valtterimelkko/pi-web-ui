/**
 * Tests for JSON-RPC Message Handler
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parseMessage,
  parseResponse,
  generateRequestId,
  resetRequestCounter,
  createResponse,
  createErrorResponse,
  createNotification,
  JSONRPC_ERRORS,
  RequestTracker,
  isRecoverableError,
  normalizeError,
} from '../../../src/protocol/jsonrpc-handler.js';
import { JSONRPCErrorCode } from '@pi-web-ui/shared';

describe('JSON-RPC Handler', () => {
  beforeEach(() => {
    resetRequestCounter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================================================================
  // parseMessage
  // ==========================================================================

  describe('parseMessage', () => {
    it('should parse a valid JSON-RPC request', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'test',
        params: { foo: 'bar' },
      });

      const result = parseMessage(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        method: 'test',
        params: { foo: 'bar' },
      });
    });

    it('should parse a valid JSON-RPC notification', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notify',
        params: { event: 'test' },
      });

      const result = parseMessage(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        method: 'notify',
        params: { event: 'test' },
      });
    });

    it('should parse a request without params', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });

      const result = parseMessage(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'test',
      });
    });

    it('should return null for malformed JSON', () => {
      const data = '{ not valid json }';
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for missing jsonrpc version', () => {
      const data = JSON.stringify({
        id: 'test-1',
        method: 'test',
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for wrong jsonrpc version', () => {
      const data = JSON.stringify({
        jsonrpc: '1.0',
        id: 'test-1',
        method: 'test',
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for missing method', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for empty method', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        method: '',
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for non-string method', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        method: 123,
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for non-string/number id', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: { complex: 'object' },
        method: 'test',
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should return null for null id', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        method: 'test',
      });
      expect(parseMessage(data)).toBeNull();
    });

    it('should accept numeric id', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'test',
      });

      const result = parseMessage(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 42,
        method: 'test',
      });
    });

    it('should accept numeric string id', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: '42',
        method: 'test',
      });

      const result = parseMessage(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: '42',
        method: 'test',
      });
    });
  });

  // ==========================================================================
  // parseResponse
  // ==========================================================================

  describe('parseResponse', () => {
    it('should parse a valid success response', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        result: { data: 'success' },
      });

      const result = parseResponse(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        result: { data: 'success' },
      });
    });

    it('should parse a valid error response', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });

      const result = parseResponse(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    });

    it('should return null for malformed JSON', () => {
      const data = '{ not valid json }';
      expect(parseResponse(data)).toBeNull();
    });

    it('should return null for response with both result and error', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        result: { data: 'success' },
        error: { code: -32600, message: 'Invalid request' },
      });

      expect(parseResponse(data)).toBeNull();
    });

    it('should return null for missing id', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        result: { data: 'success' },
      });

      expect(parseResponse(data)).toBeNull();
    });

    it('should parse error response with data field', () => {
      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-1',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { details: 'Missing required field' },
        },
      });

      const result = parseResponse(data);
      expect(result).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { details: 'Missing required field' },
        },
      });
    });
  });

  // ==========================================================================
  // generateRequestId
  // ==========================================================================

  describe('generateRequestId', () => {
    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateRequestId());
      }
      expect(ids.size).toBe(100);
    });

    it('should include timestamp component', () => {
      const now = Date.now();
      const id = generateRequestId();
      const timestamp = parseInt(id.split('-')[0], 36);
      expect(timestamp).toBeGreaterThanOrEqual(now - 100);
      expect(timestamp).toBeLessThanOrEqual(now + 100);
    });

    it('should include counter component', () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();

      // Extract counter from second ID
      const counter1 = id1.split('-')[1];
      const counter2 = id2.split('-')[1];

      expect(parseInt(counter2, 36)).toBeGreaterThan(parseInt(counter1, 36));
    });

    it('should reset counter after resetRequestCounter call', () => {
      generateRequestId();
      generateRequestId();
      generateRequestId();

      resetRequestCounter();

      const id = generateRequestId();
      const counter = parseInt(id.split('-')[1], 36);
      expect(counter).toBe(0);
    });
  });

  // ==========================================================================
  // createResponse
  // ==========================================================================

  describe('createResponse', () => {
    it('should create a valid success response with string id', () => {
      const response = createResponse('test-1', { data: 'success' });

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        result: { data: 'success' },
      });
    });

    it('should create a valid success response with numeric id', () => {
      const response = createResponse(42, 'simple result');

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 42,
        result: 'simple result',
      });
    });

    it('should handle null result', () => {
      const response = createResponse('test-1', null);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        result: null,
      });
    });

    it('should handle array result', () => {
      const response = createResponse('test-1', [1, 2, 3]);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        result: [1, 2, 3],
      });
    });
  });

  // ==========================================================================
  // createErrorResponse
  // ==========================================================================

  describe('createErrorResponse', () => {
    it('should create a valid error response', () => {
      const response = createErrorResponse('test-1', {
        code: -32601,
        message: 'Method not found',
      });

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        error: {
          code: -32601,
          message: 'Method not found',
        },
      });
    });

    it('should include error data when provided', () => {
      const response = createErrorResponse('test-1', {
        code: -32602,
        message: 'Invalid params',
        data: { field: 'required' },
      });

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        error: {
          code: -32602,
          message: 'Invalid params',
          data: { field: 'required' },
        },
      });
    });

    it('should work with standard JSONRPC_ERRORS', () => {
      const response = createErrorResponse('test-1', JSONRPC_ERRORS.METHOD_NOT_FOUND);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'test-1',
        error: JSONRPC_ERRORS.METHOD_NOT_FOUND,
      });
    });
  });

  // ==========================================================================
  // createNotification
  // ==========================================================================

  describe('createNotification', () => {
    it('should create a valid notification with params', () => {
      const notification = createNotification('status', {
        status: 'idle',
        message: 'Ready',
      });

      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'status',
        params: {
          status: 'idle',
          message: 'Ready',
        },
      });
    });

    it('should create a valid notification without params', () => {
      const notification = createNotification('ping', undefined);

      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'ping',
      });
    });
  });

  // ==========================================================================
  // JSONRPC_ERRORS
  // ==========================================================================

  describe('JSONRPC_ERRORS', () => {
    it('should have correct PARSE_ERROR', () => {
      expect(JSONRPC_ERRORS.PARSE_ERROR).toEqual({
        code: -32700,
        message: 'Parse error',
      });
    });

    it('should have correct INVALID_REQUEST', () => {
      expect(JSONRPC_ERRORS.INVALID_REQUEST).toEqual({
        code: -32600,
        message: 'Invalid request',
      });
    });

    it('should have correct METHOD_NOT_FOUND', () => {
      expect(JSONRPC_ERRORS.METHOD_NOT_FOUND).toEqual({
        code: -32601,
        message: 'Method not found',
      });
    });

    it('should have correct INVALID_PARAMS', () => {
      expect(JSONRPC_ERRORS.INVALID_PARAMS).toEqual({
        code: -32602,
        message: 'Invalid params',
      });
    });

    it('should have correct INTERNAL_ERROR', () => {
      expect(JSONRPC_ERRORS.INTERNAL_ERROR).toEqual({
        code: -32603,
        message: 'Internal error',
      });
    });
  });

  // ==========================================================================
  // RequestTracker
  // ==========================================================================

  describe('RequestTracker', () => {
    describe('add', () => {
      it('should add a pending request', () => {
        const tracker = new RequestTracker();
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);

        expect(tracker.has('test-1')).toBe(true);
        expect(tracker.size()).toBe(1);
      });

      it('should handle duplicate request IDs (last wins)', () => {
        const tracker = new RequestTracker();
        const resolve1 = vi.fn();
        const reject1 = vi.fn();
        const resolve2 = vi.fn();
        const reject2 = vi.fn();

        tracker.add('test-1', resolve1, reject1);
        tracker.add('test-1', resolve2, reject2);

        expect(tracker.size()).toBe(1);

        // Resolve should call the second set of callbacks
        tracker.resolve('test-1', 'result');
        expect(resolve2).toHaveBeenCalledWith('result');
        expect(resolve1).not.toHaveBeenCalled();
      });

      it('should use custom timeout when specified', () => {
        const tracker = new RequestTracker({ defaultTimeoutMs: 10000 });
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject, 5000);

        vi.advanceTimersByTime(5000);

        expect(reject).toHaveBeenCalled();
        const error = reject.mock.calls[0][0];
        expect(error.name).toBe('TimeoutError');
        expect(error.message).toContain('timed out');
      });

      it('should use default timeout when not specified', () => {
        const tracker = new RequestTracker({ defaultTimeoutMs: 5000 });
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);

        vi.advanceTimersByTime(5000);

        expect(reject).toHaveBeenCalled();
      });

      it('should call onTimeout callback when request times out', () => {
        const onTimeout = vi.fn();
        const tracker = new RequestTracker({ defaultTimeoutMs: 1000, onTimeout });
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);

        vi.advanceTimersByTime(1000);

        expect(onTimeout).toHaveBeenCalledWith('test-1');
      });
    });

    describe('resolve', () => {
      it('should resolve a pending request', () => {
        const tracker = new RequestTracker();
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        const result = tracker.resolve('test-1', { data: 'success' });

        expect(result).toBe(true);
        expect(resolve).toHaveBeenCalledWith({ data: 'success' });
        expect(tracker.has('test-1')).toBe(false);
      });

      it('should clear timeout when resolved', () => {
        const tracker = new RequestTracker({ defaultTimeoutMs: 1000 });
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        tracker.resolve('test-1', 'result');

        // Advance past timeout - should not trigger
        vi.advanceTimersByTime(1000);

        expect(reject).not.toHaveBeenCalled();
      });

      it('should return false for unknown request ID', () => {
        const tracker = new RequestTracker();
        const result = tracker.resolve('unknown', 'result');
        expect(result).toBe(false);
      });

      it('should return false for already resolved request', () => {
        const tracker = new RequestTracker();
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        tracker.resolve('test-1', 'result');
        const result = tracker.resolve('test-1', 'result2');

        expect(result).toBe(false);
      });
    });

    describe('reject', () => {
      it('should reject a pending request with Error', () => {
        const tracker = new RequestTracker();
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        const error = new Error('Test error');
        const result = tracker.reject('test-1', error);

        expect(result).toBe(true);
        expect(reject).toHaveBeenCalledWith(error);
        expect(tracker.has('test-1')).toBe(false);
      });

      it('should reject a pending request with JSONRPCError', () => {
        const tracker = new RequestTracker();
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        const result = tracker.reject('test-1', {
          code: -32601,
          message: 'Method not found',
        });

        expect(result).toBe(true);
        expect(reject).toHaveBeenCalled();
        const error = reject.mock.calls[0][0];
        expect(error.message).toBe('Method not found');
      });

      it('should clear timeout when rejected', () => {
        const tracker = new RequestTracker({ defaultTimeoutMs: 1000 });
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        tracker.reject('test-1', new Error('Manual rejection'));

        // Advance past timeout - should not trigger timeout rejection
        vi.advanceTimersByTime(1000);

        // Should only be called once (manual rejection)
        expect(reject).toHaveBeenCalledTimes(1);
      });

      it('should return false for unknown request ID', () => {
        const tracker = new RequestTracker();
        const result = tracker.reject('unknown', new Error('error'));
        expect(result).toBe(false);
      });
    });

    describe('cleanup', () => {
      it('should cleanup all pending requests', () => {
        const tracker = new RequestTracker();
        const resolve1 = vi.fn();
        const reject1 = vi.fn();
        const resolve2 = vi.fn();
        const reject2 = vi.fn();

        tracker.add('test-1', resolve1, reject1);
        tracker.add('test-2', resolve2, reject2);

        tracker.cleanup();

        expect(tracker.size()).toBe(0);
        expect(reject1).toHaveBeenCalled();
        expect(reject2).toHaveBeenCalled();

        const error1 = reject1.mock.calls[0][0];
        const error2 = reject2.mock.calls[0][0];
        expect(error1.name).toBe('CancelError');
        expect(error2.name).toBe('CancelError');
      });

      it('should clear all timeouts during cleanup', () => {
        const tracker = new RequestTracker({ defaultTimeoutMs: 1000 });
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        tracker.cleanup();

        // Advance past timeout - should not trigger
        vi.advanceTimersByTime(1000);

        // Should only be called once (cleanup)
        expect(reject).toHaveBeenCalledTimes(1);
      });
    });

    describe('cleanupStale', () => {
      it('should cleanup requests older than maxAge', () => {
        const tracker = new RequestTracker();
        const resolve1 = vi.fn();
        const reject1 = vi.fn();
        const resolve2 = vi.fn();
        const reject2 = vi.fn();

        tracker.add('test-1', resolve1, reject1);
        vi.advanceTimersByTime(5000);
        tracker.add('test-2', resolve2, reject2);

        // Cleanup requests older than 3 seconds
        vi.advanceTimersByTime(100);
        const cleaned = tracker.cleanupStale(3000);

        expect(cleaned).toBe(1);
        expect(tracker.has('test-1')).toBe(false);
        expect(tracker.has('test-2')).toBe(true);
        expect(reject1).toHaveBeenCalled();
      });

      it('should return 0 if no stale requests', () => {
        const tracker = new RequestTracker();
        const resolve = vi.fn();
        const reject = vi.fn();

        tracker.add('test-1', resolve, reject);
        vi.advanceTimersByTime(100);

        const cleaned = tracker.cleanupStale(5000);
        expect(cleaned).toBe(0);
      });
    });

    describe('has', () => {
      it('should return true for pending request', () => {
        const tracker = new RequestTracker();
        tracker.add('test-1', vi.fn(), vi.fn());
        expect(tracker.has('test-1')).toBe(true);
      });

      it('should return false for unknown request', () => {
        const tracker = new RequestTracker();
        expect(tracker.has('unknown')).toBe(false);
      });

      it('should return false after request is resolved', () => {
        const tracker = new RequestTracker();
        tracker.add('test-1', vi.fn(), vi.fn());
        tracker.resolve('test-1', 'result');
        expect(tracker.has('test-1')).toBe(false);
      });
    });

    describe('size', () => {
      it('should return correct count of pending requests', () => {
        const tracker = new RequestTracker();
        expect(tracker.size()).toBe(0);

        tracker.add('test-1', vi.fn(), vi.fn());
        expect(tracker.size()).toBe(1);

        tracker.add('test-2', vi.fn(), vi.fn());
        expect(tracker.size()).toBe(2);

        tracker.resolve('test-1', 'result');
        expect(tracker.size()).toBe(1);
      });
    });
  });

  // ==========================================================================
  // isRecoverableError
  // ==========================================================================

  describe('isRecoverableError', () => {
    it('should return false for PARSE_ERROR', () => {
      expect(isRecoverableError(JSONRPCErrorCode.PARSE_ERROR)).toBe(false);
    });

    it('should return false for INVALID_REQUEST', () => {
      expect(isRecoverableError(JSONRPCErrorCode.INVALID_REQUEST)).toBe(false);
    });

    it('should return true for METHOD_NOT_FOUND', () => {
      expect(isRecoverableError(JSONRPCErrorCode.METHOD_NOT_FOUND)).toBe(true);
    });

    it('should return true for INVALID_PARAMS', () => {
      expect(isRecoverableError(JSONRPCErrorCode.INVALID_PARAMS)).toBe(true);
    });

    it('should return true for INTERNAL_ERROR', () => {
      expect(isRecoverableError(JSONRPCErrorCode.INTERNAL_ERROR)).toBe(true);
    });
  });

  // ==========================================================================
  // normalizeError
  // ==========================================================================

  describe('normalizeError', () => {
    it('should pass through valid JSONRPCError', () => {
      const error = normalizeError({
        code: -32601,
        message: 'Method not found',
      });

      expect(error).toEqual({
        code: -32601,
        message: 'Method not found',
      });
    });

    it('should pass through JSONRPCError with data', () => {
      const error = normalizeError({
        code: -32602,
        message: 'Invalid params',
        data: { field: 'required' },
      });

      expect(error).toEqual({
        code: -32602,
        message: 'Invalid params',
        data: { field: 'required' },
      });
    });

    it('should convert Error to JSONRPCError', () => {
      const error = normalizeError(new Error('Something went wrong'));

      expect(error.code).toBe(JSONRPCErrorCode.INTERNAL_ERROR);
      expect(error.message).toBe('Something went wrong');
      expect(error.data).toBeDefined(); // Should include stack
    });

    it('should handle string error', () => {
      const error = normalizeError('Simple error message');

      expect(error).toEqual(JSONRPC_ERRORS.INTERNAL_ERROR);
    });

    it('should handle null', () => {
      const error = normalizeError(null);

      expect(error).toEqual(JSONRPC_ERRORS.INTERNAL_ERROR);
    });

    it('should handle undefined', () => {
      const error = normalizeError(undefined);

      expect(error).toEqual(JSONRPC_ERRORS.INTERNAL_ERROR);
    });

    it('should handle object without code', () => {
      const error = normalizeError({ message: 'Some error' });

      expect(error.code).toBe(JSONRPCErrorCode.INTERNAL_ERROR);
      expect(error.message).toBe('Some error');
    });

    it('should handle object without message', () => {
      const error = normalizeError({ code: -32600 });

      expect(error).toEqual(JSONRPC_ERRORS.INTERNAL_ERROR);
    });
  });
});
