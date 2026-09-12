/**
 * The state view: a bounded, deterministic projection of worker state that is
 * the talker's entire world (plan §10.9, Phase 1 contract).
 *
 * Guarantees pinned by tests:
 *   - deterministic (same input → byte-identical output);
 *   - bounded (field counts and lengths are capped; a pathological snapshot
 *     cannot produce an unbounded view);
 *   - structured summaries only — there is no field by which file contents or
 *     secrets could enter, and the renderer adds no ambient material.
 *
 * Rebuilt by the harness before every turn: the talker never sees stale state
 * and its context size is independent of session length.
 */

import type { HarnessView, WorkerStateSnapshot } from './types.js';

export const STATE_VIEW_LIMITS = {
  recentEvents: 6,
  eventChars: 120,
  children: 8,
  childChars: 160,
  pendingItems: 5,
  pendingChars: 120,
  lastAssistantChars: 400,
  activityChars: 160,
} as const;

export function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function elapsedLabel(snapshot: WorkerStateSnapshot): string {
  if (snapshot.elapsedLabel) return snapshot.elapsedLabel;
  if (typeof snapshot.startedAtEpochMs === 'number') {
    const seconds = Math.max(0, Math.round((Date.now() - snapshot.startedAtEpochMs) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
  }
  return 'unknown';
}

export function renderStateView(snapshot: WorkerStateSnapshot, harness: HarnessView): string {
  const lines: string[] = ['--- WORKER STATE ---', `Elapsed: ${elapsedLabel(snapshot)}`];

  if (snapshot.activity) lines.push(`Worker: ${clip(snapshot.activity, STATE_VIEW_LIMITS.activityChars)}`);

  if (snapshot.recentEvents?.length) {
    const events = snapshot.recentEvents
      .slice(-STATE_VIEW_LIMITS.recentEvents)
      .map(e => clip(e, STATE_VIEW_LIMITS.eventChars));
    lines.push(`Recent activity: ${events.join(' | ')}`);
  }

  lines.push(
    snapshot.children?.length
      ? `Workers: ${snapshot.children.slice(-STATE_VIEW_LIMITS.children).map(c => clip(c, STATE_VIEW_LIMITS.childChars)).join(' | ')}`
      : 'Workers: none'
  );

  if (snapshot.pendingItems?.length) {
    const items = snapshot.pendingItems.slice(-STATE_VIEW_LIMITS.pendingItems).map(i => clip(i, STATE_VIEW_LIMITS.pendingChars));
    lines.push(`Pending: ${items.join(' | ')}`);
  }

  if (snapshot.lastAssistantText) {
    lines.push(`Worker last said: ${clip(snapshot.lastAssistantText, STATE_VIEW_LIMITS.lastAssistantChars)}`);
  }

  if (harness.pendingUtterance) {
    lines.push(
      '--- PENDING INSTRUCTION ---',
      `The operator said: "${harness.pendingUtterance}"`,
      'It is held for delivery and will be sent only if the operator explicitly confirms.' +
        (harness.pendingAgeTurns !== null ? ` It has been waiting for ${harness.pendingAgeTurns} operator turn(s).` : '')
    );
  }

  if (harness.lastReleased) {
    lines.push('--- LAST RELEASED ---', `"${harness.lastReleased.text}" — ${harness.lastReleased.outcome}`);
  }

  lines.push('--- END STATE ---');
  return lines.join('\n');
}
