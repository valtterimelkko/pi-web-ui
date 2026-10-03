/**
 * Cross-runtime goal function (contract 1.27.0) — broker event bridge tests.
 *
 * The bridge translates goal-engine extension UI messages into normalized
 * `goal_state` / `goal_end` events published to the Internal API broker, using
 * the on-disk state as the source of truth.
 */
import { describe, it, expect } from 'vitest';
import { createPiGoalEventBridge } from '../../../../src/internal-api/goal/goal-events.js';

const RUNNING = { supported: true, status: 'running' as const, objective: 'x' };
const ACHIEVED = { supported: true, status: 'achieved' as const, objective: 'x', completedAt: 1 };

function goalStatusMessage(text: string | undefined) {
  return { type: 'extension_status', sessionId: 'session-1', status: { key: 'goal-engine', text } };
}
function goalWidgetMessage() {
  return { type: 'widget_content', sessionId: 'session-1', key: 'goal-engine-status', content: ['🎯 Goal Status'] };
}

describe('createPiGoalEventBridge', () => {
  it('ignores non-goal extension UI messages entirely', async () => {
    const published: unknown[] = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => RUNNING,
      publish: (e) => published.push(e),
    });
    await bridge({ type: 'extension_status', status: { key: 'other-key', text: 'hi' } });
    await bridge({ type: 'widget_content', key: 'other-widget', content: [] });
    await bridge({ type: 'agent_end' });
    expect(published).toEqual([]);
  });

  it('publishes a goal_state event carrying the disk-truth projection', async () => {
    const published: any[] = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => RUNNING,
      publish: (e) => published.push(e),
    });
    await bridge(goalWidgetMessage());
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe('goal_state');
    expect(published[0].data.status).toBe('running');
    expect(typeof published[0].timestamp).toBe('number');
  });

  it('emits goal_end exactly once when the projection first reaches a terminal status', async () => {
    const published: any[] = [];
    let current = RUNNING;
    const bridge = createPiGoalEventBridge({
      readProjection: async () => current,
      publish: (e) => published.push(e),
    });
    await bridge(goalStatusMessage('🎯 ▶ Running — Run 1'));
    current = ACHIEVED;
    await bridge(goalWidgetMessage());
    await bridge(goalStatusMessage(undefined)); // extension clears its status line on completion
    current = ACHIEVED;
    await bridge(goalWidgetMessage()); // repeat payload must not re-fire goal_end
        const kinds = published.map((e) => `${e.type}:${e.data?.status}`);
    // Every UI notification yields a goal_state; exactly one goal_end on the
    // running→achieved transition; repeats never re-fire it.
    expect(kinds.filter((k) => k.startsWith('goal_end'))).toHaveLength(1);
    expect(kinds[0]).toBe('goal_state:running');
    expect(kinds[1]).toBe('goal_state:achieved');
    expect(kinds[2]).toBe('goal_end:achieved');
    expect(published.find((e) => e.type === 'goal_end')!.data.status).toBe('achieved');
  });

  it('publishes nothing when disk truth cannot be read (never invents state)', async () => {
    const published: any[] = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => null,
      publish: (e) => published.push(e),
    });
    await bridge(goalWidgetMessage());
    expect(published).toEqual([]);
  });

  it('survives a throwing publisher without breaking subsequent notifications', async () => {
    let shouldThrow = true;
    const published: any[] = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => RUNNING,
      publish: (e) => {
        if (shouldThrow) throw new Error('broker closed');
        published.push(e);
      },
    });
    await expect(bridge(goalWidgetMessage())).resolves.toBeUndefined(); // error swallowed upstream contract
    shouldThrow = false;
    await bridge(goalWidgetMessage());
    expect(published).toHaveLength(1);
  });
});

describe('createPiGoalEventBridge — F4 live interruption interception', () => {
  // The REAL projected shape of a provider stop: the engine pauses with
  // lastErrorMessage set, and canonicalPiStatus projects that as status
  // 'failed' (terminal).
  const PROVIDER_FAILED = { supported: true, status: 'failed' as const, pausedReason: 'error', runtimeState: { lastErrorMessage: 'Provider overloaded (HTTP 429)' } };

  it('calls the hook BEFORE emitting goal_end; interception suppresses that goal_end', async () => {
    const published: Array<{ type: string }> = [];
    let hookRan = false;
    const bridge = createPiGoalEventBridge({
      readProjection: async () => PROVIDER_FAILED,
      publish: (e) => published.push({ type: e.type }),
      onPausedOrFailed: async () => { hookRan = true; return true; },
    });
    await bridge(goalStatusMessage('⚠ paused'));
    expect(hookRan).toBe(true);
    const types = published.map((e) => e.type);
    expect(types).toContain('goal_state');
    expect(types).not.toContain('goal_end');
  });

  it('without interception a terminal failed goal emits goal_end exactly as today', async () => {
    const published: Array<{ type: string }> = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => PROVIDER_FAILED,
      publish: (e) => published.push({ type: e.type }),
      onPausedOrFailed: async () => false,
    });
    await bridge(goalStatusMessage('⚠ failed'));
    const types = published.map((e) => e.type);
    expect(types).toContain('goal_state');
    expect(types).toContain('goal_end');
  });

  it('a running projection never calls the hook and never emits goal_end', async () => {
    const seen: unknown[] = [];
    const published: Array<{ type: string }> = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => RUNNING,
      publish: (e) => published.push({ type: e.type }),
      onPausedOrFailed: async (p) => { seen.push(p); return false; },
    });
    await bridge(goalStatusMessage('x'));
    expect(seen).toHaveLength(0);
    expect(published.map((e) => e.type)).toEqual(['goal_state']);
  });

  it('a throwing hook still emits goal_end exactly as today', async () => {
    const published: Array<{ type: string }> = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => PROVIDER_FAILED,
      publish: (e) => published.push({ type: e.type }),
      onPausedOrFailed: async () => { throw new Error('sweep down'); },
    });
    await expect(bridge(goalStatusMessage('x'))).resolves.toBeUndefined();
    const types = published.map((e) => e.type);
    expect(types).toContain('goal_state');
    expect(types).toContain('goal_end');
  });

  it('a paused (non-terminal) projection is classified before goal_state publication and goal_end never fires for it', async () => {
    const published: Array<{ type: string }> = [];
    const seen: unknown[] = [];
    const bridge = createPiGoalEventBridge({
      readProjection: async () => ({ supported: true, status: 'paused', pausedReason: 'error', runtimeState: { lastErrorMessage: 'ECONNRESET from provider' } }),
      publish: (e) => published.push({ type: e.type }),
      onPausedOrFailed: async (p) => { seen.push(p); return true; },
    });
    await bridge(goalStatusMessage('⏸ paused'));
    expect(seen).toHaveLength(1);
    expect(published.map((e) => e.type)).toEqual(['goal_state']);
  });
});
