import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeService } from '../../src/opencode/opencode-service.js';
import { ClaudeChannelService } from '../../src/claude/claude-channel-service.js';
import { setLogTap, type LogRecord } from '../../src/logging/logger.js';

afterEach(() => setLogTap(null));
function rejectingRegistry() {
  return { updateStatus: vi.fn(() => {
    const promise = Promise.reject(new Error('synthetic registry unavailable'));
    // Keep RED focused on the missing operator notice, not a runner-level
    // unhandled-rejection failure. The actual caller still receives rejection.
    void promise.catch(() => {});
    return promise;
  }) };
}

describe('fire-and-forget registry callers', () => {
  it.each(['complete', 'stale-pinned', 'stale-unpinned'])('reports OpenCode %s persistence failure', async mode => {
    const logs: LogRecord[] = [];
    setLogTap(record => logs.push(record));
    const service = new OpenCodeService({ registryPath: '/fixture/not-opened.json' });
    const registry = rejectingRegistry();
    const seam = service as unknown as { registry: typeof registry;
      sessionMeta: Map<string, { status: string; pinned: boolean; lastActivity: number; lastEventTimestamp: number }>;
      completeSession(id: string): void; cleanupIdleSessions(): void;
    };
    seam.registry = registry;
    seam.sessionMeta.set('fixture-session', { status: 'streaming', pinned: mode === 'stale-pinned', lastActivity: Date.now(), lastEventTimestamp: 0 });
    if (mode === 'complete') seam.completeSession('fixture-session'); else seam.cleanupIdleSessions();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(logs).toContainEqual(expect.objectContaining({ level: 'error', sessionId: 'fixture-session' }));
    expect(registry.updateStatus).toHaveBeenCalledOnce();
  });

  it('reports Claude channel abort persistence failure without losing completion', async () => {
    const logs: LogRecord[] = [];
    setLogTap(record => logs.push(record));
    const onComplete = vi.fn();
    const timer = setTimeout(() => {}, 60_000);
    // Exercise the real abort entrypoint with inert channel/PTY boundaries.
    const service = Object.assign(Object.create(ClaudeChannelService.prototype), {
      registry: rejectingRegistry(), internalToClaude: new Map(), abortedSessions: new Set(), latePromptListeners: new Map(),
      processManager: { sendInterrupt: vi.fn(), markPromptComplete: vi.fn() },
      pendingPrompts: new Map([['fixture-session', { timer, onComplete }]]),
    }) as ClaudeChannelService;
    try {
      service.abort('fixture-session');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(onComplete).toHaveBeenCalledOnce();
      expect(logs).toContainEqual(expect.objectContaining({ level: 'error', sessionId: 'fixture-session' }));
    } finally { clearTimeout(timer); }
  });
});
