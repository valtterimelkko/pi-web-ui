/**
 * Contract 1.47.0 — C1: session identity in runtime subprocess environments.
 * The three variable names are a cross-repo contract (Agent OS reads them).
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  PI_WEB_UI_SESSION_ID_ENV,
  PI_WEB_UI_SESSION_ORIGIN_ENV,
  PI_WEB_UI_PARENT_SESSION_ID_ENV,
  applySessionIdentityEnv,
  sessionIdentityFromEntry,
} from '../../src/session-env-identity.js';
import { CommandCodeProcessRunner } from '../../src/command-code/command-code-process-runner.js';
import { AgyStreamProcess } from '../../src/antigravity/agy-stream-process.js';

describe('session identity env helper', () => {
  afterEach(() => {
    delete process.env.PI_WEB_UI_PARENT_SESSION_ID;
  });

  it('uses the frozen cross-repo variable names', () => {
    expect(PI_WEB_UI_SESSION_ID_ENV).toBe('PI_WEB_UI_SESSION_ID');
    expect(PI_WEB_UI_SESSION_ORIGIN_ENV).toBe('PI_WEB_UI_SESSION_ORIGIN');
    expect(PI_WEB_UI_PARENT_SESSION_ID_ENV).toBe('PI_WEB_UI_PARENT_SESSION_ID');
  });

  it('adds id, origin and parent without mutating the base env', () => {
    const base = { PATH: '/bin', KEEP: '1' };
    const env = applySessionIdentityEnv(base, { sessionId: 'child-1', origin: 'internal-api', parentSessionId: 'parent-9' });
    expect(env).toEqual({
      PATH: '/bin', KEEP: '1',
      PI_WEB_UI_SESSION_ID: 'child-1',
      PI_WEB_UI_SESSION_ORIGIN: 'internal-api',
      PI_WEB_UI_PARENT_SESSION_ID: 'parent-9',
    });
    expect(base).toEqual({ PATH: '/bin', KEEP: '1' });
  });

  it('never leaks an inherited identity: stale parent/origin are removed when the session has none', () => {
    const base = {
      PATH: '/bin',
      PI_WEB_UI_SESSION_ID: 'server-inherited',
      PI_WEB_UI_SESSION_ORIGIN: 'browser',
      PI_WEB_UI_PARENT_SESSION_ID: 'someone-else',
    };
    const env = applySessionIdentityEnv(base, { sessionId: 'browser-2' });
    expect(env.PI_WEB_UI_SESSION_ID).toBe('browser-2');
    expect('PI_WEB_UI_SESSION_ORIGIN' in env).toBe(false);
    expect('PI_WEB_UI_PARENT_SESSION_ID' in env).toBe(false);
  });

  it('ignores an unknown origin value and returns the env unchanged without an identity', () => {
    const env = applySessionIdentityEnv({}, { sessionId: 's', origin: 'weird' as never });
    expect(env).toEqual({ PI_WEB_UI_SESSION_ID: 's' });
    const base = { A: '1' };
    expect(applySessionIdentityEnv(base, undefined)).toBe(base);
  });

  it('projects a registry entry', () => {
    expect(sessionIdentityFromEntry({ id: 'x', origin: 'native-discovered', parentSessionId: 'p' }))
      .toEqual({ sessionId: 'x', origin: 'native-discovered', parentSessionId: 'p' });
    expect(sessionIdentityFromEntry(undefined)).toBeUndefined();
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

describe('Command Code runner passes the session identity env', () => {
  it('adds the identity to the controlled environment', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const runner = new CommandCodeProcessRunner({ executablePath: '/opt/bin/cmd', spawn, maxWallTimeMs: 1000 });
    const resultPromise = runner.run({
      sessionId: 'cc-1', cwd: '/tmp/w', model: 'qwen/qwen3.8-max', maxTurns: 1, prompt: 'ok',
      sessionIdentity: { sessionId: 'cc-1', origin: 'internal-api', parentSessionId: 'parent-1' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write('{"type":"result","subtype":"success","sessionId":"native-1","finalText":"ok"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0, null);
    await resultPromise;
    const env = (spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    expect(env).toMatchObject({
      PI_WEB_UI_SESSION_ID: 'cc-1',
      PI_WEB_UI_SESSION_ORIGIN: 'internal-api',
      PI_WEB_UI_PARENT_SESSION_ID: 'parent-1',
    });
  });
});

describe('Antigravity stream process passes the session identity env', () => {
  it('adds the identity to the spawned agy environment', async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const proc = new AgyStreamProcess({
      sessionId: 'agy-1', cwd: '/tmp/agy', model: 'gemini-3.6-flash-low', conversationId: null,
      timeoutMs: 60_000, stallTimeoutMs: 30_000, idleTimeoutMs: 60_000,
      onEvent: () => undefined,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      sessionIdentity: { sessionId: 'agy-1', origin: 'browser' },
    });
    await proc.start();
    const env = (spawnFn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }])[2].env;
    expect(env.PI_WEB_UI_SESSION_ID).toBe('agy-1');
    expect(env.PI_WEB_UI_SESSION_ORIGIN).toBe('browser');
    expect(env.PI_WEB_UI_PARENT_SESSION_ID).toBeUndefined();
    expect(env.PATH).toContain('/root/.local/bin');
    proc.stop();
  });
});

describe('Command Code service resolves the identity from the registry projection', () => {
  it('passes id, origin and parent to the runner', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { CommandCodeService } = await import('../../src/command-code/command-code-service.js');
    const inputs: Array<Record<string, unknown>> = [];
    const runner = {
      async run(input: Record<string, unknown>) {
        inputs.push(input);
        return {
          exitCode: 0, signal: null, stderrTail: '',
          parsed: {
            events: [], terminal: { type: 'result', subtype: 'success', sessionId: 'native-x', finalText: 'ok', usage: { input: 1, output: 1, total: 2 } },
            unknownEventTypes: [], suppressedDuplicateCount: 0, bytes: 1, lineCount: 1,
          },
        };
      },
      async abort() {}, async shutdown() {}, isRunning() { return false; },
    };
    const entries = new Map<string, Record<string, unknown>>();
    const registry = {
      delete: vi.fn(async () => undefined),
      listBySdkType: vi.fn(async () => []),
      upsert: vi.fn(async (e: Record<string, unknown>) => { entries.set(e.id as string, { ...(entries.get(e.id as string) ?? {}), ...e }); }),
      get: vi.fn(async (id: string) => entries.get(id)),
    };
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-identity-'));
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'cc-identity-cwd-'));
    const service = new CommandCodeService({
      config: { enabled: true, executablePath: '/opt/bin/cmd', stateDir: root, allowedCwdRoots: [cwd] },
      runner: runner as never,
      discover: async () => ({ version: '1.23.2', models: ['qwen/qwen3.8-max'], ambiguous: [] }),
      checkExecutable: false,
      sessionRegistry: registry as never,
    });
    await service.init();
    const created = await service.createSession({ cwd, model: 'qwen/qwen3.8-max' });
    entries.set(created.sessionId, { ...(entries.get(created.sessionId) ?? {}), id: created.sessionId, origin: 'internal-api', parentSessionId: 'parent-cc' });
    await service.sendPrompt(created.sessionId, 'hello', () => undefined);
    expect(inputs[0].sessionIdentity).toEqual({ sessionId: created.sessionId, origin: 'internal-api', parentSessionId: 'parent-cc' });
  });
});
