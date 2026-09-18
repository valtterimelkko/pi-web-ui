/**
 * The bounded worker-session history projection — ONE implementation, two lanes.
 *
 * This lives in a neutral module rather than under `talker/` for two reasons,
 * both structural:
 *   1. the native voice lane needs exactly the same projection as the relay
 *      lane, and two lanes describing the same worker must never disagree about
 *      what it has done;
 *   2. the voice layer is architecturally forbidden from importing the talker's
 *      delivery module (D7 — the kernel owns releases), and that guard is
 *      right: a shared view is not a shared authority.
 *
 * The rules are the proven ones (P20, P23):
 *   - selection is a BUDGET walk, newest-first, never a flat count window, so
 *     short bookkeeping messages cannot crowd out substance;
 *   - the worker's own messages clip far deeper than the operator's, so a long
 *     answer's numbered structure survives;
 *   - the block always discloses what it is NOT showing (exact counts) and
 *     whether anything was shortened — absence is stated, never implied away.
 *
 * Data, never authority: nothing here can authorise a delivery.
 */

export interface WorkerHistoryEntryLike {
  role: 'user' | 'assistant';
  text: string;
}

export interface WorkerHistoryBlockLike {
  /** Oldest first. */
  entries: readonly WorkerHistoryEntryLike[];
  /** Total conversation messages the host saw, for honest disclosure. */
  total?: number;
}

export const SESSION_HISTORY_LIMITS = {
  /** Line-count guard; the char budget below is the primary bound. */
  entries: 40,
  /** Per-message clip for the operator's (user) messages. */
  entryChars: 400,
  /** Per-message clip for the worker's own (assistant) messages — deep enough
   *  for a long answer's numbered items (the P23 case had them at ~2100). */
  assistantChars: 2200,
  /** Total budget for the block's entry lines, enforced newest-first. */
  totalChars: 12000,
} as const;

export function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * The bounded WORKER SESSION HISTORY block, or null when there is no history at
 * all — absence is the honest statement that nothing earlier is visible here.
 */
export interface WorkerHistoryRenderOptions {
  /** Line-count guard (default: the relay lane's `SESSION_HISTORY_LIMITS.entries`). */
  maxEntries?: number;
  /** Total character budget for entry lines (default: the relay lane's). */
  maxChars?: number;
  /** Per-message clip for the operator's messages. */
  entryChars?: number;
  /** Per-message clip for the worker's own messages. */
  assistantChars?: number;
  /** Opening line; defaults to the standing block header. */
  header?: string;
}

export function renderSessionHistory(
  history: WorkerHistoryBlockLike | null | undefined,
  options: WorkerHistoryRenderOptions = {},
): string[] | null {
  const all = history?.entries ?? [];
  if (all.length === 0) return null;
  const total = Math.max(history?.total ?? all.length, all.length);
  const limits = {
    entries: options.maxEntries ?? SESSION_HISTORY_LIMITS.entries,
    maxChars: options.maxChars ?? SESSION_HISTORY_LIMITS.totalChars,
    entryChars: options.entryChars ?? SESSION_HISTORY_LIMITS.entryChars,
    assistantChars: options.assistantChars ?? SESSION_HISTORY_LIMITS.assistantChars,
  };

  const shown: Array<{ label: string; text: string }> = [];
  let budget = limits.maxChars;
  let shortened = false;
  const first = Math.max(0, all.length - limits.entries);
  for (let i = all.length - 1; i >= first; i--) {
    const entry = all[i];
    const allowance = entry.role === 'assistant' ? limits.assistantChars : limits.entryChars;
    const normalisedLength = entry.text.replace(/\s+/g, ' ').trim().length;
    if (normalisedLength > allowance) shortened = true;
    const text = clip(entry.text, allowance);
    const cost = text.length + 12; // "operator: " / "worker: " + newline
    if (shown.length > 0 && budget - cost < 0) break; // budget spent; the older tail is disclosed, not hidden
    budget -= cost;
    shown.unshift({ label: entry.role === 'assistant' ? 'worker' : 'operator', text });
  }
  const hidden = Math.max(0, total - shown.length);

  const lines = [options.header ?? '--- WORKER SESSION HISTORY ---'];
  lines.push(
    hidden > 0
      ? `Showing the most recent ${shown.length} of ${total} messages; ${hidden} earlier are not included.`
      : `All ${shown.length} messages of the session so far are shown.`
  );
  if (shortened) lines.push('Some shown messages are shortened to fit (they end with …).');
  for (const s of shown) lines.push(`${s.label}: ${s.text}`);
  return lines;
}
