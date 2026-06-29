import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { NormalizedEvent } from '@pi-web-ui/shared';

/**
 * Antigravity runs `agy` via a module-private runAgy() that spawns a child
 * process. We stub `spawn` (preserving every other child_process export) so the
 * child errors on the next tick: runAgy rejects, runPromptAsync takes its catch
 * path, and still emits agent_end — proving observer fan-out is wired into the
 * emit path with no real agy involved.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      process.nextTick(() => child.emit('error', new Error('mocked agy unavailable')));
      return child;
    }),
  };
});

import { config } from '../../../src/config.js';
import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';

describe('AntigravityService — API observer (origin-independent agent_end)', () => {
  let tmp: string;
  let svc: AntigravityService;
  let prevSessionDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'antigravity-observer-'));
    prevSessionDir = config.antigravitySessionDir;
    // config is a mutable singleton; isolate AG session storage to the temp dir.
    config.antigravitySessionDir = tmp;
    svc = new AntigravityService({ registryPath: join(tmp, 'registry.json') });
  });

  afterEach(() => {
    config.antigravitySessionDir = prevSessionDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('delivers agent_end to an attached observer (via the runPromptAsync error path)', async () => {
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
