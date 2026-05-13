import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

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

import { ClaudeProcessPool, removeStaleSessionLock, removeLockFromFile, resolveClaudeSessionPath } from '../../../src/claude/claude-process-pool.js';
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

// Helper: create a mock process that exits with "is already in use" on stderr
function makeLockedMockProcess(pid = 12345) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.pid = pid;
  proc.kill = vi.fn(() => true);
  return proc;
}

// Emit locked exit for a mock process
function emitLockedExit(proc: ReturnType<typeof makeLockedMockProcess>, claudeSessionId = 'test-claude-session') {
  (proc.stderr as PassThrough).end(`Error: Session ID ${claudeSessionId} is already in use.\n`);
  proc.emit('exit', 1, null);
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
    it('passes --permission-mode dontAsk flag', async () => {
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
      expect(capturedArgs).toContain('--permission-mode');
      // The value after --permission-mode should be 'dontAsk'
      const modeIdx = capturedArgs!.indexOf('--permission-mode');
      expect(capturedArgs![modeIdx + 1]).toBe('dontAsk');
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

  // ─── Session lock cleaning ─────────────────────────────────────────────────

  describe('session lock cleaning on retry', () => {
    it('calls lock cleaner on first "already in use" retry', async () => {
      const lockCleaner = vi.fn().mockResolvedValue(false); // no lock found
      const testPool = new ClaudeProcessPool(3, 0, lockCleaner);

      // First process exits with "is already in use"
      const proc1 = makeLockedMockProcess();
      spawnMock.mockImplementationOnce(() => proc1);
      // Second process (retry) succeeds
      const proc2 = makeImmediateMockProcess();
      spawnMock.mockImplementationOnce(() => proc2);

      const done = new Promise<void>((resolve) => {
        testPool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      // Trigger locked exit
      await new Promise((r) => setTimeout(r, 0));
      emitLockedExit(proc1, DEFAULT_OPTIONS.claudeSessionId);

      // Wait for the retry and completion (allow time for backoff)
      await new Promise((r) => setTimeout(r, 2500));
      // Complete the retry
      proc2.emit('exit', 0, null);
      await done;

      // Lock cleaner should have been called with the correct args
      expect(lockCleaner).toHaveBeenCalledWith(DEFAULT_OPTIONS.cwd, DEFAULT_OPTIONS.claudeSessionId);
    });

    it('retries quickly (500ms) when lock is successfully removed', async () => {
      const lockCleaner = vi.fn().mockResolvedValue(true); // lock removed!
      const testPool = new ClaudeProcessPool(3, 0, lockCleaner);

      // First process exits with "is already in use"
      const proc1 = makeLockedMockProcess();
      spawnMock.mockImplementationOnce(() => proc1);
      // Second process (retry after lock clean) succeeds
      const proc2 = makeImmediateMockProcess();
      spawnMock.mockImplementationOnce(() => proc2);

      const done = new Promise<void>((resolve) => {
        testPool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));
      emitLockedExit(proc1, DEFAULT_OPTIONS.claudeSessionId);

      // Wait for quick retry (500ms) + completion
      await new Promise((r) => setTimeout(r, 1000));
      proc2.emit('exit', 0, null);
      await done;

      // Second spawn should have been called (lock was cleaned)
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it('falls back to normal backoff when lock cleaner returns false', async () => {
      const lockCleaner = vi.fn().mockResolvedValue(false); // no lock to remove
      const testPool = new ClaudeProcessPool(3, 0, lockCleaner);

      // First: locked exit. Second: success.
      const proc1 = makeLockedMockProcess();
      spawnMock.mockImplementationOnce(() => proc1);
      spawnMock.mockImplementationOnce(() => makeImmediateMockProcess());

      const done = new Promise<void>((resolve) => {
        testPool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));
      emitLockedExit(proc1, DEFAULT_OPTIONS.claudeSessionId);

      // Wait for first backoff (1500ms) + retry
      await new Promise((r) => setTimeout(r, 2500));
      // Complete the retry process
      const proc2 = spawnMock.mock.results[1]?.value;
      if (proc2) proc2.emit('exit', 0, null);
      await done;

      // Lock cleaner only called once (first retry only)
      expect(lockCleaner).toHaveBeenCalledTimes(1);
      // Total 2 spawns: original + 1 retry
      expect(spawnMock).toHaveBeenCalledTimes(2);
    }, 10000);

    it('continues with backoff even if lock cleaner throws', async () => {
      const lockCleaner = vi.fn().mockRejectedValue(new Error('fs error'));
      const testPool = new ClaudeProcessPool(3, 0, lockCleaner);

      // First: locked. Second: success.
      const proc1 = makeLockedMockProcess();
      spawnMock.mockImplementationOnce(() => proc1);
      spawnMock.mockImplementationOnce(() => makeImmediateMockProcess());

      const done = new Promise<void>((resolve) => {
        testPool.spawn(DEFAULT_OPTIONS, () => {}, resolve);
      });

      await new Promise((r) => setTimeout(r, 0));
      emitLockedExit(proc1, DEFAULT_OPTIONS.claudeSessionId);

      // Wait for backoff + retry
      await new Promise((r) => setTimeout(r, 2500));
      // Complete the retry
      const proc2 = spawnMock.mock.results[1]?.value;
      if (proc2) proc2.emit('exit', 0, null);
      await done;

      // Should still have retried
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });
  });
});

// ─── removeStaleSessionLock unit tests ───────────────────────────────────────

describe('removeLockFromFile', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `claude-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('removes last-prompt entry from the end of a session file', async () => {
    const sessionFile = join(tempDir, 'session.jsonl');
    const content = [
      '{"type":"user","message":"hello"}',
      '{"type":"assistant","message":"hi"}',
      '{"type":"last-prompt","sessionId":"test-session-123"}',
    ].join('\n');
    await writeFile(sessionFile, content);

    const result = await removeLockFromFile(sessionFile);

    expect(result).toBe(true);
    const after = await readFile(sessionFile, 'utf-8');
    const lines = after.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"user"');
    expect(lines[1]).toContain('"assistant"');
    expect(after).not.toContain('last-prompt');
  });

  it('returns false when no last-prompt entry exists', async () => {
    const sessionFile = join(tempDir, 'session.jsonl');
    const content = [
      '{"type":"user","message":"hello"}',
      '{"type":"assistant","message":"hi"}',
    ].join('\n');
    await writeFile(sessionFile, content);

    const result = await removeLockFromFile(sessionFile);

    expect(result).toBe(false);
    const after = await readFile(sessionFile, 'utf-8');
    expect(after.trim().split('\n')).toHaveLength(2);
  });

  it('returns false when the file does not exist', async () => {
    const result = await removeLockFromFile(
      join(tempDir, 'nonexistent.jsonl'),
    );
    expect(result).toBe(false);
  });

  it('handles trailing newlines correctly', async () => {
    const sessionFile = join(tempDir, 'session.jsonl');
    const content = [
      '{"type":"user","message":"hello"}',
      '{"type":"last-prompt","sessionId":"test-session-789"}',
      '', // trailing newline
    ].join('\n');
    await writeFile(sessionFile, content);

    const result = await removeLockFromFile(sessionFile);

    expect(result).toBe(true);
    const after = await readFile(sessionFile, 'utf-8');
    expect(after).not.toContain('last-prompt');
    expect(after.trim()).toBe('{"type":"user","message":"hello"}');
  });

  it('removes last-prompt even when buried behind other entries (SIGTERM abort scenario)', async () => {
    const sessionFile = join(tempDir, 'session.jsonl');
    // After SIGTERM abort, Claude CLI may write ai-title and tool results
    // AFTER the last-prompt lock, burying it in the middle of the file.
    const content = [
      '{"type":"user","message":"hello"}',
      '{"type":"assistant","message":"working..."}',
      '{"type":"last-prompt","lastPrompt":"do the thing","leafUuid":"abc-123"}',
      '{"type":"ai-title","aiTitle":"My Session"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Exit code 137"}]}}',
    ].join('\n');
    await writeFile(sessionFile, content);

    const result = await removeLockFromFile(sessionFile);

    expect(result).toBe(true);
    const after = await readFile(sessionFile, 'utf-8');
    const lines = after.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(after).not.toContain('last-prompt');
    expect(lines[0]).toContain('"user"');
    expect(lines[1]).toContain('"assistant"');
    expect(lines[2]).toContain('ai-title');
    expect(lines[3]).toContain('tool_result');
  });

  it('removes ALL last-prompt entries from the file', async () => {
    const sessionFile = join(tempDir, 'session.jsonl');
    const content = [
      '{"type":"user","message":"first prompt"}',
      '{"type":"last-prompt","lastPrompt":"first prompt"}',
      '{"type":"assistant","message":"response"}',
      '{"type":"last-prompt","lastPrompt":"second prompt"}',
      '{"type":"user","message":"second prompt"}',
      '{"type":"last-prompt","lastPrompt":"third prompt"}',
      '{"type":"ai-title","aiTitle":"Session Title"}',
    ].join('\n');
    await writeFile(sessionFile, content);

    const result = await removeLockFromFile(sessionFile);

    expect(result).toBe(true);
    const after = await readFile(sessionFile, 'utf-8');
    const lines = after.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(after).not.toContain('last-prompt');
  });
});
