/**
 * Phase 1b (contract 1.45.0, INTERNAL-API-SILENT-NOOP-AND-SESSION-OWNERSHIP-PLAN.md)
 * — voice relay honesty for swallowed prompts.
 *
 * M3 (28c6d644) pins submitPrompt() as submission-shaped: it resolves on
 * agent_start or when the prompt settles first, and never waits for turn end.
 * But "prompt settled first" also covers the FENCED worker: the extension
 * input hook swallows the message, nothing runs, and the relay previously
 * reported a green "Sent" for an instruction that never reached a turn.
 *
 * The M3 timing for real deliveries is unchanged (a genuine agent_start still
 * resolves immediately); what changes is the settle-without-start case: after
 * the same bounded grace Phase 1 uses, the submission throws a typed
 * PromptNotSubmittedError so the delivery adapter reports `refused` with a
 * reason (the amber NOT-sent path, d27e75cd) instead of a false `delivered`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPiDelivery } from '../../../src/talker/delivery.js';
import { MultiSessionManager, PromptNotSubmittedError } from '../../../src/pi/multi-session-manager.js';

const GRACE_MS = 40;

function createMockAgentSession(overrides: Record<string, unknown> = {}) {
  const sessionId = `honesty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionFile = `/tmp/honesty/${sessionId}.jsonl`;
  return {
    sessionId,
    sessionFile,
    subscribe: vi.fn(),
    dispose: vi.fn(),
    setModel: vi.fn(),
    getContextUsage: vi.fn(() => undefined),
    isStreaming: false,
    prompt: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockPiService(session: ReturnType<typeof createMockAgentSession>) {
  return {
    createSession: vi.fn().mockResolvedValue(session),
    getSession: vi.fn(() => session),
    setEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
  };
}

describe('MultiSessionManager.submitPrompt — honest refusal when the turn never starts (Phase 1b)', () => {
  let priorGrace: string | undefined;
  let session: ReturnType<typeof createMockAgentSession>;
  let manager: MultiSessionManager;
  let eventHandler: (event: { type: string; timestamp?: number }) => void;

  beforeEach(async () => {
    priorGrace = process.env.PI_PROMPT_EXECUTION_GRACE_MS;
    process.env.PI_PROMPT_EXECUTION_GRACE_MS = String(GRACE_MS);
    session = createMockAgentSession();
    const piService = createMockPiService(session);
    manager = new MultiSessionManager(piService as never, () => {}, { idleSessionTimeoutMs: 600_000 });
    const path = session.sessionFile;
    await manager.subscribeClient('honesty-client', path);
    const registration = piService.setEventHandler.mock.calls.find(([key]) => key === `multi-${path}`);
    eventHandler = registration?.[1] as typeof eventHandler;
    expect(eventHandler).toBeTypeOf('function');
  });

  afterEach(() => {
    if (priorGrace === undefined) delete process.env.PI_PROMPT_EXECUTION_GRACE_MS;
    else process.env.PI_PROMPT_EXECUTION_GRACE_MS = priorGrace;
    manager.disposeAll?.();
  });

  it('RED: throws PromptNotSubmittedError when prompt settles without any turn start (fenced worker)', async () => {
    await expect(manager.submitPrompt(session.sessionFile, 'reply PONG if you run')).rejects.toBeInstanceOf(
      PromptNotSubmittedError,
    );
    // The session did nothing: it must not be left in an error state.
    expect(manager.getSessionStatus(session.sessionFile)?.status).toBe('idle');
  });

  it('still resolves at SUBMISSION when the turn genuinely starts (M3 timing unchanged)', async () => {
    session.prompt.mockImplementation(async () => {
      // The real worker shape: the SDK emits agent_start while prompt() is
      // still pending, and the submission must resolve without waiting for
      // the turn to end.
      eventHandler({ type: 'agent_start', timestamp: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 10));
    });

    const settledAt = Date.now();
    await expect(manager.submitPrompt(session.sessionFile, 'long-running worker turn')).resolves.toBeUndefined();
    expect(Date.now() - settledAt).toBeLessThan(GRACE_MS * 5);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it('does not refuse when a compaction event was observed in the window (compaction exemption)', async () => {
    session.prompt.mockImplementation(async () => {
      eventHandler({ type: 'session_compaction', timestamp: Date.now() });
      // prompt() resolves at the compaction boundary; the resumed start is
      // late but the delivery was honest — the message joined the runtime.
      await new Promise((resolve) => setTimeout(resolve, 1));
    });

    await expect(manager.submitPrompt(session.sessionFile, 'compact then resume')).resolves.toBeUndefined();
  });

  it('RED (round 2): a turn that starts LATE — inside the grace — and finishes quickly is delivered, not refused', async () => {
    session.prompt.mockImplementation(async () => {
      // The prompt settles immediately (the fenced/swallowed shape)…
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    const submission = manager.submitPrompt(session.sessionFile, 'late-start probe');
    // …but the turn actually starts during the grace window (late worker).
    setTimeout(() => {
      eventHandler({ type: 'agent_start', timestamp: Date.now() });
      eventHandler({ type: 'agent_end', timestamp: Date.now() });
    }, GRACE_MS / 2);

    await expect(submission).resolves.toBeUndefined();
    expect(manager.getSessionStatus(session.sessionFile)?.status).toBe('idle');
  });

  it('delivery adapter maps a not-started submission to refused with the reason (amber NOT-sent path)', async () => {
    const delivery = createPiDelivery({
      isBusy: () => false,
      submitPrompt: async () => {
        throw new PromptNotSubmittedError('message accepted by /tmp/worker.jsonl but no turn started');
      },
      submitSteer: async () => ({ joinedRunningTurn: true }),
    });
    const outcome = await delivery.deliver({ workerSessionId: '/tmp/worker.jsonl', text: 'relay this' });
    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome === 'refused') {
      expect(outcome.reason).toContain('no turn started');
    }
  });
});
