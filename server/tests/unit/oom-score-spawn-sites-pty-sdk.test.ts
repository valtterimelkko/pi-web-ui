import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

/**
 * Lane oom wiring (pty + SDK spawns): the Claude SDK child (through the
 * spawnClaudeCodeProcess hook), the Claude channel PTY host, and interactive
 * terminals all get applyChildOomScoreAdj right after spawn.
 */

function fakeChild(pid = 424242): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess;
  (c as unknown as { stdout: unknown }).stdout = new PassThrough();
  (c as unknown as { stderr: unknown }).stderr = new PassThrough();
  (c as unknown as { stdin: unknown }).stdin = new PassThrough();
  (c as unknown as { pid: number }).pid = pid;
  (c as unknown as { kill: () => boolean }).kill = () => true;
  return c;
}

function fakePty(pid = 54321) {
  const emitter = new EventEmitter();
  return {
    pid,
    kill: vi.fn(() => {
      setTimeout(() => emitter.emit('exit', { exitCode: 0, signal: 'SIGTERM' }), 0);
      return true;
    }),
    write: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => { emitter.on('data', cb); }),
    onExit: vi.fn((cb: (e: { exitCode: number | null; signal?: number | string }) => void) => { emitter.on('exit', cb); }),
    _emitter: emitter,
  };
}

async function withOomSpy<T>(fn: (spy: ReturnType<typeof vi.fn>) => Promise<T>): Promise<T> {
  vi.resetModules();
  const spy = vi.fn();
  vi.doMock('../../src/oom-score-adj.js', () => ({
    applyChildOomScoreAdj: spy,
    CHILD_OOM_SCORE_ADJ: '0',
    childOomScoreFilePath: (pid: number) => `/proc/${pid}/oom_score_adj`,
    resetChildOomScoreAdjWarnings: () => {},
  }));
  try {
    return await fn(spy);
  } finally {
    vi.doUnmock('../../src/oom-score-adj.js');
    vi.resetModules();
  }
}

describe('child oom_score_adj spawn-site wiring (pty + SDK)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('claude SDK sessions install spawnClaudeCodeProcess that applies the score (native + profile)', async () => {
    await withOomSpy(async (spy) => {
      const queryMock = vi.fn();
      vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
      const children: ChildProcess[] = [];
      const spawnMock = vi.fn(() => {
        const c = fakeChild();
        children.push(c);
        return c;
      });
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return { ...actual, spawn: spawnMock, execSync: vi.fn(() => '/usr/bin/claude\n') };
      });

      const dir = mkdtempSync(join(tmpdir(), 'sdk-oom-'));
      try {
        writeFileSync(join(dir, 'profiles.json'), JSON.stringify({
          profiles: [{
            id: 'p1', label: 'P', backend: 'sdk-subscription', launcherType: 'native-env',
            model: 'sonnet', settingSources: ['user'], skills: 'all', permissionMode: 'dontAsk',
            allowedTools: ['Read'], maxConcurrent: 2, enabled: true,
          }],
          defaultProfileId: 'p1',
        }));
        const { ClaudeSdkService } = await import('../../src/claude/claude-sdk-service.js');
        const svc = new ClaudeSdkService({
          claudeSessionDir: join(dir, 'sessions'),
          registryPath: join(dir, 'registry.json'),
          profilesPath: join(dir, 'profiles.json'),
        });
        queryMock.mockReturnValue((async function* () {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'x' };
        })());

        // Native (no profile) session.
        const native = await svc.createSession(join(dir, 'cwd1'), 'sonnet');
        await new Promise<void>((resolve) => {
          svc.sendPrompt(native.sessionId, 'hi', () => {}, () => resolve()).catch(() => resolve());
        });
        // Profile-backed session.
        const profiled = await svc.createSession(join(dir, 'cwd2'), 'sonnet', undefined, 'p1');
        await new Promise<void>((resolve) => {
          svc.sendPrompt(profiled.sessionId, 'hi', () => {}, () => resolve()).catch(() => resolve());
        });

        expect(queryMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const call of queryMock.mock.calls) {
          const options = (call[0] as { options?: Record<string, unknown> }).options;
          expect(typeof options?.spawnClaudeCodeProcess).toBe('function');
        }

        // Invoke the installed hook the way the SDK does and prove the spawned
        // child is scored AND the returned object is the child itself
        // (ChildProcess satisfies SpawnedProcess).
        const options = (queryMock.mock.calls[0][0] as { options: { spawnClaudeCodeProcess: (o: unknown) => unknown } }).options;
        const signal = new AbortController().signal;
        const before = children.length;
        const spawnedProcess = options.spawnClaudeCodeProcess({
          command: '/bin/echo', args: ['x'], cwd: '/tmp', env: {}, signal,
        });
        expect(children.length).toBe(before + 1);
        const child = children[children.length - 1];
        expect(spy).toHaveBeenCalledWith(child, 'claude-sdk');
        expect(spawnedProcess).toBe(child);
        // Default SDK spawn shape: stdin+stdout piped, stderr ignored (no
        // DEBUG_CLAUDE_AGENT_SDK and no Options.stderr), windowsHide, signal.
        expect(spawnMock).toHaveBeenLastCalledWith('/bin/echo', ['x'], expect.objectContaining({
          cwd: '/tmp',
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
          signal,
        }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('claude SDK spawn hook pipes stderr only when the SDK default would (stderr handler / DEBUG env)', async () => {
    await withOomSpy(async () => {
      const queryMock = vi.fn();
      vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
      const children: ChildProcess[] = [];
      const spawnMock = vi.fn(() => {
        const c = fakeChild();
        children.push(c);
        return c;
      });
      vi.doMock('node:child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:child_process')>();
        return { ...actual, spawn: spawnMock, execSync: vi.fn(() => '/usr/bin/claude\n') };
      });

      const dir = mkdtempSync(join(tmpdir(), 'sdk-oom-err-'));
      try {
        const { ClaudeSdkService } = await import('../../src/claude/claude-sdk-service.js');
        const svc = new ClaudeSdkService({
          claudeSessionDir: join(dir, 'sessions'),
          registryPath: join(dir, 'registry.json'),
        });
        queryMock.mockReturnValue((async function* () {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'x' };
        })());
        const { sessionId } = await svc.createSession(join(dir, 'cwd'), 'sonnet');
        await new Promise<void>((resolve) => {
          svc.sendPrompt(sessionId, 'hi', () => {}, () => resolve()).catch(() => resolve());
        });
        const options = (queryMock.mock.calls[0][0] as {
          options: { spawnClaudeCodeProcess: (o: unknown) => unknown; stderr?: (d: string) => void };
        }).options;

        const signal = new AbortController().signal;
        // stderr handler present → stderr piped and data forwarded.
        const stderrChunks: string[] = [];
        options.stderr = (d: string) => { stderrChunks.push(d); };
        options.spawnClaudeCodeProcess({ command: '/bin/echo', args: [], cwd: '/tmp', env: {}, signal });
        const childA = children[children.length - 1];
        expect(spawnMock).toHaveBeenLastCalledWith('/bin/echo', [], expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }));
        childA.stderr?.emit('data', Buffer.from('claude says hi'));
        expect(stderrChunks).toEqual(['claude says hi']);

        // DEBUG_CLAUDE_AGENT_SDK truthy → stderr piped even without a handler.
        delete options.stderr;
        options.spawnClaudeCodeProcess({ command: '/bin/echo', args: [], cwd: '/tmp', env: { DEBUG_CLAUDE_AGENT_SDK: '1' }, signal });
        expect(spawnMock).toHaveBeenLastCalledWith('/bin/echo', [], expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('claude channel process manager applies the score to the channel PTY host', async () => {
    await withOomSpy(async (spy) => {
      const ptySpawn = vi.fn(() => fakePty());
      vi.doMock('node-pty', () => ({ default: { spawn: ptySpawn }, spawn: ptySpawn }));
      vi.doMock('ws', async () => {
        const { EventEmitter: EE } = await import('events');
        class MockWebSocket extends EE {
          constructor() {
            super();
            setImmediate(() => this.emit('open'));
          }
          close() {}
          removeAllListeners() { return this; }
        }
        return { default: MockWebSocket, WebSocket: MockWebSocket };
      });
      const dir = mkdtempSync(join(tmpdir(), 'chan-plugin-'));
      try {
        const pluginDir = join(dir, '.claude-plugin');
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'plugin.json'), '{}');
        const { ClaudeChannelProcessManager } = await import('../../src/claude/claude-channel-process-manager.js');
        const manager = new ClaudeChannelProcessManager({
          pluginDir: dir, wsPort: 3110, hookPort: 3111, cwd: '/tmp',
        });
        try {
          await manager.start();
          expect(ptySpawn).toHaveBeenCalledTimes(1);
          const ptyChild = ptySpawn.mock.results[0].value;
          expect(spy).toHaveBeenCalledWith(ptyChild, 'claude-channel');
        } finally {
          await manager.stop().catch(() => undefined);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('terminal manager applies the score to spawned shells — placed and fallback', async () => {
    await withOomSpy(async (spy) => {
      const ptys: unknown[] = [];
      const ptySpawn = vi.fn(() => {
        const p = fakePty();
        ptys.push(p);
        return p;
      });
      vi.doMock('node-pty', () => ({ default: { spawn: ptySpawn }, spawn: ptySpawn }));
      const { TerminalManager } = await import('../../src/terminal/terminal-manager.js');
      const manager = new TerminalManager();
      try {
        const result = await manager.create('client-1', '/tmp', 80, 24);
        expect(result.success).toBe(true);
        expect(ptySpawn).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(ptys[0], 'terminal');
      } finally {
        manager.destroyAll();
      }
    });
  });
});
