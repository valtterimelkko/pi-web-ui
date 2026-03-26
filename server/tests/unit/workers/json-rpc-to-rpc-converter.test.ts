import { describe, it, expect, beforeEach } from 'vitest';
import { JSONRPCToRPCConverter } from '../../../src/workers/json-rpc-to-rpc-converter.js';

describe('JSONRPCToRPCConverter', () => {
  let converter: JSONRPCToRPCConverter;

  beforeEach(() => {
    converter = new JSONRPCToRPCConverter();
  });

  describe('convert', () => {
    it('should convert prompt messages', () => {
      const result = converter.convert({
        method: 'prompt',
        params: { message: 'Hello' },
      });
      
      expect(result).toEqual({ type: 'prompt', message: 'Hello', images: undefined });
    });

    it('should convert steer messages', () => {
      const result = converter.convert({
        method: 'steer',
        params: { message: 'Continue' },
      });
      
      expect(result).toEqual({ type: 'steer', message: 'Continue', images: undefined });
    });

    it('should convert abort messages', () => {
      const result = converter.convert({ method: 'abort' });
      expect(result).toEqual({ type: 'abort' });
    });

    it('should return null for unknown methods', () => {
      const result = converter.convert({ method: 'unknown' });
      expect(result).toBeNull();
    });
  });

  describe('toRPCCommand', () => {
    it('should add ID to commands', () => {
      const result = converter.toRPCCommand({ type: 'prompt', message: 'Hello' });
      expect(result.type).toBe('prompt');
      expect((result as any).id).toBeDefined();
    });
  });

  describe('isJSONRPCRequest', () => {
    it('should identify JSON-RPC requests', () => {
      expect(converter.isJSONRPCRequest({ method: 'prompt' })).toBe(true);
      expect(converter.isJSONRPCRequest({ type: 'prompt' })).toBe(false);
      expect(converter.isJSONRPCRequest(null)).toBe(false);
    });
  });

  describe('createResponse', () => {
    it('should create JSON-RPC responses', () => {
      const response = converter.createResponse(1, { success: true });
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ success: true });
    });
  });

  describe('createError', () => {
    it('should create JSON-RPC errors', () => {
      const error = converter.createError(1, -32600, 'Invalid Request');
      expect(error.jsonrpc).toBe('2.0');
      expect(error.id).toBe(1);
      expect((error as any).error).toEqual({ code: -32600, message: 'Invalid Request' });
    });
  });
});
