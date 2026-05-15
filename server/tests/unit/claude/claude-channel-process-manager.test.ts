import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('node-pty', () => {
  const { EventEmitter } = require('events');

  const createMockPty = () => {
    const emitter = new EventEmitter();
    return {
      pid: 99999,
      kill: vi.fn((signal?: string) => {
        const code = signal === 'SIGKILL' ? 137 : 0;
        setTimeout(() => emitter.emit('exit', { exitCode: code, signal: signal ?? 'SIGTERM' }), 0);
      }),
      onData: vi.fn((cb: (data: string) => void) => {
        emitter.on('data', cb);
      }),
      onExit: vi.fn((cb: (e: { exitCode: number | null; signal?: number | string }) => void) => {
        emitter.on('exit', cb);
      }),
      _emitter: emitter,
    };
  };

  const spawnMock = vi.fn().mockImplementation(() => createMockPty());

  return {
    default: { spawn: spawnMock },
    spawn: spawnMock,
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
import pty from 'node-pty';
import { existsSync } from 'node:fs';

const spawnMock = pty.spawn as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = existsSync as unknown as ReturnType<typeof vi.fn>;

function makeDefaultConfig() {
  return {
    pluginDir: '/fake/plugin',
    wsPort: 3110,
    hookPort: 3111,
    cwd: '/tmp/project',
  };
}

function makeDeferredPty() {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  return {
    pid: 54321,
    kill: vi.fn((signal?: string) => {
      const code = signal === 'SIGKILL' ? 137 : 0;
      setTimeout(() => emitter.emit('exit', { exitCode: code, signal: signal ?? 'SIGTERM' }), 0);
    }),
    onData: vi.fn((cb: (data: string) => void) => {
      emitter.on('data', cb);
    }),
    onExit: vi.fn((cb: (e: { exitCode: number | null; signal?: number | string }) => void) => {
      emitter.on('exit', cb);
    }),
    _emitter: emitter,
  };
}

function makeStubbornPty() {
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();
  return {
    pid: 54322,
    kill: vi.fn((signal?: string) => {
      if (signal === 'SIGKILL') {
        setTimeout(() => emitter.emit('exit', { exitCode: 137, signal: 'SIGKILL' }), 0);
      }
    }),
    onData: vi.fn(),
    onExit: vi.fn((cb: (e: { exitCode: number | null; signal?: number | string }) => void) => {
      emitter.on('exit', cb);
    }),
    _emitter: emitter,
  };
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

  it('should start Claude with channel plugin flags via PTY', async () => {
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;

    spawnMock.mockImplementationOnce((cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return makeDeferredPty();
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
    spawnMock.mockImplementationOnce(() => makeDeferredPty());

    await manager.start();
    expect(manager.isRunning()).toBe(true);
  });

  it('should gracefully stop on SIGTERM', async () => {
    const ptyProc = makeDeferredPty();
    const killCalls: string[] = [];
    (ptyProc.kill as ReturnType<typeof vi.fn>).mockImplementation((signal?: string) => {
      killCalls.push(signal ?? 'SIGTERM');
      const code = signal === 'SIGKILL' ? 137 : 0;
      setTimeout(() => ptyProc._emitter.emit('exit', { exitCode: code, signal: signal ?? 'SIGTERM' }), 0);
    });

    spawnMock.mockImplementationOnce(() => ptyProc);
    await manager.start();
    await manager.stop();

    expect(killCalls).toContain('SIGTERM');
    expect(manager.getState().status).toBe('stopped');
  });

  it('should force kill after timeout', async () => {
    const ptyProc = makeStubbornPty();

    spawnMock.mockImplementationOnce(() => ptyProc);
    await manager.start();

    vi.useFakeTimers();
    const stopP = manager.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await stopP;
    vi.useRealTimers();

    const killCalls = (ptyProc.kill as ReturnType<typeof vi.fn>).mock.calls.map((c: string[]) => c[0] ?? 'SIGTERM');
    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
  });

  it('should handle missing plugin directory', async () => {
    existsSyncMock.mockReturnValue(false);

    await expect(manager.start()).rejects.toThrow(/Plugin not found/);
  });

  it('should set environment variables for plugin ports', async () => {
    let capturedEnv: Record<string, string> | undefined;

    spawnMock.mockImplementationOnce((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      capturedEnv = opts.env as Record<string, string>;
      return makeDeferredPty();
    });

    await manager.start();

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.CLAUDE_CHANNEL_WS_PORT).toBe('3110');
    expect(capturedEnv!.CLAUDE_CHANNEL_HOOK_PORT).toBe('3111');
  });

  it('should strip API keys from environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-auth-token';

    let capturedEnv: Record<string, string> | undefined;

    spawnMock.mockImplementationOnce((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      capturedEnv = opts.env as Record<string, string>;
      return makeDeferredPty();
    });

    await manager.start();

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(capturedEnv!.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it('should report PTY process state', async () => {
    spawnMock.mockImplementationOnce(() => makeDeferredPty());
    await manager.start();

    const state = manager.getState();
    expect(state.status).toBe('running');
    expect(state.pid).toBe(54321);
    expect(state.startedAt).toBeGreaterThan(0);
  });

  it('should timeout when WS port never becomes connectable', { timeout: 35_000 }, async () => {
    mockWsHealthResult = false;
    spawnMock.mockImplementationOnce(() => makeDeferredPty());

    const managerSlow = new ClaudeChannelProcessManager({
      ...makeDefaultConfig(),
    });

    await expect(managerSlow.start()).rejects.toThrow(/did not become ready/);
    try { await managerSlow.stop(); } catch { /* ignore */ }
  });
});
