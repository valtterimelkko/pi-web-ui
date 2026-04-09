import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock child_process BEFORE importing ClaudeProcessPool
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');

  function makeMockProcess(pid = 12345) {
    const proc = new EventEmitter() as unknown as import('child_process').ChildProcess;
    // Use PassThrough (proper Node.js Readable stream) so readline.createInterface works
    (proc as unknown as Record<string, unknown>).stdout = new PassThrough();
    (proc as unknown as Record<string, unknown>).stderr = new PassThrough();
    (proc as unknown as Record<string, unknown>).pid = pid;
    (proc as unknown as Record<string, unknown>).stdin = new PassThrough();
    const killFn = vi.fn((signal?: NodeJS.Signals | number) => {
      proc.emit('exit', null, signal ?? 'SIGTERM');
      return true;
    });
    (proc as unknown as Record<string, unknown>).kill = killFn;
    return proc;
  }

  const spawnMock = vi.fn().mockImplementation(() => makeMockProcess());

  return {
    spawn: spawnMock,
    default: { spawn: spawnMock },
    makeMockProcess,
  };
});

import { ClaudeProcessPool } from '../../../src/claude/claude-process-pool.js';
import { spawn } from 'child_process';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

// Helper to create a mock process whose kill() does NOT auto-emit exit.
// Tests must manually emit 'exit' to simulate real async process death.
function makeDeferredMockProcess(pid = 12345) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = pid;
  proc.kill = vi.fn(() => true);
  return proc;
}

// Helper to create a mock process whose kill() immediately emits exit (legacy behaviour).
function makeImmediateMockProcess(pid = 12345) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = pid;
  proc.kill = vi.fn((signal?: string) => {
    proc.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  });
  return proc;
}

describe('ClaudeProcessPool', () => {
  let pool: ClaudeProcessPool;

  const DEFAULT_OPTIONS = {
    sessionId: 'session-abc',
    claudeSessionId: 'claude-sess-xyz',
    cwd: '/tmp',
    model: 'sonnet',
    prompt: 'Hello',
  };

  beforeEach(() => {
    pool = new ClaudeProcessPool(3, 0); // 0ms grace period for fast tests
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => makeImmediateMockProcess());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Spawn adds to active set ──────────────────────────────────────────────

  it('spawning a process makes isActive() return true', async () => {
    let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeImmediateMockProcess(11111);
      capturedProc = proc;
      return proc;
    });

    const done = new Promise<void>((resolve) => {
      pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
    });

    // Give event loop a turn for spawn to register
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

    // Trigger exit so the test completes
    capturedProc!.kill('SIGTERM');
    await done;
  });

  // ─── isActive() returns false after process exits ─────────────────────────

  it('isActive() returns false after process exits normally', async () => {
    let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeImmediateMockProcess(22222);
      capturedProc = proc;
      return proc;
    });

    const done = new Promise<void>((resolve) => {
      pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

    // Simulate clean exit (code 0)
    capturedProc!.emit('exit', 0, null);
    await done;

    expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(false);
  });

  // ─── abort sends SIGTERM ──────────────────────────────────────────────────

  it('abort() sends SIGTERM to the active process', async () => {
    let capturedKill: ReturnType<typeof vi.fn> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeImmediateMockProcess(33333);
      capturedKill = proc.kill as ReturnType<typeof vi.fn>;
      return proc;
    });

    const done = new Promise<void>((resolve) => {
      pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
    });

    await new Promise((r) => setTimeout(r, 0));

    pool.abort(DEFAULT_OPTIONS.sessionId);
    await done;

    expect(capturedKill).toHaveBeenCalledWith('SIGTERM');
    expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(false);
  });

  // ─── Max pool limit ───────────────────────────────────────────────────────

  it('spawning beyond max limit throws an error', async () => {
    // Fill the pool with 3 processes (maxProcesses=3)
    for (let i = 0; i < 3; i++) {
      pool.spawn(
        { ...DEFAULT_OPTIONS, sessionId: `session-${i}` },
        () => {},
        () => {},
      );
    }

    await new Promise((r) => setTimeout(r, 0));

    // The 4th should throw
    await expect(
      pool.spawn({ ...DEFAULT_OPTIONS, sessionId: 'session-overflow' }, () => {}, () => {}),
    ).rejects.toThrow(/pool is full/i);
  });

  // ─── API keys not in spawned env ─────────────────────────────────────────

  it('ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are NOT in spawned process env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-auth-token';

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;

    spawnMock.mockImplementationOnce(
      (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = opts.env;
        const proc = makeImmediateMockProcess(44444);
        capturedProc = proc;
        return proc;
      },
    );

    const done = new Promise<void>((resolve) => {
      pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
    });

    await new Promise((r) => setTimeout(r, 0));

    capturedProc!.kill('SIGTERM');
    await done;

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedEnv!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  // ─── getActiveCount ───────────────────────────────────────────────────────

  it('getActiveCount() reflects currently active processes', async () => {
    expect(pool.getActiveCount()).toBe(0);

    let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeImmediateMockProcess(55555);
      capturedProc = proc;
      return proc;
    });

    const done = new Promise<void>((resolve) => {
      pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(pool.getActiveCount()).toBe(1);

    capturedProc!.emit('exit', 0, null);
    await done;

    expect(pool.getActiveCount()).toBe(0);
  });

  // ─── Abort recovery ───────────────────────────────────────────────────────

  describe('abort recovery', () => {
    it('isActive() stays true after abort until the process exits', async () => {
      // Use deferred mock: kill() does NOT auto-emit exit
      const proc = makeDeferredMockProcess(60001);
      spawnMock.mockImplementationOnce(() => proc);

      const done = new Promise<void>((resolve) => {
        pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

      // Abort sends SIGTERM but does NOT remove from activeProcesses
      pool.abort(DEFAULT_OPTIONS.sessionId);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      // isActive should STILL be true — process hasn't exited yet
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

      // Now simulate the process actually dying
      proc.emit('exit', null, 'SIGTERM');
      await done;

      // NOW it should be false
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(false);
    });

    it('emits agent_end when aborted process exits with SIGTERM', async () => {
      const proc = makeDeferredMockProcess(60002);
      spawnMock.mockImplementationOnce(() => proc);

      const events: Array<{ type: string }> = [];
      const done = new Promise<void>((resolve) => {
        pool.spawn(DEFAULT_OPTIONS, (ev) => {
          events.push({ type: ev.type });
        }, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));

      pool.abort(DEFAULT_OPTIONS.sessionId);
      proc.emit('exit', null, 'SIGTERM');
      await done;

      expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    });

    it('allows spawning a new process after the aborted one exits', async () => {
      // First process: deferred (kill doesn't auto-emit exit)
      const proc1 = makeDeferredMockProcess(60003);
      spawnMock.mockImplementationOnce(() => proc1);

      const done1 = new Promise<void>((resolve) => {
        pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));

      // Abort the first process
      pool.abort(DEFAULT_OPTIONS.sessionId);

      // First process exits
      proc1.emit('exit', null, 'SIGTERM');
      await done1;

      // Now spawn a second process for the same session
      const proc2 = makeDeferredMockProcess(60004);
      spawnMock.mockImplementationOnce(() => proc2);

      const events2: Array<{ type: string }> = [];
      const done2 = new Promise<void>((resolve) => {
        pool.spawn(
          { ...DEFAULT_OPTIONS, prompt: 'proceed', isFollowUp: true },
          (ev) => { events2.push({ type: ev.type }); },
          resolve,
        );
      });

      // Give the spawn a tick to register
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

      // Second process completes normally
      proc2.emit('exit', 0, null);
      await done2;

      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(false);
      expect(events2.some((e) => e.type === 'agent_end')).toBe(true);
    });

    it('stale exit handler does not corrupt a new process', async () => {
      // First process: deferred
      const proc1 = makeDeferredMockProcess(60005);
      spawnMock.mockImplementationOnce(() => proc1);

      const done1 = new Promise<void>((resolve) => {
        pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));

      // Abort the first process but do NOT let it exit yet
      pool.abort(DEFAULT_OPTIONS.sessionId);
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

      // Let proc1 exit now — this resolves the exit promise
      proc1.emit('exit', null, 'SIGTERM');
      await done1;

      // Now spawn a second process
      const proc2 = makeDeferredMockProcess(60006);
      spawnMock.mockImplementationOnce(() => proc2);

      const events2: Array<{ type: string }> = [];
      const done2 = new Promise<void>((resolve) => {
        pool.spawn(
          { ...DEFAULT_OPTIONS, prompt: 'proceed', isFollowUp: true },
          (ev) => { events2.push({ type: ev.type }); },
          resolve,
        );
      });

      // Give spawn a tick to register
      await new Promise((r) => setTimeout(r, 10));
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

      // Complete proc2 normally
      proc2.emit('exit', 0, null);
      await done2;

      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(false);
      // The new process's agent_end should have been emitted exactly once
      expect(events2.filter((e) => e.type === 'agent_end').length).toBe(1);
    });

    it('spawn waits for previous process exit before starting new one', async () => {
      // First process: deferred, will NOT exit until we say so
      const proc1 = makeDeferredMockProcess(60007);
      spawnMock.mockImplementationOnce(() => proc1);

      const done1 = new Promise<void>((resolve) => {
        pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));

      // Abort first process — but don't let it exit yet
      pool.abort(DEFAULT_OPTIONS.sessionId);

      // Start second spawn — it should block waiting for proc1's exit promise
      const proc2 = makeDeferredMockProcess(60008);
      spawnMock.mockImplementationOnce(() => proc2);

      let spawn2Completed = false;
      const done2 = new Promise<void>((resolve) => {
        pool.spawn(
          { ...DEFAULT_OPTIONS, prompt: 'proceed', isFollowUp: true },
          () => {},
          resolve,
        ).then(() => { spawn2Completed = true; });
      });

      // Give the event loop a turn — spawn2 should be blocked on exit promise
      await new Promise((r) => setTimeout(r, 10));
      expect(spawn2Completed).toBe(false);

      // Now let proc1 die — this unblocks the exit promise
      proc1.emit('exit', null, 'SIGTERM');
      await done1;

      // With 0ms grace, spawn2 should proceed almost immediately
      await new Promise((r) => setTimeout(r, 20));

      // proc2 should now be active
      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(true);

      // Let proc2 complete
      proc2.emit('exit', 0, null);
      await done2;

      expect(pool.isActive(DEFAULT_OPTIONS.sessionId)).toBe(false);
    });
  });

  // ─── Spawn args ────────────────────────────────────────────────────────────

  describe('spawn arguments', () => {
    it('passes --dangerously-skip-permissions flag', async () => {
      let capturedArgs: string[] | undefined;
      let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;

      spawnMock.mockImplementationOnce(
        (_cmd: string, args: string[], _opts: unknown) => {
          capturedArgs = args;
          const proc = makeImmediateMockProcess(70001);
          capturedProc = proc;
          return proc;
        },
      );

      const done = new Promise<void>((resolve) => {
        pool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));
      capturedProc!.kill('SIGTERM');
      await done;

      expect(capturedArgs).toBeDefined();
      expect(capturedArgs).toContain('--dangerously-skip-permissions');
      expect(capturedArgs).not.toContain('acceptEdits');
    });

    it('uses --session-id on first turn', async () => {
      let capturedArgs: string[] | undefined;
      let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;

      spawnMock.mockImplementationOnce(
        (_cmd: string, args: string[], _opts: unknown) => {
          capturedArgs = args;
          const proc = makeImmediateMockProcess(70002);
          capturedProc = proc;
          return proc;
        },
      );

      const done = new Promise<void>((resolve) => {
        pool.spawn(
          { ...DEFAULT_OPTIONS, isFollowUp: false },
          () => {},
          resolve,
        );
      });

      await new Promise((r) => setTimeout(r, 0));
      capturedProc!.kill('SIGTERM');
      await done;

      expect(capturedArgs).toContain('--session-id');
      expect(capturedArgs).toContain(DEFAULT_OPTIONS.claudeSessionId);
      expect(capturedArgs).not.toContain('--resume');
    });

    it('uses --resume on follow-up turns', async () => {
      let capturedArgs: string[] | undefined;
      let capturedProc: ReturnType<typeof makeImmediateMockProcess> | null = null;

      spawnMock.mockImplementationOnce(
        (_cmd: string, args: string[], _opts: unknown) => {
          capturedArgs = args;
          const proc = makeImmediateMockProcess(70003);
          capturedProc = proc;
          return proc;
        },
      );

      const done = new Promise<void>((resolve) => {
        pool.spawn(
          { ...DEFAULT_OPTIONS, isFollowUp: true },
          () => {},
          resolve,
        );
      });

      await new Promise((r) => setTimeout(r, 0));
      capturedProc!.kill('SIGTERM');
      await done;

      expect(capturedArgs).toContain('--resume');
      expect(capturedArgs).toContain(DEFAULT_OPTIONS.claudeSessionId);
      expect(capturedArgs).not.toContain('--session-id');
    });
  });
});
