import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { ClaudeSdkService } from '../../../src/claude/claude-sdk-service.js';

function gen(messages: any[]) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

const SUCCESS_MESSAGES = (sid: string) => [
  { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: sid, tools: ['Read'], apiKeySource: 'none' },
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'OK' }] }, session_id: sid },
  { type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 100, output_tokens: 5 }, session_id: sid },
];

// The exact "Opus never answered" fingerprint: a result with no content and zero tokens.
const EMPTY_RESULT_MESSAGES = (sid: string) => [
  { type: 'result', subtype: 'error_during_execution', is_error: false, result: '', usage: { input_tokens: 0, output_tokens: 0 }, session_id: sid },
];

describe('ClaudeSdkService transient resilience', () => {
  let tmpDir: string;
  let svc: ClaudeSdkService;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-sdk-resil-'));
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [{
        id: 'opus-sub', label: 'Opus Sub', backend: 'sdk-subscription', launcherType: 'native-env',
        model: 'opus', settingSources: ['user', 'project'], skills: 'all', permissionMode: 'dontAsk',
        allowedTools: ['Read'], maxConcurrent: 2, enabled: true,
      }],
      defaultProfileId: 'opus-sub',
    }));
    svc = new ClaudeSdkService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      profilesPath,
    });
    mockQuery.mockReset();
    // Keep retries fast in tests.
    setEnv({ CLAUDE_TRANSIENT_BASE_DELAY_MS: '1', CLAUDE_TRANSIENT_MAX_DELAY_MS: '2' });
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(sessionId: string) {
    const events: any[] = [];
    let completionError: Error | undefined;
    await new Promise<void>((resolve) => {
      svc.sendPrompt(sessionId, 'review the repo', (e) => events.push(e), (err) => { completionError = err; resolve(); })
        .catch(() => resolve());
    });
    return { events, completionError };
  }

  it('surfaces an empty zero-token result as a real error (not silent success)', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '0' });
    const { sessionId, claudeSessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'opus', undefined, 'opus-sub');
    mockQuery.mockReturnValue(gen(EMPTY_RESULT_MESSAGES(claudeSessionId)));

    const { events, completionError } = await run(sessionId);

    expect(completionError).toBeDefined();
    expect(completionError?.message).toMatch(/empty response/i);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'agent_end')).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // The failure left a diagnostic trail in the session store.
    const persisted = readFileSync(join(tmpDir, 'sessions', `${sessionId}.jsonl`), 'utf-8');
    const types = persisted.split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    expect(types).toContain('error');
  });

  it('retries a transient throw and then succeeds', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const { sessionId, claudeSessionId } = await svc.createSession(join(tmpDir, 'cwd2'), 'opus', undefined, 'opus-sub');
    mockQuery
      .mockImplementationOnce(() => {
        // eslint-disable-next-line require-yield -- intentional: mock generator throws before yielding
        return (async function* () { throw new Error('API Error: 529 overloaded_error'); })();
      })
      .mockReturnValueOnce(gen(SUCCESS_MESSAGES(claudeSessionId)));

    const { events, completionError } = await run(sessionId);

    expect(completionError).toBeUndefined();
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('retries an empty zero-token result and then succeeds', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const { sessionId, claudeSessionId } = await svc.createSession(join(tmpDir, 'cwd3'), 'opus', undefined, 'opus-sub');
    mockQuery
      .mockReturnValueOnce(gen(EMPTY_RESULT_MESSAGES(claudeSessionId)))
      .mockReturnValueOnce(gen(SUCCESS_MESSAGES(claudeSessionId)));

    const { events, completionError } = await run(sessionId);

    expect(completionError).toBeUndefined();
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a permanent (non-transient) error', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd4'), 'opus', undefined, 'opus-sub');
    mockQuery.mockImplementation(() => {
      // eslint-disable-next-line require-yield -- intentional: mock generator throws before yielding
      return (async function* () { throw new Error('Invalid API key'); })();
    });

    const { events, completionError } = await run(sessionId);

    expect(completionError?.message).toMatch(/invalid api key/i);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries on a persistent transient failure and surfaces error', async () => {
    setEnv({ CLAUDE_TRANSIENT_MAX_RETRIES: '2' });
    const { sessionId, claudeSessionId } = await svc.createSession(join(tmpDir, 'cwd5'), 'opus', undefined, 'opus-sub');
    mockQuery.mockImplementation(() => gen(EMPTY_RESULT_MESSAGES(claudeSessionId)));

    const { events, completionError } = await run(sessionId);

    expect(completionError).toBeDefined();
    expect(events.some((e) => e.type === 'error')).toBe(true);
    // initial attempt + 2 retries
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});
