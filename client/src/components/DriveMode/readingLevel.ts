/**
 * readingLevel — the three reading levels, and the decision of what speaks
 * (Voice Mode P17, package A of docs/plans/VOICE-READING-AND-QA-DESIGN.md).
 *
 * THE REFRAME THIS ENCODES. The verbosity the operator complained about was
 * never the talker being chatty: the worker's final answer was read VERBATIM by
 * the auto-speak path — raw text straight to TTS, with no talker involvement at
 * all. A reading level is therefore PUTTING THE TALKER INTO THE READING PATH
 * WHERE THERE CURRENTLY IS NONE: instead of submitting the raw answer at tier 3,
 * the surface submits a digest the talker produced.
 *
 *   Verbatim   the worker's words, word for word — errors, exact commands
 *   Summary    the talker's digest of the turn — the default
 *   Headlines  status + asks, one line: "Done: X. Needs you: Y." — always-on
 *
 * Headlines is NOT a shorter Summary. It is a different extraction answering a
 * different question (what changed, and what waits on me?) which is exactly why
 * it can be left on permanently: it carries signal, not narration.
 *
 * ONE DIRECTION ONLY. Nothing in this module can condense the operator's words.
 * The operator → worker path stays verbatim, always: the gate exists for that
 * fidelity. This module only ever chooses how the WORKER's output is spoken.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ReadingLevel = 'verbatim' | 'summary' | 'headlines';

/** The two digests the talker can produce (never a third: a digest is either a
 *  condensation of the turn or the one-line status extraction). */
export type TurnDigestKind = 'summary' | 'headlines';

export const READING_LEVELS: readonly ReadingLevel[] = ['verbatim', 'summary', 'headlines'];
export const DIGEST_KINDS: readonly TurnDigestKind[] = ['summary', 'headlines'];

export const READING_LEVEL_LABEL: Record<ReadingLevel, string> = {
  verbatim: 'Verbatim',
  summary: 'Summary',
  headlines: 'Headlines',
};

/** What the operator hears unless they choose otherwise (design: Summary). */
export const DEFAULT_READING_LEVEL: ReadingLevel = 'summary';

/**
 * SHORT_TURN_VERBATIM_CHARS — the named threshold, because the number is a
 * decision and not a magic value.
 *
 * ~30 seconds of speech at a comfortable TTS rate (~13 characters a second).
 * Under it, summarising is pure overhead — a model call of a second or more to
 * compress two sentences — AND it risks distorting words that were already
 * short enough to hear. So a short turn is spoken verbatim even in Summary mode.
 *
 * Headlines is deliberately EXEMPT (see planSpeechForText): in Headlines mode
 * the operator asked for signal only, not fidelity, so they always get the line.
 */
export const SHORT_TURN_VERBATIM_CHARS = 400;

/** The audible marker on a Summary digest. The one dangerous failure of
 *  summarisation is not knowing whether you heard everything, so the surface
 *  says plainly that what follows is a condensation — the same marker wherever
 *  a summary speaks (the normal path and the mid-speech flip alike). */
export const IN_SHORT_PREFIX = 'In short: ';

export type SpeechPlan =
  | { kind: 'read'; text: string }
  | { kind: 'digest'; digestKind: TurnDigestKind };

/**
 * What speaks for a piece of the worker's output at a given level. Used for the
 * whole turn at turn end AND for the unplayed remainder after a mid-speech flip
 * — the same rule both times, so the flip is never a special case with its own
 * behaviour.
 */
export function planSpeechForText(level: ReadingLevel, text: string): SpeechPlan {
  const trimmed = text.trim();
  if (level === 'verbatim') return { kind: 'read', text: trimmed };
  if (level === 'headlines') return { kind: 'digest', digestKind: 'headlines' };
  return trimmed.length < SHORT_TURN_VERBATIM_CHARS
    ? { kind: 'read', text: trimmed }
    : { kind: 'digest', digestKind: 'summary' };
}

/**
 * The words to speak for a digest: the summary marker for a Summary, and the
 * line itself for Headlines (its "Done: … / Needs you: …" shape is the marker).
 * Null when there is nothing to say — an empty digest must never be spoken as
 * if it were the turn.
 */
export function digestSpokenText(kind: TurnDigestKind, digest: string): string | null {
  const clean = digest.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return kind === 'summary' ? `${IN_SHORT_PREFIX}${clean}` : clean;
}

/**
 * The part of the turn the operator has NOT heard yet, by chunk.
 *
 * Chunks are the surface's unit of speech, and a chunk boundary is the only
 * scheduling point (arbiter §4.1), so "what remains unplayed" is exactly the
 * chunks after the one in flight: the chunk in flight finishes before anything
 * else is spoken, so it counts as heard.
 */
export function remainderAfterChunks(chunks: readonly string[], heardChunks: number): string {
  const from = Math.max(0, Math.floor(heardChunks));
  return chunks
    .slice(from)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .join(' ');
}

export const READING_LEVEL_STORAGE_KEY = 'pi-web-ui:reading-level';

export function isReadingLevel(value: unknown): value is ReadingLevel {
  return value === 'verbatim' || value === 'summary' || value === 'headlines';
}

interface ReadingLevelState {
  level: ReadingLevel;
  setLevel: (level: ReadingLevel) => void;
}

/**
 * The operator's default, persisted (localStorage) so it survives reloads: the
 * level is a working preference — "headphones while doing other work" means it
 * has to still be on when the phone is unlocked again.
 */
export const useReadingLevelStore = create<ReadingLevelState>()(
  persist(
    (set) => ({
      level: DEFAULT_READING_LEVEL,
      setLevel: (level) => set({ level: isReadingLevel(level) ? level : DEFAULT_READING_LEVEL }),
    }),
    {
      name: READING_LEVEL_STORAGE_KEY,
      // Only the choice is persisted; the action is not data.
      partialize: (state) => ({ level: state.level }),
      // A stored value from an older/newer surface is never trusted blindly.
      merge: (persisted, current) => {
        const stored = (persisted as { level?: unknown } | undefined)?.level;
        return { ...current, level: isReadingLevel(stored) ? stored : current.level };
      },
    }
  )
);

/**
 * Test seam: drop the in-memory choice and take whatever is in storage, applying
 * the same guard a real reload applies.
 */
export function resetReadingLevelStore(): void {
  useReadingLevelStore.setState({ level: readPersistedReadingLevel() });
}

function readPersistedReadingLevel(): ReadingLevel {
  try {
    const raw = localStorage.getItem(READING_LEVEL_STORAGE_KEY);
    if (!raw) return DEFAULT_READING_LEVEL;
    const parsed = JSON.parse(raw) as { state?: { level?: unknown } };
    return isReadingLevel(parsed?.state?.level) ? parsed.state.level : DEFAULT_READING_LEVEL;
  } catch {
    return DEFAULT_READING_LEVEL;
  }
}
