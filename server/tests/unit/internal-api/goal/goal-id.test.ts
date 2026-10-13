import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InternalApiEventBroker } from '../../../../src/internal-api/event-broker.js';
import { createGoalIdStore, stampGoalEventData } from '../../../../src/internal-api/goal/goal-id.js';
import type { SessionGoalProjection } from '../../../../src/internal-api/goal/types.js';

/** W2-a (contract 1.62.0): stable top-level goalId on goal_state / goal_end. */

const running = (objective: string, startedAt: number): SessionGoalProjection =>
  ({ supported: true, status: 'running', objective, startedAt });
const ended = (status: 'achieved' | 'cleared' | 'failed', objective?: string): SessionGoalProjection =>
  ({ supported: true, status, objective });

describe('goal id store', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('mints once per goal and keeps it across repeated observations', () => {
    const store = createGoalIdStore();
    const a = store.stamp('s1', running('ship it', 100));
    const b = store.stamp('s1', { ...running('ship it', 100), runs: 3 });
    expect(a.goalId).toMatch(/^goal_[0-9a-f]{12,}$/);
    expect(b.goalId).toBe(a.goalId);
  });

  it('gives a new goal on a reused session a new id; the old goal\'s clear carries the OLD id', () => {
    const store = createGoalIdStore();
    const first = store.stamp('s1', running('first', 100));
    const cleared = store.stamp('s1', ended('cleared', 'first'));
    expect(cleared.goalId).toBe(first.goalId);
    const second = store.stamp('s1', running('second', 200));
    expect(second.goalId).not.toBe(first.goalId);
    // a late projection of the old terminal state must not adopt the new id
    expect(store.stamp('s1', running('second', 200)).goalId).toBe(second.goalId);
  });

  it('mints a fresh id after rotate() even when the objective repeats', () => {
    const store = createGoalIdStore();
    const first = store.stamp('s1', { supported: true, status: 'running', objective: 'same' });
    store.stamp('s1', ended('cleared', 'same'));
    store.rotate('s1');
    const again = store.stamp('s1', { supported: true, status: 'running', objective: 'same' });
    expect(again.goalId).not.toBe(first.goalId);
  });

  it('a terminal observation of a never-seen new goal after rotate mints a new id', () => {
    const store = createGoalIdStore();
    const first = store.stamp('s1', running('a', 1));
    store.rotate('s1');
    expect(store.stamp('s1', ended('achieved', 'b')).goalId).not.toBe(first.goalId);
  });

  it('does not invent an id for idle sessions with no goal history, nor unsupported runtimes', () => {
    const store = createGoalIdStore();
    expect(store.stamp('s1', { supported: true, status: 'idle' }).goalId).toBeUndefined();
    expect(store.stamp('s2', { supported: false, status: 'unknown' }).goalId).toBeUndefined();
  });

  it('persists across restart (rehydrate from the data dir)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-id-'));
    dirs.push(dir);
    const id = createGoalIdStore({ dir }).stamp('s1', running('x', 5)).goalId;
    const reloaded = createGoalIdStore({ dir });
    expect(reloaded.stamp('s1', running('x', 5)).goalId).toBe(id);
    expect(reloaded.stamp('s1', ended('achieved', 'x')).goalId).toBe(id);
  });

  it('stampGoalEventData leaves non-object data alone', () => {
    const store = createGoalIdStore();
    expect(stampGoalEventData(store, 's1', 'goal_state', null)).toBeNull();
    expect(stampGoalEventData(store, 's1', 'goal_state', 'x')).toBe('x');
  });
});

describe('event broker stamps goalId on goal events', () => {
  it('stamps goal_state and goal_end data top-level via the enricher, not other events', () => {
    const store = createGoalIdStore();
    const broker = new InternalApiEventBroker({
      eventEnricher: (key, event) => {
        if (event.type !== 'goal_state' && event.type !== 'goal_end') return event;
        return { ...event, data: stampGoalEventData(store, key, event.type, (event as { data?: unknown }).data) } as typeof event;
      },
    });
    const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
    broker.subscribe('s1', (e) => seen.push(e as never));
    broker.publish('s1', { type: 'goal_state', timestamp: 1, data: running('o', 1) } as never);
    broker.publish('s1', { type: 'goal_end', timestamp: 2, data: ended('cleared', 'o') } as never);
    broker.publish('s1', { type: 'agent_end', timestamp: 3, data: { x: 1 } } as never);
    const [a, b, c] = seen;
    expect(a.data.goalId).toBeTruthy();
    expect(b.data.goalId).toBe(a.data.goalId);
    expect(c.data.goalId).toBeUndefined();
  });
});
