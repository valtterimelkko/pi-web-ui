import { describe, it, expect } from 'vitest';
import { 
  isClientMessage, 
  isAuthMessage, 
  isPromptMessage,
  ErrorCodes,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';
import { 
  parseMessage, 
  serializeMessage, 
  validateMessage,
  createErrorResponse,
} from './handlers.js';

describe('Protocol Types', () => {
  describe('isClientMessage', () => {
    it('should return true for valid client messages', () => {
      expect(isClientMessage({ type: 'abort' })).toBe(true);
      expect(isClientMessage({ type: 'prompt', sessionId: 's1', message: 'hello' })).toBe(true);
      expect(isClientMessage({ type: 'set_model', modelId: 'openai/gpt-4' })).toBe(true);
    });

    it('should return false for invalid messages', () => {
      expect(isClientMessage(null)).toBe(false);
      expect(isClientMessage(undefined)).toBe(false);
      expect(isClientMessage({})).toBe(false);
      expect(isClientMessage('string')).toBe(false);
      expect(isClientMessage(123)).toBe(false);
    });
  });

  describe('isAuthMessage', () => {
    it('should return true for auth messages', () => {
      expect(isAuthMessage({ type: 'auth', csrfToken: 'token123' })).toBe(true);
    });

    it('should return false for non-auth messages', () => {
      expect(isAuthMessage({ type: 'auth' } as unknown as ClientMessage)).toBe(false);
      expect(isAuthMessage({ type: 'prompt', sessionId: 's1', message: 'test' })).toBe(false);
    });
  });

  describe('isPromptMessage', () => {
    it('should return true for prompt messages', () => {
      expect(isPromptMessage({ type: 'prompt', sessionId: 's1', message: 'hello' })).toBe(true);
    });

    it('should return false for non-prompt messages', () => {
      expect(isPromptMessage({ type: 'abort' })).toBe(false);
    });
  });

  describe('ErrorCodes', () => {
    it('should have all expected error codes', () => {
      expect(ErrorCodes.RATE_LIMIT).toBe('RATE_LIMIT');
      expect(ErrorCodes.INVALID_JSON).toBe('INVALID_JSON');
      expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED');
      expect(ErrorCodes.SESSION_NOT_FOUND).toBe('SESSION_NOT_FOUND');
      expect(ErrorCodes.PROMPT_INJECTION).toBe('PROMPT_INJECTION');
      expect(ErrorCodes.INVALID_MESSAGE).toBe('INVALID_MESSAGE');
      expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    });
  });
});

describe('Message Handlers', () => {
  describe('parseMessage', () => {
    it('should parse valid JSON messages', () => {
      const buffer = Buffer.from(JSON.stringify({ type: 'abort' }));
      const result = parseMessage(buffer);
      expect(result).toEqual({ type: 'abort' });
    });

    it('should return null for invalid JSON', () => {
      const buffer = Buffer.from('not json');
      expect(parseMessage(buffer)).toBeNull();
    });

    it('should return null for non-object JSON', () => {
      expect(parseMessage(Buffer.from('"string"'))).toBeNull();
      expect(parseMessage(Buffer.from('123'))).toBeNull();
      expect(parseMessage(Buffer.from('null'))).toBeNull();
    });

    it('should return null for objects without type', () => {
      expect(parseMessage(Buffer.from('{"foo":"bar"}'))).toBeNull();
    });

    it('should return null for non-string type', () => {
      expect(parseMessage(Buffer.from('{"type":123}'))).toBeNull();
    });
  });

  describe('serializeMessage', () => {
    it('should serialize server messages to JSON', () => {
      const message: ServerMessage = { type: 'authenticated', sessionId: 's1' };
      const result = serializeMessage(message);
      expect(JSON.parse(result)).toEqual(message);
    });

    it('should serialize error messages', () => {
      const message: ServerMessage = { 
        type: 'error', 
        message: 'Something went wrong',
        code: 'TEST_ERROR',
      };
      const result = serializeMessage(message);
      expect(JSON.parse(result)).toEqual(message);
    });
  });

  describe('validateMessage', () => {
    it('should validate auth messages', () => {
      expect(validateMessage({ type: 'auth', csrfToken: 'token' })).toBeNull();
      expect(validateMessage({ type: 'auth' } as ClientMessage)).toBe('Missing csrfToken');
    });

    it('should validate prompt messages', () => {
      expect(validateMessage({ type: 'prompt', sessionId: 's1', message: 'hello' })).toBeNull();
      expect(validateMessage({ type: 'prompt', sessionId: 's1', message: '' } as ClientMessage)).toBe('Missing message');
    });

    it('should validate set_model messages', () => {
      expect(validateMessage({ type: 'set_model', modelId: 'openai/gpt-4' })).toBeNull();
      expect(validateMessage({ type: 'set_model' } as ClientMessage)).toBe('Missing modelId');
    });

    it('should validate set_thinking_level messages', () => {
      expect(validateMessage({ type: 'set_thinking_level', level: 'high' })).toBeNull();
      expect(validateMessage({ type: 'set_thinking_level', level: 'invalid' } as unknown as ClientMessage)).toContain('Invalid thinking level');
    });

    it('should validate new_session cwd', () => {
      expect(validateMessage({ type: 'new_session', cwd: '/home/user' })).toBeNull();
      expect(validateMessage({ type: 'new_session' })).toBeNull();
      expect(validateMessage({ type: 'new_session', cwd: 123 } as unknown as ClientMessage)).toBe('cwd must be a string');
    });

    it('should validate switch_session messages', () => {
      expect(validateMessage({ type: 'switch_session', sessionPath: '/path/to/session' })).toBeNull();
      expect(validateMessage({ type: 'switch_session' } as ClientMessage)).toBe('Missing sessionPath');
    });

    it('should validate extension_ui_response messages', () => {
      expect(validateMessage({ type: 'extension_ui_response', response: { id: '123' } })).toBeNull();
      expect(validateMessage({ type: 'extension_ui_response', response: {} } as ClientMessage)).toBe('Missing response.id');
    });
  });

  describe('createErrorResponse', () => {
    it('should create error messages without code', () => {
      const result = createErrorResponse('Test error');
      expect(result).toEqual({
        type: 'error',
        message: 'Test error',
        code: undefined,
      });
    });

    it('should create error messages with code', () => {
      const result = createErrorResponse('Test error', 'TEST_CODE');
      expect(result).toEqual({
        type: 'error',
        message: 'Test error',
        code: 'TEST_CODE',
      });
    });
  });
});
