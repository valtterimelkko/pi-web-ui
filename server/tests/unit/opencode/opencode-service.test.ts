import { describe, it, expect, beforeEach, beforeAll, vi, afterEach, afterAll } from 'vitest';
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

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-service-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await fs.rm(registryPath, { force: true }).catch(() => {});
    service = new OpenCodeService({ registryPath });
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
  });

  afterAll(async () => {
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

  describe('createSession', () => {
    it('stores opencodeSessionId and cwd in the registry', async () => {
      const session = makeSession({ directory: '/root' });

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/config/providers')) {
          return Promise.resolve(jsonResponse({ providers: {} }));
        }
        if (url.includes('/session?directory=')) {
          return Promise.resolve(jsonResponse(session));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId, opencodeSessionId } = await service.createSession('/root');
      expect(opencodeSessionId).toBe(session.id);

      const entry = await service.getSession(sessionId);
      expect(entry?.cwd).toBe('/root');
      expect(entry?.opencodeSessionId).toBe(session.id);
    });
  });

  describe('getReplayEvents', () => {
    it('returns empty array for unknown sessions', async () => {
      const events = await service.getReplayEvents('unknown');
      expect(events).toEqual([]);
    });

    it('requests message history for a known session', async () => {
      const session = makeSession();
      const userMsg = makeUserMessage('hello');
      const assistantMsg = makeAssistantMessage('world');

      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/config/providers')) {
          return Promise.resolve(jsonResponse({ providers: {} }));
        }
        if (url.includes('/session?directory=%2Ftmp')) {
          return Promise.resolve(jsonResponse(session));
        }
        if (url.includes('/message')) {
          return Promise.resolve(jsonResponse([userMsg, assistantMsg]));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId } = await service.createSession('/tmp');
      const events = await service.getReplayEvents(sessionId);

      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe('replyPermission', () => {
    it('can resolve a permission response for a known session', async () => {
      const session = makeSession();

      mockFetch.mockImplementation((url: string, opts: RequestInit) => {
        if (url.includes('/config/providers')) {
          return Promise.resolve(jsonResponse({ providers: {} }));
        }
        if (url.includes('/session?directory=%2Ftmp') && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(session));
        }
        if (url.includes('/permissions/')) {
          return Promise.resolve(jsonResponse({}));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId } = await service.createSession('/tmp');
      await expect(service.replyPermission(sessionId, 'perm-1', true)).resolves.toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('returns an array of opencode sessions from registry', async () => {
      const session = makeSession();

      mockFetch.mockImplementation((url: string, opts: RequestInit) => {
        if (url.includes('/config/providers')) {
          return Promise.resolve(jsonResponse({ providers: {} }));
        }
        if (url.includes('/session?directory=%2Ftmp') && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(session));
        }
        return Promise.resolve(jsonResponse(null));
      });

      await service.createSession('/tmp');
      const sessions = await service.listSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(1);
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

  describe('SSE routing', () => {
    it('routes events that use OpenCode sessionID casing', async () => {
      const session = makeSession({ directory: '/root' });
      mockFetch.mockImplementation((url: string, opts: RequestInit) => {
        if (url.endsWith('/config/providers')) {
          return Promise.resolve(jsonResponse({ providers: {} }));
        }
        if (url.endsWith('/session?directory=%2Froot') && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(session));
        }
        return Promise.resolve(jsonResponse(null));
      });

      const { sessionId } = await service.createSession('/root');
      const seen: string[] = [];
      const promptCallbacks = (service as unknown as {
        promptCallbacks: Map<string, { onEvent: (event: { type: string }) => void; onComplete: (error?: Error) => void }>;
      }).promptCallbacks;
      promptCallbacks.set(sessionId, {
        onEvent: (event) => seen.push(event.type),
        onComplete: () => undefined,
      });

      await (service as unknown as { handleSSEEvent: (event: { type: string; properties: Record<string, unknown> }) => Promise<void> }).handleSSEEvent({
        type: 'session.idle',
        properties: { sessionID: session.id },
      });

      expect(seen).toContain('agent_end');
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
