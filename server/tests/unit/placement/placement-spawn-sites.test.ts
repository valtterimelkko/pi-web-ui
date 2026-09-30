import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

/**
 * D0 wiring tests for the runtime spawn sites. The claude/antigravity/command-code
 * sites are the representative shapes: session-bound argv spawns with env. Placement
 * off must leave argv and env byte-identical (amendment E).
 */

function fakeChild(): ChildProcess {
  // A real EventEmitter so tests can drive 'close' (both wired sites listen for it).
  const c = new EventEmitter() as unknown as ChildProcess;
  (c as unknown as { stdout: null; stderr: null; stdin: null }).stdout = null;
  (c as unknown as { stdin: null }).stdin = null;
  (c as unknown as { pid: number }).pid = 424242;
  (c as unknown as { kill: () => void }).kill = () => {};
  return c;
}

const PLACEMENT_ENV = {
  PI_TOOLS_PLACEMENT: 'on',
  PI_TOOLS_CGROUP_ROOT: '/tmp/d0-wire-cg',
  PI_TOOLS_SLICE: '/tmp/d0-wire-cg/t.slice',
  PI_TOOLS_RUNTIME_DIR: '/tmp/d0-wire-rt',
};

const INJECTED_PLACEMENT_KEYS = [
  'PI_TOOLS_CG', 'PI_TOOLS_ROOT', 'PI_TOOLS_GROUP', 'PI_TOOLS_MEM_MAX', 'PI_TOOLS_MEM_HIGH',
  'PI_TOOLS_PIDS_MAX', 'PI_TOOLS_SWAP_MAX', 'PI_TOOLS_SHELL', 'PI_TOOLS_DEGRADE_FILE',
];

const RUN_ENV = {
  PI_TOOLS_CGROUP_ROOT: PLACEMENT_ENV.PI_TOOLS_CGROUP_ROOT,
  PI_TOOLS_SLICE: PLACEMENT_ENV.PI_TOOLS_SLICE,
  PI_TOOLS_RUNTIME_DIR: PLACEMENT_ENV.PI_TOOLS_RUNTIME_DIR,
};

function stubPlacementOn(): void {
  vi.stubEnv('PI_TOOLS_PLACEMENT', 'on');
  vi.stubEnv('PI_TOOLS_CGROUP_ROOT', RUN_ENV.PI_TOOLS_CGROUP_ROOT);
  vi.stubEnv('PI_TOOLS_SLICE', RUN_ENV.PI_TOOLS_SLICE);
  vi.stubEnv('PI_TOOLS_RUNTIME_DIR', RUN_ENV.PI_TOOLS_RUNTIME_DIR);
}

function stubPlacementOff(): void {
  vi.stubEnv('PI_TOOLS_PLACEMENT', 'off');
  vi.stubEnv('PI_TOOLS_CGROUP_ROOT', RUN_ENV.PI_TOOLS_CGROUP_ROOT);
  vi.stubEnv('PI_TOOLS_SLICE', RUN_ENV.PI_TOOLS_SLICE);
  vi.stubEnv('PI_TOOLS_RUNTIME_DIR', RUN_ENV.PI_TOOLS_RUNTIME_DIR);
}

describe('D0 spawn-site wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('command-code runner: session-bound group via the injectable spawn, byte-identical when off', async () => {
    const { CommandCodeProcessRunner } = await import('../../../src/command-code/command-code-process-runner.js');
    const seen: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const children: ChildProcess[] = [];
    const fakeSpawn = vi.fn((_c: string, _a: readonly string[], o: { env?: NodeJS.ProcessEnv }) => {
      const child = fakeChild();
      children.push(child);
      seen.push({ file: _c, args: [..._a], env: o.env });
      return child;
    });

    // ON: the wrapper is the executable; the argv carries the full original; env merged.
    stubPlacementOn();
    const onRunner = new CommandCodeProcessRunner({ spawn: fakeSpawn as never, executablePath: '/usr/bin/cmdc', nativeHomeDir: '/tmp/d0-native' });
    fakeSpawn.mockClear();
    const onRun = onRunner.run({ sessionId: 'cmd-s1', prompt: 'hi', cwd: '/tmp', maxTurns: 5, model: 'cmdc/custom-model' as never, onEvent: () => {} } as never);
    await vi.waitFor(() => expect(seen.length).toBe(1));
    (children[0] as unknown as EventEmitter).emit('close', 0, null);
    await onRun;
    const onCall = seen[0];
    expect(onCall.file).toMatch(/placement-wrapper\.sh$/);
    expect(onCall.args[0]).toBe('/usr/bin/cmdc');
    expect(onCall.env?.PI_TOOLS_GROUP).toContain('cmd-s1');
    expect(onCall.env?.PI_TOOLS_MEM_MAX).toBeTruthy();

    // OFF: byte-identical argv and env — none of the INJECTED placement keys.
    // (Config vars like PI_TOOLS_PLACEMENT legitimately ride process.env.)
    stubPlacementOff();
    const offRunner = new CommandCodeProcessRunner({ spawn: fakeSpawn as never, executablePath: '/usr/bin/cmdc', nativeHomeDir: '/tmp/d0-native' });
    fakeSpawn.mockClear();
    seen.length = 0;
    const offRun = offRunner.run({ sessionId: 'cmd-s1', prompt: 'hi', cwd: '/tmp', maxTurns: 5, model: 'cmdc/custom-model' as never, onEvent: () => {} } as never);
    await vi.waitFor(() => expect(seen.length).toBe(1)); // seen was reset before the OFF run
    (children[1] as unknown as EventEmitter).emit('close', 0, null);
    await offRun;
    const offCall = seen[0];
    expect(offCall.file).toBe('/usr/bin/cmdc');
    expect(offCall.args[0]).toBe('-p'); // original spawn(file, args) signature restored
    expect(Object.keys(offCall.env ?? {}).filter((k) => INJECTED_PLACEMENT_KEYS.includes(k))).toHaveLength(0);
  });

  it('agy stream process: session-bound group via the injectable spawnFn, byte-identical when off', async () => {
    const { AgyStreamProcess } = await import('../../../src/antigravity/agy-stream-process.js');
    const seen: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const fakeSpawn = vi.fn(((c: string, a: readonly string[], o: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ file: c, args: [...a], env: o.env });
      return fakeChild();
    }) as never);

    stubPlacementOn();
    const on = new AgyStreamProcess({
      sessionId: 'agy-s1', cwd: '/tmp', timeoutMs: 1000, stallTimeoutMs: 900, idleTimeoutMs: 800,
      onEvent: () => {}, spawnFn: fakeSpawn,
    });
    await on.start();
    expect(seen[0].file).toMatch(/placement-wrapper\.sh$/);
    expect(seen[0].args[0]).toBe('/root/.local/bin/agy');
    expect(seen[0].env?.PI_TOOLS_GROUP).toContain('agy-s1');
    on.abort?.();

    stubPlacementOff();
    seen.length = 0;
    const off = new AgyStreamProcess({
      sessionId: 'agy-s1', cwd: '/tmp', timeoutMs: 1000, stallTimeoutMs: 900, idleTimeoutMs: 800,
      onEvent: () => {}, spawnFn: fakeSpawn,
    });
    await off.start();
    expect(seen[0].file).toBe('/root/.local/bin/agy');
    expect(Object.keys(seen[0].env ?? {}).filter((k) => INJECTED_PLACEMENT_KEYS.includes(k))).toHaveLength(0);
    off.abort?.();
  });

  it('claude process pool: session-bound group when on (global spawn mocked)', async () => {
    vi.resetModules();
    const seen: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        spawn: vi.fn(((c: string, a: readonly string[], o: { env?: NodeJS.ProcessEnv }) => {
          seen.push({ file: c, args: [...a], env: o.env });
          const child = fakeChild();
          return child;
        }) as never),
      };
    });
    const { ClaudeProcessPool } = await import('../../../src/claude/claude-process-pool.js');
    vi.stubEnv('PI_TOOLS_PLACEMENT', 'on');
    vi.stubEnv('PI_TOOLS_CGROUP_ROOT', PLACEMENT_ENV.PI_TOOLS_CGROUP_ROOT);
    vi.stubEnv('PI_TOOLS_SLICE', PLACEMENT_ENV.PI_TOOLS_SLICE);
    vi.stubEnv('PI_TOOLS_RUNTIME_DIR', PLACEMENT_ENV.PI_TOOLS_RUNTIME_DIR);
    const pool = new ClaudeProcessPool();
    const wait = pool.spawn(
      { sessionId: 'reg-1', claudeSessionId: 'claude-s1', cwd: '/tmp', prompt: 'hello' } as never,
      () => {},
      () => {},
    );
    await wait.catch(() => undefined);
    expect(seen.length).toBe(1);
    expect(seen[0].file).toMatch(/placement-wrapper\.sh$/);
    expect(seen[0].args).toContain('--output-format');
    expect(seen[0].args).toContain('stream-json');
    expect(seen[0].env?.PI_TOOLS_GROUP).toContain('claude-s1');
  });
});
