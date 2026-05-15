import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');

  const createMockProcess = () => {
    const proc = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
    (proc as unknown as Record<string, unknown>).stdout = new PassThrough();
    (proc as unknown as Record<string, unknown>).stderr = new PassThrough();
    (proc as unknown as Record<string, unknown>).stdin = new PassThrough();
    (proc as unknown as Record<string, unknown>).pid = 99999;
    (proc as unknown as Record<string, unknown>).kill = vi.fn((signal?: string) => {
      setTimeout(() => proc.emit('exit', signal === 'SIGKILL' ? null : 0, signal ?? 'SIGTERM'), 0);
      return true;
    });
    return proc;
  };

  const spawnMock = vi.fn().mockImplementation(() => createMockProcess());

  return {
    spawn: spawnMock,
    default: { spawn: spawnMock },
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

let mockWsHealthResult = true;

vi.mock('ws', async () => {
  const { EventEmitter } = await import('events');
  class MockWebSocket extends EventEmitter {
    constructor() {
      super();
      setImmediate(() => {
        if (mockWsHealthResult) {
          this.emit('open');
        } else {
          this.emit('error', new Error('connect ECONNREFUSED'));
        }
      });
    }
    close() {}
    removeAllListeners() { return this; }
  }
  return { default: MockWebSocket, WebSocket: MockWebSocket };
});

import { ClaudeChannelProcessManager } from '../../../src/claude/claude-channel-process-manager.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = existsSync as unknown as ReturnType<typeof vi.fn>;

function makeDefaultConfig() {
  return {
    pluginDir: '/fake/plugin',
    wsPort: 3100,
    hookPort: 3101,
    cwd: '/tmp/project',
  };
}

function makeDeferredProcess() {
  const proc = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
  (proc as unknown as Record<string, unknown>).stdout = new PassThrough();
  (proc as unknown as Record<string, unknown>).stderr = new PassThrough();
  (proc as unknown as Record<string, unknown>).stdin = new PassThrough();
  (proc as unknown as Record<string, unknown>).pid = 54321;
  (proc as unknown as Record<string, unknown>).kill = vi.fn((signal?: string) => {
    setTimeout(() => proc.emit('exit', signal === 'SIGKILL' ? null : 0, signal ?? 'SIGTERM'), 0);
    return true;
  });
  return proc;
}

function makeStubbornProcess() {
  const proc = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
  (proc as unknown as Record<string, unknown>).stdout = new PassThrough();
  (proc as unknown as Record<string, unknown>).stderr = new PassThrough();
  (proc as unknown as Record<string, unknown>).stdin = new PassThrough();
  (proc as unknown as Record<string, unknown>).pid = 54322;
  (proc as unknown as Record<string, unknown>).kill = vi.fn((signal?: string) => {
    if (signal === 'SIGKILL') {
      setTimeout(() => proc.emit('exit', null, 'SIGKILL'), 0);
    }
    return true;
  });
  return proc;
}

describe('ClaudeChannelProcessManager', () => {
  let manager: ClaudeChannelProcessManager;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    mockWsHealthResult = true;
    manager = new ClaudeChannelProcessManager(makeDefaultConfig());
  });

  afterEach(async () => {
    try { await manager.stop(); } catch { /* ignore */ }
  });

  it('should start Claude with channel plugin flags', async () => {
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;

    spawnMock.mockImplementationOnce((cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return makeDeferredProcess();
    });

    await manager.start();

    expect(capturedCmd).toBe('claude');
    expect(capturedArgs).toContain('--dangerously-load-development-channels');
    expect(capturedArgs).toContain('server:pi-claude-channel');
    expect(capturedArgs).toContain('--plugin-dir');
    expect(capturedArgs).toContain('/fake/plugin');
    expect(capturedArgs).toContain('--permission-mode');
    expect(capturedArgs).toContain('acceptEdits');
  });

  it('should detect when WS port becomes connectable', async () => {
    mockWsHealthResult = true;
    spawnMock.mockImplementationOnce(() => makeDeferredProcess());

    await manager.start();
    expect(manager.isRunning()).toBe(true);
  });

  it('should gracefully stop on SIGTERM', async () => {
    const proc = makeDeferredProcess();
    const killCalls: string[] = [];
    (proc.kill as ReturnType<typeof vi.fn>).mockImplementation((signal?: string) => {
      killCalls.push(signal ?? 'SIGTERM');
      setTimeout(() => proc.emit('exit', 0, signal ?? 'SIGTERM'), 0);
      return true;
    });

    spawnMock.mockImplementationOnce(() => proc);
    await manager.start();
    await manager.stop();

    expect(killCalls).toContain('SIGTERM');
    expect(manager.getState().status).toBe('stopped');
  });

  it('should force kill after timeout', async () => {
    const proc = makeStubbornProcess();

    spawnMock.mockImplementationOnce(() => proc);
    await manager.start();

    vi.useFakeTimers();
    const stopP = manager.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await stopP;
    vi.useRealTimers();

    const killCalls = (proc.kill as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0] ?? 'SIGTERM');
    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
  });

  it('should report errors from stderr', async () => {
    const proc = makeDeferredProcess();
    spawnMock.mockImplementationOnce(() => proc);
    mockWsHealthResult = false;

    const startPromise = manager.start();

    await new Promise((r) => setTimeout(r, 10));
    (proc.stderr as PassThrough).write('Error: authentication failed\n');

    try {
      await startPromise;
    } catch {
      // expected
    }

    const state = manager.getState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('authentication');
  });

  it('should handle missing plugin directory', async () => {
    existsSyncMock.mockReturnValue(false);

    await expect(manager.start()).rejects.toThrow(/Plugin not found/);
  });

  it('should handle Claude binary not found', async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = makeDeferredProcess();
      setTimeout(() => {
        proc.emit('error', new Error('spawn claude ENOENT'));
        setTimeout(() => proc.emit('exit', 1, null), 0);
      }, 0);
      return proc;
    });

    mockWsHealthResult = false;

    await expect(manager.start()).rejects.toThrow();
    const state = manager.getState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('ENOENT');
  });

  it('should set environment variables for plugin ports', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;

    spawnMock.mockImplementationOnce((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      capturedEnv = opts.env as NodeJS.ProcessEnv;
      return makeDeferredProcess();
    });

    await manager.start();

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.CLAUDE_CHANNEL_WS_PORT).toBe('3100');
    expect(capturedEnv!.CLAUDE_CHANNEL_HOOK_PORT).toBe('3101');
  });

  it('should strip API keys from environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-auth-token';

    let capturedEnv: NodeJS.ProcessEnv | undefined;

    spawnMock.mockImplementationOnce((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      capturedEnv = opts.env as NodeJS.ProcessEnv;
      return makeDeferredProcess();
    });

    await manager.start();

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedEnv!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });
});
