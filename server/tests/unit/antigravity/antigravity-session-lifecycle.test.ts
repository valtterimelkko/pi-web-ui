import { describe, it, expect, vi, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';

/**
 * Process-lifecycle ownership for stream-mode Antigravity sessions
 * (census 2026-10-16: sessions created through the Internal API and then
 * deleted with DELETE /sessions/:id left their `agy --input-format stream-json`
 * processes running for up to the idle window — six piled up and exhausted the
 * host's inotify limit).
 *
 * What owns the process: AntigravityService.streamProcesses — one persistent
 * AgyStreamProcess per live session. A session's child is only ended by (a) an
 * in-flight turn cut-off, (b) the idle stdin-close timer inside
 * AgyStreamProcess (ANTIGRAVITY_IDLE_TIMEOUT_MS), or (c) the parent process
 * exiting and closing the child's stdin pipe. Deletion went through
 * AntigravityService.abort() → AgyStreamProcess.abort(), which used to return
 * early for an IDLE process (no pending turn) — exactly the state a
 * delete-after-one-prompt session is in.
 *
 * The harness drives a REAL AntigravityService with a scripted fake agy child
 * (the same wire the stub binary speaks) so the process ownership is asserted
 * on the object the delete path really calls.
 */

const ctrl = vi.hoisted(() => {
  // Must be set BEFORE the config module is imported (module-level singleton
  // reads this env at import time). vi.hoisted runs before the imports below.
  const sessionDir = `/tmp/agy-lifecycle-store-${process.pid}-${Math.random().toString(36).slice(2)}`;
  process.env.ANTIGRAVITY_SESSION_DIR = sessionDir;
  process.env.ANTIGRAVITY_IDLE_TIMEOUT_MS = '500';
  process.env.ANTIGRAVITY_CLEANUP_INTERVAL_MS = '200';
  return { sessionDir };
});

import { AntigravityService } from '../../../src/antigravity/antigravity-service.js';

const INIT_LINE =
  '{"event":"init","conversation_id":"c-life-1","init":{"cwd":"/tmp/agy-lifecycle","tools":["run_command"],"permission_mode":"always-proceed","model":"gemini-3.6-flash-low"}}';

const SCRIPTED =
  INIT_LINE +
  '\n' +
  JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'c-life-1',
      status: 'SUCCESS',
      response: 'done',
      duration_seconds: 0.4,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 2, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 12 },
    },
  }) +
  '\n';

/** Scripted fake agy child: records signals + stdin writes, replays the wire on
 *  the first turn write, and NEVER emits `close` (so a process is not silently
 *  reaped by the fake — only by the code under test). */
interface FakeStdin extends EventEmitter {
  write: (chunk: string) => boolean;
  end: () => void;
  destroyed: boolean;
}

class FakeAgyChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  readonly stdinWrites: string[] = [];
  readonly stdin: FakeStdin;

  constructor() {
    super();
    const writes = this.stdinWrites;
    const stdout = this.stdout;
    const stdin = new EventEmitter() as FakeStdin;
    stdin.destroyed = false;
    stdin.write = (chunk: string) => {
      writes.push(chunk);
      if (stdout.listenerCount('data') > 0) stdout.emit('data', Buffer.from(SCRIPTED));
      return true;
    };
    stdin.end = () => {
      writes.push('__END__');
      stdin.destroyed = true;
    };
    this.stdin = stdin;
  }

  kill(signal: string): void {
    this.signals.push(signal);
  }
}

let registryCounter = 0;

function makeService(): { service: AntigravityService; children: FakeAgyChild[] } {
  const children: FakeAgyChild[] = [];
  const service = new AntigravityService({
    registryPath: `${ctrl.sessionDir}/registry-${++registryCounter}.json`,
    streamSpawnFn: (() => {
      const child = new FakeAgyChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  return { service, children };
}

function promptOnce(service: AntigravityService, sessionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void service.sendPrompt(sessionId, 'tiny prompt', () => {}, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

/** One session, one completed turn: the state DELETE /sessions/:id finds — a
 *  live keep-warm agy child with no in-flight turn. */
async function startedIdleSession() {
  const { service, children } = makeService();
  const { sessionId } = await service.createSession('/tmp/agy-lifecycle', 'gemini-3.6-flash-low');
  await promptOnce(service, sessionId);
  return { service, children, sessionId };
}

describe('antigravity session process lifecycle', () => {
  it('DELETE path: abort() ends the session\'s live agy child and never reuses the dying process', async () => {
    const { service, children, sessionId } = await startedIdleSession();
    expect(children).toHaveLength(1);
    expect(children[0].signals).toEqual([]);
    expect(service.hasSession(sessionId)).toBe(true);

    // Exactly the call the delete route makes (server/src/internal-api/routes/sessions.ts:3306).
    service.abort(sessionId);

    expect(children[0].signals).toContain('SIGTERM');
    await vi.waitFor(() => { expect(children[0].stdinWrites).toContain('__END__'); });

    // A follow-up turn (the same session re-used before its registry entry goes)
    // must get a FRESH process, never the one being terminated.
    await promptOnce(service, sessionId);
    expect(children).toHaveLength(2);
  });

  it('server-stop path: shutdown() terminates every live agy child', async () => {
    const { service, children } = makeService();
    const first = await service.createSession('/tmp/agy-lifecycle', 'gemini-3.6-flash-low');
    const second = await service.createSession('/tmp/agy-lifecycle', 'gemini-3.6-flash-low');
    await promptOnce(service, first.sessionId);
    await promptOnce(service, second.sessionId);
    expect(children).toHaveLength(2);
    expect(children.flatMap((c) => c.signals)).toEqual([]);

    await service.shutdown();

    expect(children[0].signals).toContain('SIGTERM');
    expect(children[1].signals).toContain('SIGTERM');
  });

  it('the idle/expired path is NOT a leak: the process ends itself on schedule (its own idle stdin close)', async () => {
    // Characterisation, not a fix: AgyStreamProcess.armIdleTimer() closes the
    // child's stdin `idleTimeoutMs` after the last turn (unit-pinned by
    // agy-stream-process.test.ts T3.5), which makes the process unusable and
    // ends it cleanly (live-validated: stdin close after a completed turn exits
    // 0). The abandoned process is therefore never written into again: a later
    // turn on the forgotten session spawns a fresh one.
    vi.useFakeTimers();
    try {
      const { service, children, sessionId } = await startedIdleSession();
      expect(children).toHaveLength(1);
      // idle window 500 ms + cleanup interval 200 ms
      await vi.advanceTimersByTimeAsync(1_000);
      expect(service.hasSession(sessionId)).toBe(false);
      expect(children[0].stdinWrites).toContain('__END__');

      await promptOnce(service, sessionId);
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterAll(() => {
  try {
    rmSync(ctrl.sessionDir, { recursive: true, force: true });
  } catch { /* tmp cleanup best-effort */ }
});
