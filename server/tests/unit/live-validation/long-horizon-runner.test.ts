import { describe, it, expect, vi } from 'vitest';
import {
  startRun,
  tick,
  runToCompletion,
  type LongHorizonClient,
} from '../../../src/live-validation/long-horizon-runner.js';
import type { WatchResponse } from '../../../src/internal-api/types.js';

/**
 * A controllable fake of the Internal API. `fireAfter` lets a test decide how
 * many polls happen before the condition "fires", which is how we exercise the
 * long-horizon loop in milliseconds instead of hours.
 */
function makeFakeClient(opts: { fireAfter: number }): { client: LongHorizonClient; promptMessages: string[] } {
  let getWatchCalls = 0;
  const promptMessages: string[] = [];

  const buildWatch = (fired: boolean): WatchResponse => ({
    watchId: 'watch-subj',
    sessionId: 'subj',
    runtime: 'pi',
    status: 'active',
    pinned: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conditions: [{ id: 'c0', type: 'tool', spec: { id: 'c0', type: 'tool', toolName: 'Bash' }, fired, fireCount: fired ? 1 : 0 }],
    firings: fired ? [{ conditionId: 'c0', firedAt: Date.now(), eventType: 'tool_execution_start', evidence: 'Bash (start)' }] : [],
    firingCount: fired ? 1 : 0,
    pendingConditionIds: fired ? [] : ['c0'],
    allFired: fired,
    snapshot: { status: 'idle', eventCount: 1, toolCallCount: fired ? 1 : 0, sawAgentEnd: false },
  });

  const client: LongHorizonClient = {
    createSession: vi.fn(async () => ({ sessionId: 'subj', sessionPath: 'subj', runtime: 'pi', cwd: '/tmp', createdAt: new Date().toISOString() })),
    prompt: vi.fn(async (_sid, input) => { promptMessages.push(input.message); return { sessionId: 'subj', content: 'ok', turnComplete: true }; }),
    pinSession: vi.fn(async () => ({ success: true, action: 'pin', pinned: true })),
    registerWatch: vi.fn(async () => buildWatch(false)),
    getWatch: vi.fn(async () => { getWatchCalls += 1; return buildWatch(getWatchCalls >= opts.fireAfter); }),
    deleteWatch: vi.fn(async () => ({ success: true })),
    deleteSession: vi.fn(async () => undefined),
    waitForStatus: vi.fn(async () => ({ sessionId: 'subj', status: 'idle' as const, waitedMs: 0 })),
  };

  return { client, promptMessages };
}

describe('long-horizon-runner', () => {
  it('startRun creates a subject, registers a watch, and dispatches the seed', async () => {
    const { client, promptMessages } = makeFakeClient({ fireAfter: 1 });
    const { state } = await startRun({
      client,
      subjectRuntime: 'pi',
      seedPrompt: 'Run: echo hi',
      conditions: [{ type: 'tool', toolName: 'Bash' }],
    });
    expect(client.createSession).toHaveBeenCalled();
    expect(client.registerWatch).toHaveBeenCalled();
    expect(state.subjectSessionId).toBe('subj');
    expect(state.createdSubject).toBe(true);
    expect(state.status).toBe('running');
    // Seed dispatched (fire-and-forget) — allow the microtask to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(promptMessages).toContain('Run: echo hi');
  });

  it('tick transitions to passed once the target condition fires', async () => {
    const { client } = makeFakeClient({ fireAfter: 2 });
    const { state } = await startRun({ client, subjectRuntime: 'pi', conditions: [{ type: 'tool', toolName: 'Bash' }] });
    const first = await tick(state, client);
    expect(first.done).toBe(false);
    expect(state.status).toBe('running');
    const second = await tick(state, client);
    expect(second.done).toBe(true);
    expect(state.status).toBe('passed');
    expect(state.firedConditionIds).toContain('c0');
  });

  it('tick times out when the deadline passes before success', async () => {
    const { client } = makeFakeClient({ fireAfter: 999 });
    const { state } = await startRun({ client, subjectRuntime: 'pi', conditions: [{ type: 'tool', toolName: 'Bash' }], maxWaitMs: 0 });
    const result = await tick(state, client);
    expect(result.done).toBe(true);
    expect(state.status).toBe('timeout');
  });

  it('runToCompletion polls to success then cleans up the watch and subject', async () => {
    const { client } = makeFakeClient({ fireAfter: 1 });
    const final = await runToCompletion({
      client,
      subjectRuntime: 'pi',
      conditions: [{ type: 'tool', toolName: 'Bash' }],
      pollIntervalMs: 5,
      probePrompt: 'what did you run?',
    });
    expect(final.status).toBe('passed');
    expect(client.deleteWatch).toHaveBeenCalledWith('subj');
    expect(client.deleteSession).toHaveBeenCalledWith('subj');
    expect(final.probeAnswer).toBe('ok');
  });

  it('honours stopWhen=any', async () => {
    const { client } = makeFakeClient({ fireAfter: 1 });
    const final = await runToCompletion({
      client, subjectRuntime: 'pi', stopWhen: 'any',
      conditions: [{ type: 'tool', toolName: 'Bash' }], pollIntervalMs: 5,
    });
    expect(final.status).toBe('passed');
  });
});
