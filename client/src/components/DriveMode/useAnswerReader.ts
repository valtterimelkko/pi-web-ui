/**
 * useAnswerReader — the talker in the reading path (P17 package A, whole-turn
 * input P19 package B).
 *
 * Before this existed the surface read the worker's final answer VERBATIM with
 * no talker involvement at all: raw text straight to TTS at tier 3. This hook is
 * where the reading level applies — it decides what speaks at turn end, asks the
 * talker for a digest when the level calls for one, and applies a level change
 * immediately and boundedly while an answer is being read.
 *
 * P19 — THE ANSWER IS THE WHOLE TURN. The auto-speak path used to plan on the
 * LAST assistant message only, which is why mid-turn detail was reachable only
 * by clicking read-aloud. The digest input is now the turn's assistant output:
 * every assistant message since the operator's last message, interim updates
 * included (see `getTurnAssistantParts`). Recorded decisions that are easy to
 * get wrong again:
 *   - VERBATIM reads the whole turn, interim included. If it stayed on the last
 *     message, the faithful level would surface strictly less than Summary
 *     (which reads the whole turn) — an incoherent hierarchy.
 *   - The short-turn threshold applies to the TURN (the text being considered):
 *     a long turn is digested even when its last message is short, because the
 *     threshold exists to avoid compressing trivially little text, and a long
 *     turn with a short tail is exactly the case the operator does not want
 *     spoken line by line.
 *   - A turn is ACCOUNTED for once this surface has taken it on — spoken, held
 *     for the focus recap, or already surfaced another way. The next turn's
 *     scan stops there, so successive turns — including UNPROMPTED
 *     continuations (goal loops, watch wakes) where no operator message
 *     separates them — can never re-digest content that was already spoken.
 *     The P16 spoken ledger alone cannot provide this: two turns produce two
 *     different strings, so exact-text claims never collide while content does.
 *     The boundary is id AND words: a completed message never changes under
 *     the same id in a real stream, but content that appears with new words is
 *     new content, and new content surfaces rather than being silenced.
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
 *     path in this module at all, and the operator's messages bound the turn
 *     scan without ever entering it.
 *
 * Playback only: nothing here gates capture, and a failed digest falls back to
 * reading the turn in full, so an answer can never be lost to a summariser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '../../store/sessionStore';
import {
  chunkIntoSentences,
  speechArbiter,
  TIER_ANSWER,
  type SpeechArbiter,
} from '../../lib/speechArbiter';
import { spokenLedger } from '../../lib/spokenLedger';
import type { TurnDigestKind, TurnDigestOutcome } from '../../lib/turnDigest';
import { primePlaybackQueue } from '../../hooks/useReadAloud';
import { focusRecapAnnouncement, type HeldAnswer } from './focusHold';
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
  /**
   * P19 — the conversation the answer is read from. The hook scans it for the
   * whole turn itself (`getTurnAssistantParts`), so the accounted-turn
   * boundary that keeps a later turn from re-digesting already-spoken content
   * lives in exactly one place.
   */
  messages: Message[];
  /** The operator's chosen level. */
  level: ReadingLevel;
  /**
   * The operator's focus/hold control (P18 package C). While it is on, the
   * worker's answers are transcript-only: they are HELD, never spoken, and
   * surfaced explicitly when focus is left. Focus gates playback only —
   * nothing here can touch capture.
   */
  focused: boolean;
  /** The digest seam (useTurnDigest in the surface). Returns ok:false whenever
   *  the talker cannot help, which is a normal, handled outcome. */
  requestDigest: (request: {
    kind: TurnDigestKind;
    text: string;
    spokenPrefix?: string;
  }) => Promise<TurnDigestOutcome>;
  /** Multi-lane: prefix for this surface's intent ids (the worker session id),
   *  so the shared arbiter's queue attributes speech to the right lane. */
  intentIdPrefix?: string;
}

export interface AnswerReaderView {
  /** The form in which the current answer is being read; null when nothing of
   *  this answer is speaking. */
  spokenKind: ReadingLevel | null;
  /** Honest note when a digest was unavailable and the turn was read in full. */
  fallbackNote: string | null;
  /** Answers that have arrived while focus is on (oldest first), currently
   *  held: visible while focused, spoken on exit. Never dropped. */
  heldWhileFocused: HeldAnswer[];
  /** What arrived while focused, set when focus is left with something held —
   *  the explicit surfacing that makes "exit focus" safe. Null otherwise. */
  exitRecap: HeldAnswer[] | null;
  dismissRecap: () => void;
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

// ---------------------------------------------------------------------------
// P19 — the whole-turn scan. The digest input is the TURN, not the last
// message: detail the worker emits mid-turn surfaces in the digest without
// the operator asking, and verbatim mode reads the turn faithfully.
// ---------------------------------------------------------------------------

/** The words of one assistant message that can be spoken: its text parts.
 *  Thinking is never spoken, and tool messages are not the worker's voice at
 *  all. Same extraction rule the surface has always used for the last
 *  message, now applied to every message of the turn. */
function assistantMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

export interface TurnAssistantParts {
  /** The turn's assistant output (messages joined by a blank line); null when
   *  the tail of the conversation has no assistant words. */
  text: string | null;
  /** The ids of the assistant messages composing it, oldest first. */
  ids: string[];
  /** Each message's own contribution, oldest first — what the caller records
   *  as accounted so the next scan can recognise the same content again. */
  parts: Array<{ id: string; text: string }>;
}

/**
 * The whole turn: every assistant message back to the operator's last message
 * — or back to already-accounted content, whichever comes first — interim
 * updates included.
 *
 * Scan rules, each load-bearing:
 *   - a USER message stops the scan: the operator's words bound the turn and
 *     are never part of it (one direction only);
 *   - TOOL messages are skipped WITHOUT stopping: the worker's activity is not
 *     its voice, but it is not a turn boundary either;
 *   - an ACCOUNTED message stops the scan: `accounted` maps message id to the
 *     exact words already taken on by a previous turn of this surface (spoken,
 *     or held for the focus recap). Same id and same words means that content
 *     was already handled, so a later turn — an unprompted continuation
 *     included — must not re-digest it. The WORDS are half of the key on
 *     purpose: content arriving under a reused id with new words is new
 *     content, and new content surfaces — it is never silenced by bookkeeping;
 *   - a message with no speakable words contributes nothing.
 */
export function getTurnAssistantParts(
  messages: readonly Message[],
  accounted?: ReadonlyMap<string, string>
): TurnAssistantParts {
  const collected: Array<{ id: string; text: string }> = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') break;
    if (message.role !== 'assistant') continue;
    const text = assistantMessageText(message);
    if (!text) continue;
    if (accounted?.get(message.id) === text) break;
    collected.push({ id: message.id, text });
  }
  collected.reverse();
  return {
    text: collected.length > 0 ? collected.map((part) => part.text).join('\n\n') : null,
    ids: collected.map((part) => part.id),
    parts: collected,
  };
}

/** Text-only convenience for callers that only need to know whether (and what)
 *  the worker has produced for this turn — read-aloud and the answer controls. */
export function getTurnAssistantText(messages: readonly Message[]): string | null {
  return getTurnAssistantParts(messages).text;
}

export function useAnswerReader(options: AnswerReaderOptions): AnswerReaderView {
  const { isStreaming, messages, level, focused, requestDigest, intentIdPrefix } = options;
  const [spokenKind, setSpokenKind] = useState<ReadingLevel | null>(null);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  /** P18/2 — the answers held while focus is on, and the recap they produce. */
  const [heldWhileFocused, setHeldWhileFocused] = useState<HeldAnswer[]>([]);
  const [exitRecap, setExitRecap] = useState<HeldAnswer[] | null>(null);

  const answerRef = useRef<AnswerSpeech | null>(null);
  /** P19 — what this surface has already taken on in a turn: message id → the
   *  exact words (spoken, held for the focus recap, or already surfaced
   *  another way). The next turn's scan stops at the same id AND same words;
   *  successive turns — unprompted continuations included — never re-digest
   *  content that was already accounted for. The spoken ledger cannot do this
   *  job: two turns produce two different strings, so its exact-text claims
   *  never collide while content overlaps. */
  const accountedTurnMessages = useRef<Map<string, string>>(new Map());
  /** Bumped whenever this answer's reading is re-planned; anything in flight
   *  for an older plan is discarded rather than spoken. */
  const generationRef = useRef(0);
  const digestInFlightRef = useRef(false);
  const autoSeqRef = useRef(0);
  const prevStreamingRef = useRef(isStreaming);

  // P18/2 — focus and the digest seam are read inside ASYNC continuations
  // (a digest that comes back after the operator pressed focus must not
  // start speaking), so both are mirrored in refs.
  const focusedRef = useRef(focused);
  const heldRef = useRef<HeldAnswer[]>([]);
  const levelRef = useRef(level);
  const requestDigestRef = useRef(requestDigest);
  const intentPrefixRef = useRef(intentIdPrefix);
  levelRef.current = level;
  requestDigestRef.current = requestDigest;
  intentPrefixRef.current = intentIdPrefix;
  const recapSeqRef = useRef(0);

  /** Lane-scoped intent id: `${prefix}answer-auto-N` (or the recap scope),
   *  so the shared arbiter can attribute a playing intent to its lane. */
  const scopedItemId = useCallback(
    (suffix: string) => `${intentPrefixRef.current ?? ''}${suffix}`,
    []
  );

  const submitAnswerText = useCallback((itemId: string, text: string, form: ReadingLevel) => {
    const answer = answerRef.current;
    if (answer && answer.itemId === itemId) answer.spokenForm = form;
    // P21 — prime one-ahead synthesis so chunk boundaries in the read do not
    // wait on a TTS round trip, and the first synthesis starts at submit.
    primePlaybackQueue(chunkIntoSentences(text));
    speechArbiter.submit({ id: itemId, tier: TIER_ANSWER, text });
  }, []);

  /**
   * P18/2 — hold an answer that arrived (or was left unplayed) while focus is
   * on. The words are never dropped and never spoken here; they are surfaced
   * and spoken when focus is left.
   */
  const holdAnswer = useCallback((itemId: string, text: string) => {
    const spoken = text.trim();
    if (!spoken) return;
    if (heldRef.current.some((held) => held.text === spoken)) return;
    heldRef.current = [...heldRef.current, { id: itemId, text: spoken }];
    setHeldWhileFocused(heldRef.current);
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
  // P18/2 — leaving focus. Everything that arrived while focus was on is
  // surfaced explicitly: the recap is shown, and it SPEAKS (the mechanical
  // announcement, then each answer through the operator's reading level). This
  // is the part that matters — "exit focus" must never mean "the thing that
  // happened while you were away disappeared".
  // ---------------------------------------------------------------------------
  const speakFocusRecapItem = useCallback(
    async (item: HeldAnswer) => {
      const generation = ++generationRef.current;
      const plan = planSpeechForText(levelRef.current, item.text);
      // Tracked as the current answer so a mid-recap level flip still lands
      // (the flip path supersedes this item through the same generation rule
      // the normal turn-end path uses).
      answerRef.current = {
        itemId: item.id,
        text: item.text,
        chunks: chunkIntoSentences(item.text),
        spokenForm: null,
      };
      setSpokenKind(plan.kind === 'read' ? 'verbatim' : plan.digestKind);

      if (plan.kind === 'read') {
        // A held answer was never claimed (nothing was spoken while focused),
        // so the shared record still protects it: if the operator read it aloud
        // while focus was on, the recap does not say the same words twice.
        if (!spokenLedger.claim(item.text)) return;
        submitAnswerText(item.id, item.text, 'verbatim');
        return;
      }
      digestInFlightRef.current = true;
      let outcome: TurnDigestOutcome;
      try {
        outcome = await requestDigestRef.current({ kind: plan.digestKind, text: item.text });
      } catch {
        outcome = { ok: false, reason: 'failed' };
      } finally {
        digestInFlightRef.current = false;
      }
      if (generation !== generationRef.current) return; // a level flip superseded this item
      if (outcome.ok) {
        const spoken = digestSpokenText(plan.digestKind, outcome.digest);
        if (spoken && spokenLedger.claim(spoken)) {
          submitAnswerText(item.id, spoken, plan.digestKind);
          return;
        }
      }
      // The talker could not help: read the held answer rather than lose it.
      setFallbackNote(DIGEST_FALLBACK_NOTE);
      setSpokenKind('verbatim');
      if (!spokenLedger.claim(item.text)) return;
      submitAnswerText(item.id, item.text, 'verbatim');
    },
    [submitAnswerText]
  );

  const speakFocusRecap = useCallback(
    async (items: HeldAnswer[]) => {
      const count = items.length;
      if (count === 0) return;
      // The announcement is a mechanical, constant-shaped line, so it is held
      // under its own event scope: a second focus session must be able to say
      // the same words again (P16's event-scoping rule).
      const scope = scopedItemId(`focus-recap-${recapSeqRef.current++}`);
      const announcement = focusRecapAnnouncement(count);
      if (spokenLedger.claim(announcement, scope)) {
        speechArbiter.submit({ id: scope, tier: TIER_ANSWER, text: announcement });
      }
      for (const item of items) {
        await speakFocusRecapItem(item);
      }
    },
    [speakFocusRecapItem]
  );

  const prevFocusedRef = useRef(focused);
  useEffect(() => {
    const wasFocused = prevFocusedRef.current;
    prevFocusedRef.current = focused;
    focusedRef.current = focused;
    if (!wasFocused || focused) return; // only on a real exit
    const held = heldRef.current;
    if (held.length === 0) return;
    heldRef.current = [];
    setHeldWhileFocused([]);
    setExitRecap(held);
    void speakFocusRecap(held);
  }, [focused, speakFocusRecap]);

  const dismissRecap = useCallback(() => setExitRecap(null), []);

  // ---------------------------------------------------------------------------
  // Turn end: the plan speaks. A digest plan asks the talker; while the request
  // is in flight nothing has been spoken yet, so a digest that never arrives
  // costs latency, never words — the fallback reads the turn in full.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;

    // P19 — the answer is the whole turn, interim updates included.
    const turn = getTurnAssistantParts(messages, accountedTurnMessages.current);
    const turnText = turn.text;
    if (!turnText) return;

    // This run's output is now this surface's business, whichever way the
    // decision below goes: spoken, held for the focus recap, or already
    // surfaced another way (a failed ledger claim means read-aloud got there
    // first). Accounting at the decision is what keeps a later turn — an
    // unprompted continuation included — from re-digesting the same content.
    for (const part of turn.parts) accountedTurnMessages.current.set(part.id, part.text);

    // P18/2 — focus gates PLAYBACK ONLY. While focus is on the answer is not
    // spoken; it is held (and the shared ledger claim is deliberately NOT made
    // here — claiming would mark the words as already heard and the exit recap
    // could never speak them).
    if (focusedRef.current) {
      holdAnswer(scopedItemId(`answer-auto-${autoSeqRef.current++}`), turnText);
      return;
    }

    // One answer speaks once, whichever producer got there first — the shared
    // record (P16). Claimed at the decision, so a repeated turn-end cannot
    // double-speak while a digest is still being fetched.
    if (!spokenLedger.claim(turnText)) return;

    const generation = ++generationRef.current;
    const itemId = scopedItemId(`answer-auto-${autoSeqRef.current++}`);
    const plan = planSpeechForText(level, turnText);
    answerRef.current = {
      itemId,
      text: turnText,
      chunks: chunkIntoSentences(turnText),
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
    void requestDigest({ kind: plan.digestKind, text: turnText }).then((outcome) => {
      if (generation !== generationRef.current) return;
      digestInFlightRef.current = false;
      if (focusedRef.current) {
        // The operator pressed focus while the digest was in flight. Nothing
        // has been spoken of this answer, so the whole of it is held.
        answerRef.current = null;
        setSpokenKind(null);
        holdAnswer(itemId, turnText);
        return;
      }
      if (!outcome.ok) {
        setFallbackNote(DIGEST_FALLBACK_NOTE);
        setSpokenKind('verbatim');
        submitAnswerText(itemId, turnText, 'verbatim');
        return;
      }
      const spoken = digestSpokenText(plan.digestKind, outcome.digest);
      if (!spoken || !spokenLedger.claim(spoken)) {
        // An empty digest, or words already spoken: read the turn rather than
        // say nothing at all.
        setFallbackNote(DIGEST_FALLBACK_NOTE);
        setSpokenKind('verbatim');
        submitAnswerText(itemId, turnText, 'verbatim');
        return;
      }
      submitAnswerText(itemId, spoken, plan.digestKind);
    });
  }, [isStreaming, messages, level, requestDigest, submitAnswerText]);

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
        if (focusedRef.current) {
          holdAnswer(answer.itemId, remainder);
          answerRef.current = null;
          setSpokenKind(null);
          return;
        }
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
      if (focusedRef.current) {
        // Focus arrived while the digest was in flight: hold the unplayed
        // remainder rather than speaking over the operator's request for quiet.
        holdAnswer(answer.itemId, remainder);
        answerRef.current = null;
        setSpokenKind(null);
        return;
      }
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

  return { spokenKind, fallbackNote, heldWhileFocused, exitRecap, dismissRecap };
}
