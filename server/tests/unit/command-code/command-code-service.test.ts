import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { CommandCodeModelDiscovery } from '../../../src/command-code/command-code-model-catalog.js';
import type { CommandCodeProcessRunInput, CommandCodeProcessRunResult } from '../../../src/command-code/command-code-process-runner.js';
import { COMMAND_CODE_FULL_MODEL_CATALOGUE, COMMAND_CODE_MODELS } from '../../../src/command-code/command-code-model-catalog.js';
import { CommandCodeService } from '../../../src/command-code/command-code-service.js';
import { createCommandCodeRoleAttestation } from '../../../src/command-code/command-code-role-attestation.js';

class FakeRunner {
  inputs: CommandCodeProcessRunInput[] = [];
  running = new Set<string>();
  results: CommandCodeProcessRunResult[] = [];
  shutdownError?: Error;
  async run(input: CommandCodeProcessRunInput): Promise<CommandCodeProcessRunResult> {
    this.inputs.push(input);
    this.running.add(input.sessionId);
    const result = this.results.shift()!;
    this.running.delete(input.sessionId);
    return result;
  }
  async abort(sessionId: string) { this.running.delete(sessionId); }
  async shutdown() { this.running.clear(); if (this.shutdownError) throw this.shutdownError; }
  isRunning(sessionId: string) { return this.running.has(sessionId); }
}

const discovery: CommandCodeModelDiscovery = {
  version: '1.19.0',
  models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'],
  ambiguous: [],
  effortCapabilities: {
    'qwen/qwen3.8-max': {
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'xhigh'],
      defaultEffort: 'medium',
      status: 'adjustable',
      source: 'live-preflight',
      capabilityHash: 'a'.repeat(64),
    },
    'meta/muse-spark-1.2-contributor': {
      supportsEffort: false,
      effortLevels: [],
      status: 'unavailable',
      source: 'live-preflight',
      capabilityHash: 'b'.repeat(64),
    },
  },
};

function success(nativeSessionId: string, finalText: string): CommandCodeProcessRunResult {
  return {
    exitCode: 0,
    signal: null,
    stderrTail: '',
    parsed: {
      events: [{ event: { type: 'message_update', text: finalText }, lineNumber: 1 }],
      terminal: { type: 'result', subtype: 'success', sessionId: nativeSessionId, finalText },
      unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 2,
    },
  };
}

describe('Command Code service', () => {
  it('rejects a default-discovered catalogue that is missing a model row', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-catalogue-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const executable = path.join(stateDir, 'cmd');
    await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] || '';
const effort = args[args.indexOf('--effort') + 1] || '';
if (args.includes('--version')) { console.log('Command Code v1.19.0'); process.exit(0); }
if (args.includes('--list-models')) {
  console.log('qwen/qwen3.8-max                      fixture adjustable model');
  console.log('meta/muse-spark-1.2-contributor       fixture non-adjustable model');
  process.exit(0);
}
if (model === 'qwen/qwen3.8-max' && ['low', 'medium', 'xhigh'].includes(effort)) { console.error('authentication required'); process.exit(3); }
if (model === 'qwen/qwen3.8-max' && effort === '__pi_web_ui_capability_probe__') { console.error('Unknown effort. Supported: low, medium, xhigh.'); process.exit(2); }
if (model === 'meta/muse-spark-1.2-contributor') { console.error('Model does not support adjustable reasoning effort.'); process.exit(2); }
process.exit(2);
`, { mode: 0o700 });
    try {
      const service = new CommandCodeService({
        config: { enabled: true, executablePath: executable, stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
        checkExecutable: false,
      });
      await service.init();
      expect(service.getHealth()).toMatchObject({ status: 'exact_model_unavailable', advertisedModels: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'] });
      await service.shutdown();
    } finally {
      await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
    }
  });

  it('marks the exact policy models unavailable when the pinned runtime version drifts', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-version-drift-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({ ...discovery, version: '1.23.2' }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.getHealth()).toMatchObject({ status: 'version_mismatch', version: '1.23.2' });
    expect(service.getModels().map((model) => ({ id: model.id, status: model.status, runnable: model.runnable }))).toEqual([
      { id: 'qwen/qwen3.8-max', status: 'unavailable', runnable: false },
      { id: 'meta/muse-spark-1.2-contributor', status: 'unavailable', runnable: false },
    ]);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('copies operator auth into each private native home without a shared auth symlink', async () => {
    const operatorHome = await mkdtemp(path.join(os.tmpdir(), 'command-code-operator-home-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const nativeHomeDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-native-home-'));
    const executablePath = path.join(nativeHomeDir, 'cmd');
    await writeFile(executablePath, '#!/bin/sh\n', { mode: 0o700 });
    await mkdir(path.join(operatorHome, '.commandcode'), { recursive: true });
    await writeFile(path.join(operatorHome, '.commandcode', 'auth.json'), '{"apiKey":"fixture-secret"}\n', { mode: 0o600 });
    const previousHome = process.env.HOME;
    process.env.HOME = operatorHome;
    try {
      const service = new CommandCodeService({
        config: { enabled: true, executablePath, stateDir, nativeHomeDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
        discover: async () => discovery,
        checkExecutable: false,
      });
      await service.init();
      const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'low', permissionProfile: 'implementation-child-wide' });
      const authPath = path.join(nativeHomeDir, created.sessionId, '.commandcode', 'auth.json');
      const metadata = await lstat(authPath);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o400);
      await expect(readFile(authPath, 'utf8')).resolves.toBe('{"apiKey":"fixture-secret"}\n');
    } finally {
      process.env.HOME = previousHome;
      await Promise.all([rm(operatorHome, { recursive: true, force: true }), rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true }), rm(nativeHomeDir, { recursive: true, force: true })]);
    }
  });

  it('creates, journals, resumes by exact native id, and exposes replay events', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-1', 'first'), success('native-1', 'second'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner,
      discover: async () => discovery,
      checkExecutable: false,
    });
    await service.init();
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'xhigh', permissionProfile: 'agent-os-7f-root-readonly' });
    expect(created.runtime).toBe('commandcode');
    expect(created.effort).toBe('xhigh');
    const first: string[] = [];
    await service.sendPrompt(created.sessionId, 'one', (event) => first.push(event.type));
    await service.sendPrompt(created.sessionId, 'two', () => undefined);
    expect(runner.inputs[0]?.nativeSessionId).toBeUndefined();
    expect(runner.inputs[1]?.nativeSessionId).toBe('native-1');
    expect(first).toContain('agent_end');
    expect(runner.inputs[0]?.effort).toBe('xhigh');
    const defaultSession = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' });
    expect(defaultSession.effort).toBe('medium');
    const replay = await service.getReplayEvents(created.sessionId);
    expect(replay.filter((event) => event.type === 'message_start' && (event.data as { role?: string }).role === 'user')).toHaveLength(2);
    expect(replay.some((event) => event.type === 'agent_end')).toBe(true);
  });

  it('rejects effort changes while a prompt is pending before launch', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-pending', 'pending-safe'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'medium', permissionProfile: 'implementation-child-wide' });

    const send = service.sendPrompt(session.sessionId, 'pending prompt', () => undefined);
    await expect(service.setEffort(session.sessionId, 'low')).rejects.toMatchObject({ code: 'runtime_error' });
    await send;
    expect(runner.inputs[0]?.effort).toBe('medium');
  });

  it('does not start a prompt while an effort update is in flight', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-control-race', 'control-race'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'medium', permissionProfile: 'implementation-child-wide' });
    let releaseRead!: () => void;
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    let readEntered!: () => void;
    const readStarted = new Promise<void>((resolve) => { readEntered = resolve; });
    const originalGet = service.store.get.bind(service.store);
    let blocked = true;
    vi.spyOn(service.store, 'get').mockImplementation(async (id) => {
      if (blocked && id === session.sessionId) {
        blocked = false;
        readEntered();
        await readRelease;
      }
      return originalGet(id);
    });

    const effortUpdate = service.setEffort(session.sessionId, 'low');
    await readStarted;
    const prompt = service.sendPrompt(session.sessionId, 'must wait for control', () => undefined);
    const promptRejection = expect(prompt).rejects.toMatchObject({ code: 'runtime_error' });
    releaseRead();
    await effortUpdate;
    await promptRejection;
    expect((await service.getSession(session.sessionId))?.effort).toBe('low');
    expect(runner.inputs).toHaveLength(0);
  });

  it('waits for an in-flight effort update before deleting the session', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'medium', permissionProfile: 'implementation-child-wide' });
    let releaseRead!: () => void;
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve; });
    let readEntered!: () => void;
    const readStarted = new Promise<void>((resolve) => { readEntered = resolve; });
    const originalGet = service.store.get.bind(service.store);
    let blocked = true;
    vi.spyOn(service.store, 'get').mockImplementation(async (id) => {
      if (blocked && id === session.sessionId) {
        blocked = false;
        readEntered();
        await readRelease;
      }
      return originalGet(id);
    });

    const effortUpdate = service.setEffort(session.sessionId, 'low');
    await readStarted;
    let deleted = false;
    const deletion = service.deleteSession(session.sessionId).then((value) => { deleted = value; return value; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deleted).toBe(false);
    releaseRead();
    await Promise.all([effortUpdate, deletion]);
    expect(deleted).toBe(true);
    expect(await service.getSession(session.sessionId)).toBeUndefined();
  });

  it('accepts a freshly discovered model without inventing a native default effort', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const model = 'deepseek/deepseek-v4-pro';
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        version: '1.19.0',
        models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor', model],
        ambiguous: [],
        effortCapabilities: {
          'qwen/qwen3.8-max': {
            supportsEffort: true,
            effortLevels: ['low', 'medium', 'xhigh'],
            defaultEffort: 'medium',
            status: 'adjustable',
            source: 'live-preflight',
            capabilityHash: 'a'.repeat(64),
          },
          'meta/muse-spark-1.2-contributor': {
            supportsEffort: false,
            effortLevels: [],
            status: 'unavailable',
            source: 'live-preflight',
            capabilityHash: 'b'.repeat(64),
          },
          [model]: {
            supportsEffort: true,
            effortLevels: ['high', 'max'],
            status: 'adjustable',
            source: 'live-preflight',
            capabilityHash: 'c'.repeat(64),
          },
        },
      }),
      checkExecutable: false,
    });
    await service.init();

    await expect(service.createSession({
      cwd,
      model: model as any,
      permissionProfile: 'implementation-child-wide',
    })).rejects.toThrow(/allowlist|shadow|unavailable|policy/i);
    expect(service.getModels()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: model, effortLevels: ['high', 'max'], supportsEffort: true }),
    ]));
  });

  it('fails closed when an extra discovered model carries drifted approved-model capability metadata', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const extraModel = 'deepseek/deepseek-v4-pro';
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        version: '1.19.0',
        models: [...discovery.models, extraModel],
        ambiguous: [],
        effortCapabilities: {
          ...discovery.effortCapabilities!,
          'qwen/qwen3.8-max': { ...discovery.effortCapabilities!['qwen/qwen3.8-max'], effortLevels: ['low', 'medium'], capabilityHash: 'd'.repeat(64) },
          [extraModel]: { supportsEffort: true, effortLevels: ['high', 'max'], status: 'adjustable', source: 'live-preflight', capabilityHash: 'c'.repeat(64) },
        },
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isAvailable()).toBe(false);
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' })).rejects.toThrow(/available|effort|capability|catalogue/i);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('exposes the full discovered catalogue with runnable status while retaining the narrow shadow projection', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const extraModel = 'deepseek/deepseek-v4-pro';
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        version: '1.19.0',
        models: [...discovery.models, extraModel],
        ambiguous: [],
        effortCapabilities: {
          ...discovery.effortCapabilities!,
          [extraModel]: {
            supportsEffort: true,
            effortLevels: ['high', 'max'],
            status: 'adjustable',
            source: 'live-preflight',
            capabilityHash: 'c'.repeat(64),
          },
        },
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isShadowAvailable()).toBe(true);
    expect(service.getModels().map((model) => model.id)).toEqual([...discovery.models, extraModel]);
    expect(service.getModels().map((model) => model.runnable)).toEqual([true, true, false]);
    expect(service.getModels().map((model) => model.status)).toEqual(['runnable', 'runnable', 'evidence-only']);
    expect(service.getModels().map((model) => model.browserRunnable)).toEqual([false, false, false]);
    expect(service.getShadowModels().map((model) => model.id)).toEqual([...COMMAND_CODE_MODELS]);
    expect(service.getShadowEffortCapabilities()).toEqual({
      'qwen/qwen3.8-max': expect.objectContaining({ effortLevels: ['low', 'medium', 'xhigh'] }),
      'meta/muse-spark-1.2-contributor': expect.objectContaining({ effortLevels: [] }),
    });
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('keeps the approved pair available when an extra catalogue model has unknown evidence', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const effortCapabilities = Object.fromEntries(COMMAND_CODE_FULL_MODEL_CATALOGUE.map((model) => [
      model,
      discovery.effortCapabilities?.[model] ?? {
        supportsEffort: false,
        effortLevels: [],
        status: 'unknown' as const,
        source: 'live-preflight' as const,
        capabilityHash: 'c'.repeat(64),
      },
    ]));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        version: '1.19.0',
        models: [...COMMAND_CODE_FULL_MODEL_CATALOGUE],
        ambiguous: [],
        effortCapabilities,
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isAvailable()).toBe(true);
    expect(service.getModels()).toHaveLength(COMMAND_CODE_FULL_MODEL_CATALOGUE.length);
    expect(service.getModels().find((model) => model.id === 'google/gemini-3.7-flash')).toMatchObject({ status: 'unavailable', runnable: false });
    expect(service.getModels().filter((model) => model.runnable).map((model) => model.id)).toEqual([...COMMAND_CODE_MODELS]);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('fails closed when unknown extra-model effort evidence carries a plausible selector', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-unknown-extra-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const effortCapabilities = Object.fromEntries(COMMAND_CODE_FULL_MODEL_CATALOGUE.map((model) => [
      model,
      model === 'deepseek/deepseek-v4-pro'
        ? { supportsEffort: true, effortLevels: ['high'], status: 'unknown' as const, source: 'live-preflight' as const, capabilityHash: 'd'.repeat(64) }
        : discovery.effortCapabilities?.[model] ?? { supportsEffort: false, effortLevels: [], status: 'unknown' as const, source: 'live-preflight' as const, capabilityHash: 'c'.repeat(64) },
    ]));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({ version: '1.19.0', models: [...COMMAND_CODE_FULL_MODEL_CATALOGUE], ambiguous: [], effortCapabilities }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isAvailable()).toBe(false);
    const extraProjection = service.getModels().find((model) => model.id === 'deepseek/deepseek-v4-pro');
    expect(extraProjection).toMatchObject({ supportsEffort: false, effortLevels: [] });
    expect(extraProjection?.defaultEffort).toBeUndefined();
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' })).rejects.toThrow(/available|effort|capability|catalogue/i);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('fails closed when approved Muse effort discovery is unknown', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-muse-unknown-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        ...discovery,
        effortCapabilities: {
          ...discovery.effortCapabilities!,
          'meta/muse-spark-1.2-contributor': {
            ...discovery.effortCapabilities!['meta/muse-spark-1.2-contributor'],
            status: 'unknown',
          },
        },
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isAvailable()).toBe(false);
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' })).rejects.toThrow(/available|effort|capability|catalogue/i);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('fails closed when effort capability status evidence is malformed', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-capability-status-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        ...discovery,
        effortCapabilities: {
          ...discovery.effortCapabilities!,
          'meta/muse-spark-1.2-contributor': {
            ...discovery.effortCapabilities!['meta/muse-spark-1.2-contributor'],
            status: 'not-a-status' as any,
          },
        },
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isAvailable()).toBe(false);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('fails closed without throwing when effort-level evidence is malformed', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-capability-shape-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        ...discovery,
        effortCapabilities: {
          ...discovery.effortCapabilities!,
          'qwen/qwen3.8-max': {
            ...discovery.effortCapabilities!['qwen/qwen3.8-max'],
            effortLevels: undefined as any,
          },
        },
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(() => service.getHealth()).not.toThrow();
    expect(service.getHealth()).toMatchObject({ status: 'effort_capability_unknown' });
    expect(service.isAvailable()).toBe(false);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('retains the discovered catalogue when hybrid effort discovery fails', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-effort-discovery-failure-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    let effortDiscoveryCalled = false;
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({ version: '1.19.0', models: [...COMMAND_CODE_FULL_MODEL_CATALOGUE], ambiguous: [] }),
      discoverEfforts: async () => {
        effortDiscoveryCalled = true;
        throw new Error('bounded effort discovery failed');
      },
      checkExecutable: false,
    } as any);
    await service.init();
    expect(effortDiscoveryCalled).toBe(true);
    expect(service.getHealth()).toMatchObject({ status: 'effort_capability_unknown', advertisedModels: [...COMMAND_CODE_FULL_MODEL_CATALOGUE] });
    expect(service.getModels()).toHaveLength(COMMAND_CODE_FULL_MODEL_CATALOGUE.length);
    expect(service.getModels().every((model) => model.runnable === false)).toBe(true);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('fails closed when the approved shadow catalogue is reordered in discovery', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({
        ...discovery,
        models: [...discovery.models].reverse(),
      }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isShadowAvailable()).toBe(false);
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' })).rejects.toThrow(/available|catalogue|order|policy/i);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('requires the full canonical catalogue order before exposing the shadow gate', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-catalogue-order-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const effortCapabilities = Object.fromEntries(COMMAND_CODE_FULL_MODEL_CATALOGUE.map((model) => [
      model,
      discovery.effortCapabilities?.[model] ?? {
        supportsEffort: false,
        effortLevels: [],
        status: 'unknown' as const,
        source: 'live-preflight' as const,
        capabilityHash: 'c'.repeat(64),
      },
    ]));
    const reordered = [...COMMAND_CODE_FULL_MODEL_CATALOGUE];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => ({ version: '1.19.0', models: reordered, ambiguous: [], effortCapabilities }),
      checkExecutable: false,
    });
    await service.init();
    expect(service.isAvailable()).toBe(true);
    expect(service.isShadowAvailable()).toBe(false);
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' })).rejects.toThrow(/available|catalogue|order|policy/i);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('marks only exact policy models runnable through the browser profile', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const browserAuthFile = path.join(cwd, 'browser-auth.json');
    await writeFile(browserAuthFile, '{"token":"fixture"}\n', { mode: 0o600 });
    const model = 'deepseek/deepseek-v4-pro';
    const service = new CommandCodeService({
      config: {
        enabled: false,
        browserEnabled: true,
        browserAllowedModels: [model],
        browserAllowedCwdRoots: [cwd],
        browserAuthFile,
        browserRuntimeRoots: [cwd],
        executablePath: '/opt/bin/cmd',
        stateDir,
        expectedVersion: '1.19.0',
      } as any,
      runner: new FakeRunner(),
      discover: async () => ({
        version: '1.19.0',
        models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor', model],
        ambiguous: [],
        effortCapabilities: {
          'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium', status: 'adjustable', source: 'live-preflight', capabilityHash: 'a'.repeat(64) },
          'meta/muse-spark-1.2-contributor': { supportsEffort: false, effortLevels: [], status: 'unavailable', source: 'live-preflight', capabilityHash: 'b'.repeat(64) },
          [model]: { supportsEffort: false, effortLevels: [], status: 'unavailable', source: 'live-preflight', capabilityHash: 'c'.repeat(64) },
        },
      }),
      checkExecutable: false,
    });
    (service as any).runner.browserSandboxReady = () => true;
    await service.init();
    await expect(service.createSession({ cwd, model, permissionProfile: 'browser-contained' } as any)).rejects.toThrow(/policy|allowlist|model|containment/i);
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'browser-contained' } as any)).rejects.toThrow(/policy|browser|allowlist/i);
  });

  it('refuses a browser workspace symlink that resolves outside the configured root', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const allowedRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-browser-root-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'command-code-browser-outside-'));
    const link = path.join(allowedRoot, 'linked-workspace');
    const browserAuthFile = path.join(allowedRoot, 'browser-auth.json');
    await writeFile(browserAuthFile, '{"token":"fixture"}\n', { mode: 0o600 });
    await (await import('node:fs/promises')).symlink(outside, link, 'dir');
    const service = new CommandCodeService({
      config: {
        enabled: true,
        browserEnabled: true,
        browserAllowedModels: ['qwen/qwen3.8-max'],
        browserAllowedCwdRoots: [allowedRoot],
        browserAuthFile,
        browserRuntimeRoots: [allowedRoot],
        executablePath: '/opt/bin/cmd',
        stateDir,
        expectedVersion: '1.19.0',
      } as any,
      runner: Object.assign(new FakeRunner(), { browserSandboxReady: () => true }),
      discover: async () => discovery,
      checkExecutable: false,
    });
    await service.init();
    await expect(service.createSession({ cwd: link, model: 'qwen/qwen3.8-max', permissionProfile: 'browser-contained' })).rejects.toThrow(/outside|root/i);
    await Promise.all([
      service.shutdown(),
      rm(stateDir, { recursive: true, force: true }),
      rm(allowedRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('does not expose browser sessions through shadow-only lookups', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const browserAuthFile = path.join(cwd, 'browser-auth.json');
    await writeFile(browserAuthFile, '{"token":"fixture"}\n', { mode: 0o600 });
    const service = new CommandCodeService({
      config: { enabled: false, shadowEnabled: true, browserEnabled: true, browserAllowedModels: ['qwen/qwen3.8-max'], browserAllowedCwdRoots: [cwd], browserAuthFile, browserRuntimeRoots: [cwd], executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' } as any,
      runner: Object.assign(new FakeRunner(), { browserSandboxReady: () => true }),
      discover: async () => discovery,
      checkExecutable: false,
    });
    await service.init();
    const shadow = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' });
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'browser-contained' });
    await expect(service.getShadowSession(created.sessionId)).resolves.toBeUndefined();
    await expect(service.getBrowserSession(created.sessionId)).resolves.toMatchObject({ sessionId: created.sessionId });
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-other-browser-root-'));
    service.config.browserAllowedCwdRoots = [otherRoot];
    await expect(service.getBrowserSession(created.sessionId)).resolves.toBeUndefined();
    service.config.browserAllowedCwdRoots = [cwd];
    await rm(otherRoot, { recursive: true, force: true });
    await expect(service.findShadowSession(created.sessionId)).resolves.toBeUndefined();
    await expect(service.listShadowSessions()).resolves.toEqual([expect.objectContaining({ sessionId: shadow.sessionId })]);
    await expect(service.listBrowserSessions()).resolves.toEqual([expect.objectContaining({ sessionId: created.sessionId, permissionProfile: 'browser-contained' })]);
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('does not expose a persisted browser session after the browser gate is disabled', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const browserAuthFile = path.join(cwd, 'browser-auth.json');
    await writeFile(browserAuthFile, '{"token":"fixture"}\n', { mode: 0o600 });
    const first = new CommandCodeService({
      config: {
        enabled: true,
        shadowEnabled: false,
        browserEnabled: true,
        browserAllowedModels: ['qwen/qwen3.8-max'],
        browserAllowedCwdRoots: [cwd],
        browserAuthFile,
        browserRuntimeRoots: [cwd],
        executablePath: '/opt/bin/cmd',
        stateDir,
        expectedVersion: '1.19.0',
      } as any,
      runner: Object.assign(new FakeRunner(), { browserSandboxReady: () => true }),
      discover: async () => discovery,
      checkExecutable: false,
    });
    await first.init();
    const created = await first.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'browser-contained' });

    const second = new CommandCodeService({
      config: { enabled: false, shadowEnabled: false, browserEnabled: false, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      checkExecutable: false,
    });
    await second.init();

    await expect(second.findSession(created.sessionId)).resolves.toBeUndefined();
    await expect(second.isSessionAccessible(created.sessionId)).resolves.toBe(false);

    await Promise.all([
      first.shutdown(),
      second.shutdown(),
      rm(stateDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  });

  it('does not expose a persisted session after capability evidence changes', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-capability-reload-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const first = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => discovery,
      checkExecutable: false,
    });
    await first.init();
    const created = await first.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'medium', permissionProfile: 'implementation-child-wide' });
    await first.shutdown();

    const drifted = {
      ...discovery,
      effortCapabilities: {
        ...discovery.effortCapabilities!,
        'qwen/qwen3.8-max': {
          ...discovery.effortCapabilities!['qwen/qwen3.8-max'],
          capabilityHash: 'd'.repeat(64),
        },
      },
    };
    const second = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, allowedCwdRoots: [cwd], expectedVersion: '1.19.0' },
      runner: new FakeRunner(),
      discover: async () => drifted,
      checkExecutable: false,
    });
    await second.init();
    await expect(second.getSession(created.sessionId)).resolves.toBeUndefined();
    await expect(second.listShadowSessions()).resolves.toEqual([]);
    await second.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('refuses native effort for a model with no adjustable effort capability', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd, model: 'meta/muse-spark-1.2-contributor', effort: 'low', permissionProfile: 'implementation-child-wide' })).rejects.toThrow(/effort|supported/i);
  });

  it('records provider-result effective effort without conflating it with the requested effort', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0, signal: null, stderrTail: '',
      parsed: {
        events: [],
        terminal: { type: 'result', subtype: 'success', sessionId: 'native-effort', effort: 'xhigh', finalText: 'ok' },
        unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 1,
      },
    });
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'medium', permissionProfile: 'implementation-child-wide' });
    await service.sendPrompt(session.sessionId, 'report effort', () => undefined);
    await expect(service.getSession(session.sessionId)).resolves.toMatchObject({
      effort: 'medium',
      effectiveEffort: 'xhigh',
      effortEvidenceMethod: 'provider-result',
    });
  });

  it('rejects a role-bound Command Code session outside the configured workspace roots', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const allowedRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-allowed-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'command-code-outside-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0', allowedCwdRoots: [allowedRoot] } as any, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd: outside, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'conductor-root' })).rejects.toThrow(/workspace|cwd|root/i);
  });

  it('rejects a role-bound Command Code session without an attestation', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'conductor-root' })).rejects.toThrow(/attestation|role/i);
  });

  it('accepts a valid server-bound Command Code role attestation', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    service.setRoleAttestationSecret('service-secret');
    const attestation = createCommandCodeRoleAttestation('service-secret', {
      role: 'conductor-root', model: 'qwen/qwen3.8-max', effort: 'medium', cwd, worktreeRoot: cwd,
      leaseId: 'lease-valid', issuedAt: new Date().toISOString(),
    });
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'conductor-root', roleAttestation: attestation });
    expect(created.cwd).toBe(cwd);
    const childAttestation = createCommandCodeRoleAttestation('service-secret', {
      role: 'implementation-child', model: 'meta/muse-spark-1.2-contributor', cwd, worktreeRoot: cwd,
      leaseId: 'lease-child', parentSessionId: created.sessionId, issuedAt: new Date().toISOString(),
    });
    const child = await service.createSession({ cwd, model: 'meta/muse-spark-1.2-contributor', permissionProfile: 'implementation-child-wide', invocationRole: 'implementation-child', roleAttestation: childAttestation });
    expect(child.invocationRole).toBe('implementation-child');
  });

  it('rejects a Command Code role/profile mismatch before creating a session', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'implementation-child' })).rejects.toThrow(/profile|role/i);
  });

  it('emits one synthetic terminal event when the runner fails before a terminal frame', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' });
    const events: string[] = [];
    await service.sendPrompt(session.sessionId, 'fail safely', (event) => events.push(event.type));
    const replay = await service.getReplayEvents(session.sessionId);
    expect(events.filter((type) => type === 'agent_end')).toHaveLength(1);
    expect(replay.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect((await service.getSession(session.sessionId))?.state).toBe('failed');
  });

  it('preserves terminal effort and usage when the runtime emits an early terminal marker', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-terminal-evidence-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0,
      signal: null,
      stderrTail: '',
      parsed: {
        events: [{ event: { type: 'agent_end', reason: 'turn-ended' }, lineNumber: 1 }],
        terminal: { type: 'result', subtype: 'success', sessionId: 'native-terminal-evidence', effort: 'xhigh', finalText: 'done', usage: { input: 2, output: 3, total: 5 } },
        unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 2,
      },
    });
    vi.spyOn(runner, 'run').mockImplementation(async (input) => {
      runner.inputs.push(input);
      const result = runner.results.shift()!;
      for (const event of result.parsed?.events ?? []) input.onEvent?.(event);
      return result;
    });
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' });
    const events: NormalizedEvent[] = [];
    await service.sendPrompt(session.sessionId, 'terminal evidence', (event) => events.push(event));
    const terminal = events.filter((event) => event.type === 'agent_end');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.data).toMatchObject({ effort: 'xhigh', effortEvidenceMethod: 'provider-result', tokenUsage: { input: 2, output: 3, total: 5 } });
    expect((await service.getSession(session.sessionId))?.effectiveEffort).toBe('xhigh');
    await service.shutdown();
    await Promise.all([rm(stateDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('revalidates the active workspace policy before spawning a turn', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const allowedRoot = await mkdtemp(path.join(os.tmpdir(), 'command-code-allowed-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'command-code-outside-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-policy', 'must-not-run'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0', allowedCwdRoots: [allowedRoot] } as any, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    // Create under an initially permitted root, then change the live policy.
    const session = await service.createSession({ cwd: allowedRoot, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    (service as any).config.allowedCwdRoots = [outside];
    let completionError: Error | undefined;
    await expect(service.sendPrompt(session.sessionId, 'must not spawn', () => undefined, (error) => { completionError = error; })).rejects.toMatchObject({ code: 'permission_denied' });
    expect(completionError).toBeUndefined();
    expect(runner.inputs).toHaveLength(0);
    await Promise.all([service.shutdown(), rm(stateDir, { recursive: true, force: true }), rm(allowedRoot, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  });

  it('revalidates the canonical cwd before spawning a turn', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-never', 'never'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    await rm(cwd, { recursive: true, force: true });
    let completionError: Error | undefined;
    await service.sendPrompt(session.sessionId, 'must not spawn', () => undefined, (error) => { completionError = error; });
    expect(completionError).toBeInstanceOf(Error);
    expect(completionError?.message).toMatch(/no such file|cwd|ENOENT/i);
    expect(runner.inputs).toHaveLength(0);
    expect((await service.getSession(session.sessionId))?.state).toBe('failed');
  });

  it('rejects a tampered persisted session id before native-home preparation', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const nativeHomeDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-native-home-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const sessionsDir = path.join(stateDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(path.join(sessionsDir, 'bad.json'), JSON.stringify({
      schemaVersion: 1, sessionId: '../escaped', runtime: 'commandcode', cwd: path.resolve(cwd), modelSelector: 'qwen/qwen3.8-max',
      executionInstanceId: 'commandcode-default', permissionProfile: 'implementation-child-wide', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      eventJournalRef: 'events/bad.jsonl', state: 'idle', messageCount: 0, firstMessage: '',
    }));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, nativeHomeDir, expectedVersion: '1.19.0' }, discover: async () => discovery, checkExecutable: false });
    await service.init();
    expect(await service.listSessions()).toEqual([]);
    expect(await service.getSession('../escaped')).toBeUndefined();
    await Promise.all([service.shutdown(), rm(stateDir, { recursive: true, force: true }), rm(nativeHomeDir, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]);
  });

  it('abort fences a pending turn before the process runner can spawn', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-never', 'never'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    let releaseAppend!: () => void;
    const appendBlocked = new Promise<void>((resolve) => { releaseAppend = resolve; });
    vi.spyOn(service.journal, 'append').mockImplementation(async () => { await appendBlocked; });
    const send = service.sendPrompt(session.sessionId, 'must not spawn', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    await service.abort(session.sessionId);
    releaseAppend();
    await send;
    expect(runner.inputs).toHaveLength(0);
    expect((await service.getSession(session.sessionId))?.state).toBe('aborted');
  });

  it('waits for an in-flight turn before clearing a deleted session journal', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-never', 'never'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    let releaseAppend!: () => void;
    const appendBlocked = new Promise<void>((resolve) => { releaseAppend = resolve; });
    vi.spyOn(service.journal, 'append').mockImplementation(async () => { await appendBlocked; });
    const send = service.sendPrompt(session.sessionId, 'delete safely', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    let deleted = false;
    const deletion = service.deleteSession(session.sessionId).then((value) => { deleted = value; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deleted).toBe(false);
    releaseAppend();
    await Promise.all([send, deletion]);
    expect(deleted).toBe(true);
    expect(await service.getSession(session.sessionId)).toBeUndefined();
    expect(await service.journal.read(session.sessionId)).toEqual([]);
  });

  it('abort after the runner closes still terminalises the in-flight turn as interrupted', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-close', 'finished'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    let enteredIdle!: () => void;
    let releaseIdle!: () => void;
    const idleEntered = new Promise<void>((resolve) => { enteredIdle = resolve; });
    const idleRelease = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const originalUpdate = service.store.update.bind(service.store);
    vi.spyOn(service.store, 'update').mockImplementation(async (id, patch) => {
      if (patch.state === 'idle') {
        enteredIdle();
        await idleRelease;
      }
      return originalUpdate(id, patch);
    });
    let completionError: Error | undefined;
    const send = service.sendPrompt(session.sessionId, 'finish then abort', () => undefined, (error) => { completionError = error; });
    await idleEntered;
    await service.abort(session.sessionId);
    releaseIdle();
    await send;
    expect(completionError?.message).toMatch(/aborted|interrupted/i);
    expect((await service.getSession(session.sessionId))?.state).toBe('aborted');
  });

  it('shutdown fences a new prompt and waits for no post-shutdown spawn', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    await service.shutdown();
    await expect(service.sendPrompt(session.sessionId, 'must not spawn', () => undefined)).rejects.toThrow(/shutting down|stopping/i);
    expect(runner.inputs).toHaveLength(0);
  });

  it('waits for an in-flight turn even when runner shutdown reports an error', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    let releaseRun!: () => void;
    const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
    vi.spyOn(runner, 'run').mockImplementation(async (input) => {
      runner.inputs.push(input);
      await runRelease;
      return success('native-shutdown', 'finished');
    });
    runner.shutdownError = new Error('runner shutdown failed');
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    const send = service.sendPrompt(session.sessionId, 'shutdown waits', () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    let settled = false;
    const shutdown = service.shutdown().catch((error) => { settled = true; throw error; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseRun();
    await expect(shutdown).rejects.toThrow('runner shutdown failed');
    await send;
  });

  it('classifies a parser failure as protocol error even when process termination was timed out', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push({ exitCode: null, signal: 'SIGTERM', stderrTail: '', terminationCause: 'timeout', protocolError: 'NDJSON output exceeded the configured limit' });
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly' });
    let completionError: Error | undefined;
    await service.sendPrompt(session.sessionId, 'malformed', () => undefined, (error) => { completionError = error; });
    expect(completionError).toMatchObject({ code: 'protocol_error' });
  });

  it('does not claim success for max-turns or malformed/incomplete output', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push({
      exitCode: 0, signal: null, stderrTail: '',
      parsed: { events: [], terminal: { type: 'result', subtype: 'max_turns' }, unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 1 },
    });
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.19.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'meta/muse-spark-1.2-contributor', permissionProfile: 'implementation-child-wide' });
    let completionError: Error | undefined;
    await service.sendPrompt(session.sessionId, 'bounded', () => undefined, (error) => { completionError = error; });
    expect(completionError?.message).toMatch(/max turns/i);
    expect((await service.getSession(session.sessionId))?.state).toBe('failed');
  });
});
