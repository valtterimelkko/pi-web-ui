import { describe, it, expect } from 'vitest';

/**
 * Unit tests for Multi-Session WebSocket Protocol Types
 *
 * These tests cover the new protocol types added for multi-session support:
 * - SessionStatusBroadcast: Server → Client status broadcasts
 * - SessionEvent: Server → Client wrapped agent events
 * - SubscribeSession: Client → Server subscription request
 * - UnsubscribeSession: Client → Server unsubscription request
 * - SessionSubscribed: Server → Client subscription confirmation
 * - SessionUnsubscribed: Server → Client unsubscription confirmation
 *
 * @see REFACTORING_MULTI_SESSION.md for protocol specification
 */

// ============================================================================
// Type Definitions (will be moved to protocol.ts during implementation)
// ============================================================================

/**
 * Session status types
 */
export type SessionStatus = 'idle' | 'busy' | 'streaming' | 'error';

/**
 * Server → Client: Broadcast when any session's state changes
 */
export interface SessionStatusBroadcast {
  type: 'session_status';
  sessionId: string;
  sessionPath: string;
  status: SessionStatus;
  lastActivity: string;
  messageCount: number;
  currentStep?: number;
}

/**
 * Server → Client: Wrap all events with sessionId for routing
 */
export interface SessionEvent {
  type: 'session_event';
  sessionId: string;
  event: unknown; // AgentSessionEvent from Pi SDK
}

/**
 * Client → Server: Subscribe to a session's events
 */
export interface SubscribeSession {
  type: 'subscribe_session';
  sessionPath: string;
}

/**
 * Client → Server: Unsubscribe from a session's events
 */
export interface UnsubscribeSession {
  type: 'unsubscribe_session';
  sessionPath: string;
}

/**
 * Server → Client: Confirmation of subscription
 */
export interface SessionSubscribed {
  type: 'session_subscribed';
  sessionId: string;
  sessionPath: string;
  status: SessionStatus;
}

/**
 * Server → Client: Confirmation of unsubscription
 */
export interface SessionUnsubscribed {
  type: 'session_unsubscribed';
  sessionId: string;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a valid SessionStatus
 */
export function isValidSessionStatus(value: unknown): value is SessionStatus {
  return (
    typeof value === 'string' &&
    ['idle', 'busy', 'streaming', 'error'].includes(value)
  );
}

/**
 * Type guard for SessionStatusBroadcast
 */
export function isSessionStatusBroadcast(
  data: unknown
): data is SessionStatusBroadcast {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_status' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.sessionPath === 'string' &&
    isValidSessionStatus(msg.status) &&
    typeof msg.lastActivity === 'string' &&
    typeof msg.messageCount === 'number' &&
    (msg.currentStep === undefined || typeof msg.currentStep === 'number')
  );
}

/**
 * Type guard for SessionEvent
 */
export function isSessionEvent(data: unknown): data is SessionEvent {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_event' &&
    typeof msg.sessionId === 'string' &&
    msg.event !== undefined
  );
}

/**
 * Type guard for SubscribeSession
 */
export function isSubscribeSession(data: unknown): data is SubscribeSession {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg.type === 'subscribe_session' && typeof msg.sessionPath === 'string';
}

/**
 * Type guard for UnsubscribeSession
 */
export function isUnsubscribeSession(
  data: unknown
): data is UnsubscribeSession {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'unsubscribe_session' && typeof msg.sessionPath === 'string'
  );
}

/**
 * Type guard for SessionSubscribed
 */
export function isSessionSubscribed(data: unknown): data is SessionSubscribed {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_subscribed' &&
    typeof msg.sessionId === 'string' &&
    typeof msg.sessionPath === 'string' &&
    isValidSessionStatus(msg.status)
  );
}

/**
 * Type guard for SessionUnsubscribed
 */
export function isSessionUnsubscribed(
  data: unknown
): data is SessionUnsubscribed {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg.type === 'session_unsubscribed' && typeof msg.sessionId === 'string'
  );
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a valid SessionStatusBroadcast
 */
export function createSessionStatusBroadcast(
  overrides: Partial<SessionStatusBroadcast> = {}
): SessionStatusBroadcast {
  return {
    type: 'session_status',
    sessionId: 'session-123',
    sessionPath: '/path/to/session.jsonl',
    status: 'idle',
    lastActivity: new Date().toISOString(),
    messageCount: 5,
    ...overrides,
  };
}

/**
 * Create a valid SessionEvent
 */
export function createSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    type: 'session_event',
    sessionId: 'session-123',
    event: { type: 'test_event', data: 'test' },
    ...overrides,
  };
}

/**
 * Create a valid SubscribeSession
 */
export function createSubscribeSession(
  overrides: Partial<SubscribeSession> = {}
): SubscribeSession {
  return {
    type: 'subscribe_session',
    sessionPath: '/path/to/session.jsonl',
    ...overrides,
  };
}

/**
 * Create a valid UnsubscribeSession
 */
export function createUnsubscribeSession(
  overrides: Partial<UnsubscribeSession> = {}
): UnsubscribeSession {
  return {
    type: 'unsubscribe_session',
    sessionPath: '/path/to/session.jsonl',
    ...overrides,
  };
}

/**
 * Create a valid SessionSubscribed
 */
export function createSessionSubscribed(
  overrides: Partial<SessionSubscribed> = {}
): SessionSubscribed {
  return {
    type: 'session_subscribed',
    sessionId: 'session-123',
    sessionPath: '/path/to/session.jsonl',
    status: 'idle',
    ...overrides,
  };
}

/**
 * Create a valid SessionUnsubscribed
 */
export function createSessionUnsubscribed(
  overrides: Partial<SessionUnsubscribed> = {}
): SessionUnsubscribed {
  return {
    type: 'session_unsubscribed',
    sessionId: 'session-123',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Multi-Session WebSocket Protocol', () => {
  // ==========================================================================
  // SessionStatusBroadcast Tests
  // ==========================================================================
  describe('SessionStatusBroadcast', () => {
    describe('validation', () => {
      it('should validate required fields', () => {
        const valid = createSessionStatusBroadcast();
        expect(isSessionStatusBroadcast(valid)).toBe(true);
      });

      it('should reject missing sessionId', () => {
        const invalid = { ...createSessionStatusBroadcast() };
        delete (invalid as Record<string, unknown>).sessionId;
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject missing sessionPath', () => {
        const invalid = { ...createSessionStatusBroadcast() };
        delete (invalid as Record<string, unknown>).sessionPath;
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject missing status', () => {
        const invalid = { ...createSessionStatusBroadcast() };
        delete (invalid as Record<string, unknown>).status;
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject missing lastActivity', () => {
        const invalid = { ...createSessionStatusBroadcast() };
        delete (invalid as Record<string, unknown>).lastActivity;
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject missing messageCount', () => {
        const invalid = { ...createSessionStatusBroadcast() };
        delete (invalid as Record<string, unknown>).messageCount;
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject invalid status type', () => {
        const invalid = createSessionStatusBroadcast({
          status: 'invalid' as SessionStatus,
        });
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should accept all valid status types', () => {
        const statuses: SessionStatus[] = ['idle', 'busy', 'streaming', 'error'];
        for (const status of statuses) {
          const valid = createSessionStatusBroadcast({ status });
          expect(isSessionStatusBroadcast(valid)).toBe(true);
        }
      });

      it('should accept optional currentStep', () => {
        const withStep = createSessionStatusBroadcast({ currentStep: 3 });
        expect(isSessionStatusBroadcast(withStep)).toBe(true);
        expect(withStep.currentStep).toBe(3);
      });

      it('should accept messageCount of 0', () => {
        const valid = createSessionStatusBroadcast({ messageCount: 0 });
        expect(isSessionStatusBroadcast(valid)).toBe(true);
      });

      it('should reject non-string sessionId', () => {
        const invalid = createSessionStatusBroadcast({
          sessionId: 123 as unknown as string,
        });
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject non-number messageCount', () => {
        const invalid = createSessionStatusBroadcast({
          messageCount: '5' as unknown as number,
        });
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });

      it('should reject non-number currentStep if present', () => {
        const invalid = {
          ...createSessionStatusBroadcast(),
          currentStep: '3',
        };
        expect(isSessionStatusBroadcast(invalid)).toBe(false);
      });
    });

    describe('serialization', () => {
      it('should serialize to JSON correctly', () => {
        const msg = createSessionStatusBroadcast({
          sessionId: 'test-session',
          sessionPath: '/test/path.jsonl',
          status: 'streaming',
          messageCount: 10,
          currentStep: 5,
        });

        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.type).toBe('session_status');
        expect(parsed.sessionId).toBe('test-session');
        expect(parsed.sessionPath).toBe('/test/path.jsonl');
        expect(parsed.status).toBe('streaming');
        expect(parsed.messageCount).toBe(10);
        expect(parsed.currentStep).toBe(5);
        expect(parsed.lastActivity).toBeDefined();
      });

      it('should round-trip through JSON', () => {
        const original = createSessionStatusBroadcast({
          currentStep: 7,
        });
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);

        expect(isSessionStatusBroadcast(parsed)).toBe(true);
        expect(parsed.sessionId).toBe(original.sessionId);
        expect(parsed.currentStep).toBe(7);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string sessionId', () => {
        const valid = createSessionStatusBroadcast({ sessionId: '' });
        expect(isSessionStatusBroadcast(valid)).toBe(true);
      });

      it('should handle empty string sessionPath', () => {
        const valid = createSessionStatusBroadcast({ sessionPath: '' });
        expect(isSessionStatusBroadcast(valid)).toBe(true);
      });

      it('should handle large messageCount', () => {
        const valid = createSessionStatusBroadcast({
          messageCount: Number.MAX_SAFE_INTEGER,
        });
        expect(isSessionStatusBroadcast(valid)).toBe(true);
      });

      it('should handle negative currentStep', () => {
        const valid = createSessionStatusBroadcast({ currentStep: -1 });
        // Note: negative step might be semantically invalid but is structurally valid
        expect(isSessionStatusBroadcast(valid)).toBe(true);
      });

      it('should handle ISO date string for lastActivity', () => {
        const isoDate = '2024-01-15T10:30:00.000Z';
        const valid = createSessionStatusBroadcast({ lastActivity: isoDate });
        expect(isSessionStatusBroadcast(valid)).toBe(true);
        expect(valid.lastActivity).toBe(isoDate);
      });

      it('should reject null values', () => {
        expect(isSessionStatusBroadcast(null)).toBe(false);
      });

      it('should reject undefined values', () => {
        expect(isSessionStatusBroadcast(undefined)).toBe(false);
      });

      it('should reject non-object values', () => {
        expect(isSessionStatusBroadcast('string')).toBe(false);
        expect(isSessionStatusBroadcast(123)).toBe(false);
        expect(isSessionStatusBroadcast(true)).toBe(false);
      });
    });
  });

  // ==========================================================================
  // SessionEvent Tests
  // ==========================================================================
  describe('SessionEvent', () => {
    describe('validation', () => {
      it('should validate required fields', () => {
        const valid = createSessionEvent();
        expect(isSessionEvent(valid)).toBe(true);
      });

      it('should reject missing sessionId', () => {
        const invalid = { ...createSessionEvent() };
        delete (invalid as Record<string, unknown>).sessionId;
        expect(isSessionEvent(invalid)).toBe(false);
      });

      it('should reject missing event', () => {
        const invalid = { ...createSessionEvent() };
        delete (invalid as Record<string, unknown>).event;
        expect(isSessionEvent(invalid)).toBe(false);
      });

      it('should reject non-string sessionId', () => {
        const invalid = createSessionEvent({
          sessionId: 123 as unknown as string,
        });
        expect(isSessionEvent(invalid)).toBe(false);
      });

      it('should accept any event object', () => {
        const events = [
          { type: 'agent_start' },
          { type: 'agent_end', messages: [] },
          { type: 'message_start', message: { id: '1', role: 'user' } },
          { type: 'tool_execution_start', toolName: 'bash', args: {} },
          null,
          'string event',
          123,
        ];

        for (const event of events) {
          const valid = createSessionEvent({ event });
          expect(isSessionEvent(valid)).toBe(true);
        }
      });
    });

    describe('serialization', () => {
      it('should wrap agent events with sessionId', () => {
        const agentEvent = {
          type: 'message_start',
          message: { id: 'msg-1', role: 'assistant', content: 'Hello' },
        };

        const msg = createSessionEvent({
          sessionId: 'session-456',
          event: agentEvent,
        });

        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.type).toBe('session_event');
        expect(parsed.sessionId).toBe('session-456');
        expect(parsed.event.type).toBe('message_start');
        expect(parsed.event.message.id).toBe('msg-1');
      });

      it('should preserve original event structure', () => {
        const complexEvent = {
          type: 'tool_execution_end',
          toolCallId: 'call-123',
          toolName: 'bash',
          result: {
            content: [{ type: 'text', text: 'output' }],
            isError: false,
          },
          nested: {
            deep: {
              value: [1, 2, 3],
            },
          },
        };

        const msg = createSessionEvent({ event: complexEvent });
        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.event).toEqual(complexEvent);
      });

      it('should handle events with circular references gracefully', () => {
        const circularEvent: Record<string, unknown> = { type: 'test' };
        circularEvent.self = circularEvent;

        // JSON.stringify throws on circular references
        const msg = createSessionEvent({ event: circularEvent });
        expect(() => JSON.stringify(msg)).toThrow();
      });
    });

    describe('edge cases', () => {
      it('should handle empty string sessionId', () => {
        const valid = createSessionEvent({ sessionId: '' });
        expect(isSessionEvent(valid)).toBe(true);
      });

      it('should handle null event', () => {
        const valid = createSessionEvent({ event: null });
        expect(isSessionEvent(valid)).toBe(true);
      });

      it('should handle undefined event', () => {
        const invalid = { type: 'session_event', sessionId: 'test' };
        expect(isSessionEvent(invalid)).toBe(false);
      });

      it('should handle empty object event', () => {
        const valid = createSessionEvent({ event: {} });
        expect(isSessionEvent(valid)).toBe(true);
      });

      it('should handle array event', () => {
        const valid = createSessionEvent({ event: [1, 2, 3] });
        expect(isSessionEvent(valid)).toBe(true);
      });
    });
  });

  // ==========================================================================
  // SubscribeSession Tests
  // ==========================================================================
  describe('SubscribeSession', () => {
    describe('validation', () => {
      it('should validate required fields', () => {
        const valid = createSubscribeSession();
        expect(isSubscribeSession(valid)).toBe(true);
      });

      it('should reject missing sessionPath', () => {
        const invalid = { type: 'subscribe_session' };
        expect(isSubscribeSession(invalid)).toBe(false);
      });

      it('should reject non-string sessionPath', () => {
        const invalid = createSubscribeSession({
          sessionPath: 123 as unknown as string,
        });
        expect(isSubscribeSession(invalid)).toBe(false);
      });

      it('should reject wrong type', () => {
        const invalid = {
          type: 'unsubscribe_session',
          sessionPath: '/path/to/session.jsonl',
        };
        expect(isSubscribeSession(invalid)).toBe(false);
      });
    });

    describe('serialization', () => {
      it('should serialize to JSON correctly', () => {
        const msg = createSubscribeSession({
          sessionPath: '/home/user/sessions/test.jsonl',
        });

        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.type).toBe('subscribe_session');
        expect(parsed.sessionPath).toBe('/home/user/sessions/test.jsonl');
      });

      it('should round-trip through JSON', () => {
        const original = createSubscribeSession();
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);

        expect(isSubscribeSession(parsed)).toBe(true);
        expect(parsed.sessionPath).toBe(original.sessionPath);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string sessionPath', () => {
        const valid = createSubscribeSession({ sessionPath: '' });
        expect(isSubscribeSession(valid)).toBe(true);
      });

      it('should handle relative path', () => {
        const valid = createSubscribeSession({
          sessionPath: './sessions/test.jsonl',
        });
        expect(isSubscribeSession(valid)).toBe(true);
      });

      it('should handle path with special characters', () => {
        const valid = createSubscribeSession({
          sessionPath: '/path/with spaces/and-dashes_and_underscores.jsonl',
        });
        expect(isSubscribeSession(valid)).toBe(true);
      });

      it('should handle path with unicode characters', () => {
        const valid = createSubscribeSession({
          sessionPath: '/path/日本語/путь.jsonl',
        });
        expect(isSubscribeSession(valid)).toBe(true);
      });

      it('should handle very long path', () => {
        const longPath = '/a'.repeat(1000) + '.jsonl';
        const valid = createSubscribeSession({ sessionPath: longPath });
        expect(isSubscribeSession(valid)).toBe(true);
      });

      it('should reject null', () => {
        expect(isSubscribeSession(null)).toBe(false);
      });

      it('should reject undefined', () => {
        expect(isSubscribeSession(undefined)).toBe(false);
      });

      it('should reject empty object', () => {
        expect(isSubscribeSession({})).toBe(false);
      });
    });
  });

  // ==========================================================================
  // UnsubscribeSession Tests
  // ==========================================================================
  describe('UnsubscribeSession', () => {
    describe('validation', () => {
      it('should validate required fields', () => {
        const valid = createUnsubscribeSession();
        expect(isUnsubscribeSession(valid)).toBe(true);
      });

      it('should reject missing sessionPath', () => {
        const invalid = { type: 'unsubscribe_session' };
        expect(isUnsubscribeSession(invalid)).toBe(false);
      });

      it('should reject non-string sessionPath', () => {
        const invalid = createUnsubscribeSession({
          sessionPath: { path: 'invalid' } as unknown as string,
        });
        expect(isUnsubscribeSession(invalid)).toBe(false);
      });

      it('should reject wrong type', () => {
        const invalid = {
          type: 'subscribe_session',
          sessionPath: '/path/to/session.jsonl',
        };
        expect(isUnsubscribeSession(invalid)).toBe(false);
      });
    });

    describe('serialization', () => {
      it('should serialize to JSON correctly', () => {
        const msg = createUnsubscribeSession({
          sessionPath: '/home/user/sessions/test.jsonl',
        });

        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.type).toBe('unsubscribe_session');
        expect(parsed.sessionPath).toBe('/home/user/sessions/test.jsonl');
      });

      it('should round-trip through JSON', () => {
        const original = createUnsubscribeSession();
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);

        expect(isUnsubscribeSession(parsed)).toBe(true);
        expect(parsed.sessionPath).toBe(original.sessionPath);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string sessionPath', () => {
        const valid = createUnsubscribeSession({ sessionPath: '' });
        expect(isUnsubscribeSession(valid)).toBe(true);
      });

      it('should handle null sessionPath (reject)', () => {
        const invalid = {
          type: 'unsubscribe_session',
          sessionPath: null,
        };
        expect(isUnsubscribeSession(invalid)).toBe(false);
      });
    });
  });

  // ==========================================================================
  // SessionSubscribed Tests
  // ==========================================================================
  describe('SessionSubscribed', () => {
    describe('validation', () => {
      it('should validate required fields', () => {
        const valid = createSessionSubscribed();
        expect(isSessionSubscribed(valid)).toBe(true);
      });

      it('should reject missing sessionId', () => {
        const invalid = { ...createSessionSubscribed() };
        delete (invalid as Record<string, unknown>).sessionId;
        expect(isSessionSubscribed(invalid)).toBe(false);
      });

      it('should reject missing sessionPath', () => {
        const invalid = { ...createSessionSubscribed() };
        delete (invalid as Record<string, unknown>).sessionPath;
        expect(isSessionSubscribed(invalid)).toBe(false);
      });

      it('should reject missing status', () => {
        const invalid = { ...createSessionSubscribed() };
        delete (invalid as Record<string, unknown>).status;
        expect(isSessionSubscribed(invalid)).toBe(false);
      });

      it('should reject invalid status type', () => {
        const invalid = createSessionSubscribed({
          status: 'invalid' as SessionStatus,
        });
        expect(isSessionSubscribed(invalid)).toBe(false);
      });

      it('should accept all valid status types', () => {
        const statuses: SessionStatus[] = ['idle', 'busy', 'streaming', 'error'];
        for (const status of statuses) {
          const valid = createSessionSubscribed({ status });
          expect(isSessionSubscribed(valid)).toBe(true);
        }
      });
    });

    describe('serialization', () => {
      it('should include session status on subscribe', () => {
        const msg = createSessionSubscribed({
          sessionId: 'session-789',
          sessionPath: '/path/to/session.jsonl',
          status: 'streaming',
        });

        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.type).toBe('session_subscribed');
        expect(parsed.sessionId).toBe('session-789');
        expect(parsed.sessionPath).toBe('/path/to/session.jsonl');
        expect(parsed.status).toBe('streaming');
      });

      it('should round-trip through JSON', () => {
        const original = createSessionSubscribed();
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);

        expect(isSessionSubscribed(parsed)).toBe(true);
        expect(parsed.sessionId).toBe(original.sessionId);
        expect(parsed.status).toBe(original.status);
      });
    });

    describe('edge cases', () => {
      it('should handle all status values', () => {
        const statuses: SessionStatus[] = ['idle', 'busy', 'streaming', 'error'];
        for (const status of statuses) {
          const msg = createSessionSubscribed({ status });
          const json = JSON.stringify(msg);
          const parsed = JSON.parse(json);
          expect(parsed.status).toBe(status);
        }
      });

      it('should handle empty strings for IDs and paths', () => {
        const valid = createSessionSubscribed({
          sessionId: '',
          sessionPath: '',
        });
        expect(isSessionSubscribed(valid)).toBe(true);
      });
    });
  });

  // ==========================================================================
  // SessionUnsubscribed Tests
  // ==========================================================================
  describe('SessionUnsubscribed', () => {
    describe('validation', () => {
      it('should validate required fields', () => {
        const valid = createSessionUnsubscribed();
        expect(isSessionUnsubscribed(valid)).toBe(true);
      });

      it('should reject missing sessionId', () => {
        const invalid = { type: 'session_unsubscribed' };
        expect(isSessionUnsubscribed(invalid)).toBe(false);
      });

      it('should reject non-string sessionId', () => {
        const invalid = createSessionUnsubscribed({
          sessionId: 123 as unknown as string,
        });
        expect(isSessionUnsubscribed(invalid)).toBe(false);
      });

      it('should reject wrong type', () => {
        const invalid = {
          type: 'session_subscribed',
          sessionId: 'session-123',
          sessionPath: '/path',
          status: 'idle',
        };
        expect(isSessionUnsubscribed(invalid)).toBe(false);
      });
    });

    describe('serialization', () => {
      it('should serialize to JSON correctly', () => {
        const msg = createSessionUnsubscribed({
          sessionId: 'session-abc',
        });

        const json = JSON.stringify(msg);
        const parsed = JSON.parse(json);

        expect(parsed.type).toBe('session_unsubscribed');
        expect(parsed.sessionId).toBe('session-abc');
      });

      it('should round-trip through JSON', () => {
        const original = createSessionUnsubscribed();
        const json = JSON.stringify(original);
        const parsed = JSON.parse(json);

        expect(isSessionUnsubscribed(parsed)).toBe(true);
        expect(parsed.sessionId).toBe(original.sessionId);
      });
    });

    describe('edge cases', () => {
      it('should handle empty string sessionId', () => {
        const valid = createSessionUnsubscribed({ sessionId: '' });
        expect(isSessionUnsubscribed(valid)).toBe(true);
      });

      it('should handle UUID format sessionId', () => {
        const uuid = '123e4567-e89b-12d3-a456-426614174000';
        const valid = createSessionUnsubscribed({ sessionId: uuid });
        expect(isSessionUnsubscribed(valid)).toBe(true);
      });

      it('should reject null sessionId', () => {
        const invalid = {
          type: 'session_unsubscribed',
          sessionId: null,
        };
        expect(isSessionUnsubscribed(invalid)).toBe(false);
      });
    });
  });

  // ==========================================================================
  // SessionStatus Validation Tests
  // ==========================================================================
  describe('SessionStatus validation', () => {
    it('should accept valid status values', () => {
      expect(isValidSessionStatus('idle')).toBe(true);
      expect(isValidSessionStatus('busy')).toBe(true);
      expect(isValidSessionStatus('streaming')).toBe(true);
      expect(isValidSessionStatus('error')).toBe(true);
    });

    it('should reject invalid status values', () => {
      expect(isValidSessionStatus('invalid')).toBe(false);
      expect(isValidSessionStatus('IDLE')).toBe(false);
      expect(isValidSessionStatus('Idle')).toBe(false);
      expect(isValidSessionStatus('')).toBe(false);
      expect(isValidSessionStatus('idle ')).toBe(false);
      expect(isValidSessionStatus(' idle')).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(isValidSessionStatus(null)).toBe(false);
      expect(isValidSessionStatus(undefined)).toBe(false);
      expect(isValidSessionStatus(123)).toBe(false);
      expect(isValidSessionStatus({})).toBe(false);
      expect(isValidSessionStatus([])).toBe(false);
      expect(isValidSessionStatus(true)).toBe(false);
    });
  });

  // ==========================================================================
  // Cross-Type Validation Tests
  // ==========================================================================
  describe('cross-type validation', () => {
    it('should not confuse SessionStatusBroadcast with other types', () => {
      const broadcast = createSessionStatusBroadcast();
      expect(isSessionStatusBroadcast(broadcast)).toBe(true);
      expect(isSessionEvent(broadcast)).toBe(false);
      expect(isSubscribeSession(broadcast)).toBe(false);
      expect(isSessionSubscribed(broadcast)).toBe(false);
    });

    it('should not confuse SessionEvent with other types', () => {
      const event = createSessionEvent();
      expect(isSessionEvent(event)).toBe(true);
      expect(isSessionStatusBroadcast(event)).toBe(false);
      expect(isSessionSubscribed(event)).toBe(false);
    });

    it('should not confuse SubscribeSession with UnsubscribeSession', () => {
      const subscribe = createSubscribeSession();
      const unsubscribe = createUnsubscribeSession();

      expect(isSubscribeSession(subscribe)).toBe(true);
      expect(isSubscribeSession(unsubscribe)).toBe(false);
      expect(isUnsubscribeSession(unsubscribe)).toBe(true);
      expect(isUnsubscribeSession(subscribe)).toBe(false);
    });

    it('should not confuse SessionSubscribed with SessionUnsubscribed', () => {
      const subscribed = createSessionSubscribed();
      const unsubscribed = createSessionUnsubscribed();

      expect(isSessionSubscribed(subscribed)).toBe(true);
      expect(isSessionSubscribed(unsubscribed)).toBe(false);
      expect(isSessionUnsubscribed(unsubscribed)).toBe(true);
      expect(isSessionUnsubscribed(subscribed)).toBe(false);
    });
  });

  // ==========================================================================
  // Message Flow Simulation Tests
  // ==========================================================================
  describe('message flow simulation', () => {
    it('should validate a complete subscribe flow', () => {
      // 1. Client sends subscribe request
      const subscribeReq = createSubscribeSession({
        sessionPath: '/sessions/test.jsonl',
      });
      expect(isSubscribeSession(subscribeReq)).toBe(true);

      // 2. Server sends confirmation
      const subscribeResp = createSessionSubscribed({
        sessionId: 'session-123',
        sessionPath: '/sessions/test.jsonl',
        status: 'idle',
      });
      expect(isSessionSubscribed(subscribeResp)).toBe(true);

      // 3. Server sends status broadcast
      const statusBroadcast = createSessionStatusBroadcast({
        sessionId: 'session-123',
        sessionPath: '/sessions/test.jsonl',
        status: 'streaming',
        messageCount: 1,
        currentStep: 1,
      });
      expect(isSessionStatusBroadcast(statusBroadcast)).toBe(true);

      // 4. Server sends event
      const event = createSessionEvent({
        sessionId: 'session-123',
        event: { type: 'message_start', message: { id: 'msg-1' } },
      });
      expect(isSessionEvent(event)).toBe(true);

      // 5. Client unsubscribes
      const unsubscribeReq = createUnsubscribeSession({
        sessionPath: '/sessions/test.jsonl',
      });
      expect(isUnsubscribeSession(unsubscribeReq)).toBe(true);

      // 6. Server confirms unsubscription
      const unsubscribeResp = createSessionUnsubscribed({
        sessionId: 'session-123',
      });
      expect(isSessionUnsubscribed(unsubscribeResp)).toBe(true);
    });

    it('should handle concurrent session subscriptions', () => {
      const sessions = [
        '/sessions/session-1.jsonl',
        '/sessions/session-2.jsonl',
        '/sessions/session-3.jsonl',
      ];

      // Subscribe to multiple sessions
      const subscribeRequests = sessions.map((path) =>
        createSubscribeSession({ sessionPath: path })
      );

      subscribeRequests.forEach((req) => {
        expect(isSubscribeSession(req)).toBe(true);
      });

      // Server confirms each subscription
      const subscribedResponses = sessions.map((path, i) =>
        createSessionSubscribed({
          sessionId: `session-${i + 1}`,
          sessionPath: path,
          status: i === 0 ? 'streaming' : 'idle',
        })
      );

      subscribedResponses.forEach((resp) => {
        expect(isSessionSubscribed(resp)).toBe(true);
      });

      // Status broadcasts for all sessions
      const statusBroadcasts = sessions.map((path, i) =>
        createSessionStatusBroadcast({
          sessionId: `session-${i + 1}`,
          sessionPath: path,
          status: i === 0 ? 'streaming' : 'idle',
          messageCount: i + 1,
        })
      );

      statusBroadcasts.forEach((broadcast) => {
        expect(isSessionStatusBroadcast(broadcast)).toBe(true);
      });
    });

    it('should handle rapid subscribe/unsubscribe cycles', () => {
      const path = '/sessions/test.jsonl';

      for (let i = 0; i < 5; i++) {
        const subscribe = createSubscribeSession({ sessionPath: path });
        expect(isSubscribeSession(subscribe)).toBe(true);

        const subscribed = createSessionSubscribed({
          sessionId: `session-${i}`,
          sessionPath: path,
          status: 'idle',
        });
        expect(isSessionSubscribed(subscribed)).toBe(true);

        const unsubscribe = createUnsubscribeSession({ sessionPath: path });
        expect(isUnsubscribeSession(unsubscribe)).toBe(true);

        const unsubscribed = createSessionUnsubscribed({
          sessionId: `session-${i}`,
        });
        expect(isSessionUnsubscribed(unsubscribed)).toBe(true);
      }
    });
  });
});
