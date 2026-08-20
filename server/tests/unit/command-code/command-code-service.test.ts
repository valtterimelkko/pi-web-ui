import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CommandCodeRuntimeError, CommandCodeService } from '../../../src/command-code/command-code-service.js';
import type { CommandCodeProcessRunInput, CommandCodeProcessRunResult } from '../../../src/command-code/command-code-process-runner.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

class Runner {
  inputs: CommandCodeProcessRunInput[] = [];
  hang = false;
  async run(input: CommandCodeProcessRunInput): Promise<CommandCodeProcessRunResult> {
    this.inputs.push(input);
    if (this.hang) return new Promise(() => undefined);
    return {
      exitCode: 0, signal: null, stderrTail: '',
      parsed: {
        events: [{ event: { type: 'message_update', text: 'ok' }, lineNumber: 1 }],
        terminal: { type: 'result', subtype: 'success', sessionId: `native-${this.inputs.length}`, finalText: 'ok', usage: { input: 2, output: 3, total: 5 } },
        unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 2,
      },
    };
  }
  async abort() {}
  async shutdown() {}
  isRunning() { return false; }
}

async function harness(options: { models?: string[]; enabled?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-cwd-'));
  const runner = new Runner();
  const service = new CommandCodeService({
    config: {
      enabled: options.enabled ?? true,
      executablePath: '/opt/bin/cmd',
      stateDir: root,
      allowedCwdRoots: [cwd],
    },
    runner,
    discover: async () => ({ version: '1.23.2', models: options.models ?? ['qwen/qwen3.8-max', 'deepseek/deepseek-v4-flash'], ambiguous: [] }),
    checkExecutable: false,
  });
  return { root, cwd, runner, service };
}

// Native-home preparation only runs when the service owns its process runner
// (ownsProcessRunner = !options.runner), so tests covering it must not inject
// a fake runner. The real runner never spawns a process until sendPrompt.
async function harnessOwningRunner() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-cwd-'));
  const service = new CommandCodeService({
    config: {
      enabled: true,
      executablePath: '/opt/bin/cmd',
      stateDir: root,
      allowedCwdRoots: [cwd],
    },
    discover: async () => ({ version: '1.23.2', models: ['qwen/qwen3.8-max'], ambiguous: [] }),
    checkExecutable: false,
  });
  return { root, cwd, service };
}

describe('Command Code service', () => {
  it('reports disabled without discovery when the runtime is not enabled', async () => {
    const { service } = await harness({ enabled: false });
    await service.init();
    expect(service.isEnabled()).toBe(false);
    expect(service.isAvailable()).toBe(false);
    expect(service.getHealth().status).toBe('disabled');
    expect(await service.listSessions()).toEqual([]);
  });

  it('is available with a discovered catalogue and reports the version diagnostically', async () => {
    const { service } = await harness();
    await service.init();
    expect(service.isAvailable()).toBe(true);
    expect(service.getHealth().version).toBe('1.23.2');
    expect(service.getModels().map((model) => model.id)).toEqual(['qwen/qwen3.8-max', 'deepseek/deepseek-v4-flash']);
  });

  it('marks the runtime unavailable when the CLI advertises no models', async () => {
    const { service } = await harness({ models: [] });
    await service.init();
    expect(service.isAvailable()).toBe(false);
    expect(service.getHealth().status).toBe('exact_model_unavailable');
  });

  it('rejects a model that is not advertised and a cwd outside the allowed roots', async () => {
    const { cwd, service } = await harness();
    await service.init();
    await expect(service.createSession({ cwd, model: 'not/advertised' })).rejects.toThrow(CommandCodeRuntimeError);
    await expect(service.createSession({ cwd: os.tmpdir(), model: 'qwen/qwen3.8-max' })).rejects.toThrow(/outside the configured isolated workspace roots/i);
    // The tmpdir is an ancestor of cwd but the root list only contains cwd.
    const outside = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-outside-'));
    await expect(service.createSession({ cwd: outside, model: 'qwen/qwen3.8-max' })).rejects.toThrow(/outside the configured isolated workspace roots/i);
  });

  it('runs one turn per prompt, journals it, and binds the native session id', async () => {
    const { cwd, runner, service } = await harness();
    await service.init();
    const created = await service.createSession({ cwd, model: 'deepseek/deepseek-v4-flash', effort: undefined });
    expect(created.modelSelector).toBe('deepseek/deepseek-v4-flash');

    const events: NormalizedEvent[] = [];
    let completion: Error | undefined;
    await service.sendPrompt(created.sessionId, 'say ok', (event) => events.push(event), (error) => { completion = error; });
    expect(completion).toBeUndefined();
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]).toMatchObject({ model: 'deepseek/deepseek-v4-flash', cwd: created.cwd, prompt: 'say ok' });

    const record = await service.getSession(created.sessionId);
    expect(record?.nativeSessionId).toBe('native-1');
    expect(record?.state).toBe('idle');
    expect(record?.lastFinalText).toBe('ok');
    const replay = await service.getReplayEvents(created.sessionId);
    expect(replay.some((event) => event.type === 'agent_end')).toBe(true);
  });

  it('coalesces per-token deltas on replay and exposes projection and journal stats', async () => {
    const { cwd, service } = await harness();
    await service.init();
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
    // Simulate the real journal shape: one message_update per streaming delta.
    const manyDeltas: NormalizedEvent[] = [];
    for (const [index, letter] of ['o', 'k', 'a', 'y'].entries()) {
      manyDeltas.push({
        type: 'message_update', sessionId: created.sessionId, timestamp: index,
        data: { id: 'm1', assistantMessageEvent: { type: 'text_delta', delta: letter } },
      });
    }
    for (const event of manyDeltas) await service.journal.append(created.sessionId, event);

    const replay = await service.getReplayEvents(created.sessionId);
    expect(replay).toHaveLength(1);
    expect((replay[0].data as { assistantMessageEvent: { delta: string } }).assistantMessageEvent.delta).toBe('okay');

    const projection = service.getLastReplayProjection();
    expect(projection).toMatchObject({ sessionId: created.sessionId, inputCount: 4, outputCount: 1, collapsed: 3 });

    const stats = await service.getJournalStats(created.sessionId);
    expect(stats).toMatchObject({ exists: true, eventCount: 4 });
    expect(stats?.byteSize).toBeGreaterThan(0);
  });

  it('rejects concurrent prompts for one session and enforces the concurrency limit', async () => {
    const { cwd, runner, service } = await harness();
    await service.init();
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
    runner.hang = true;
    const first = service.sendPrompt(created.sessionId, 'one', () => undefined);
    await expect(service.sendPrompt(created.sessionId, 'two', () => undefined)).rejects.toThrow(/already running/i);
    await service.abort(created.sessionId);
    await first;
    runner.hang = false;
  });

  it('deletes a session, its journal, and its registry entry', async () => {
    const registry = { delete: vi.fn().mockResolvedValue(undefined), listBySdkType: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue(undefined) };
    const root = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-registry-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-cwd-'));
    const runner = new Runner();
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir: root, allowedCwdRoots: [cwd] },
      runner,
      discover: async () => ({ version: '1.23.2', models: ['qwen/qwen3.8-max'], ambiguous: [] }),
      checkExecutable: false,
      sessionRegistry: registry as any,
    });
    await service.init();
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
    expect(registry.upsert).toHaveBeenCalled();
    expect(await service.deleteSession(created.sessionId)).toBe(true);
    expect(await service.getSession(created.sessionId)).toBeUndefined();
    expect(registry.delete).toHaveBeenCalledWith(created.sessionId);
    await expect(service.getReplayEvents(created.sessionId)).rejects.toThrow(CommandCodeRuntimeError);
  });

  it('treats a stored session as accessible while its cwd stays within the allowed roots', async () => {
    const { cwd, service } = await harness();
    await service.init();
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
    expect(await service.hasSession(created.sessionId)).toBe(true);
    // Accessibility no longer depends on capability hashes or shadow gates;
    // only existence, deletion state, and the cwd root policy matter.
    expect((await service.getSession(created.sessionId))?.sessionId).toBe(created.sessionId);
  });

  it('mirrors the operator\'s user-scope mods into the session native home', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-home-'));
    const modsDir = path.join(fakeHome, '.commandcode', 'mods');
    await mkdir(modsDir, { recursive: true });
    await writeFile(path.join(modsDir, 'test-mod.ts'), '// test mod\n');
    // Symlinks point outside the operator home and must never be followed
    // into the session-private native home.
    await symlink('/etc/hostname', path.join(modsDir, 'escape.ts'));
    vi.stubEnv('HOME', fakeHome);
    try {
      const { root, cwd, service } = await harnessOwningRunner();
      await service.init();
      const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
      const sessionMods = path.join(root, 'native-home', created.sessionId, '.commandcode', 'mods');
      expect(await readFile(path.join(sessionMods, 'test-mod.ts'), 'utf8')).toBe('// test mod\n');
      // The symlink is skipped outright, not copied through.
      expect(await lstat(path.join(sessionMods, 'escape.ts')).catch(() => undefined)).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('creates sessions normally when the operator has no user-scope mods installed', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-home-'));
    vi.stubEnv('HOME', fakeHome);
    try {
      const { cwd, service } = await harnessOwningRunner();
      await service.init();
      const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
      expect((await service.getSession(created.sessionId))?.sessionId).toBe(created.sessionId);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
