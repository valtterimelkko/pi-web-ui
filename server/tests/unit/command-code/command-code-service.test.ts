import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CommandCodeModelDiscovery } from '../../../src/command-code/command-code-model-catalog.js';
import type { CommandCodeProcessRunInput, CommandCodeProcessRunResult } from '../../../src/command-code/command-code-process-runner.js';
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
  version: '1.15.0',
  models: ['qwen/qwen3.8-max', 'meta/muse-spark-1.2-contributor'],
  ambiguous: [],
  effortCapabilities: {
    'qwen/qwen3.8-max': {
      supportsEffort: true,
      effortLevels: ['low', 'medium', 'xhigh'],
      defaultEffort: 'medium',
      source: 'live-preflight',
      capabilityHash: 'a'.repeat(64),
    },
    'meta/muse-spark-1.2-contributor': {
      supportsEffort: false,
      effortLevels: [],
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
  it('copies operator auth into each private native home without a shared auth symlink', async () => {
    const operatorHome = await mkdtemp(path.join(os.tmpdir(), 'command-code-operator-home-'));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const nativeHomeDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-native-home-'));
    await mkdir(path.join(operatorHome, '.commandcode'), { recursive: true });
    await writeFile(path.join(operatorHome, '.commandcode', 'auth.json'), '{"apiKey":"fixture-secret"}\n', { mode: 0o600 });
    const previousHome = process.env.HOME;
    process.env.HOME = operatorHome;
    try {
      const service = new CommandCodeService({
        config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, nativeHomeDir, allowedCwdRoots: [cwd], expectedVersion: '1.15.0' },
        discover: async () => discovery,
        checkExecutable: false,
      });
      await service.init();
      const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', effort: 'low', permissionProfile: 'implementation-child-wide' });
      const authPath = path.join(nativeHomeDir, created.sessionId, '.commandcode', 'auth.json');
      const metadata = await lstat(authPath);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o600);
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
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' },
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
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

  it('refuses native effort for a model with no adjustable effort capability', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0', allowedCwdRoots: [allowedRoot] } as any, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd: outside, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'conductor-root' })).rejects.toThrow(/workspace|cwd|root/i);
  });

  it('rejects a role-bound Command Code session without an attestation', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'conductor-root' })).rejects.toThrow(/attestation|role/i);
  });

  it('accepts a valid server-bound Command Code role attestation', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner: new FakeRunner(), discover: async () => discovery, checkExecutable: false });
    await service.init();
    await expect(service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'agent-os-7f-root-readonly', invocationRole: 'implementation-child' })).rejects.toThrow(/profile|role/i);
  });

  it('emits one synthetic terminal event when the runner fails before a terminal frame', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'qwen/qwen3.8-max', permissionProfile: 'implementation-child-wide' });
    const events: string[] = [];
    await service.sendPrompt(session.sessionId, 'fail safely', (event) => events.push(event.type));
    const replay = await service.getReplayEvents(session.sessionId);
    expect(events.filter((type) => type === 'agent_end')).toHaveLength(1);
    expect(replay.filter((event) => event.type === 'agent_end')).toHaveLength(1);
    expect((await service.getSession(session.sessionId))?.state).toBe('failed');
  });

  it('revalidates the canonical cwd before spawning a turn', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-never', 'never'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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

  it('abort fences a pending turn before the process runner can spawn', async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'command-code-service-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'command-code-cwd-'));
    const runner = new FakeRunner();
    runner.results.push(success('native-never', 'never'));
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
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
    const service = new CommandCodeService({ config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir, expectedVersion: '1.15.0' }, runner, discover: async () => discovery, checkExecutable: false });
    await service.init();
    const session = await service.createSession({ cwd, model: 'meta/muse-spark-1.2-contributor', permissionProfile: 'implementation-child-wide' });
    let completionError: Error | undefined;
    await service.sendPrompt(session.sessionId, 'bounded', () => undefined, (error) => { completionError = error; });
    expect(completionError?.message).toMatch(/max turns/i);
    expect((await service.getSession(session.sessionId))?.state).toBe('failed');
  });
});
