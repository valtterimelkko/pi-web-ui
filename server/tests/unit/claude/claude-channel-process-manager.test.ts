import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('node-pty', async () => {
  const { EventEmitter: MockEventEmitter } = await import('events');

  const createMockPty = () => {
    const emitter = new MockEventEmitter();
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
    expect(capturedArgs).toContain('--permission-mode');
    expect(capturedArgs).toContain('dontAsk');
    expect(capturedArgs).toContain('--allowedTools');
    expect(capturedArgs).toContain('Bash');
    expect(capturedArgs).toContain('WebSearch');
    expect(capturedArgs).toContain('mcp__pi-claude-channel__reply');
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

  it('should timeout when WS port never becomes connectable', async () => {
    mockWsHealthResult = false;
    spawnMock.mockImplementationOnce(() => makeDeferredPty());

    const managerSlow = new ClaudeChannelProcessManager({
      ...makeDefaultConfig(),
    });

    // Fast-forward the 30s ready-timeout with fake timers instead of waiting it
    // out for real. start()→waitForReady() polls on setTimeout(500) + a mock-WS
    // healthCheck that resolves via setImmediate — both are driven by fake timers.
    vi.useFakeTimers();
    const startP = managerSlow.start();
    // Attach the rejection expectation before advancing timers so the rejection
    // (which fires during advanceTimersByTimeAsync) is handled synchronously and
    // is not reported as an unhandled rejection.
    const expectation = expect(startP).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(31_000);
    await expectation;
    vi.useRealTimers();
    try { await managerSlow.stop(); } catch { /* ignore */ }
  });

  describe('busy-state tracking', () => {
    const FAST = { idleQuietMs: 150, idleCheckIntervalMs: 30, activityThrottleMs: 20 };

    function makeFastManager() {
      return new ClaudeChannelProcessManager({ ...makeDefaultConfig(), ...FAST });
    }

    // Start under fake timers so the idle-watch interval (created during start())
    // is driven by vi.advanceTimersByTimeAsync. Resolves once the WS ready-check
    // succeeds (the mock WS healthCheck resolves via faked setImmediate).
    async function startFake(mgr: ClaudeChannelProcessManager) {
      vi.useFakeTimers();
      const p = mgr.start();
      await vi.advanceTimersByTimeAsync(600);
      await p;
    }
    const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

    it('reports busy after a prompt is dispatched and emits idle once the PTY goes quiet', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const idleSpy = vi.fn();
        manager.on('idle', idleSpy);

        manager.markPromptSent();
        expect(manager.isBusy()).toBe(true);

        ptyProc._emitter.emit('data', '✻ Thinking… (2s · esc to interrupt)');
        expect(manager.isBusy()).toBe(true);
        expect(idleSpy).not.toHaveBeenCalled();

        // No further PTY output - after the quiet window the turn is declared done.
        await tick(300);
        expect(idleSpy).toHaveBeenCalledTimes(1);
        expect(manager.isBusy()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT emit idle while a busy indicator keeps arriving (regression: false turn-completion)', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const idleSpy = vi.fn();
        manager.on('idle', idleSpy);
        manager.markPromptSent();

        // Simulate a long turn: spinner frames keep arriving past the quiet window.
        for (let i = 0; i < 8; i++) {
          ptyProc._emitter.emit('data', `✶ Nesting… (${i}s · esc to interrupt)`);
          await tick(60);
        }

        expect(idleSpy).not.toHaveBeenCalled();
        expect(manager.isBusy()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays busy when the "esc to interrupt" footer is rendered ABOVE the prompt box', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const idleSpy = vi.fn();
        manager.on('idle', idleSpy);
        manager.markPromptSent();

        // The footer sits above the input box - the old detector only scanned
        // text AFTER the prompt and so wrongly force-completed live turns.
        for (let i = 0; i < 6; i++) {
          ptyProc._emitter.emit('data', '✻ Working… (esc to interrupt)\n--------\n❯ \n--------');
          await tick(60);
        }

        expect(idleSpy).not.toHaveBeenCalled();
        expect(manager.isBusy()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits idle when Claude returns to a bare prompt after the turn ends', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const idleSpy = vi.fn();
        manager.on('idle', idleSpy);
        manager.markPromptSent();

        ptyProc._emitter.emit('data', '✻ Working… (esc to interrupt)');
        await tick(40);
        // Turn ends: a clean prompt frame with no busy indicator, then silence.
        ptyProc._emitter.emit('data', '\rBoth channel messages handled\r❯');
        await tick(300);

        expect(idleSpy).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not emit idle when no prompt was ever dispatched', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const idleSpy = vi.fn();
        manager.on('idle', idleSpy);

        ptyProc._emitter.emit('data', 'Some output\n❯ ');
        await tick(300);

        expect(idleSpy).not.toHaveBeenCalled();
        expect(manager.isBusy()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('markPromptComplete clears the busy state immediately', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        manager.markPromptSent();
        expect(manager.isBusy()).toBe(true);

        manager.markPromptComplete();
        expect(manager.isBusy()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waitForIdle resolves immediately when not busy', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        expect(manager.isBusy()).toBe(false);
        const idleP = manager.waitForIdle(1000);
        await tick(20);
        const result = await idleP;
        expect(result).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waitForIdle resolves when busy state clears', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        manager.markPromptSent();
        expect(manager.isBusy()).toBe(true);

        // Clear busy after a short delay
        setTimeout(() => manager.markPromptComplete(), 50);

        const idleP = manager.waitForIdle(5000);
        await tick(200); // past the 50ms clear + a poll iteration
        const result = await idleP;
        expect(result).toBe(true);
        expect(manager.isBusy()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits throttled activity pings while a turn is in progress', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const activitySpy = vi.fn();
        manager.on('activity', activitySpy);
        manager.markPromptSent();

        for (let i = 0; i < 5; i++) {
          ptyProc._emitter.emit('data', `✻ Working… (${i}s · esc to interrupt)`);
          await tick(30);
        }

        expect(activitySpy).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should emit auth_error when Claude reports expired credentials', async () => {
      const ptyProc = makeDeferredPty();
      spawnMock.mockImplementationOnce(() => ptyProc);
      manager = makeFastManager();
      await startFake(manager);
      try {
        const authErrorSpy = vi.fn();
        manager.on('auth_error', authErrorSpy);

        ptyProc._emitter.emit('data', 'Please run /login · API Error: 401 Invalid authentication credentials\r❯');

        await tick(50);

        expect(authErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
          message: expect.stringContaining('Claude Code authentication expired'),
        }));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('redundant write guard', () => {
    it('should skip switchModel if model unchanged', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      const changed1 = manager.switchModel('opus');
      expect(changed1).toBe(true);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy).toHaveBeenCalledWith('/model opus\r');

      const changed2 = manager.switchModel('opus');
      expect(changed2).toBe(false);
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });

    it('should allow switchModel when model changes', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.switchModel('opus');
      manager.switchModel('sonnet');

      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(writeSpy).toHaveBeenCalledWith('/model sonnet\r');
    });

    it('should skip setThinkingLevel if level unchanged', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('high');
      expect(writeSpy).toHaveBeenCalledTimes(1);

      manager.setThinkingLevel('high');
      expect(writeSpy).toHaveBeenCalledTimes(1);
    });

    it('should allow setThinkingLevel when level changes', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('high');
      manager.setThinkingLevel('low');

      expect(writeSpy).toHaveBeenCalledTimes(2);
    });

    it('should not write when no PTY process exists', async () => {
      expect(() => manager.switchModel('opus')).not.toThrow();
      expect(() => manager.setThinkingLevel('high')).not.toThrow();
    });
  });

  describe('thinking-level effort mapping', () => {
    it('should map xhigh to high (not low)', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('xhigh');

      expect(writeSpy).toHaveBeenCalledWith('/effort high\r');
    });

    it('should map off and minimal to low', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('off');
      expect(writeSpy).toHaveBeenCalledWith('/effort low\r');
    });

    it('should map minimal to low on a fresh manager', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      const freshManager = new ClaudeChannelProcessManager(makeDefaultConfig());
      await freshManager.start();

      freshManager.setThinkingLevel('minimal');
      expect(writeSpy).toHaveBeenCalledWith('/effort low\r');

      await freshManager.stop();
    });

    it('should map medium to medium', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('medium');

      expect(writeSpy).toHaveBeenCalledWith('/effort medium\r');
    });

    it('should map high to high', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('high');

      expect(writeSpy).toHaveBeenCalledWith('/effort high\r');
    });

    it('should default unknown levels to medium', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      manager.setThinkingLevel('bogus');

      expect(writeSpy).toHaveBeenCalledWith('/effort medium\r');
    });
  });

  describe('clearContext', () => {
    it('should write /clear to the PTY', async () => {
      const ptyProc = makeDeferredPty();
      const writeSpy = vi.fn();
      (ptyProc as Record<string, unknown>).write = writeSpy;
      spawnMock.mockImplementationOnce(() => ptyProc);
      await manager.start();

      // clearContext awaits a 1500ms processing delay — fast-forward it.
      vi.useFakeTimers();
      const ccP = manager.clearContext();
      await vi.advanceTimersByTimeAsync(1500);
      await ccP;
      vi.useRealTimers();

      expect(writeSpy).toHaveBeenCalledWith('/clear\r');
    });

    it('should not throw when no PTY process exists', async () => {
      await expect(manager.clearContext()).resolves.toBeUndefined();
    });
  });
});
