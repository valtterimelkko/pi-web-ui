import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeProcessPool } from '../../../src/claude/claude-process-pool.js';
import type { ResolvedClaudeLaunch } from '../../../src/claude/claude-profiles.js';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

// Helper: create a fake child process with a proper Readable stdout
function createFakeProc(lines: string[]) {
  const proc = new EventEmitter() as any;
  proc.pid = 12345;
  proc.stdout = Readable.from(lines.map((l) => l + '\n'));
  proc.stderr = new EventEmitter();
  // Simulate process exit after stdout is consumed
  proc.stdout.on('end', () => {
    setTimeout(() => proc.emit('exit', 0, null), 5);
  });
  return proc;
}

// Mock spawn
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      return createFakeProc([
        JSON.stringify({ type: 'system', subtype: 'init', model: 'glm-5.2[1m]', session_id: 'test-uuid', tools: ['Bash', 'Read'], cwd: '/tmp/test', permissionMode: 'dontAsk', apiKeySource: 'none' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'test-uuid', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }),
      ]);
    }),
    execSync: vi.fn((cmd: string) => {
      if (cmd.startsWith('which')) return '/usr/local/bin/claude\n';
      return '';
    }),
  };
});

// Import after mock
const { spawn } = await import('node:child_process');

describe('ClaudeProcessPool profile-aware spawning', () => {
  let pool: ClaudeProcessPool;

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    pool = new ClaudeProcessPool(10, 0, vi.fn().mockResolvedValue(false));
  });

  it('uses profile env when resolvedLaunch is provided', async () => {
    const resolvedLaunch: ResolvedClaudeLaunch = {
      executable: 'claude',
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
      },
      model: 'sonnet',
      modelMode: 'claude-alias',
      backend: 'cli-direct',
      sdkOptions: {
        settingSources: ['user', 'project'],
        skills: 'all',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Write', 'Skill'],
      },
      cliArgsBase: ['--model', 'sonnet'],
      providerId: 'zai',
    };

    await pool.spawn(
      {
        sessionId: 'test-sess',
        claudeSessionId: '00000000-0000-0000-0000-000000000001',
        cwd: '/tmp/test-profile-spawn',
        model: 'sonnet',
        prompt: 'hello',
        resolvedLaunch,
      },
      () => {},
      () => {},
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    const [executable, args, options] = call;

    // Should use the resolved absolute path
    expect(executable).toContain('claude');
    // Env should have the GLM settings
    expect(options.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe('test-token');
    expect(options.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.2[1m]');
    // API key should NOT be present
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Should use allowedTools from profile
    expect(args).toContain('--allowedTools');
    const toolsIdx = args.indexOf('--allowedTools');
    expect(args[toolsIdx + 1]).toBe('Read,Write,Skill');
  });

  it('strips API keys when no resolvedLaunch (legacy behavior)', async () => {
    process.env.ANTHROPIC_API_KEY = 'should-be-stripped';
    process.env.ANTHROPIC_AUTH_TOKEN = 'should-be-stripped';

    await pool.spawn(
      {
        sessionId: 'test-sess-2',
        claudeSessionId: '00000000-0000-0000-0000-000000000002',
        cwd: '/tmp/test-legacy-spawn',
        model: 'sonnet',
        prompt: 'hello',
      },
      () => {},
      () => {},
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    const call = vi.mocked(spawn).mock.calls[0];
    const [, , options] = call;

    // Legacy behavior: strip both keys
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it('uses model from resolvedLaunch when provided', async () => {
    const resolvedLaunch: ResolvedClaudeLaunch = {
      executable: 'claude',
      env: { ...process.env },
      model: 'opus',
      modelMode: 'claude-alias',
      backend: 'cli-direct',
      sdkOptions: {
        settingSources: ['user', 'project'],
        skills: 'all',
        permissionMode: 'dontAsk',
        allowedTools: ['Read'],
      },
      cliArgsBase: [],
      providerId: 'anthropic',
    };

    await pool.spawn(
      {
        sessionId: 'test-sess-3',
        claudeSessionId: '00000000-0000-0000-0000-000000000003',
        cwd: '/tmp/test-model-spawn',
        model: 'sonnet', // pool options model
        prompt: 'hello',
        resolvedLaunch,
      },
      () => {},
      () => {},
    );

    const call = vi.mocked(spawn).mock.calls[0];
    const args = call[1] as string[];
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('opus'); // from resolvedLaunch, not options.model
  });
});
