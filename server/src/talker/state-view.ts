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
  draftUtterances: 8,
  draftChars: 200,
} as const;

/**
 * P20 — the worker session's recent conversation in the projection.
 *
 * The choice, made explicit: a RECENT-WINDOW view, not a transcript. A worker
 * session can be enormous, so the block carries at most the last 12
 * conversation messages, each clipped to 400 chars, under a 3600-char budget
 * for the block as a whole — roughly a screenful, the same order as the rest
 * of the state view, and a talker context that stays independent of session
 * length (plan §10.9). The newest tail is kept because "what happened
 * earlier?" is overwhelmingly about the recent stretch of a mid-session
 * attach; anything older is handled honestly: the block states exactly how
 * many messages it does not include, the prompt tells the talker never to
 * imply knowledge beyond the window, and the unchanged [[ask-worker]] offer
 * remains the fallback for questions that exceed it.
 */
export const SESSION_HISTORY_LIMITS = {
  /** Max conversation messages shown (the newest tail; rendered oldest first). */
  entries: 12,
  /** Per-message clip. */
  entryChars: 400,
  /** Total budget for the block's entry lines, enforced newest-first. */
  totalChars: 3600,
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

/**
 * The bounded WORKER SESSION HISTORY block (P20), or null when the provider
 * supplied no history — absence is the honest statement that nothing earlier
 * is visible here. Entries are taken newest-first (the newest tail is what a
 * mid-session question is mostly about) and rendered oldest-first. The
 * disclosure line states the window's coverage with exact counts: complete
 * when nothing is hidden, otherwise how many messages are not included.
 */
function renderSessionHistory(snapshot: WorkerStateSnapshot): string[] | null {
  const all = snapshot.recentHistory ?? [];
  if (all.length === 0) return null;
  const total = Math.max(snapshot.historyTotal ?? all.length, all.length);

  const windowed = all.slice(-SESSION_HISTORY_LIMITS.entries);
  const shown: Array<{ label: string; text: string }> = [];
  let budget = SESSION_HISTORY_LIMITS.totalChars;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const entry = windowed[i];
    const text = clip(entry.text, SESSION_HISTORY_LIMITS.entryChars);
    const cost = text.length + 12; // "operator: " / "worker: " + newline
    if (shown.length > 0 && budget - cost < 0) break; // budget spent; the older tail is disclosed, not hidden
    budget -= cost;
    shown.unshift({ label: entry.role === 'assistant' ? 'worker' : 'operator', text });
  }
  const hidden = Math.max(0, total - shown.length);

  const lines = ['--- WORKER SESSION HISTORY ---'];
  lines.push(
    hidden > 0
      ? `Showing the most recent ${shown.length} of ${total} messages; ${hidden} earlier are not included.`
      : `All ${shown.length} messages of the session so far are shown.`
  );
  for (const s of shown) lines.push(`${s.label}: ${s.text}`);
  return lines;
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
  const historyBlock = renderSessionHistory(snapshot);
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
