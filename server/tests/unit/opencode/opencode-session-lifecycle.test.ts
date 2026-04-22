import { describe, it, expect, beforeEach, beforeAll, vi, afterEach, afterAll } from 'vitest';
import { OpenCodeService } from '../../../src/opencode/opencode-service.js';
import type { OpenCodeSession } from '../../../src/opencode/opencode-types.js';
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
    id: `oc-sess-${Math.random().toString(36).slice(2, 8)}`,
    slug: 'test-session',
    version: '1',
    projectID: 'proj-1',
    directory: '/tmp',
    title: 'Test Session',
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  };
}

async function createTestSession(service: OpenCodeService, cwd = '/tmp'): Promise<string> {
  const session = makeSession({ directory: cwd });
  let callIdx = 0;
  mockFetch.mockImplementation((url: string, opts: RequestInit) => {
    if (url.includes('/config/providers')) return Promise.resolve(jsonResponse({ providers: {} }));
    if (url.includes('/session?') && opts?.method === 'POST') return Promise.resolve(jsonResponse(session));
    return Promise.resolve(jsonResponse(null));
  });
  const { sessionId } = await service.createSession(cwd);
  return sessionId;
}

describe('OpenCodeService — Session Lifecycle', () => {
  let service: OpenCodeService;
  let tmpDir: string;
  let registryPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-lifecycle-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
  });

  beforeEach(async () => {
    mockFetch.mockReset();
    await fs.rm(registryPath, { force: true }).catch(() => {});
    await fs.mkdir(tmpDir, { recursive: true });
    service = new OpenCodeService({
      registryPath,
      lifecycle: {
        maxSessions: 3,
        idleTimeoutMs: 5000,
        staleStreamingMs: 2000,
        maxPinnedSessions: 2,
        cleanupIntervalMs: 60000,
      },
    });
  });

  afterEach(async () => {
    await service.shutdown().catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('pinSession', () => {
    it('pins an existing session', async () => {
      const sessionId = await createTestSession(service);
      expect(service.pinSession(sessionId)).toBe(true);
      expect(service.isSessionPinned(sessionId)).toBe(true);
    });

    it('returns false for unknown sessions', () => {
      expect(service.pinSession('unknown')).toBe(false);
    });

    it('enforces max pinned sessions limit', async () => {
      const s1 = await createTestSession(service);
      const s2 = await createTestSession(service);
      const s3 = await createTestSession(service);

      expect(service.pinSession(s1)).toBe(true);
      expect(service.pinSession(s2)).toBe(true);
      expect(service.pinSession(s3)).toBe(false);
    });

    it('returns true when pinning an already-pinned session', async () => {
      const sessionId = await createTestSession(service);
      expect(service.pinSession(sessionId)).toBe(true);
      expect(service.pinSession(sessionId)).toBe(true);
    });
  });

  describe('unpinSession', () => {
    it('unpins a pinned session', async () => {
      const sessionId = await createTestSession(service);
      service.pinSession(sessionId);
      expect(service.unpinSession(sessionId)).toBe(true);
      expect(service.isSessionPinned(sessionId)).toBe(false);
    });

    it('returns false for unknown sessions', () => {
      expect(service.unpinSession('unknown')).toBe(false);
    });

    it('allows re-pinning after unpinning when at limit', async () => {
      const s1 = await createTestSession(service);
      const s2 = await createTestSession(service);
      const s3 = await createTestSession(service);

      service.pinSession(s1);
      service.pinSession(s2);
      expect(service.pinSession(s3)).toBe(false);

      service.unpinSession(s1);
      expect(service.pinSession(s3)).toBe(true);
    });
  });

  describe('getPinnedCount', () => {
    it('returns 0 when no sessions are pinned', async () => {
      await createTestSession(service);
      expect(service.getPinnedCount()).toBe(0);
    });

    it('returns correct count after pinning', async () => {
      const s1 = await createTestSession(service);
      const s2 = await createTestSession(service);
      service.pinSession(s1);
      expect(service.getPinnedCount()).toBe(1);
      service.pinSession(s2);
      expect(service.getPinnedCount()).toBe(2);
    });
  });

  describe('getSessionStatuses', () => {
    it('returns statuses for tracked sessions', async () => {
      const sessionId = await createTestSession(service);
      const statuses = service.getSessionStatuses();
      expect(statuses.length).toBeGreaterThanOrEqual(1);
      const found = statuses.find(s => s.sessionId === sessionId);
      expect(found).toBeDefined();
      expect(found!.status).toBe('idle');
      expect(found!.pinned).toBe(false);
    });

    it('reflects pinned state in statuses', async () => {
      const sessionId = await createTestSession(service);
      service.pinSession(sessionId);
      const statuses = service.getSessionStatuses();
      const found = statuses.find(s => s.sessionId === sessionId);
      expect(found!.pinned).toBe(true);
    });
  });

  describe('touchSession', () => {
    it('updates lastActivity timestamp', async () => {
      const sessionId = await createTestSession(service);
      const before = service.getSessionStatuses().find(s => s.sessionId === sessionId)!;
      const beforeTime = before.lastActivity.getTime();

      await new Promise(r => setTimeout(r, 10));
      service.touchSession(sessionId);

      const after = service.getSessionStatuses().find(s => s.sessionId === sessionId)!;
      expect(after.lastActivity.getTime()).toBeGreaterThanOrEqual(beforeTime);
    });
  });

  describe('hasSession', () => {
    it('returns true for tracked sessions', async () => {
      const sessionId = await createTestSession(service);
      expect(service.hasSession(sessionId)).toBe(true);
    });

    it('returns false for unknown sessions', () => {
      expect(service.hasSession('unknown')).toBe(false);
    });
  });

  describe('idle session cleanup', () => {
    it('removes sessions idle beyond the timeout', async () => {
      const sessionId = await createTestSession(service);
      expect(service.hasSession(sessionId)).toBe(true);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        cleanupIdleSessions: () => void;
      };

      const meta = internals.sessionMeta.get(sessionId)!;
      meta.lastActivity = Date.now() - 10000;

      internals.cleanupIdleSessions();

      expect(service.hasSession(sessionId)).toBe(false);
    });

    it('does not remove pinned sessions even when idle', async () => {
      const sessionId = await createTestSession(service);
      service.pinSession(sessionId);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        cleanupIdleSessions: () => void;
      };

      const meta = internals.sessionMeta.get(sessionId)!;
      meta.lastActivity = Date.now() - 10000;

      internals.cleanupIdleSessions();

      expect(service.hasSession(sessionId)).toBe(true);
      expect(service.isSessionPinned(sessionId)).toBe(true);
    });

    it('does not remove sessions with active subscribers', async () => {
      const sessionId = await createTestSession(service);
      service.getSubscriberTracker().subscribe('client-1', sessionId);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        cleanupIdleSessions: () => void;
      };

      const meta = internals.sessionMeta.get(sessionId)!;
      meta.lastActivity = Date.now() - 10000;

      internals.cleanupIdleSessions();

      expect(service.hasSession(sessionId)).toBe(true);

      service.getSubscriberTracker().unsubscribe('client-1', sessionId);
    });
  });

  describe('stale streaming detection', () => {
    it('resets sessions stuck in streaming state beyond the threshold', async () => {
      const sessionId = await createTestSession(service);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        runningSessions: Set<string>;
        promptCallbacks: Map<string, { onComplete: (error?: Error) => void }>;
        cleanupIdleSessions: () => void;
      };

      internals.runningSessions.add(sessionId);
      const meta = internals.sessionMeta.get(sessionId)!;
      meta.status = 'streaming';
      meta.lastEventTimestamp = Date.now() - 5000;

      let completed = false;
      internals.promptCallbacks.set(sessionId, {
        onComplete: (error) => { completed = !error; },
      });

      internals.cleanupIdleSessions();

      expect(meta.status).toBe('idle');
      expect(internals.runningSessions.has(sessionId)).toBe(false);
    });

    it('keeps pinned sessions alive during stale reset', async () => {
      const sessionId = await createTestSession(service);
      service.pinSession(sessionId);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        runningSessions: Set<string>;
        promptCallbacks: Map<string, { onComplete: (error?: Error) => void }>;
        cleanupIdleSessions: () => void;
      };

      internals.runningSessions.add(sessionId);
      const meta = internals.sessionMeta.get(sessionId)!;
      meta.status = 'streaming';
      meta.lastEventTimestamp = Date.now() - 5000;

      internals.cleanupIdleSessions();

      expect(service.hasSession(sessionId)).toBe(true);
      expect(meta.status).toBe('idle');
      expect(service.isSessionPinned(sessionId)).toBe(true);
    });
  });

  describe('max sessions enforcement', () => {
    it('evicts oldest idle session when max is exceeded', async () => {
      const s1 = await createTestSession(service);
      const s2 = await createTestSession(service);
      const s3 = await createTestSession(service);

      expect(service.hasSession(s1)).toBe(true);
      expect(service.hasSession(s2)).toBe(true);
      expect(service.hasSession(s3)).toBe(true);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        cleanupIdleSessions: () => void;
      };

      const meta1 = internals.sessionMeta.get(s1)!;
      meta1.lastActivity = Date.now() - 10000;

      internals.cleanupIdleSessions();

      expect(service.hasSession(s1)).toBe(false);
      expect(service.hasSession(s2)).toBe(true);
      expect(service.hasSession(s3)).toBe(true);
    });

    it('does not evict pinned sessions even if oldest', async () => {
      const s1 = await createTestSession(service);
      const s2 = await createTestSession(service);
      const s3 = await createTestSession(service);

      service.pinSession(s1);

      const internals = service as unknown as {
        sessionMeta: Map<string, { lastActivity: number; pinned: boolean; status: string; lastEventTimestamp: number }>;
        cleanupIdleSessions: () => void;
      };

      const meta1 = internals.sessionMeta.get(s1)!;
      meta1.lastActivity = Date.now() - 10000;

      internals.cleanupIdleSessions();

      expect(service.hasSession(s1)).toBe(true);
    });
  });

  describe('cleanup timer', () => {
    it('cleanup timer is started on construction', () => {
      const internals = service as unknown as { cleanupTimer: ReturnType<typeof setInterval> | null };
      expect(internals.cleanupTimer).not.toBeNull();
    });

    it('cleanup timer is cleared on shutdown', async () => {
      const internals = service as unknown as { cleanupTimer: ReturnType<typeof setInterval> | null };
      await service.shutdown();
      expect(internals.cleanupTimer).toBeNull();
    });
  });
});
