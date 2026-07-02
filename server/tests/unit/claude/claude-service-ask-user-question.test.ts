import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeService } from '../../../src/claude/claude-service.js';

function makeAsyncGenerator(messages: any[]) {
  return async function* () {
    for (const msg of messages) {
      yield msg;
    }
  };
}

const QUESTIONS = [
  {
    question: 'Pick one',
    header: 'Pick',
    multiSelect: false,
    options: [
      { label: 'A', description: 'a' },
      { label: 'B', description: 'b' },
    ],
  },
];

describe('ClaudeService AskUserQuestion delegation', () => {
  let tmpDir: string;
  let svc: ClaudeService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-svc-auq-'));
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [{
        id: 'sdk-profile',
        label: 'SDK',
        backend: 'sdk-subscription',
        launcherType: 'native-env',
        model: 'sonnet',
        settingSources: ['user', 'project'],
        skills: 'all',
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Write', 'Bash'],
        maxConcurrent: 2,
        enabled: true,
      }],
      defaultProfileId: 'sdk-profile',
    }));

    svc = new ClaudeService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      useChannel: false,
      useSdk: true,
      profilesPath,
    });

    mockQuery.mockReset();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Drive an SDK prompt to completion, capturing the SDK options (canUseTool). */
  async function captureCanUseTool(sessionId: string, events: any[]): Promise<any> {
    let captured: any;
    mockQuery.mockImplementation((arg: any) => {
      captured = arg.options;
      return makeAsyncGenerator([
        { type: 'system', subtype: 'init', model: 'glm-5.2', session_id: 'x', apiKeySource: 'none' },
        { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'ok' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: { input_tokens: 1, output_tokens: 1 } },
      ])();
    });
    await new Promise<void>((resolve) => {
      svc.sendPrompt(sessionId, 'q', (e) => events.push(e), () => resolve()).catch(() => resolve());
    });
    return captured.canUseTool;
  }

  it('delegates isPendingAskUserQuestion and respondToAskUserQuestion to the SDK service', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'sonnet', undefined, 'sdk-profile');
    const events: any[] = [];
    const canUseTool = await captureCanUseTool(sessionId, events);

    const pending = canUseTool('AskUserQuestion', { questions: QUESTIONS }, {
      toolUseID: 'toolu_x',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');

    // Delegated pending check.
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(true);

    // Delegated response returns the SDK service's success boolean.
    const ok = svc.respondToAskUserQuestion(req.data.requestId, {
      answers: { 'Pick one': 'B' },
    });
    expect(ok).toBe(true);

    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toEqual({ 'Pick one': 'B' });

    // No longer pending after resolution.
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(false);
  });

  it('returns false for an unknown requestId', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd2'), 'sonnet', undefined, 'sdk-profile');
    expect(svc.isPendingAskUserQuestion('does-not-exist')).toBe(false);
    expect(svc.respondToAskUserQuestion('does-not-exist', { cancelled: true })).toBe(false);
  });

  it('returns false when the SDK backend is not enabled', async () => {
    const noSdk = new ClaudeService({
      claudeSessionDir: join(tmpDir, 'sessions-nosdk'),
      registryPath: join(tmpDir, 'registry-nosdk.json'),
      useChannel: false,
      useSdk: false,
    });
    expect(noSdk.isPendingAskUserQuestion('any')).toBe(false);
    expect(noSdk.respondToAskUserQuestion('any', { cancelled: true })).toBe(false);
  });

  it('still routes channel permission responses via sendPermissionResponse (unchanged)', async () => {
    // sendPermissionResponse must remain a separate, untouched path. It should
    // not throw even with no channel service present.
    expect(() => svc.sendPermissionResponse('sid', 'req-1', true)).not.toThrow();
  });
});
