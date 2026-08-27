/**
 * Cross-runtime goal function (contract 1.27.0) — browser bridge tests.
 * The synthesized messages must fit the exact grammar the client goalStore
 * already parses (extension_status / widget_content / notification).
 */
import { describe, it, expect } from 'vitest';
import {
  buildGoalStatusText,
  buildGoalWidgetLines,
  buildGoalBrowserMessages,
} from '../../../../src/internal-api/goal/browser-bridge.js';

const RUNNING = { supported: true, status: 'running' as const, objective: 'Process 160 species', runs: 3, maxRuns: 10 };
const ACHIEVED = { ...RUNNING, status: 'achieved' as const, completedAt: 1787840000000 };

describe('browser bridge', () => {
  it('running: status text carries the phase and run; widget lines parse-ready', () => {
    expect(buildGoalStatusText(RUNNING)).toBe('🎯 ▶ Running — Run 3');
    const lines = buildGoalWidgetLines(RUNNING);
    expect(lines[0]).toBe('🎯 Goal Status');
    expect(lines).toEqual(expect.arrayContaining([
      'Status: ▶ Running',
      'Objective: Process 160 species',
      'Agent runs: 3',
      'Max runs: 10',
    ]));
  });

  it('achieved: status clears (undefined triggers client archive) and a completion notification matches the client outcome regex', () => {
    expect(buildGoalStatusText(ACHIEVED)).toBeUndefined();
    const messages = buildGoalBrowserMessages('s1', ACHIEVED);
    const notification = messages.find((m) => m.type === 'notification') as any;
    expect(notification.notification.message).toMatch(/🎯 Goal achieved in 3 agent runs/);
    expect(messages.some((m) => m.type === 'widget_cleared')).toBe(true);
  });

  it('every message carries the goal keys the client filters on', () => {
    for (const m of buildGoalBrowserMessages('s1', RUNNING)) {
      expect(m.sessionId).toBe('s1');
    }
    const [status, widget] = buildGoalBrowserMessages('s1', RUNNING);
    expect((status as any).status.key).toBe('goal-engine');
    expect((widget as any).key).toBe('goal-engine-status');
  });
});
