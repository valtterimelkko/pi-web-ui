/**
 * Contract 1.47.0 — C1: Claude SDK and cli-direct subprocesses receive the
 * Pi Web UI session identity (PI_WEB_UI_SESSION_ID / _ORIGIN / _PARENT_SESSION_ID).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new EventEmitter() as any;
      proc.pid = 12345;
      proc.stdout = Readable.from([
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'x', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n',
      ]);
      proc.stderr = new EventEmitter();
      proc.stdout.on('end', () => setTimeout(() => proc.emit('exit', 0, null), 5));
      return proc;
    }),
    execSync: vi.fn((cmd: string) => (cmd.startsWith('which') ? '/usr/local/bin/claude\n' : '')),
  };
});

const { spawn } = await import('node:child_process');
import { ClaudeSdkService } from '../../../src/claude/claude-sdk-service.js';
import { ClaudeProcessPool } from '../../../src/claude/claude-process-pool.js';
import { getSessionRegistry } from '../../../src/session-registry.js';

function gen(messages: unknown[]) {
  return (async function* () { for (const m of messages) yield m; })();
}

describe('Claude SDK backend — session identity env', () => {
  let tmpDir: string;
  let svc: ClaudeSdkService;
  let registryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-sdk-identity-'));
    registryPath = join(tmpDir, 'registry.json');
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [{
        id: 'p-sdk', label: 'SDK', backend: 'sdk-subscription', launcherType: 'native-env', model: 'sonnet',
        settingSources: ['user'], skills: 'all', permissionMode: 'dontAsk', allowedTools: ['Bash'], maxConcurrent: 2, enabled: true,
      }],
      defaultProfileId: 'p-sdk',
    }));
    svc = new ClaudeSdkService({ claudeSessionDir: join(tmpDir, 'sessions'), registryPath, profilesPath });
    mockQuery.mockReset();
    mockQuery.mockImplementation(() => gen([
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'c' },
    ]));
    process.env.PI_WEB_UI_PARENT_SESSION_ID = 'inherited-from-server-env';
  });

  afterEach(() => {
    delete process.env.PI_WEB_UI_PARENT_SESSION_ID;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function send(sessionId: string): Promise<void> {
    await new Promise<void>((resolve) => {
      svc.sendPrompt(sessionId, 'hi', () => undefined, () => resolve()).catch(() => resolve());
    });
  }

  it('profile path: injects id, origin and parent from the registry', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'sonnet', undefined, 'p-sdk');
    const registry = getSessionRegistry(registryPath);
    await registry.upsert({ id: sessionId, sdkType: 'claude', cwd: join(tmpDir, 'cwd'), origin: 'internal-api' });
    await registry.patchSessionMeta(sessionId, { parentSessionId: 'parent-abc' });
    await send(sessionId);
    const env = mockQuery.mock.calls[0][0].options.env as Record<string, string>;
    expect(env.PI_WEB_UI_SESSION_ID).toBe(sessionId);
    expect(env.PI_WEB_UI_SESSION_ORIGIN).toBe('internal-api');
    expect(env.PI_WEB_UI_PARENT_SESSION_ID).toBe('parent-abc');
  });

  it('native (profile-less) path: injects id and origin, and drops an inherited parent', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd2'), 'sonnet');
    await getSessionRegistry(registryPath).upsert({ id: sessionId, sdkType: 'claude', cwd: join(tmpDir, 'cwd2'), origin: 'browser' });
    await send(sessionId);
    const env = mockQuery.mock.calls[0][0].options.env as Record<string, string | undefined>;
    expect(env.PI_WEB_UI_SESSION_ID).toBe(sessionId);
    expect(env.PI_WEB_UI_SESSION_ORIGIN).toBe('browser');
    expect(env.PI_WEB_UI_PARENT_SESSION_ID).toBeUndefined();
    // Existing behaviour preserved: API keys still stripped on the native path.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('Claude cli-direct pool — session identity env', () => {
  it('applies the identity to the spawned claude -p environment', async () => {
    vi.mocked(spawn).mockClear();
    const pool = new ClaudeProcessPool(10, 0, vi.fn().mockResolvedValue(false));
    await pool.spawn(
      {
        sessionId: 'direct-1',
        claudeSessionId: '00000000-0000-0000-0000-00000000000a',
        cwd: join(tmpdir(), 'claude-direct-identity'),
        model: 'sonnet',
        prompt: 'hello',
        sessionIdentity: { sessionId: 'direct-1', origin: 'browser', parentSessionId: 'p-1' },
      },
      () => undefined,
      () => undefined,
    );
    const options = vi.mocked(spawn).mock.calls[0][2] as { env: Record<string, string> };
    expect(options.env.PI_WEB_UI_SESSION_ID).toBe('direct-1');
    expect(options.env.PI_WEB_UI_SESSION_ORIGIN).toBe('browser');
    expect(options.env.PI_WEB_UI_PARENT_SESSION_ID).toBe('p-1');
  });
});
