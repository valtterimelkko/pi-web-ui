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

// Helper to create a proper mock process with PassThrough streams
function makeMockProcess(pid = 12345) {
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
    pool = new ClaudeProcessPool(3);
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => makeMockProcess());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── Spawn adds to active set ──────────────────────────────────────────────

  it('spawning a process makes isActive() return true', async () => {
    let capturedProc: ReturnType<typeof makeMockProcess> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeMockProcess(11111);
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
    let capturedProc: ReturnType<typeof makeMockProcess> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeMockProcess(22222);
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
      const proc = makeMockProcess(33333);
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
    let capturedProc: ReturnType<typeof makeMockProcess> | null = null;

    spawnMock.mockImplementationOnce(
      (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        capturedEnv = opts.env;
        const proc = makeMockProcess(44444);
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

    let capturedProc: ReturnType<typeof makeMockProcess> | null = null;
    spawnMock.mockImplementationOnce(() => {
      const proc = makeMockProcess(55555);
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
});
