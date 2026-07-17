import { describe, it, expect, afterEach, vi } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { buildAskUserAnswers, scenarioRegistry } from '../../../src/live-validation/scenarios.js';

describe('buildAskUserAnswers (claude-ask-user-question scenario helper)', () => {
  const q = (question: string, header: string, multiSelect: boolean, labels: string[]) => ({
    question,
    header,
    multiSelect,
    options: labels.map((label) => ({ label, description: '' })),
  });

  it('answers colour=Blue, size=Large, features=Search+Export keyed by exact question text', () => {
    const questions = [
      q('Pick a colour', 'Colour', false, ['Red', 'Blue']),
      q('Pick a size', 'Size', false, ['Small', 'Large']),
      q('Pick features', 'Features', true, ['Search', 'Attachments', 'Export']),
    ];

    const answers = buildAskUserAnswers(questions as any);

    expect(answers['Pick a colour']).toBe('Blue');
    expect(answers['Pick a size']).toBe('Large');
    expect(answers['Pick features']).toBe('Search, Export');
  });

  it('tolerates "color" spelling and decorated labels', () => {
    const questions = [
      q('Which color do you want?', 'Color', false, ['Red', 'Blue (recommended)']),
    ];
    const answers = buildAskUserAnswers(questions as any);
    expect(answers['Which color do you want?']).toBe('Blue (recommended)');
  });

  it('falls back to the last option when no keyword matches', () => {
    const questions = [q('Something unrelated?', 'X', false, ['A', 'B'])];
    const answers = buildAskUserAnswers(questions as any);
    expect(answers['Something unrelated?']).toBe('B');
  });
});

describe('AskUserQuestion live-validation scenarios', () => {
  afterEach(() => {
    delete process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS;
    delete process.env.CLAUDE_ASK_USER_DELAYED_ANSWER_MS;
  });

  const event = (type: string, data: unknown = {}): NormalizedEvent => ({
    type,
    sessionId: 'sess-1',
    timestamp: Date.now(),
    data,
  });

  const textEvent = (text: string): NormalizedEvent => event('message_update', {
    assistantMessageEvent: {
      type: 'text_delta',
      delta: text,
    },
  });

  function makeContext(promptEvents: NormalizedEvent[]) {
    return {
      runtime: 'claude' as const,
      cwd: '/tmp',
      capabilities: { runtimes: { claude: {}, pi: {}, opencode: {}, antigravity: {} } },
      client: {
        createSession: vi.fn(async () => ({ sessionId: 'sess-1', sessionPath: 'sess-1', runtime: 'claude', cwd: '/tmp' })),
        deleteSession: vi.fn(async () => undefined),
        getSessionInfo: vi.fn(async () => ({
          sessionId: 'sess-1', runtime: 'claude', status: 'idle', cwd: '/tmp',
          createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), messageCount: 1,
        })),
        respondToApproval: vi.fn(async () => ({ success: true, approved: true })),
        promptStreamLive: vi.fn(async (_sessionId: string, _input: unknown, onEvent: (evt: NormalizedEvent) => void) => {
          for (const evt of promptEvents) onEvent(evt);
          return promptEvents;
        }),
      },
    } as any;
  }

  it('fails the cancel scenario when Claude does not explicitly report that no answer was received', async () => {
    const scenario = scenarioRegistry['claude-ask-user-question-cancel'];
    const context = makeContext([
      event('ask_user_question_request', { requestId: 'req-1' }),
      textEvent('ASK_CANCEL_RESULT status=received'),
      event('agent_end'),
    ]);

    const result = await scenario.run(context);

    expect(result.passed).toBe(false);
    expect(result.assertions.find((a) => a.name === 'model_saw_no_answer')?.passed).toBe(false);
  });

  it('fails the timeout scenario when Claude completes without the timeout marker', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '1000';
    const scenario = scenarioRegistry['claude-ask-user-question-timeout'];
    const context = makeContext([
      event('ask_user_question_request', { requestId: 'req-1' }),
      textEvent('I completed but did not emit the required marker'),
      event('agent_end'),
    ]);

    const result = await scenario.run(context);

    expect(result.passed).toBe(false);
    expect(result.assertions.find((a) => a.name === 'model_saw_timeout')?.passed).toBe(false);
  });

  it('skips the timeout scenario unless a short ask-user timeout is configured', async () => {
    const scenario = scenarioRegistry['claude-ask-user-question-timeout'];
    const context = makeContext([]);

    const result = await scenario.run(context);

    expect(result.skipped).toBe(true);
    expect(result.reason).toMatch(/CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS/i);
    expect(context.client.createSession).not.toHaveBeenCalled();
  });

  it('passes the timeout scenario when ask_user_question_closed(timeout) is emitted and the late answer is rejected', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '1000';
    const scenario = scenarioRegistry['claude-ask-user-question-timeout'];
    const context = makeContext([
      event('ask_user_question_request', { requestId: 'req-1' }),
      event('ask_user_question_closed', { requestId: 'req-1', reason: 'timeout' }),
      textEvent('ASK_TIMEOUT_RESULT timed_out'),
      event('agent_end'),
    ]);
    context.client.respondToApproval = vi.fn(async () => {
      throw new Error('{"error":"That question already closed","code":"ASK_ALREADY_CLOSED"}');
    });

    const result = await scenario.run(context);

    expect(result.passed).toBe(true);
    expect(result.assertions.find((a) => a.name === 'ask_user_question_closed_emitted')?.passed).toBe(true);
    expect(result.assertions.find((a) => a.name === 'late_answer_rejected')?.passed).toBe(true);
    // The late answer must have targeted the ask requestId.
    expect(context.client.respondToApproval).toHaveBeenCalledWith(
      'sess-1', 'req-1', expect.objectContaining({ approved: true }),
    );
  });

  it('fails the timeout scenario when no ask_user_question_closed is emitted (D2 regression guard)', async () => {
    process.env.CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS = '1000';
    const scenario = scenarioRegistry['claude-ask-user-question-timeout'];
    const context = makeContext([
      event('ask_user_question_request', { requestId: 'req-1' }),
      textEvent('ASK_TIMEOUT_RESULT timed_out'),
      event('agent_end'),
    ]);

    const result = await scenario.run(context);

    expect(result.passed).toBe(false);
    expect(result.assertions.find((a) => a.name === 'ask_user_question_closed_emitted')?.passed).toBe(false);
  });

  // ── delayed-answer scenario (§10 fix proof) ─────────────────────────────────

  const colour = { question: 'Pick a colour', header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }] };
  const size = { question: 'Pick a size', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: '' }, { label: 'Large', description: '' }] };
  const features = { question: 'Pick features', header: 'Features', multiSelect: true, options: [{ label: 'Search', description: '' }, { label: 'Attachments', description: '' }, { label: 'Export', description: '' }] };

  it('passes the delayed-answer scenario when the delayed answer is accepted with no premature close', async () => {
    process.env.CLAUDE_ASK_USER_DELAYED_ANSWER_MS = '5';
    const scenario = scenarioRegistry['claude-ask-user-question-delayed-answer'];
    const context = makeContext([
      event('ask_user_question_request', { requestId: 'req-1', questions: [colour, size, features] }),
      textEvent('ASK_VALIDATION_RESULT colour=Blue; size=Large; features=Search, Export'),
      event('agent_end'),
    ]);

    const result = await scenario.run(context);

    expect(result.passed).toBe(true);
    expect(result.assertions.find((a) => a.name === 'no_premature_close')?.passed).toBe(true);
    expect(result.assertions.find((a) => a.name === 'colour_blue')?.passed).toBe(true);
    expect(result.assertions.find((a) => a.name === 'ask_user_question_request_emitted')?.passed).toBe(true);
  });

  it('fails the delayed-answer scenario when a premature close fires before the answer lands', async () => {
    process.env.CLAUDE_ASK_USER_DELAYED_ANSWER_MS = '5';
    const scenario = scenarioRegistry['claude-ask-user-question-delayed-answer'];
    const context = makeContext([
      event('ask_user_question_request', { requestId: 'req-1', questions: [colour, size, features] }),
      event('ask_user_question_closed', { requestId: 'req-1', reason: 'timeout' }),
      textEvent('ASK_VALIDATION_RESULT colour=Blue; size=Large; features=Search, Export'),
      event('agent_end'),
    ]);

    const result = await scenario.run(context);

    expect(result.passed).toBe(false);
    expect(result.assertions.find((a) => a.name === 'no_premature_close')?.passed).toBe(false);
  });

  it('skips the delayed-answer scenario for non-claude runtimes', async () => {
    const scenario = scenarioRegistry['claude-ask-user-question-delayed-answer'];
    const context = makeContext([]);
    context.runtime = 'opencode';

    const result = await scenario.run(context);

    expect(result.skipped).toBe(true);
  });
});
