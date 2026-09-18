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
import {
  clip,
  renderSessionHistory,
  SESSION_HISTORY_LIMITS,
  type WorkerHistoryBlockLike,
} from '../worker-history-view.js';

export const STATE_VIEW_LIMITS = {
  recentEvents: 6,
  eventChars: 120,
  children: 8,
  childChars: 160,
  pendingItems: 5,
  pendingChars: 120,
  lastAssistantChars: 400,
  activityChars: 160,
  draftUtterances: 8,
  draftChars: 200,
} as const;

/**
 * P20/P23 — the worker session's conversation in the projection.
 *
 * The choice, made explicit: a BUDGET-SELECTED view, not a transcript. A
 * worker session can be enormous, so the block carries at most a fixed char
 * budget of conversation, selected newest-first — a talker context that stays
 * independent of session length (plan §10.9).
 *
 * P23 (live defect, proven from a real worker session): the P20 flat
 * newest-12 window with a 400-char clip could not answer "summarise the
 * production queue". The session's substance — a 3,472-char assistant answer
 * whose numbered items sat at offsets 448/1377/2099 — was either crowded
 * toward exclusion by newer short bookkeeping messages (10 of the 12 window
 * slots) or, when present, amputated above its first numbered item. The fix
 * is weighting, not a bigger blind ceiling:
 *
 *   - the flat count window is GONE; the char budget is the selector, walked
 *     newest-first. Short messages cost little, so bookkeeping can no longer
 *     crowd substance out by count;
 *   - the worker's OWN messages get a much deeper per-message allowance
 *     (`assistantChars`) than the operator's (`entryChars`), so a long
 *     answer's numbered structure survives. This is the deliberate cost:
 *     the block can reach ~3x the old size, still hard-bounded;
 *   - the count cap remains only as a line-count guard;
 *   - honesty is unchanged and extended: exact counts of what is shown and
 *     what is not, plus an explicit note when shown messages are shortened.
 *     The prompt's never-imply-knowledge-beyond-the-window rule and the
 *     [[ask-worker]] fallback are untouched.
 */
function elapsedLabel(snapshot: WorkerStateSnapshot): string {
  if (snapshot.elapsedLabel) return snapshot.elapsedLabel;
  if (typeof snapshot.startedAtEpochMs === 'number') {
    const seconds = Math.max(0, Math.round((Date.now() - snapshot.startedAtEpochMs) / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes > 0 ? `${minutes}m${seconds % 60}s` : `${seconds}s`;
  }
  return 'unknown';
}

/**
 * The bounded WORKER SESSION HISTORY block (P20, selection reworked by P23),
 * or null when the provider supplied no history — absence is the honest
 * statement that nothing earlier is visible here.
 *
 * Selection (P23): newest-first budget walk over the provider's entries — no
 * flat count pre-window. Each entry costs its clipped length plus label
 * overhead against `totalChars`; the operator's entries clip to `entryChars`,
 * the worker's own to `assistantChars`. The newest entry is always shown even
 * if alone it exceeds the budget. The walk STOPS when the next older entry no
 * longer fits, so what is shown is always the most recent contiguous run —
 * which is exactly what the disclosure line then states. Entries are rendered
 * oldest-first. Any shortened message is disclosed, and the coverage line
 * gives exact counts: complete when nothing is hidden, otherwise how many
 * messages are not included.
 */
export { clip, renderSessionHistory, SESSION_HISTORY_LIMITS };

/** Adapt the talker's snapshot to the neutral block shape (one definition). */
function historyBlockFor(snapshot: WorkerStateSnapshot): WorkerHistoryBlockLike | null {
  if (!snapshot.recentHistory || snapshot.recentHistory.length === 0) return null;
  return { entries: snapshot.recentHistory, ...(snapshot.historyTotal !== undefined ? { total: snapshot.historyTotal } : {}) };
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

  // P20: the session's earlier turns, so a mid-session question about them is
  // answerable from real history. Absent when the provider supplied none.
  const historyBlock = renderSessionHistory(historyBlockFor(snapshot));
  if (historyBlock) lines.push(...historyBlock);

  if (harness.draft && harness.draft.utterances.length > 0) {
    const { utterances, ageTurns, needsReConfirmation } = harness.draft;
    lines.push('--- PENDING INSTRUCTION ---');
    if (utterances.length === 1) {
      lines.push(`The operator said: "${clip(utterances[0], STATE_VIEW_LIMITS.draftChars)}"`);
    } else {
      // A multi-part draft (plan §4.2): every part is the operator's verbatim
      // words, numbered so the talker can ask which part the operator means.
      const shown = utterances.slice(-STATE_VIEW_LIMITS.draftUtterances);
      const hidden = utterances.length - shown.length;
      lines.push(`The operator is composing an instruction in ${utterances.length} part(s), held verbatim:`);
      shown.forEach((u, i) => lines.push(`${i + 1 + hidden}. "${clip(u, STATE_VIEW_LIMITS.draftChars)}"`));
      if (hidden > 0) lines.push(`(${hidden} earlier part(s) not shown)`);
    }
    let heldLine = 'It is held for delivery and will be sent only if the operator explicitly confirms.';
    if (ageTurns !== null) heldLine += ` It has been waiting for ${ageTurns} operator turn(s).`;
    lines.push(heldLine);
    if (needsReConfirmation) {
      lines.push(
        'Its confirmation window has lapsed: nothing will be sent until the operator explicitly re-confirms. Offer it back to the operator.'
      );
    }
  }

  if (harness.lastReleased) {
    lines.push('--- LAST RELEASED ---', `"${harness.lastReleased.text}" — ${harness.lastReleased.outcome}`);
  }

  if (harness.operatorFocus) {
    // P18/2: the operator's focus control is ON. The talker is told the truth
    // about the mechanism — it cannot switch it — so the only thing it can
    // usefully do is suggest.
    lines.push(
      '--- OPERATOR FOCUS ---',
      'The operator has FOCUS ON: the worker\'s answers are NOT being spoken to them, so they can concentrate on talking with you.',
      'If something genuinely needs their attention, say so briefly and suggest they leave focus. It is their control: you cannot switch it, so never claim you did.'
    );
  }

  lines.push('--- END STATE ---');
  return lines.join('\n');
}
