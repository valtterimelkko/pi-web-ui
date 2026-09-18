/**
 * P25 — the semi-verbatim relay normalisation (pure, deterministic, model-free).
 *
 * The preserved intent (docs/VOICE-ORCHESTRATOR-FEASIBILITY.md §3.2 rule 3):
 *
 *   "Relay with very high fidelity. Semi-verbatim: the operator's own words,
 *   optionally made more concise when the speech rambles, but never summarised
 *   into the talker's own plan, never expanded into long-winded instructions.
 *   The worker receives the owner's intent, not a re-planned version of it."
 *
 * The first build kept part one (own words) and part three (never summarised,
 * never expanded) and dropped part two (concision) — so the operator's spoken
 * channel ("Okay, ask the worker if ...") reached the worker byte-for-byte,
 * and the worker — which does not know it is a worker — parsed "the worker"
 * as some OTHER agent and started dispatching sub-agents. That failure is
 * what part two exists to prevent.
 *
 * Governing principle: fidelity is about INTENT, not about BYTES. The
 * concision implemented here is REMOVAL of what carries no instruction —
 *   - the channel: commission/addressing frames ("ask the worker to/if", ...);
 *   - the disfluency: hesitation fillers, stutters, leading discourse
 *     markers, trailing courtesies.
 * Never rewriting, never substituting words, never reordering, never
 * re-casing, never composing a sentence. A conservative transform that misses
 * some noise is correct; an aggressive one that removes intent is the failure
 * this project exists to prevent. Every rule below is a closed pattern with
 * the safe direction chosen explicitly.
 *
 * Hard boundary (P25 outcome 2): the model NEVER produces the relayed text —
 * not one token. This module is harness-owned, in the same family as the
 * confirm/cancel patterns and the [[ask-worker]] / [[to-talker]] marker
 * handling. It is applied by the proposal store at draft time
 * (appendToDraft — the single choke point for everything that can later be
 * released), so the confirmation card, the mechanical re-confirmation quote
 * and the release are byte-identical BY CONSTRUCTION: the transform happens
 * BEFORE approval, never after it.
 *
 * Reversibility: every strip records the exact bytes it removed
 * (`removals`), and the draft part keeps the original utterance
 * (`originalText`) — the operator can always see what was originally said.
 */

export interface RelayNormalisation {
  /** The relay text: the operator's own words minus the channel and the disfluency. */
  text: string;
  /** False when nothing was removed — `text` is then byte-identical to the input. */
  changed: boolean;
  /** The exact pieces the strip transforms removed, in removal order. */
  removals: string[];
}

/**
 * R1 (card-contract brief) — the "visible tidy" distinction.
 *
 * `changed` is a BYTE-level fact: a dictation trailing newline, a collapsed
 * double space or a space closed before punctuation sets it with ZERO recorded
 * removals. Treating that as a tidy made the confirmation card cry wolf — it
 * claimed "your words, tidied" while showing text visually identical to what
 * the operator said, and struck through the whole utterance as if discarded.
 *
 * A tidy is only real when a removal took content the operator can SEE. This
 * predicate is the single definition of it; the card payload and the release
 * both derive from it, so they cannot disagree.
 */
export function relayHasVisibleRemoval(removals: readonly string[]): boolean {
  return removals.some(piece => /\S/.test(piece));
}

/**
 * R2 — the visible removal fragments themselves: non-whitespace pieces only,
 * trimmed for display. Never the operator's whole utterance.
 */
export function visibleRemovalFragments(removals: readonly string[]): string[] {
  return removals
    .filter(piece => /\S/.test(piece))
    .map(piece => piece.trim())
    .filter(piece => piece.length > 0);
}

/**
 * Hesitation fillers, word-bounded so 'her' / 'thermal' survive. Alternation
 * is longest-first so 'erm' wins over 'er'. A trailing single space is
 * consumed with the token; a following comma is left for seam repair.
 */
const HESITATION = /\b(?:erm+|um+|uh+|er+)\b[ \t]*/gi;

/**
 * Immediate word repetition (stutters). Case-insensitive; whitespace only
 * between the repeats, so 'Stop. Stop the run' (sentence boundary) is safe.
 * EXEMPTIONS are meaning-bearing repetitions: 'very very' is an intensifier,
 * 'no no' is emphasis/answer, the rest are acknowledgements. When in doubt,
 * the word stays in.
 */
const STUTTER = /\b([A-Za-z']+)(?:[ \t]+\1\b)+/gi;
const STUTTER_EXEMPT = new Set([
  'very', 'so', 'no', 'oh', 'yeah', 'well', 'ok', 'okay', 'hmm', 'ah',
]);

/**
 * Leading discourse markers. Two tiers, deliberately:
 *   - UNAMBIGUOUS particles (all right / okay so / okay / well / ...) may be
 *     followed by any separator — they are never instruction words at the
 *     head of a sentence;
 *   - AMBIGUOUS words (so / right / and) are stripped ONLY when punctuated as
 *     particles ('So, ', 'Right, '). 'So the cache warms' or 'Right there,
 *     fix the build' keep their first word — those are content.
 */
const MARKER_FREE = /^(?:all right|okay so|right so|okay then|okay well|okay|ok|alright|well)\b(?:[\s,;:]+|\s+\u2014\s*)/i;
const MARKER_PUNCTUATED = /^(?:so|right|and)\b\s*(?:[,;:]\s*|\s+\u2014\s+)/i;

/**
 * Politeness prefixes addressed at the talker in front of a commission. The
 * content after them is untouched.
 */
const POLITENESS = /^(?:could|can|would|will)\s+you\s+(?:please\s+)?(?:be\s+able\s+to\s+)?/i;

/**
 * M5 (review R, P25 failure class): acknowledgement/lead-in particles directly
 * in front of a commission frame — "yeah tell the worker to …", "so, please ask
 * it …". This is the operator's channel, not their instruction, and leaving it
 * in is what made a worker dispatch sub-agents. Closed list, and stripped ONLY
 * when a commission verb follows (optionally behind a politeness prelude), so an
 * ordinary "yeah, the tests are green" keeps its particle byte-for-byte.
 */
const COMMISSION_VERB = '(?:ask|tell|let|pass)\\b';
const COMMISSION_LEAD_IN = new RegExp(
  '^(?:(?:all\\s+right|yeah|yep|yup|okay|ok|alright|right|so|well|um|uh|er|erm|please)\\b[\\s,;:]*)+' +
    `(?=(?:(?:could|can|would|will)\\s+you\\s+(?:please\\s+)?(?:be\\s+able\\s+to\\s+)?)?${COMMISSION_VERB})`,
  'i'
);

/**
 * M5 (review R): a polite interpolation between a commission frame and its
 * connector — "tell the worker, if you would, to check line 10". Closed list;
 * only removed INSIDE a parsed commission frame and only when a real connector
 * follows, so the same phrase in an unrelated sentence is never touched.
 */
const POLITE_INTERPOLATION =
  /^\s*,?\s*(?:if\s+you\s+(?:would|could|don'?t\s+mind|please|like)|if\s+you\s+like|please|if\s+that'?s\s+(?:okay|ok|alright|fine))\s*,?\s*/i;

/** The addressee vocabulary for commission frames. Deliberately closed:
 *  'the worker' is unambiguous (this is the talker's own relay), and 'it' is
 *  the pronoun the operator actually uses for the worker in voice mode.
 *  'him'/'her'/'them' are excluded: they may name a THIRD party ('ask him to
 *  rebase' could mean a human colleague), and stripping that frame would
 *  change who the instruction is about — intent damage, not concision. */
const ADDRESSEE = /(?:the\s+worker|it)\b/i;

/**
 * One commission frame, tried at the head of the working string. Returns the
 * number of characters consumed, or null when the frame is not SAFELY
 * parseable here — in which case the whole utterance is left untouched. A
 * frame is only stripped when what follows is a KNOWN connector shape:
 *   - 'to X' / 'that X'  → the connector is consumed with the frame (the
 *     content keeps its imperative / declarative force: 'rebase the branch');
 *   - ':' or an em-dash before content → consumed with the frame;
 *   - an interrogative or 'for' ('if / whether / what / for ...') → the frame
 *     is consumed but the connector is KEPT: question force is meaning, and
 *     rewriting 'if it has enough materials' into a statement is forbidden;
 *   - anything else ('ask the worker nicely to stop') → no match. The
 *     unknown word might be the operator's real adverb.
 */
function frameConsumer(verb: 'ask' | 'tell', connectorsKept: boolean): (work: string) => number | null {
  const head = new RegExp(`^${verb}\\s+${ADDRESSEE.source}`, 'i');
  return (work: string): number | null => {
    const headMatch = head.exec(work);
    if (!headMatch) return null;
    const afterHead = work.slice(headMatch[0].length);
    // M5: skip a closed-list polite interpolation before the connector, and
    // count it as part of the consumed frame (it is channel, not content).
    const polite = POLITE_INTERPOLATION.exec(afterHead);
    const base = headMatch[0].length + (polite ? polite[0].length : 0);
    const after = polite ? afterHead.slice(polite[0].length) : afterHead;
    const withConnector = /^\s*(?:to|that)\b[\s,;:]+/i.exec(after);
    if (withConnector) return base + withConnector[0].length;
    const withColon = /^\s*[:\u2014-]\s*/.exec(after);
    if (withColon && /\S/.test(after.slice(withColon[0].length))) {
      return base + withColon[0].length;
    }
    if (connectorsKept) {
      const kept = /^\s+(?:if|whether|about|for|what|when|where|why|how|which|who|whose)\b/i.exec(after);
      if (kept) {
        // Consume the frame together with its trailing whitespace so the
        // removal record keeps the phrase whole ('ask the worker ').
        const ws = /^\s*/.exec(after);
        return base + (ws ? ws[0].length : 0);
      }
    }
    return null;
  };
}

const consumeAskFrame = frameConsumer('ask', true);
const consumeTellFrame = frameConsumer('tell', false);

/** 'let the worker know [that] X' — 'that' is a complementiser, not content. */
function consumeLetKnowFrame(work: string): number | null {
  const headMatch = /^let\s+the\s+worker\s+know\b/i.exec(work);
  if (!headMatch) return null;
  const after = work.slice(headMatch[0].length);
  const withThat = /^\s+that\s+/i.exec(after);
  if (withThat) return headMatch[0].length + withThat[0].length;
  const withColon = /^\s*[:\u2014-]\s*/.exec(after);
  if (withColon && /\S/.test(after.slice(withColon[0].length))) {
    return headMatch[0].length + withColon[0].length;
  }
  // Bare: 'let the worker know the build is green' — take the trailing
  // whitespace with the frame so the removal record stays whole.
  const ws = /^\s*/.exec(after);
  return headMatch[0].length + (ws ? ws[0].length : 0);
}

/** 'pass this/that/it (on) to the worker: X' — only with explicit content
 *  after a separator. A bare 'pass this on to the worker' IS the whole
 *  utterance: stripping it would empty the relay, so it stays untouched. */
function consumePassFrame(work: string): number | null {
  const headMatch = /^pass\s+(?:this|that|it)\s+(?:on\s+)?to\s+(?:the\s+worker|it|them)\b/i.exec(work);
  if (!headMatch) return null;
  const after = work.slice(headMatch[0].length);
  const withColon = /^\s*[:\u2014-]\s*/.exec(after);
  if (withColon && /\S/.test(after.slice(withColon[0].length))) {
    return headMatch[0].length + withColon[0].length;
  }
  return null;
}

/**
 * Trailing courtesy padding — a CLOSED list of phrases that carry no
 * instruction. Conditionals that DO carry instruction ('if possible',
 * 'if needed', 'if that works') are deliberately absent: removing them would
 * change what the worker is asked to do.
 */
const TRAILING_PAD: RegExp[] = [
  /,?\s*if\s+(?:that\s*'?s|that\s+is|this\s+is)\s+(?:okay|ok|alright|fine)\b[.!\s]*$/i,
  /,?\s*if\s+you\s+(?:don\s*'?t\s+mind|could)\b[.!?\s]*$/i,
  /,?\s*please\b[.!\s]*$/i,
];

export function normaliseRelayText(raw: string): RelayNormalisation {
  const removals: string[] = [];
  const record = (piece: string): void => {
    if (piece.length > 0) removals.push(piece);
  };

  let work = raw;

  // 1. Hesitation fillers, anywhere (standalone tokens only).
  work = work.replace(HESITATION, (removed) => {
    record(removed);
    return '';
  });

  // 2. Stutters: keep one instance of an immediately repeated word.
  work = work.replace(STUTTER, (match, word: string) => {
    if (STUTTER_EXEMPT.has(word.toLowerCase())) return match; // meaning-bearing — leave it
    record(match.slice(word.length));
    return word;
  });

  // 3. The leading loop: strip one head item at a time — discourse marker,
  //    politeness prefix, or commission frame — re-trying after each strip
  //    ('Okay, could you ask the worker to X' needs three passes) and
  //    repairing the head seam as we go ('um' before a comma leaves ', ...').
  //    Bounded iterations: a safety cap, not a semantic limit.
  for (let i = 0; i < 16; i++) {
    repairHeadSeam(work, record, (next) => { work = next; });
    let consumed: number | null = null;
    for (const pattern of [MARKER_FREE, MARKER_PUNCTUATED]) {
      const m = pattern.exec(work);
      if (m?.[0]) {
        record(m[0]);
        work = work.slice(m[0].length);
        consumed = m[0].length;
        break;
      }
    }
    if (consumed !== null) continue;
    // M5: the lead-in particle in front of a commission frame ('yeah tell the
    // worker to …'). Only when a commission verb follows — ordinary speech
    // keeps its particle.
    const leadIn = COMMISSION_LEAD_IN.exec(work);
    if (leadIn?.[0]) {
      record(leadIn[0]);
      work = work.slice(leadIn[0].length);
      continue;
    }
    const politeness = POLITENESS.exec(work);
    if (politeness?.[0]) {
      record(politeness[0]);
      work = work.slice(politeness[0].length);
      continue;
    }
    // A chained-instruction connective directly in front of a commission
    // frame ('also tell the worker to …') is channel chaining, not content:
    // leaving it would leak the frame to the worker. Stripped ONLY when a
    // commission verb follows — a bare 'also …' is left alone.
    const chained = /^also\s+(?=(?:ask|tell|let|pass)\b)/i.exec(work);
    if (chained?.[0]) {
      record(chained[0]);
      work = work.slice(chained[0].length);
      continue;
    }
    for (const consumeFrame of [consumeAskFrame, consumeTellFrame, consumeLetKnowFrame, consumePassFrame]) {
      consumed = consumeFrame(work);
      if (consumed !== null) {
        record(work.slice(0, consumed));
        work = work.slice(consumed);
        break;
      }
    }
    if (consumed !== null) continue;
    break; // nothing more is safely strippable at the head
  }

  // 4. Trailing courtesy padding (closed list, loop for stacked courtesies).
  for (let i = 0; i < 4; i++) {
    let stripped = false;
    for (const pattern of TRAILING_PAD) {
      const m = pattern.exec(work);
      if (m?.[0]) {
        record(m[0]);
        work = work.slice(0, work.length - m[0].length);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }

  // 5. Interior seam repair — separator bytes only, never words. Records the
  //    punctuation it drops, so a visible change is never claimed as exact.
  work = repairRelaySeams(work, record);

  // Never relay an empty instruction: a transform that would empty the text
  // is aborted wholesale and the raw words stand.
  if (!work.trim()) {
    return { text: raw, changed: false, removals: [] };
  }

  return { text: work, changed: work !== raw, removals };
}

/** Head seam: stray punctuation/space a strip left at the start (recorded —
 *  it can include real separator characters the operator spoke). */
function repairHeadSeam(work: string, record: (piece: string) => void, set: (next: string) => void): void {
  const m = /^[\s,.;:!?\u2014-]+/.exec(work);
  if (m?.[0]) {
    record(m[0]);
    set(work.slice(m[0].length));
  }
}

/** Interior seams: double spaces collapse; space before punctuation closes;
 *  duplicated punctuation merges. The two whitespace rules are invisible and
 *  are deliberately not recorded; **merging duplicated punctuation deletes
 *  characters the operator spoke**, so it IS recorded — otherwise the
 *  descriptor reports `cleaned: false` and the card claims "your words,
 *  exactly" over text that differs from what was said (W3 review,
 *  2026-09-15: `run!! tests` became `run! tests` with no removal recorded).
 *  Exported (as the same function) so the card's removal note is joined with
 *  identical semantics. */
export function repairRelaySeams(work: string, record?: (piece: string) => void): string {
  return work
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])[ \t]*[,.;:!?]+/g, (match: string, first: string) => {
      const dropped = match.slice(first.length);
      if (dropped.length > 0) record?.(dropped);
      return first;
    })
    .trim();
}
