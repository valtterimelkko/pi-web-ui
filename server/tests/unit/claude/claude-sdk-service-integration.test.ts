import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use vi.hoisted so the mock function exists before vi.mock runs
const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeSdkService } from '../../../src/claude/claude-sdk-service.js';

function makeAsyncGenerator(messages: any[]) {
  return async function* () {
    for (const msg of messages) {
      yield msg;
    }
  };
}

describe('ClaudeSdkService integration with mocked SDK', () => {
  let tmpDir: string;
  let svc: ClaudeSdkService;
  let profilesPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-sdk-integ-'));
    profilesPath = join(tmpDir, 'profiles.json');

    process.env.TEST_GLM_TOKEN = 'test-token-value';
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [{
        id: 'test-sdk-profile',
        label: 'Test SDK',
        backend: 'sdk-subscription',
        launcherType: 'native-env',
        model: 'sonnet',
        settingSources: ['user', 'project'],
        skills: 'all',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Write', 'Bash'],
        maxConcurrent: 2,
        enabled: true,
      }, {
        id: 'test-glm-profile',
        label: 'GLM 5.2',
        backend: 'sdk-subscription',
        launcherType: 'native-env',
        baseUrl: 'https://api.z.ai/api/anthropic',
        authTokenEnv: 'TEST_GLM_TOKEN',
        model: 'sonnet',
        modelAliases: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6' },
        settingSources: ['user', 'project'],
        skills: 'all',
        permissionMode: 'dontAsk',
        allowedTools: ['Read'],
        maxConcurrent: 2,
        enabled: true,
      }],
      defaultProfileId: 'test-sdk-profile',
    }));

    svc = new ClaudeSdkService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      profilesPath,
    });

    mockQuery.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates session and persists events from mocked SDK messages', async () => {
    const { sessionId, claudeSessionId } = await svc.createSession(
      join(tmpDir, 'cwd'), 'sonnet', undefined, 'test-sdk-profile',
    );

    // Mock SDK to emit init, assistant text, tool_use, tool_result, result
    mockQuery.mockReturnValue(makeAsyncGenerator([
      { type: 'system', subtype: 'init', model: 'glm-5.2[1m]', session_id: claudeSessionId, tools: ['Read', 'Write'], apiKeySource: 'none' },
      { type: 'assistant', message: { id: 'msg1', model: 'glm-5.2', content: [{ type: 'text', text: 'Creating file.' }] }, session_id: claudeSessionId },
      { type: 'assistant', message: { id: 'msg1', content: [{ type: 'tool_use', id: 'tool1', name: 'Write', input: { file_path: 'test.txt' } }] }, session_id: claudeSessionId },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'Written', is_error: false }] }, session_id: claudeSessionId },
      { type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, session_id: claudeSessionId },
    ])());

    const events: any[] = [];
    let completionError: Error | undefined;

    await new Promise<void>((resolve) => {
      svc.sendPrompt(
        sessionId,
        'Create test.txt',
        (event) => events.push(event),
        (error) => { completionError = error; resolve(); },
      ).catch(() => resolve());
    });

    // Verify events were produced
    expect(events.some((e) => e.type === 'session_init')).toBe(true);
    expect(events.some((e) => e.type === 'tool_execution_start')).toBe(true);
    expect(events.some((e) => e.type === 'tool_execution_end')).toBe(true);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect(completionError).toBeUndefined();

    // Verify events were persisted to the session store
    const sessionFile = join(tmpDir, 'sessions', `${sessionId}.jsonl`);
    const persisted = readFileSync(sessionFile, 'utf-8');
    const lines = persisted.split('\n').filter((l) => l.trim());
    const persistedTypes = lines.map((l) => JSON.parse(l).type);
    expect(persistedTypes).toContain('user');
    expect(persistedTypes).toContain('assistant');
    expect(persistedTypes).toContain('tool');
    expect(persistedTypes).toContain('tool_result');

    // Verify model identity in session_init
    const initEvent = events.find((e) => e.type === 'session_init');
    expect((initEvent?.data as any)?.model).toBe('glm-5.2[1m]');
    expect((initEvent?.data as any)?.apiKeySource).toBe('none');
  });

  it('surfaces SDK errors cleanly', async () => {
    const { sessionId } = await svc.createSession(
      join(tmpDir, 'cwd2'), 'sonnet', undefined, 'test-sdk-profile',
    );

    // Mock SDK to throw
    mockQuery.mockImplementation(() => {
      // eslint-disable-next-line require-yield -- intentional: mock generator throws before yielding
      return (async function* () {
        throw new Error('SDK connection failed');
      })();
    });

    let completionError: Error | undefined;
    const events: any[] = [];

    await new Promise<void>((resolve) => {
      svc.sendPrompt(
        sessionId,
        'test',
        (event) => events.push(event),
        (error) => { completionError = error; resolve(); },
      ).catch(() => resolve());
    });

    expect(completionError).toBeDefined();
    expect(completionError?.message).toContain('SDK connection failed');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('surfaces auth-expiry as a CLAUDE_AUTH_EXPIRED reauth error', async () => {
    const { sessionId } = await svc.createSession(
      join(tmpDir, 'cwd-auth'), 'sonnet', undefined, 'test-sdk-profile',
    );

    // Mock SDK to throw the real Anthropic wire-format 401 body.
    mockQuery.mockImplementation(() => {
      // eslint-disable-next-line require-yield -- intentional: throws before yielding
      return (async function* () {
        throw new Error('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
      })();
    });

    let completionError: (Error & { code?: string; sessionEventAlreadyEmitted?: boolean }) | undefined;
    const events: any[] = [];

    await new Promise<void>((resolve) => {
      svc.sendPrompt(
        sessionId,
        'test',
        (event) => events.push(event),
        (error) => { completionError = error as typeof completionError; resolve(); },
      ).catch(() => resolve());
    });

    // The completion error carries the auth code and the already-emitted flag so
    // connection.ts does not double-surface it.
    expect(completionError?.code).toBe('CLAUDE_AUTH_EXPIRED');
    expect(completionError?.sessionEventAlreadyEmitted).toBe(true);

    // A single error event with the reauth code + flag and a closing agent_end.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as any)?.code).toBe('CLAUDE_AUTH_EXPIRED');
    expect((errorEvent?.data as any)?.reauthRequired).toBe(true);
    // Native profile (no baseUrl/token) → native remediation, not "Claude Direct".
    expect((errorEvent?.data as any)?.message).toMatch(/claude auth login/i);
    expect((errorEvent?.data as any)?.message).not.toMatch(/Claude Direct/i);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);

    // Persisted error entry retains the code + reauthRequired for replay.
    const sessionFile = join(tmpDir, 'sessions', `${sessionId}.jsonl`);
    const lines = readFileSync(sessionFile, 'utf-8').split('\n').filter((l) => l.trim());
    const errorEntry = lines.map((l) => JSON.parse(l)).find((e) => e.type === 'error');
    expect(errorEntry?.code).toBe('CLAUDE_AUTH_EXPIRED');
    expect(errorEntry?.reauthRequired).toBe(true);
  });

  it('uses a token-refresh remediation message for token-backed (Z.ai) profiles', async () => {
    const { sessionId } = await svc.createSession(
      join(tmpDir, 'cwd-glm-auth'), 'sonnet', undefined, 'test-glm-profile',
    );

    mockQuery.mockImplementation(() => {
      // eslint-disable-next-line require-yield -- intentional: throws before yielding
      return (async function* () {
        throw new Error('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid token"}}');
      })();
    });

    const events: any[] = [];
    await new Promise<void>((resolve) => {
      svc.sendPrompt(sessionId, 'test', (e) => events.push(e), () => resolve()).catch(() => resolve());
    });

    const errorEvent = events.find((e) => e.type === 'error');
    const message = (errorEvent?.data as any)?.message as string;
    expect((errorEvent?.data as any)?.code).toBe('CLAUDE_AUTH_EXPIRED');
    expect(message).toMatch(/Z\.ai/);
    expect(message).toMatch(/GLM 5\.2/);
    expect(message).toMatch(/TEST_GLM_TOKEN/);
    expect(message).toMatch(/refresh/i);
    expect(message).not.toMatch(/claude auth login/i);
  });

  it('enforces maxConcurrent limit', async () => {
    const { sessionId: sid1 } = await svc.createSession(
      join(tmpDir, 'cwd3a'), 'sonnet', undefined, 'test-sdk-profile',
    );
    const { sessionId: sid2 } = await svc.createSession(
      join(tmpDir, 'cwd3b'), 'sonnet', undefined, 'test-sdk-profile',
    );
    const { sessionId: sid3 } = await svc.createSession(
      join(tmpDir, 'cwd3c'), 'sonnet', undefined, 'test-sdk-profile',
    );

    // Mock SDK that never resolves (simulates long-running session)
    let resolveFirst: () => void;
    const firstDone = new Promise<void>((r) => { resolveFirst = r; });

    mockQuery.mockImplementation(() => {
      return (async function* () {
        yield { type: 'system', subtype: 'init', model: 'glm-5.2', session_id: 'x', apiKeySource: 'none' };
        // Never yield result — stays "active"
        await firstDone;
      })();
    });

    // Start two prompts (maxConcurrent = 2)
    const p1 = svc.sendPrompt(sid1, 'test', () => {}, () => {}).catch(() => {});
    const p2 = svc.sendPrompt(sid2, 'test', () => {}, () => {}).catch(() => {});

    // Give them time to increment the counter
    await new Promise((r) => setTimeout(r, 50));

    // Third prompt should be rejected
    await expect(
      svc.sendPrompt(sid3, 'test', () => {}, () => {}),
    ).rejects.toThrow(/maxConcurrent limit/);

    // Release the first two
    resolveFirst!();
    await Promise.all([p1, p2]);
  });
});
