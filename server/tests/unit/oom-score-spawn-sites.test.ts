import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

/**
 * Lane oom wiring: every child-runtime process the server spawns must get
 * applyChildOomScoreAdj(child, <site>) right after the spawn call — devin ACP,
 * claude CLI/SDK/channel, antigravity, command-code, opencode, pi parallel,
 * pi workers, terminals, and the session-bound goal verify helpers.
 */

function fakeChild(pid = 424242): ChildProcess {
  const c = new EventEmitter() as unknown as ChildProcess;
  (c as unknown as { stdout: unknown }).stdout = new PassThrough();
  (c as unknown as { stderr: unknown }).stderr = new PassThrough();
  (c as unknown as { stdin: unknown }).stdin = new PassThrough();
  (c as unknown as { pid: number }).pid = pid;
  (c as unknown as { kill: () => boolean }).kill = () => {
    setTimeout(() => c.emit('exit', 0, 'SIGTERM'), 0);
    return true;
  };
  return c;
}

/** Mock the shared helper and hand the spy to the test body. */
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

/** Mock node:child_process spawn (capturing children); everything else real. */
async function mockNodeSpawn(children: ChildProcess[], extra: Record<string, unknown> = {}): Promise<void> {
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
      ...actual,
      spawn: vi.fn(() => {
        const child = fakeChild();
        children.push(child);
        return child;
      }),
      ...extra,
    };
  });
}

describe('child oom_score_adj spawn-site wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals?.();
    vi.unstubAllEnvs();
  });

  it('devin ACP client applies the score to its `devin acp` child', async () => {
    await withOomSpy(async (spy) => {
      const { DevinAcpClient } = await import('../../src/devin/devin-acp-client.js');
      const spawned: unknown[] = [];
      const client = new DevinAcpClient({
        cwd: '/tmp',
        devinHome: '/tmp/devin-home',
        executablePath: '/bin/true',
        spawnFn: (() => {
          const c = fakeChild();
          spawned.push(c);
          return c;
        }) as never,
      });
      // start() spawns synchronously then awaits the ACP handshake; the score
      // is applied before that first await. Exiting the fake child rejects the
      // pending initialize so start() settles.
      const p = client.start();
      expect(spawned).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(spawned[0], 'devin-acp');
      (spawned[0] as ChildProcess).emit('exit', 0, null);
      await p.catch(() => undefined);
    });
  });

  it('runDevin applies the score to auxiliary devin probes', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children);
      const { runDevin } = await import('../../src/devin/devin-service.js');
      const p = runDevin(['--version'], 1000, '/tmp/devin-home', '/bin/true');
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'devin-probe');
      children[0].emit('close', 0);
      await p;
    });
  });

  it('claude process pool applies the score to `claude -p` children', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children, { execSync: vi.fn(() => '/usr/bin/claude\n') });
      const { ClaudeProcessPool } = await import('../../src/claude/claude-process-pool.js');
      const pool = new ClaudeProcessPool();
      await pool.spawn(
        { sessionId: 's1', claudeSessionId: 'c1', cwd: '/tmp', prompt: 'hi', model: 'm' } as never,
        () => {},
        () => {},
      );
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'claude-cli');
      children[0].emit('exit', 0, null);
    });
  });

  it('agy stream process applies the score to the persistent agy child', async () => {
    await withOomSpy(async (spy) => {
      const { AgyStreamProcess } = await import('../../src/antigravity/agy-stream-process.js');
      const spawned: unknown[] = [];
      const proc = new AgyStreamProcess({
        sessionId: 'agy-s1', cwd: '/tmp', timeoutMs: 1000, stallTimeoutMs: 900, idleTimeoutMs: 800,
        onEvent: () => {},
        spawnFn: (() => {
          const c = fakeChild();
          spawned.push(c);
          return c;
        }) as never,
      });
      await proc.start();
      expect(spawned).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(spawned[0], 'antigravity-stream');
      proc.abort();
    });
  });

  it('runAgy applies the score to auxiliary agy probes', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children);
      const { runAgy } = await import('../../src/antigravity/antigravity-service.js');
      const p = runAgy(['--version'], '/tmp', 1000);
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'antigravity-probe');
      children[0].emit('close', 0);
      await p;
    });
  });

  it('command-code process runner applies the score to the cmdc child', async () => {
    await withOomSpy(async (spy) => {
      const { CommandCodeProcessRunner } = await import('../../src/command-code/command-code-process-runner.js');
      const spawned: unknown[] = [];
      const runner = new CommandCodeProcessRunner({
        executablePath: '/usr/bin/cmdc',
        spawn: (() => {
          const c = fakeChild();
          spawned.push(c);
          return c;
        }) as never,
      });
      const p = runner.run({
        sessionId: 'cc-s1', prompt: 'hi', cwd: '/tmp', maxTurns: 1, model: 'cmdc/model' as never,
      });
      expect(spawned).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(spawned[0], 'command-code');
      (spawned[0] as ChildProcess).emit('close', 0, null);
      await p;
    });
  });

  it('command-code model discovery applies the score to both probes', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children);
      const { discoverCommandCodeModels } = await import('../../src/command-code/command-code-model-catalog.js');
      const p = discoverCommandCodeModels('/usr/bin/cmdc', { timeoutMs: 5000 });
      await vi.waitFor(() => expect(children.length).toBe(1));
      children[0].emit('close', 0);
      await vi.waitFor(() => expect(children.length).toBe(2));
      children[1].emit('close', 0);
      await p;
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(children[0], 'command-code-probe');
      expect(spy).toHaveBeenCalledWith(children[1], 'command-code-probe');
    });
  });

  it('opencode process manager applies the score to `opencode serve`', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children, { execSync: vi.fn(() => Buffer.from('/usr/bin/opencode')) });
      const { OpenCodeProcessManager } = await import('../../src/opencode/opencode-process-manager.js');
      const manager = new OpenCodeProcessManager({
        host: '127.0.0.1', port: 4096, password: '', workingDir: '/tmp', enabled: true,
      } as never);
      vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue(new Response(null, { status: 200 }));
      await manager.start();
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'opencode-serve');
      await manager.stop().catch(() => undefined);
    });
  });

  it('opencode service applies the score to the `opencode models` warm probe', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children, {
        execFile: vi.fn((_f: string, _a: string[], _o: unknown, cb?: (e: unknown, so: string, se: string) => void) => {
          const c = fakeChild();
          children.push(c);
          cb?.(null, '', '');
          return c;
        }),
      });
      const dir = mkdtempSync(join(tmpdir(), 'oc-warm-'));
      try {
        const { OpenCodeService } = await import('../../src/opencode/opencode-service.js');
        const svc = new OpenCodeService({ registryPath: join(dir, 'reg.json') });
        await (svc as unknown as { warmModelCache: () => Promise<boolean> }).warmModelCache();
        expect(children).toHaveLength(1);
        expect(spy).toHaveBeenCalledWith(children[0], 'opencode-probe');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('pi parallel session orchestrator applies the score to spawned pi sessions', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children);
      const { SessionOrchestrator } = await import('../../src/pi/parallel/session-orchestrator.js');
      const worktreeManager = { updateWorktreeStatus: vi.fn(async () => undefined) };
      const orch = new SessionOrchestrator(worktreeManager as never);
      const task = { id: 't1', title: 'T', description: 'D' };
      await orch.startOrchestration(
        { orchestrationId: 'o1', repoPath: '/tmp', planTitle: 't', baseBranch: 'b', autoMerge: false, maxParallel: 1 },
        [task as never],
      );
      await orch.startSession('o1', { id: 't1', path: '/tmp/wt1' } as never, task as never);
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'pi-parallel');
      children[0].emit('close', 0, null);
    });
  });

  it('plain worker launcher applies the score to pi --mode rpc workers', async () => {
    await withOomSpy(async (spy) => {
      const { PlainWorkerLauncher } = await import('../../src/workers/worker-launcher.js');
      const child = fakeChild();
      const launcher = new PlainWorkerLauncher({ spawnProcess: vi.fn(() => child) });
      await launcher.launch({ executable: '/usr/bin/pi', args: ['--mode', 'rpc'], env: {} } as never);
      expect(spy).toHaveBeenCalledWith(child, 'pi-worker');
    });
  });

  it('devin goal verify applies the score to the session-bound verify command', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children, {
        exec: vi.fn((_c: string, _o: unknown, cb?: (e: unknown, so: string, se: string) => void) => {
          const c = fakeChild();
          children.push(c);
          cb?.(null, '', '');
          return c;
        }),
      });
      const { verifyDevinGoalTurn } = await import('../../src/internal-api/goal/devin-goal.js');
      await verifyDevinGoalTurn({ verifyCommand: 'true', cwd: '/tmp', timeoutMs: 1000 });
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'goal-verify');
    });
  });

  it('antigravity goal verify applies the score to the session-bound verify command', async () => {
    await withOomSpy(async (spy) => {
      const children: ChildProcess[] = [];
      await mockNodeSpawn(children, {
        exec: vi.fn((_c: string, _o: unknown, cb?: (e: unknown, so: string, se: string) => void) => {
          const c = fakeChild();
          children.push(c);
          cb?.(null, '', '');
          return c;
        }),
      });
      const { verifyAgyGoalTurn } = await import('../../src/internal-api/goal/antigravity-goal.js');
      await verifyAgyGoalTurn({ verifyCommand: 'true', cwd: '/tmp', timeoutMs: 1000 });
      expect(children).toHaveLength(1);
      expect(spy).toHaveBeenCalledWith(children[0], 'goal-verify');
    });
  });
});
