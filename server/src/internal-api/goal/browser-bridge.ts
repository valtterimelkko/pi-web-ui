/**
 * Cross-runtime goal function (contract 1.27.0) — browser bridge.
 *
 * The browser goal surface (GoalPanel, goal tag, goalStore) is fed by the
 * Pi/OpenCode "extension UI" message grammar: `extension_status` (key
 * 'goal-engine'), `widget_content` (key 'goal-engine-status') and completion
 * notifications. Claude and Command Code have no extension UI channel, so the
 * server synthesizes the same message shapes from the canonical projection —
 * the client renders them with zero runtime-specific parsing.
 */

import type { SessionGoalProjection } from './types.js';

export const GOAL_STATUS_KEY = 'goal-engine';
export const GOAL_WIDGET_KEY = 'goal-engine-status';

export type GoalBrowserMessage = Record<string, unknown> & { sessionId: string };

const STATUS_LABELS: Record<string, string> = {
  running: '▶ Running',
  wrapping_up: '⏸ Wrapping up…',
  paused: '⏸ Paused',
  failed: '✖ Failed',
};

/** One-line footer/badge text; undefined = the goal UI should clear. */
export function buildGoalStatusText(projection: SessionGoalProjection): string | undefined {
  const label = STATUS_LABELS[projection.status];
  if (!label) return undefined;
  const run = typeof projection.runs === 'number' ? ` — Run ${projection.runs}` : '';
  return `🎯 ${label}${run}`;
}

/** Widget lines in the exact grammar the client's parseGoalWidget reads. */
export function buildGoalWidgetLines(projection: SessionGoalProjection): string[] {
  const lines: string[] = ['🎯 Goal Status'];
  lines.push(`Status: ${STATUS_LABELS[projection.status] ?? projection.status}`);
  if (projection.objective) lines.push(`Objective: ${projection.objective}`);
  if (typeof projection.runs === 'number') lines.push(`Agent runs: ${projection.runs}`);
  if (projection.maxRuns != null) lines.push(`Max runs: ${projection.maxRuns}`);
  if (projection.verification?.status && projection.verification.status !== 'not_run') {
    lines.push(`Verification status: ${projection.verification.status}`);
  }
  if (projection.verification?.message) lines.push(`Verification result: ${projection.verification.message}`);
  if (projection.completedAt != null) lines.push(`Completed: ${new Date(projection.completedAt).toISOString()}`);
  return lines;
}

/**
 * The browser messages for a goal projection: status (with text=undefined on
 * terminal/achieved to trigger the client's archive path), widget content, and
 * a completion notification phrased to match the client's outcome regexes.
 */
export function buildGoalBrowserMessages(sessionId: string, projection: SessionGoalProjection): GoalBrowserMessage[] {
  const messages: GoalBrowserMessage[] = [];
  const statusText = buildGoalStatusText(projection);
  messages.push({
    type: 'extension_status',
    sessionId,
    status: { key: GOAL_STATUS_KEY, text: statusText },
  });
  const objectiveLive = projection.status === 'running' || projection.status === 'paused' || projection.status === 'wrapping_up';
  if (objectiveLive) {
    messages.push({
      type: 'widget_content',
      sessionId,
      key: GOAL_WIDGET_KEY,
      content: buildGoalWidgetLines(projection),
    });
  } else {
    messages.push({ type: 'widget_cleared', sessionId, key: GOAL_WIDGET_KEY });
  }
  if (projection.status === 'achieved' && typeof projection.runs === 'number') {
    messages.push({
      type: 'notification',
      sessionId,
      notification: { message: `🎯 Goal achieved in ${projection.runs} agent runs`, type: 'success' },
    });
  }
  return messages;
}
