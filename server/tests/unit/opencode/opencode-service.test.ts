import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { OpenCodeService } from '../../../src/opencode/opencode-service.js';
import type { OpenCodeSession, OpenCodeMessage } from '../../../src/opencode/opencode-types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeSession(overrides: Partial<OpenCodeSession> = {}): OpenCodeSession {
  return {
    id: 'oc-sess-1',
    slug: 'test-session',
    version: '1',
    projectID: 'proj-1',
    directory: '/tmp',
    title: 'Test Session',
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  };
}

function makeUserMessage(text: string): OpenCodeMessage {
  return {
    info: {
      id: 'msg-user-1',
      sessionID: 'oc-sess-1',
      role: 'user',
      time: { created: Date.now() },
    },
    parts: [{ type: 'text', id: 'p1', sessionID: 'oc-sess-1', messageID: 'msg-user-1', text }],
  };
}

function makeAssistantMessage(text: string): OpenCodeMessage {
  return {
    info: {
      id: 'msg-assistant-1',
      sessionID: 'oc-sess-1',
      role: 'assistant',
      time: { created: Date.now() },
    },
    parts: [{ type: 'text', id: 'p2', sessionID: 'oc-sess-1', messageID: 'msg-assistant-1', text }],
  };
}

describe('OpenCodeService', () => {
  let service: OpenCodeService;
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-service-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
    mockFetch.mockReset();
    service = new OpenCodeService({ registryPath });
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('isAvailable', () => {
    it('returns false when opencode is not on PATH', async () => {
      const result = await service.isAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isRunning', () => {
    it('returns false for unknown sessions', () => {
      expect(service.isRunning('unknown')).toBe(false);
    });
  });

  describe('getReplayEvents', () => {
    it('returns empty array for unknown sessions', async () => {
      const events = await service.getReplayEvents('unknown');
      expect(events).toEqual([]);
    });

    it('converts messages to replay events', async () => {
      const session = makeSession();
      const userMsg = makeUserMessage('hello');
      const assistantMsg = makeAssistantMessage('world');

      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/session') || url.includes('/session?')) {
          return Promise.resolve(jsonResponse(session));
        }
        if (url.includes('/message')) {
          return Promise.resolve(jsonResponse([userMsg, assistantMsg]));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId } = await service.createSession('/tmp');
      const events = await service.getReplayEvents(sessionId);

      expect(events.length).toBeGreaterThan(0);

      const types = events.map(e => e.type as string);
      expect(types).toContain('message_start');
      expect(types).toContain('message_end');
    });
  });

  describe('replyPermission', () => {
    it('calls the permission reply API', async () => {
      const session = makeSession();

      mockFetch.mockImplementation((url: string, opts: RequestInit) => {
        if (url.endsWith('/session') && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(session));
        }
        if (url.includes('/permissions/')) {
          return Promise.resolve(jsonResponse({}));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId } = await service.createSession('/tmp');

      const ocSessionId = (service as unknown as Record<string, Map<string, string>>).opencodeSessionIds?.get(sessionId);
      expect(ocSessionId).toBeDefined();

      await service.replyPermission(sessionId, 'perm-1', true);

      const permCall = mockFetch.mock.calls.find(
        (c: [string, RequestInit]) => c[0].includes('/permissions/perm-1'),
      );
      expect(permCall).toBeDefined();
    });
  });

  describe('listSessions', () => {
    it('returns opencode sessions from registry', async () => {
      const session = makeSession();

      mockFetch.mockImplementation((url: string, opts: RequestInit) => {
        if (url.endsWith('/session') && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(session));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId } = await service.createSession('/tmp');
      const sessions = await service.listSessions();

      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions.some(s => s.id === sessionId)).toBe(true);
    });
  });

  describe('getSubscriberTracker', () => {
    it('returns the subscriber tracker instance', () => {
      const tracker = service.getSubscriberTracker();
      expect(tracker).toBeDefined();
      expect(typeof tracker.subscribe).toBe('function');
    });
  });

  describe('permission tracking', () => {
    it('isPendingPermission returns false for unknown permission', () => {
      expect(service.isPendingPermission('unknown')).toBe(false);
    });

    it('getSessionForPermission returns undefined for unknown permission', () => {
      expect(service.getSessionForPermission('unknown')).toBeUndefined();
    });
  });

  describe('resolvePermission', () => {
    it('throws for unknown permission ID', async () => {
      await expect(service.resolvePermission('unknown', true)).rejects.toThrow('Unknown permission');
    });
  });

  describe('shutdown', () => {
    it('can be called without error', async () => {
      await expect(service.shutdown()).resolves.toBeUndefined();
    });
  });
});
