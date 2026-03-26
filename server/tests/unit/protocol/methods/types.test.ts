import { describe, it, expect } from 'vitest';
import {
  JsonRpcErrorCodes,
  createJsonRpcError,
  createJsonRpcResult,
} from '../../../../src/protocol/methods/types.js';

describe('JSON-RPC Types', () => {
  describe('JsonRpcErrorCodes', () => {
    it('should define standard JSON-RPC error codes', () => {
      expect(JsonRpcErrorCodes.PARSE_ERROR).toBe(-32700);
      expect(JsonRpcErrorCodes.INVALID_REQUEST).toBe(-32600);
      expect(JsonRpcErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
      expect(JsonRpcErrorCodes.INVALID_PARAMS).toBe(-32602);
      expect(JsonRpcErrorCodes.INTERNAL_ERROR).toBe(-32603);
    });

    it('should define custom application error codes', () => {
      expect(JsonRpcErrorCodes.SESSION_NOT_FOUND).toBe(-33001);
      expect(JsonRpcErrorCodes.NOT_STREAMING).toBe(-33002);
      expect(JsonRpcErrorCodes.OPERATION_FAILED).toBe(-33003);
      expect(JsonRpcErrorCodes.UNAUTHORIZED).toBe(-33004);
    });
  });

  describe('createJsonRpcError', () => {
    it('should create a valid JSON-RPC error response', () => {
      const response = createJsonRpcError('test-id', -32601, 'Method not found');
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('test-id');
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
      expect(response.error?.message).toBe('Method not found');
      expect(response.result).toBeUndefined();
    });

    it('should include optional data in error response', () => {
      const data = { method: 'unknown' };
      const response = createJsonRpcError('test-id', -32601, 'Method not found', data);
      
      expect(response.error?.data).toEqual(data);
    });

    it('should use null for undefined id', () => {
      const response = createJsonRpcError(undefined, -32600, 'Invalid request');
      
      expect(response.id).toBeNull();
    });

    it('should use null for null id', () => {
      const response = createJsonRpcError(null, -32600, 'Invalid request');
      
      expect(response.id).toBeNull();
    });
  });

  describe('createJsonRpcResult', () => {
    it('should create a valid JSON-RPC success response', () => {
      const result = { sessionId: 'test-session' };
      const response = createJsonRpcResult('test-id', result);
      
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('test-id');
      expect(response.result).toEqual(result);
      expect(response.error).toBeUndefined();
    });

    it('should use null for undefined id', () => {
      const response = createJsonRpcResult(undefined, { success: true });
      
      expect(response.id).toBeNull();
    });

    it('should support numeric ids', () => {
      const response = createJsonRpcResult(42, { success: true });
      
      expect(response.id).toBe(42);
    });
  });
});
