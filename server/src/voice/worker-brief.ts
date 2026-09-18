/**
 * The voice lane's brief policy — how much of the worker session the live talker
 * holds, and how it reaches the rest.
 *
 * MEASURED, not assumed (`docs/plans/VOICE-TALKER-FULL-SESSION-BRIEF.md`):
 * on the real provider, with the real instruction and a fact buried at the very
 * start of the brief, a full session is effectively free up to ~82k tokens
 * (injection 1.6 s, answer 1.5 s, needle recalled) and the lane is **dead** from
 * ~100k tokens (the injection turn never completes and the talker says nothing).
 * So the 12k-character cap the lane shipped with was not buying latency, and
 * "always send everything" would brick exactly the long sessions where the
 * question matters most.
 *
 * The policy that follows:
 *   - **full**: the whole session, while it fits under the measured ceiling;
 *   - **recent**: a bounded recent view above it, which SAYS what it is not
 *     showing, plus on-demand retrieval for the rest (intent §19.3);
 *   - **delta**: after the first injection, only the messages the model has not
 *     been told about — a live session accumulates context, and re-sending a
 *     40k-token brief on every change is what walks it into the stall;
 *   - **none**: nothing new, so nothing is sent.
 *
 * This module is pure: it decides, it renders nothing itself, and it authorises
 * nothing. History is data, never authority.
 */
import type { WorkerHistoryEntryLike } from '../worker-history-view.js';
import { clip, renderSessionHistory } from '../worker-history-view.js';

export const VOICE_BRIEF_LIMITS = {
  /** The whole session while its rendering fits here (~50k tokens). */
  fullMaxChars: 200_000,
  /** Above the ceiling: a bounded recent view, sized like the relay lane's. */
  recentChars: 12_000,
  recentEntries: 40,
  /** Per-message clips stay the proven ones; a single huge message cannot eat the budget. */
  entryChars: 2_000,
  assistantChars: 6_000,
  /** Retrieval bounds. */
  searchCharBudget: 40_000,
  searchDefaultLimit: 5,
} as const;

export type VoiceBriefMode = 'full' | 'recent' | 'delta' | 'none';

export interface VoiceBriefPlan {
  mode: VoiceBriefMode;
  /** The lines to inject (empty when the mode is `none`). */
  lines: string[];
  /**
   * How many source entries the model holds once these lines are delivered.
   * The next delta is computed from this, so it must only advance when the
   * caller has actually handed the text over.
   */
  acknowledgedEntries: number;
}

export interface VoiceBriefInput {
  entries: readonly WorkerHistoryEntryLike[];
  /** Total messages the host saw (may exceed `entries` when the source is tailed). */
  total?: number;
  /** How many entries the model already holds (0 = nothing yet). */
  acknowledgedEntries: number;
}

const CONTENT_HEADER = '--- WORKER SESSION HISTORY ---';
const CONTINUED_HEADER = '--- WORKER SESSION HISTORY (new since your last update) ---';

function sizeOf(lines: string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/**
 * What the session costs to send, from the SOURCE rather than from a rendering:
 * a rendered size is capped by the budget it was given, so comparing it to that
 * budget would always say "it fits" — including when it truncated.
 */
function sourceChars(entries: readonly WorkerHistoryEntryLike[]): number {
  return entries.reduce((sum, entry) => sum + Math.min(entry.text.length, VOICE_BRIEF_LIMITS.assistantChars) + 12, 0);
}

function renderFull(entries: readonly WorkerHistoryEntryLike[], total: number): string[] | null {
  return renderSessionHistory(
    { entries, total },
    {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxChars: VOICE_BRIEF_LIMITS.fullMaxChars,
      entryChars: VOICE_BRIEF_LIMITS.entryChars,
      assistantChars: VOICE_BRIEF_LIMITS.assistantChars,
    },
  );
}

function renderRecent(entries: readonly WorkerHistoryEntryLike[], total: number): string[] | null {
  return renderSessionHistory(
    { entries, total },
    {
      maxEntries: VOICE_BRIEF_LIMITS.recentEntries,
      maxChars: VOICE_BRIEF_LIMITS.recentChars,
      entryChars: VOICE_BRIEF_LIMITS.entryChars,
      assistantChars: VOICE_BRIEF_LIMITS.assistantChars,
    },
  );
}

/** Decide what (if anything) the lane should inject now. Pure. */
export function planWorkerBrief(input: VoiceBriefInput): VoiceBriefPlan {
  const entries = input.entries ?? [];
  const total = Math.max(input.total ?? entries.length, entries.length);
  if (entries.length === 0) {
    return { mode: 'none', lines: [], acknowledgedEntries: Math.max(0, input.acknowledgedEntries) };
  }

  // First contact: the whole session if it fits, otherwise the honest bounded view.
  if (input.acknowledgedEntries <= 0) {
    if (sourceChars(entries) <= VOICE_BRIEF_LIMITS.fullMaxChars) {
      const full = renderFull(entries, total);
      return { mode: 'full', lines: full ?? [], acknowledgedEntries: entries.length };
    }
    return {
      mode: 'recent',
      lines: renderRecent(entries, total) ?? [],
      acknowledgedEntries: entries.length,
    };
  }

  if (entries.length <= input.acknowledgedEntries) {
    return { mode: 'none', lines: [], acknowledgedEntries: input.acknowledgedEntries };
  }

  // New work: send only what the model has not been told about. (If a whole large
  // session appeared at once, that delta would be huge — re-state the bounded
  // view instead of dumping it into a live context that accumulates.)
  const fresh = entries.slice(input.acknowledgedEntries);
  const delta = renderSessionHistory(
    { entries: fresh, total },
    {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxChars: VOICE_BRIEF_LIMITS.fullMaxChars,
      entryChars: VOICE_BRIEF_LIMITS.entryChars,
      assistantChars: VOICE_BRIEF_LIMITS.assistantChars,
      header: CONTINUED_HEADER,
    },
  );
  if (!delta) return { mode: 'none', lines: [], acknowledgedEntries: input.acknowledgedEntries };
  if (sourceChars(fresh) > VOICE_BRIEF_LIMITS.fullMaxChars) {
    return {
      mode: 'recent',
      lines: renderRecent(entries, total) ?? [],
      acknowledgedEntries: entries.length,
    };
  }
  // The disclosure in a continued block refers to the fresh slice, so say what
  // the model is NOT seeing overall — it must never imply it has read it all.
  return { mode: 'delta', lines: delta, acknowledgedEntries: entries.length };
}

export interface WorkerHistorySearchResult {
  /** How many messages matched (not how many were shown). */
  matches: number;
  /** How many messages were searched. */
  searched: number;
  /** The bounded, labelled block to hand the talker (data, never instruction). */
  text: string;
}

/**
 * Read-only retrieval over the worker session (intent §19.3): the talker may ask
 * for more than its standing recent view holds. An empty query reads the START of
 * the session, which is the other thing a newest-first view cannot reach.
 *
 * The result is always explicit about what was searched and how many matched, so
 * "I could not find it" is a fact rather than a silence, and a session that does
 * not contain the thing cannot be answered from invention.
 */
export function searchWorkerHistory(
  entries: readonly WorkerHistoryEntryLike[],
  query: string,
  options: { limit?: number } = {},
): WorkerHistorySearchResult {
  const limit = Math.max(1, options.limit ?? VOICE_BRIEF_LIMITS.searchDefaultLimit);
  const searched = entries.length;
  const label = (entry: WorkerHistoryEntryLike): string => (entry.role === 'assistant' ? 'worker' : 'operator');

  if (query.trim().length === 0) {
    const earliest = entries.slice(0, limit);
    const lines = ['--- WORKER HISTORY (earliest messages, as requested) ---'];
    lines.push(`Read the earliest ${earliest.length} of ${searched} messages in this session.`);
    for (const entry of earliest) lines.push(`${label(entry)}: ${clip(entry.text, VOICE_BRIEF_LIMITS.entryChars)}`);
    return { matches: earliest.length, searched, text: lines.join('\n') };
  }

  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const scored: Array<{ entry: WorkerHistoryEntryLike; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const haystack = entry.text.toLowerCase();
    let score = 0;
    for (const token of tokens) if (haystack.includes(token)) score += 1;
    if (score > 0) scored.push({ entry, score, index });
  });

  if (scored.length === 0) {
    return {
      matches: 0,
      searched,
      text:
        `No message in this session matches "${query.trim().slice(0, 200)}". ` +
        `Searched ${searched} messages. Say plainly that it is not in the session; do not guess.`,
    };
  }

  // Best matches first; newest wins a tie (recent work usually supersedes).
  scored.sort((a, b) => b.score - a.score || b.index - a.index);
  const chosen: typeof scored = [];
  let budget = VOICE_BRIEF_LIMITS.searchCharBudget;
  for (const candidate of scored) {
    if (chosen.length >= limit) break;
    const rendered = clip(candidate.entry.text, VOICE_BRIEF_LIMITS.entryChars);
    const cost = rendered.length + 12;
    if (chosen.length > 0 && budget - cost < 0) break;
    budget -= cost;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => a.index - b.index); // read in session order, oldest first

  const lines = ['--- WORKER HISTORY (retrieved from earlier in this session) ---'];
  lines.push(
    `Found ${scored.length} matching message${scored.length === 1 ? '' : 's'}; ` +
      `searched ${searched} messages in this session; showing ${chosen.length}, oldest first.`
  );
  for (const match of chosen) lines.push(`${label(match.entry)}: ${clip(match.entry.text, VOICE_BRIEF_LIMITS.entryChars)}`);
  return { matches: scored.length, searched, text: lines.join('\n') };
}
