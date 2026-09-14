/**
 * useAnswerReader — the talker in the reading path (P17 package A).
 *
 * Before this existed the surface read the worker's final answer VERBATIM with
 * no talker involvement at all: raw text straight to TTS at tier 3. This hook is
 * where the reading level applies — it decides what speaks at turn end, asks the
 * talker for a digest when the level calls for one, and applies a level change
 * immediately and boundedly while an answer is being read.
 *
 * Rules this hook implements, and will not soften:
 *   - Summary and Headlines speak at TIER_ANSWER (3) — they are the answer,
 *     condensed, never tier 4 chatter (which would be dropped whenever anything
 *     else speaks, making the level silently unreliable).
 *   - A short turn speaks verbatim even in Summary (SHORT_TURN_VERBATIM_CHARS);
 *     Headlines is exempt, because there the operator asked for signal, not
 *     fidelity.
 *   - A mid-speech flip stops the current item at the NEXT CHUNK BOUNDARY —
 *     never mid-word — and digests only what the operator has not yet heard.
 *   - Nothing here can condense the operator's words. There is no send-to-worker
 *     path in this module at all.
 *
 * Playback only: nothing here gates capture, and a failed digest falls back to
 * reading the turn in full, so an answer can never be lost to a summariser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chunkIntoSentences,
  speechArbiter,
  TIER_ANSWER,
  type SpeechArbiter,
} from '../../lib/speechArbiter';
import { spokenLedger } from '../../lib/spokenLedger';
import type { TurnDigestKind, TurnDigestOutcome } from '../../lib/turnDigest';
import {
  digestSpokenText,
  planSpeechForText,
  remainderAfterChunks,
  type ReadingLevel,
} from './readingLevel';

/** Said visibly (and only visibly — speech stays clean) when the talker could
 *  not produce a digest and the turn was read in full instead. The fallback is
 *  never silent: the operator must not believe a summary they did not get. */
export const DIGEST_FALLBACK_NOTE = 'Could not summarise — read in full.';

export interface AnswerReaderOptions {
  isStreaming: boolean;
  lastAssistantText: string | null;
  /** The operator's chosen level. */
  level: ReadingLevel;
  /** The digest seam (useTurnDigest in the surface). Returns ok:false whenever
   *  the talker cannot help, which is a normal, handled outcome. */
  requestDigest: (request: {
    kind: TurnDigestKind;
    text: string;
    spokenPrefix?: string;
  }) => Promise<TurnDigestOutcome>;
}

export interface AnswerReaderView {
  /** The form in which the current answer is being read; null when nothing of
   *  this answer is speaking. */
  spokenKind: ReadingLevel | null;
  /** Honest note when a digest was unavailable and the turn was read in full. */
  fallbackNote: string | null;
}

interface AnswerSpeech {
  itemId: string;
  text: string;
  chunks: string[];
  /** The form of the item currently submitted for this answer, or null while
   *  nothing of it has been submitted yet. A digest item's chunk index counts
   *  DIGEST chunks, not the worker's — conflating the two would make a flip
   *  skip part of the turn it never actually read out. */
  spokenForm: ReadingLevel | null;
}

/**
 * Stop the item in flight at the NEXT CHUNK BOUNDARY, then call `onStopped`.
 *
 * The frozen arbiter has two cancels: `stopAll()` (hard — it cuts the current
 * chunk, which would cut mid-word) and `pause()` (soft — the chunk finishes and
 * the loop stops). So a boundary stop is pause → wait for the chunk count to
 * advance → stopAll, which by then has nothing in flight to cut.
 *
 * The `stopAll` also clears the queue. That is the only removal the frozen
 * arbiter offers (there is no per-item cancel, by design), and the surface only
 * queues its own answer/chatter intents behind one another, so the cost of a
 * level flip is at most a dropped chatter item — never another answer's speech.
 */
export function stopAtNextChunkBoundary(
  arbiter: SpeechArbiter,
  onStopped: () => void
): () => void {
  const state = arbiter.getState();
  const current = state.current;
  if (!current) {
    // Nothing in flight: the hard cancel cannot cut anything.
    arbiter.stopAll();
    onStopped();
    return () => {};
  }

  const itemId = current.id;
  const fromChunk = current.chunkIndex;
  let done = false;
  let unsubscribe: () => void = () => {};

  const settle = () => {
    if (done) return true;
    const now = arbiter.getState();
    const cur = now.current;
    const boundaryReached = !cur || cur.id !== itemId || cur.chunkIndex > fromChunk;
    if (!boundaryReached) return false;
    // Done BEFORE stopAll: stopAll notifies again, and the re-entrant call
    // must not run this twice.
    done = true;
    arbiter.stopAll();
    unsubscribe();
    onStopped();
    return true;
  };

  arbiter.pause();
  if (settle()) return () => {};
  unsubscribe = arbiter.subscribe(() => {
    settle();
  });
  return () => {
    done = true;
    unsubscribe();
  };
}

function heardText(chunks: readonly string[], heardChunks: number): string {
  return chunks
    .slice(0, Math.max(0, Math.floor(heardChunks)))
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .join(' ');
}

export function useAnswerReader(options: AnswerReaderOptions): AnswerReaderView {
  const { isStreaming, lastAssistantText, level, requestDigest } = options;
  const [spokenKind, setSpokenKind] = useState<ReadingLevel | null>(null);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);

  const answerRef = useRef<AnswerSpeech | null>(null);
  /** Bumped whenever this answer's reading is re-planned; anything in flight
   *  for an older plan is discarded rather than spoken. */
  const generationRef = useRef(0);
  const digestInFlightRef = useRef(false);
  const autoSeqRef = useRef(0);
  const prevStreamingRef = useRef(isStreaming);

  const submitAnswerText = useCallback((itemId: string, text: string, form: ReadingLevel) => {
    const answer = answerRef.current;
    if (answer && answer.itemId === itemId) answer.spokenForm = form;
    speechArbiter.submit({ id: itemId, tier: TIER_ANSWER, text });
  }, []);

  /**
   * Speak a piece of the answer in flight, winning the shared record first —
   * EXCEPT when the piece is the answer's own raw text.
   *
   * That text was already claimed when the surface decided to read this turn,
   * so claiming it again would fail and the operator would get silence instead
   * of the full text they explicitly asked for (found by the flip-to-Verbatim
   * test). Anything else — a digest, an unplayed remainder — must still claim,
   * because those words have not been spoken.
   */
  const speakAnswerPiece = useCallback(
    (itemId: string, text: string, form: ReadingLevel) => {
      const spoken = text.trim();
      if (!spoken) return;
      const answer = answerRef.current;
      const ownedByThisAnswer = answer !== null && spoken === answer.text.trim();
      if (!ownedByThisAnswer && !spokenLedger.claim(spoken)) return;
      submitAnswerText(itemId, spoken, form);
    },
    [submitAnswerText]
  );

  // Keep the indicator honest: once the answer's item has left the arbiter and
  // nothing is being planned, this answer is no longer being read.
  useEffect(() => {
    const sync = () => {
      const answer = answerRef.current;
      if (!answer) return;
      const state = speechArbiter.getState();
      const live =
        state.current?.id === answer.itemId ||
        state.queued.some((queued) => queued.id === answer.itemId);
      if (!live && !digestInFlightRef.current) {
        answerRef.current = null;
        setSpokenKind(null);
      }
    };
    const unsubscribe = speechArbiter.subscribe(sync);
    sync();
    return unsubscribe;
  }, []);

  // ---------------------------------------------------------------------------
  // Turn end: the plan speaks. A digest plan asks the talker; while the request
  // is in flight nothing has been spoken yet, so a digest that never arrives
  // costs latency, never words — the fallback reads the turn in full.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming || !lastAssistantText) return;

    // One answer speaks once, whichever producer got there first — the shared
    // record (P16). Claimed at the decision, so a repeated turn-end cannot
    // double-speak while a digest is still being fetched.
    if (!spokenLedger.claim(lastAssistantText)) return;

    const generation = ++generationRef.current;
    const itemId = `answer-auto-${autoSeqRef.current++}`;
    const plan = planSpeechForText(level, lastAssistantText);
    answerRef.current = {
      itemId,
      text: lastAssistantText,
      chunks: chunkIntoSentences(lastAssistantText),
      spokenForm: null,
    };
    setFallbackNote(null);
    setSpokenKind(plan.kind === 'read' ? 'verbatim' : plan.digestKind);

    if (plan.kind === 'read') {
      // Verbatim, or a turn short enough that a digest would be pure overhead.
      digestInFlightRef.current = false;
      submitAnswerText(itemId, plan.text, 'verbatim');
      return;
    }

    digestInFlightRef.current = true;
    void requestDigest({ kind: plan.digestKind, text: lastAssistantText }).then((outcome) => {
      if (generation !== generationRef.current) return;
      digestInFlightRef.current = false;
      if (!outcome.ok) {
        setFallbackNote(DIGEST_FALLBACK_NOTE);
        setSpokenKind('verbatim');
        submitAnswerText(itemId, lastAssistantText, 'verbatim');
        return;
      }
      const spoken = digestSpokenText(plan.digestKind, outcome.digest);
      if (!spoken || !spokenLedger.claim(spoken)) {
        // An empty digest, or words already spoken: read the turn rather than
        // say nothing at all.
        setFallbackNote(DIGEST_FALLBACK_NOTE);
        setSpokenKind('verbatim');
        submitAnswerText(itemId, lastAssistantText, 'verbatim');
        return;
      }
      submitAnswerText(itemId, spoken, plan.digestKind);
    });
  }, [isStreaming, lastAssistantText, level, requestDigest, submitAnswerText]);

  // ---------------------------------------------------------------------------
  // The mid-speech flip. Reaching for the switch means the operator wants it
  // NOW: the current item stops at the next chunk boundary, the talker digests
  // what they have not heard, and nothing they have already heard is repeated.
  // ---------------------------------------------------------------------------
  const prevLevelRef = useRef(level);
  useEffect(() => {
    const previousLevel = prevLevelRef.current;
    prevLevelRef.current = level;
    if (previousLevel === level) return;

    const answer = answerRef.current;
    if (!answer) return;

    const state = speechArbiter.getState();
    const current = state.current?.id === answer.itemId ? state.current : null;
    const queued = state.queued.some((entry) => entry.id === answer.itemId);
    const planning = digestInFlightRef.current;
    if (!current && !queued && !planning) {
      answerRef.current = null;
      setSpokenKind(null);
      return; // this answer is finished; the new level applies to the next one
    }

    // Supersede whatever the previous level had in flight for this answer.
    const generation = ++generationRef.current;
    digestInFlightRef.current = false;

    // The chunk in flight finishes before anything new is spoken (that is what
    // makes the stop land on a boundary and never mid-word), so it counts as
    // heard and is never repeated. Only a VERBATIM item advances the worker's
    // own chunk list; while a digest is playing, none of the worker's words have
    // been read out, so the whole turn is still unplayed.
    const heardChunks = current && answer.spokenForm === 'verbatim' ? current.chunkIndex + 1 : 0;
    const remainder = remainderAfterChunks(answer.chunks, heardChunks);
    const prefix = heardText(answer.chunks, heardChunks);

    const stopped = new Promise<void>((resolve) => {
      if (!current && !queued) {
        resolve();
        return;
      }
      stopAtNextChunkBoundary(speechArbiter, resolve);
    });

    if (remainder.length === 0) {
      // Nothing left unplayed: stop at the boundary and say nothing rather than
      // replay the turn.
      void stopped.then(() => {
        if (generation !== generationRef.current) return;
        answerRef.current = null;
        setSpokenKind(null);
      });
      return;
    }

    const plan = planSpeechForText(level, remainder);
    setSpokenKind(plan.kind === 'read' ? 'verbatim' : plan.digestKind);

    if (plan.kind === 'read') {
      // A short remainder is read out: a digest of two clauses is pure overhead,
      // and reading it verbatim loses nothing. The in-flight flag keeps this
      // answer alive across the boundary stop, so a second flip still lands.
      digestInFlightRef.current = true;
      void stopped.then(() => {
        if (generation !== generationRef.current) return;
        digestInFlightRef.current = false;
        speakAnswerPiece(answer.itemId, remainder, 'verbatim');
      });
      return;
    }

    digestInFlightRef.current = true;
    void Promise.all([
      stopped,
      requestDigest({
        kind: plan.digestKind,
        text: remainder,
        ...(prefix ? { spokenPrefix: prefix } : {}),
      }),
    ]).then(([, outcome]) => {
      if (generation !== generationRef.current) return;
      digestInFlightRef.current = false;
      if (outcome.ok) {
        const spoken = digestSpokenText(plan.digestKind, outcome.digest);
        if (spoken && spokenLedger.claim(spoken)) {
          submitAnswerText(answer.itemId, spoken, plan.digestKind);
          return;
        }
      }
      // The talker could not help: finish the turn in the operator's own ears
      // rather than leave the answer half-read.
      if (!remainder.trim()) return;
      setFallbackNote(DIGEST_FALLBACK_NOTE);
      setSpokenKind('verbatim');
      speakAnswerPiece(answer.itemId, remainder, 'verbatim');
    });
  }, [level, requestDigest, submitAnswerText, speakAnswerPiece]);

  return { spokenKind, fallbackNote };
}
