import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * The direct-CLI Claude backend spawns the `claude` process via ClaudeProcessPool.
 * We stub the pool so a prompt emits a synthetic `agent_end` and completes, which
 * lets us assert the new service-level observer fan-out works without a real CLI.
 */
vi.mock('../../../src/claude/claude-process-pool.js', () => ({
  ClaudeProcessPool: class {
    constructor() {
      /* no-op for tests */
    }
    async spawn(
      options: { sessionId: string },
      onEvent: (e: NormalizedEvent) => void | Promise<void>,
      onComplete: (error?: Error) => void,
    ): Promise<void> {
      // Await so the service's async on-event handler (persist + observer fan-out)
      // settles before completion is signaled.
      await onEvent({
        type: 'agent_end',
        sessionId: options.sessionId,
        timestamp: Date.now(),
        data: {},
      });
      onComplete();
    }
  },
  resolveClaudeSessionPath: () => '/tmp/claude-observer-test-session',
}));

import { ClaudeService } from '../../../src/claude/claude-service.js';

describe('ClaudeService — API observer (origin-independent agent_end)', () => {
  let tmp: string;
  let svc: ClaudeService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'claude-observer-'));
    svc = new ClaudeService({
      claudeSessionDir: join(tmp, 'sessions'),
      registryPath: join(tmp, 'registry.json'),
      useChannel: false,
      useSdk: false,
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('delivers agent_end to an attached observer regardless of which backend ran', async () => {
    const { sessionId } = await svc.createSession(tmp);
    const seen: string[] = [];
    svc.addApiObserver(sessionId, (e) => seen.push(e.type));

    await new Promise<void>((resolve) =>
      svc.sendPrompt(sessionId, 'hi', () => {}, () => resolve()),
    );

    expect(seen).toContain('agent_end');
  });

  it('stops delivering events after removeApiObserver', async () => {
    const { sessionId } = await svc.createSession(tmp);
    const seen: string[] = [];
    const obs = (e: NormalizedEvent) => seen.push(e.type);
    svc.addApiObserver(sessionId, obs);
    svc.removeApiObserver(sessionId, obs);

    await new Promise<void>((resolve) =>
      svc.sendPrompt(sessionId, 'hi', () => {}, () => resolve()),
    );

    expect(seen).not.toContain('agent_end');
  });
});
