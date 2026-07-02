import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Focused tests for the Claude SDK `AskUserQuestion` bridge.
 *
 * Strategy mirrors claude-sdk-service-integration.test.ts: mock the SDK
 * `query()` to capture the `options` (incl. `canUseTool`), drive `sendPrompt`
 * to completion, then invoke the captured `canUseTool` directly to exercise the
 * ask-user-question flow (emit request → await response → return answers).
 */

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

/** A minimal SDK message sequence that lets sendPrompt complete cleanly. */
function completingMessages(claudeSessionId: string) {
  return [
    { type: 'system', subtype: 'init', model: 'glm-5.2', session_id: claudeSessionId, tools: ['Read'], apiKeySource: 'none' },
    { type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'ok' }] }, session_id: claudeSessionId },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: { input_tokens: 1, output_tokens: 1 }, session_id: claudeSessionId },
  ];
}

const SAMPLE_QUESTIONS = [
  {
    question: 'Which library should we use?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'A', description: 'option a' },
      { label: 'B', description: 'option b' },
    ],
  },
];

interface Captured {
  sid: string;
  options: any;
  events: any[];
}

/** Create a session, drive one prompt to completion, and capture SDK options + emitted events. */
async function captureOptions(svc: ClaudeSdkService, profileId: string, opts?: { timeoutMs?: number }): Promise<Captured> {
  const { sessionId, claudeSessionId } = await svc.createSession(join('/tmp', 'auq-cwd'), 'sonnet', undefined, profileId);
  const events: any[] = [];
  let captured: any;

  mockQuery.mockImplementation((arg: any) => {
    captured = arg.options;
    return makeAsyncGenerator(completingMessages(claudeSessionId))();
  });

  await new Promise<void>((resolve) => {
    svc.sendPrompt(
      sessionId,
      'q',
      (e) => events.push(e),
      () => resolve(),
    ).catch(() => resolve());
  });

  return { sid: sessionId, options: captured, events };
}

describe('ClaudeSdkService AskUserQuestion bridge', () => {
  let tmpDir: string;
  let svc: ClaudeSdkService;
  let profilesPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-sdk-auq-'));
    profilesPath = join(tmpDir, 'profiles.json');

    process.env.TEST_GLM_TOKEN = 'test-token-value';
    writeFileSync(profilesPath, JSON.stringify({
      profiles: [
        {
          id: 'dontask-profile',
          label: 'DontAsk SDK',
          backend: 'sdk-subscription',
          launcherType: 'native-env',
          model: 'sonnet',
          settingSources: ['user', 'project'],
          skills: 'all',
          permissionMode: 'dontAsk',
          allowedTools: ['Read', 'Write', 'Bash'],
          maxConcurrent: 2,
          enabled: true,
        },
        {
          id: 'restricted-profile',
          label: 'Restricted SDK',
          backend: 'sdk-subscription',
          launcherType: 'native-env',
          model: 'sonnet',
          settingSources: ['user', 'project'],
          skills: 'all',
          permissionMode: 'dontAsk',
          allowedTools: ['Read'],
          maxConcurrent: 2,
          enabled: true,
        },
      ],
      defaultProfileId: 'dontask-profile',
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
    delete process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS;
  });

  // ── Effective permission mode ──────────────────────────────────────────────

  it('does not use dontAsk as the effective SDK permission mode for a dontAsk profile', async () => {
    const { options } = await captureOptions(svc, 'dontask-profile');
    expect(options.permissionMode).not.toBe('dontAsk');
    // Plan §7.3: prefer 'default' so canUseTool becomes the real gate.
    expect(options.permissionMode).toBe('default');
  });

  // ── AskUserQuestion routes through canUseTool ───────────────────────────────

  it('emits an ask_user_question_request and resolves updatedInput.answers when answered', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;
    expect(typeof canUseTool).toBe('function');

    const input = { questions: SAMPLE_QUESTIONS };
    const signal = new AbortController().signal;
    const pending = canUseTool('AskUserQuestion', input, { toolUseID: 'toolu_1', signal });

    // Wait for the request event to be emitted.
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });

    const req = events.find((e) => e.type === 'ask_user_question_request');
    expect(req.data.toolName).toBe('AskUserQuestion');
    expect(req.data.toolCallId).toBe('toolu_1');
    expect(req.data.questions).toEqual(SAMPLE_QUESTIONS);
    expect(typeof req.data.requestId).toBe('string');

    // The request is pending until answered.
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(true);

    const ok = svc.respondToAskUserQuestion(req.data.requestId, {
      answers: { 'Which library should we use?': 'B' },
    });
    expect(ok).toBe(true);

    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toEqual({ 'Which library should we use?': 'B' });
    // Original input (questions) is preserved on the updated input.
    expect(result.updatedInput.questions).toEqual(SAMPLE_QUESTIONS);
  });

  // ── Cancel is graceful (allow, no answers) ──────────────────────────────────

  it('maps a cancelled response to allow with no answers and cleans up', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_2',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');

    svc.respondToAskUserQuestion(req.data.requestId, { cancelled: true });

    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toBeUndefined();
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(false);
  });

  // ── Timeout is graceful (allow, no answers) ─────────────────────────────────

  it('maps a timeout to allow with no answers and cleans up', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '40';
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_3',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');

    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toBeUndefined();
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(false);
  });

  // ── Timeout policy (D1): long finite safety net, env-overridable ────────────

  it('uses a 30-minute safety-net default for the ask-user timeout when no env override is set', async () => {
    // afterEach clears CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS; beforeEach does not
    // set it, so a fresh test sees the built-in default.
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_default',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');

    // The wall clock is now a long safety net (abandonment is detected via
    // disconnect, not the clock). 30 min, finite, not Infinity.
    expect(req.data.timeoutMs).toBe(30 * 60 * 1000);

    svc.respondToAskUserQuestion(req.data.requestId, { cancelled: true });
    await pending;
  });

  it('honours CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS when it is a positive integer', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '7000';
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_env',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');
    expect(req.data.timeoutMs).toBe(7000);

    svc.respondToAskUserQuestion(req.data.requestId, { cancelled: true });
    await pending;
  });

  it('falls back to the 30-minute default when the timeout env is zero', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '0';
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_zero',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');
    expect(req.data.timeoutMs).toBe(30 * 60 * 1000);

    svc.respondToAskUserQuestion(req.data.requestId, { cancelled: true });
    await pending;
  });

  it('falls back to the 30-minute default when the timeout env is non-numeric', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = 'not-a-number';
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_nan',
      signal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');
    expect(req.data.timeoutMs).toBe(30 * 60 * 1000);

    svc.respondToAskUserQuestion(req.data.requestId, { cancelled: true });
    await pending;
  });

  // ── Abort resolves a pending ask as cancelled ───────────────────────────────

  it('resolves a pending ask as cancelled when the SDK abort signal fires', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const ac = new AbortController();
    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_4',
      signal: ac.signal,
    });

    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');

    ac.abort();

    const result = await pending;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toBeUndefined();
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(false);
  });

  // ── Resolution reason + single-fire close notification (D2) ────────────────

  it('emits exactly one ask_user_question_closed with reason timeout on timeout', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '40';
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_to', signal: new AbortController().signal,
    });
    await pending;

    const closed = events.filter((e) => e.type === 'ask_user_question_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].data.reason).toBe('timeout');
    const req = events.find((e) => e.type === 'ask_user_question_request');
    expect(closed[0].data.requestId).toBe(req.data.requestId);
  });

  it('emits exactly one ask_user_question_closed with reason aborted on SDK abort', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;
    const ac = new AbortController();

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_ab', signal: ac.signal,
    });
    ac.abort();
    await pending;

    const closed = events.filter((e) => e.type === 'ask_user_question_closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].data.reason).toBe('aborted');
  });

  it('does NOT emit ask_user_question_closed on the normal user-answer path', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_ok', signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');
    svc.respondToAskUserQuestion(req.data.requestId, {
      answers: { 'Which library should we use?': 'B' },
    });
    await pending;

    // The browser initiated this resolution — it must not receive a spurious
    // "expired" notification (failure mode §13.3).
    expect(events.filter((e) => e.type === 'ask_user_question_closed')).toHaveLength(0);
  });

  it('does NOT emit ask_user_question_closed on the user-cancel path', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_cancel', signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');
    svc.respondToAskUserQuestion(req.data.requestId, { cancelled: true });
    await pending;

    expect(events.filter((e) => e.type === 'ask_user_question_closed')).toHaveLength(0);
  });

  it('never notifies twice: a late answer after a timeout is a no-op (exactly one close)', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '40';
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_idem', signal: new AbortController().signal,
    });
    await pending;
    const req = events.find((e) => e.type === 'ask_user_question_request');

    // The timeout already resolved + notified. A late answer must be rejected
    // and must NOT emit a second close event (failure mode §13.4).
    const secondOk = svc.respondToAskUserQuestion(req.data.requestId, {
      answers: { 'Which library should we use?': 'A' },
    });
    expect(secondOk).toBe(false);
    // Let any deferred microtasks drain.
    await vi.waitFor(() => {
      expect(events.filter((e) => e.type === 'ask_user_question_closed')).toHaveLength(1);
    });
  });

  it('clears the timeout after it fires (no duplicate close on later timer advance)', async () => {
    vi.useFakeTimers();
    try {
      process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '1000';
      const { options, events } = await captureOptions(svc, 'dontask-profile');
      const canUseTool = options.canUseTool;

      const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
        toolUseID: 'toolu_leak', signal: new AbortController().signal,
      });

      // Let the 1s safety-net timeout fire.
      await vi.advanceTimersByTimeAsync(1500);
      await pending;

      const closed = events.filter((e) => e.type === 'ask_user_question_closed');
      expect(closed).toHaveLength(1);
      expect(closed[0].data.reason).toBe('timeout');

      // The timer must have been cleared — advancing well past it fires nothing.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events.filter((e) => e.type === 'ask_user_question_closed')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout + removes the abort listener when answered (no late close)', async () => {
    vi.useFakeTimers();
    try {
      process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '1000';
      const { options, events } = await captureOptions(svc, 'dontask-profile');
      const canUseTool = options.canUseTool;
      const ac = new AbortController();

      const pending = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
        toolUseID: 'toolu_leak2', signal: ac.signal,
      });
      // The request event is emitted synchronously before the await.
      const req = events.find((e) => e.type === 'ask_user_question_request');
      expect(req).toBeDefined();

      // Answer before the timeout fires — this must clear the timer + listener.
      svc.respondToAskUserQuestion(req!.data.requestId, {
        answers: { 'Which library should we use?': 'B' },
      });
      await pending;

      // Advancing past the original timeout must not fire a late close.
      await vi.advanceTimersByTimeAsync(5000);
      // Aborting now must not trigger a removed listener.
      ac.abort();
      await vi.advanceTimersByTimeAsync(1000);

      expect(events.filter((e) => e.type === 'ask_user_question_closed')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Session-level cancel API (B / disconnect) ───────────────────────────────

  it('cancelPendingAskUserQuestionsForSession resolves all pending for a session with the given reason and leaves other sessions untouched', async () => {
    const capA = await captureOptions(svc, 'dontask-profile');
    const capB = await captureOptions(svc, 'dontask-profile');

    const pendingA = capA.options.canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_a', signal: new AbortController().signal,
    });
    const pendingB = capB.options.canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_b', signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(capA.events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
      expect(capB.events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const reqA = capA.events.find((e) => e.type === 'ask_user_question_request');
    const reqB = capB.events.find((e) => e.type === 'ask_user_question_request');

    // Cancel everything pending on session A as disconnected.
    svc.cancelPendingAskUserQuestionsForSession(capA.sid, 'disconnected');

    const resultA = await pendingA;
    expect(resultA.behavior).toBe('allow');
    expect(resultA.updatedInput.answers).toBeUndefined();

    const closedA = capA.events.filter((e) => e.type === 'ask_user_question_closed');
    expect(closedA).toHaveLength(1);
    expect(closedA[0].data.reason).toBe('disconnected');
    expect(closedA[0].data.requestId).toBe(reqA.data.requestId);
    expect(svc.isPendingAskUserQuestion(reqA.data.requestId)).toBe(false);

    // Session B is untouched: still pending, no close emitted.
    expect(svc.isPendingAskUserQuestion(reqB.data.requestId)).toBe(true);
    expect(capB.events.filter((e) => e.type === 'ask_user_question_closed')).toHaveLength(0);

    // Tear down B so the test doesn't leave a dangling timer/entry.
    svc.respondToAskUserQuestion(reqB.data.requestId, { cancelled: true });
    await pendingB;
  });

  it('cancelPendingAskUserQuestionsForSession on a session with no pending questions is a harmless no-op', async () => {
    // No AskUserQuestion is pending on this session; calling cancel must not throw.
    expect(() => svc.cancelPendingAskUserQuestionsForSession('never-existed', 'disconnected')).not.toThrow();
  });

  it('hasPendingAskUserQuestionForSession reflects per-session pending state', async () => {
    const capA = await captureOptions(svc, 'dontask-profile');
    const capB = await captureOptions(svc, 'dontask-profile');

    capA.options.canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
      toolUseID: 'toolu_sess_a', signal: new AbortController().signal,
    });
    await vi.waitFor(() => {
      expect(capA.events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });

    expect(svc.hasPendingAskUserQuestionForSession(capA.sid)).toBe(true);
    expect(svc.hasPendingAskUserQuestionForSession(capB.sid)).toBe(false);
    expect(svc.hasPendingAskUserQuestionForSession('never-existed')).toBe(false);

    const reqA = capA.events.find((e) => e.type === 'ask_user_question_request');
    svc.respondToAskUserQuestion(reqA.data.requestId, { cancelled: true });
  });

  // ── Non-AskUserQuestion tools still obey the allowlist ──────────────────────

  it('allows a tool in the profile allowlist and denies a tool not in it', async () => {
    const { options } = await captureOptions(svc, 'restricted-profile'); // allowedTools: ['Read']
    const canUseTool = options.canUseTool;
    const ctx = { toolUseID: 't', signal: new AbortController().signal };

    const allowed = await canUseTool('Read', { file_path: 'a' }, ctx);
    expect(allowed.behavior).toBe('allow');

    const denied = await canUseTool('Bash', { command: 'rm -rf /' }, ctx);
    expect(denied.behavior).toBe('deny');
    expect((denied as { message?: string }).message).toMatch(/not in the allowed tools/i);
  });

  it('includes AskUserQuestion in options.allowedTools so Claude can see the tool', async () => {
    // Claude Code only advertises AskUserQuestion when it is in the allowed
    // tools set. The SDK canUseTool callback still handles the actual dialog
    // resolution and returns updatedInput.answers.
    const { options } = await captureOptions(svc, 'dontask-profile');
    expect(options.allowedTools).toContain('AskUserQuestion');
  });

  it('denies malformed AskUserQuestion payloads before opening a pending dialog', async () => {
    const { options, events } = await captureOptions(svc, 'dontask-profile');
    const canUseTool = options.canUseTool;

    const result = await canUseTool('AskUserQuestion', {
      questions: [
        { question: 'One?', header: '1', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
        { question: 'Two?', header: '2', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
        { question: 'Three?', header: '3', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
        { question: 'Four?', header: '4', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
        { question: 'Five?', header: '5', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
      ],
    }, {
      toolUseID: 'toolu_bad',
      signal: new AbortController().signal,
    });

    expect(result.behavior).toBe('deny');
    expect((result as { message?: string }).message).toMatch(/AskUserQuestion/i);
    expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(false);
  });

  it('cleans up pending AskUserQuestion state immediately when the SDK turn errors mid-question', async () => {
    const { sessionId, claudeSessionId } = await svc.createSession(
      join(tmpDir, 'cwd-err'), 'sonnet', undefined, 'dontask-profile',
    );
    const events: any[] = [];
    let askPromise: Promise<any> | undefined;

    // Simulate the SDK invoking canUseTool for AskUserQuestion and then the
    // stream erroring before an answer arrives — leaving an orphaned pending
    // entry that must NOT leak to the 5-minute timeout.
    mockQuery.mockImplementation((arg: any) => {
      const canUseTool = arg.options.canUseTool;
      return (async function* () {
        yield { type: 'system', subtype: 'init', model: 'glm-5.2', session_id: claudeSessionId, apiKeySource: 'none' };
        // canUseTool registers the pending entry synchronously before awaiting.
        askPromise = canUseTool('AskUserQuestion', { questions: SAMPLE_QUESTIONS }, {
          toolUseID: 'toolu_err',
          signal: arg.options.abortController.signal,
        });
        yield { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'asking' }] } };
        throw new Error('SDK connection failed');
      })();
    });

    let completionError: Error | undefined;
    await new Promise<void>((resolve) => {
      svc.sendPrompt(
        sessionId, 'q',
        (e) => events.push(e),
        (err) => { completionError = err; resolve(); },
      ).catch(() => resolve());
    });

    expect(completionError?.message).toContain('SDK connection failed');
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === 'ask_user_question_request')).toBe(true);
    });
    const req = events.find((e) => e.type === 'ask_user_question_request');

    // The turn errored → pending state must be cleaned up now, not leaked.
    expect(svc.isPendingAskUserQuestion(req.data.requestId)).toBe(false);
    // The orphaned canUseTool promise must resolve gracefully (cancelled allow),
    // so it never hangs the SDK / leaves the session permanently streaming.
    const result = await askPromise;
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toBeUndefined();
  });
});
