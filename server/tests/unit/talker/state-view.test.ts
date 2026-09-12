import { describe, it, expect } from 'vitest';

// RED: module does not exist yet.
import { renderStateView, STATE_VIEW_LIMITS } from '../../../src/talker/state-view.js';
import type { WorkerStateSnapshot, HarnessView } from '../../../src/talker/types.js';

const emptyHarness: HarnessView = { pendingUtterance: null, pendingAgeTurns: null, lastReleased: null };

describe('renderStateView', () => {
  const snapshot: WorkerStateSnapshot = {
    elapsedLabel: '14m',
    activity: 'supervising two workers; waiting on the first one',
    recentEvents: ['watching worker 1', 'board updated'],
    children: ['worker 1 (transfer handler): running, 22m', 'worker 2 (queue + runner): phases 1-2 committed'],
    pendingItems: ['phase 3 held for the operator'],
    lastAssistantText: 'Both are running. Worker 1 is in the transfer handler.',
  };

  it('renders the deterministic sections of the prototype shape', () => {
    const view = renderStateView(snapshot, emptyHarness);
    expect(view).toContain('--- WORKER STATE ---');
    expect(view).toContain('Elapsed: 14m');
    expect(view).toContain('Worker: supervising two workers; waiting on the first one');
    expect(view).toContain('Recent activity: watching worker 1 | board updated');
    expect(view).toContain('worker 1 (transfer handler): running, 22m');
    expect(view).toContain('Pending: phase 3 held for the operator');
    expect(view).toContain('Worker last said: Both are running. Worker 1 is in the transfer handler.');
    expect(view).toContain('--- END STATE ---');
  });

  it('is deterministic: identical input produces byte-identical output', () => {
    expect(renderStateView(snapshot, emptyHarness)).toBe(renderStateView(snapshot, emptyHarness));
  });

  it('shows none-when-empty instead of inventing content', () => {
    const view = renderStateView({}, emptyHarness);
    expect(view).toContain('Workers: none');
    expect(view).not.toContain('Recent activity:');
  });

  it('is bounded: long inputs are clipped to the documented limits', () => {
    const long = 'x'.repeat(5000);
    const bloated: WorkerStateSnapshot = {
      activity: long,
      recentEvents: Array.from({ length: 50 }, (_, i) => `event ${i} ${long}`),
      children: Array.from({ length: 50 }, (_, i) => `child ${i} ${long}`),
      pendingItems: Array.from({ length: 50 }, (_, i) => `item ${i} ${long}`),
      lastAssistantText: long,
    };
    const view = renderStateView(bloated, emptyHarness);
    // Every clipped piece stays within its cap.
    const workersLine = view.split('\n').find(l => l.startsWith('Workers:')) as string;
    for (const piece of workersLine.slice('Workers: '.length).split(' | ')) {
      expect(piece.length).toBeLessThanOrEqual(STATE_VIEW_LIMITS.childChars + 2); // ellipsis allowance
    }
    // Counts are capped.
    expect(view.match(/event \d+/g)?.length).toBeLessThanOrEqual(STATE_VIEW_LIMITS.recentEvents);
    expect(view.match(/child \d+/g)?.length).toBeLessThanOrEqual(STATE_VIEW_LIMITS.children);
    expect(view.match(/item \d+/g)?.length).toBeLessThanOrEqual(STATE_VIEW_LIMITS.pendingItems);
    // Overall bounded: a pathological snapshot cannot produce an unbounded view.
    expect(view.length).toBeLessThan(6000);
  });

  it('injects the pending proposal verbatim with its explanation', () => {
    const harness: HarnessView = {
      pendingUtterance: 'tell the worker to hold phase 3 until my review',
      pendingAgeTurns: 1,
      lastReleased: null,
    };
    const view = renderStateView(snapshot, harness);
    expect(view).toContain('--- PENDING INSTRUCTION ---');
    expect(view).toContain('tell the worker to hold phase 3 until my review');
    expect(view).toContain('only if the operator explicitly confirms');
  });

  it('injects the last released instruction with its delivery outcome', () => {
    const harness: HarnessView = {
      pendingUtterance: null,
      pendingAgeTurns: null,
      lastReleased: { text: 'hold phase 3', outcome: 'delivered (steer)' },
    };
    const view = renderStateView(snapshot, harness);
    expect(view).toContain('--- LAST RELEASED ---');
    expect(view).toContain('hold phase 3');
    expect(view).toContain('delivered (steer)');
  });

  it('never contains a secrets-shaped token passed through state fields', () => {
    // The projection cannot redact arbitrary strings, but the snapshot contract
    // is structured summaries only; this pins that the renderer adds no ambient
    // material of its own (no env, no keys, no file contents machinery).
    const view = renderStateView(snapshot, emptyHarness);
    expect(view).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(view).not.toMatch(/API[_-]?KEY/i);
  });
});
