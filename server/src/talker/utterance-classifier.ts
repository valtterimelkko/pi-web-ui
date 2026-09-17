/**
 * Mechanical classification of operator utterances (harness state machine, not
 * model judgement).
 *
 * The classification has exactly two mechanical consequences:
 *   - 'confirm'  → a pending proposal (if any) is released to the worker;
 *   - 'cancel'   → a pending proposal (if any) is cleared;
 * everything else is conversational: the utterance becomes/updates the
 * candidate that a later confirmation would release.
 *
 * The gate itself never depends on this classifier being clever: when in doubt,
 * the safe direction is that nothing is released (a release requires a
 * confirmation-classified utterance AND a live pending proposal).
 */

import type { UtteranceClass } from './types.js';
import type { DraftSelection, OrdinalPosition } from './proposal-store.js';

/** Explicit withdrawals of the pending proposal. Each pattern consumes its
 *  natural object ("cancel that" / "cancel it") — see extractPostCancelInstruction
 *  for why a pattern that stops at the verb is a defect, not a detail. */
const CANCEL_PATTERNS: RegExp[] = [
  /^\s*no\b[.!\s]*$/i,
  /\bnever\s?mind(?:\s+(?:that|it|this))?\b/i,
  /\bforget it\b/i,
  /\bforget (?:that|this)\b/i,
  /\bscratch (?:that|it)\b/i,
  /\bdon'?t send(?:\s+(?:that|it|this))?\b/i,
  /\bdo not send(?:\s+(?:that|it|this))?\b/i,
  /\bcancel (?:that|it|this)\b/i,
  /\bno,?\s*(?!\s)(wait|hold|stop|don'?t|cancel|forget)(?:\s+(?:that|it|this))?\b/i,
  /\bactually,?\s*no\b/i,
];

/**
 * The closed confirmation vocabulary. A confirmation is built ONLY from these
 * atoms, matched as whole words over the whole utterance — never from a
 * substring anywhere in a larger utterance. This is the Phase 1 repair of the
 * live gate defect: `\bsure\b` used to match inside "not sure", `\byes\b`
 * inside "yes, hold phase three", and either released a held draft.
 */
const CONFIRM_ATOMS = [
  'go ahead',
  'go on',
  'carry on',
  'off you go',
  "that's right",
  'send it over',
  'send it',
  'send that over',
  'send that',
  'do it',
  'do that',
  'please do',
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'affirmative',
  'confirmed',
  'confirm',
] as const;

/** Word-boundary presence of any confirmation atom (used by the pushback branch). */
const CONFIRM_ATOM_PRESENCE = new RegExp(`\\b(?:${CONFIRM_ATOMS.join('|')})\\b`, 'i');

/**
 * Discourse glue that may surround atoms without changing their meaning
 * ("well, yes", "ok then send it"). Fillers never stand alone as a
 * confirmation: at least one atom must carry it.
 */
const CONFIRM_FILLERS = new Set([
  'please',
  'just',
  'now',
  'then',
  'and',
  'um',
  'uh',
  'ah',
  'er',
  'well',
  'so',
  'ok',
  'okay',
  'right',
]);

/**
 * Explicit negation / uncertainty vocabulary (Phase 1 repair, brief item 2).
 * Anything carrying one of these is a statement — never a confirmation —
 * regardless of an affirmative word elsewhere in it ("not sure", "I doubt
 * it", "I would never say yes").
 */
const CONFIRM_DISQUALIFIER =
  /\b(?:not|never|hardly|doubt|unsure|uncertain|can'?t|won'?t|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|shouldn'?t|wouldn'?t|couldn'?t)\b/i;

/** Sentence punctuation tolerated at the edges; the words carry the meaning. */
const EDGE_PUNCTUATION = /^[\s,;:.!—-]+|[\s,;:.!—-]+$/g;

/** Word separators inside an utterance (commas and sentence stops are seams). */
const WORD_SEPARATORS = /[\s,;:.!?—-]+/;

/**
 * A whole-utterance confirmation (brief item 2): every word belongs to the
 * closed confirmation vocabulary — atoms and discourse glue only — and at
 * least one atom is present. A qualifier, a negation, a conditional, a quote
 * or any post-affirmation instruction is a word outside the vocabulary, so it
 * falls through to `statement`. Deliberately narrow: the safe direction for
 * the gate is that nothing is released.
 */
const CONFIRM_MAX_WORDS = 8;
const CONFIRM_PHRASES = [...CONFIRM_ATOMS].sort((a, b) => b.length - a.length);

function isWholeUtteranceConfirmation(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(EDGE_PUNCTUATION, '')
    .split(WORD_SEPARATORS)
    .filter(Boolean);
  if (words.length === 0 || words.length > CONFIRM_MAX_WORDS) return false;
  let index = 0;
  let atoms = 0;
  while (index < words.length) {
    const phrase = CONFIRM_PHRASES.find(atom =>
      atom.split(' ').every((part, offset) => words[index + offset] === part)
    );
    if (phrase) {
      atoms += 1;
      index += phrase.split(' ').length;
      continue;
    }
    if (CONFIRM_FILLERS.has(words[index])) {
      index += 1;
      continue;
    }
    return false;
  }
  return atoms > 0;
}

/**
 * Operator pushback on the gate itself ("just do it, don't ask me every
 * single time"). With a live proposal this is an authorisation; this pattern
 * is what keeps the mandatory pushback turn working despite its length. The
 * dismissal phrases are stripped before the negation check so that "don't ask
 * me" — a complaint about the ritual, not a denial of the authorisation —
 * cannot disqualify it; a negation elsewhere still does.
 */
const PUSHBACK_PATTERN =
  /\b(just do it|just send it|stop asking|don'?t ask(ing)?( me)?( every| each)?|no more asking|every (single )?time)\b/i;
const PUSHBACK_DISMISSAL =
  /\b(?:stop asking(?: me)?|don'?t ask(?:ing)?(?: me)?|no more asking|every (?:single )?time|it'?s a simple thing)\b/gi;

/** Questions are never confirmations ("did you send it?" must not release). */
const QUESTION_TRAILING = /\?\s*$/;
const QUESTION_LEADING =
  /^\s*(what|why|how|when|where|who|which|is|are|was|were|did|does|do\s+(you|i|we|they|he|she)|can|could|should|would|will|has|have|had|shall|may|any)\b/i;

/**
 * Meta questions about the send in flight ("did you send it?"). They must
 * neither release the proposal nor replace it.
 */
const META_SEND_QUESTION =
  /\b(send|sent|deliver|delivered|relay|relayed|reach(ed)?|go(ing|ne)? through|went through)\b/i;

/**
 * A question counts as an instruction (and may replace the candidate) only
 * when it is worker-directed: a directive verb aimed at the worker. Status
 * and chat questions ("how's it going?", "what is worker 2 doing?") never
 * become proposals, so a stray confirmation cannot relay them.
 */
const DIRECTIVE_QUESTION =
  /\b(tell|ask|have|make|get|remind|instruct|show|give|send|run|pass)\b[^?]*\b(worker|workers|agent|it|him|her|them)\b/i;

export function isWorkerDirectedQuestion(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  return DIRECTIVE_QUESTION.test(text);
}

export function classifyOperatorUtterance(raw: string): UtteranceClass {
  const text = raw.trim();
  if (!text) return 'statement';

  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.test(text)) return 'cancel';
  }

  const isTrailingQuestion = QUESTION_TRAILING.test(text);
  const isLeadingQuestion = QUESTION_LEADING.test(text) && !PUSHBACK_PATTERN.test(text);
  const isQuestion = isTrailingQuestion || isLeadingQuestion;

  if (isQuestion) {
    return 'question';
  }

  // The mandatory pushback turn stays an authorisation — but only when it
  // actually carries one ("just do it"), and only when the dismissal itself
  // is not a negation of the authorisation ("just don't do it, stop asking").
  if (PUSHBACK_PATTERN.test(text) && CONFIRM_ATOM_PRESENCE.test(text)) {
    const withoutDismissal = text.replace(PUSHBACK_DISMISSAL, ' ');
    if (!CONFIRM_DISQUALIFIER.test(withoutDismissal)) return 'confirm';
  }

  // Explicit negation/uncertainty disqualifies before any shape is considered
  // ("not sure" must never release because of the word inside it).
  if (CONFIRM_DISQUALIFIER.test(text)) return 'statement';

  // A confirmation must be a confirmation SHAPE: its whole utterance is built
  // from the closed confirmation vocabulary. Everything else — a condition, a
  // quote, a delay, or a post-affirmation instruction — is a statement.
  if (isWholeUtteranceConfirmation(text)) return 'confirm';

  return 'statement';
}

/** A residue that is nothing but the tail of a cancel phrase is not an
 *  instruction ("don't send /that/"). Safe by construction: dropping a draft
 *  can only reduce what a release could ever carry. */
const DANGLING_OBJECT = /^(?:that|it|this|these|those|them)(?:\s+one)?[.!,]?$/i;

/**
 * Locate the instruction residue AFTER the cancel boundary of a
 * cancel-classified utterance (finding F1, P7). "Never mind, forget it. Tell
 * the worker to rebase instead." is ONE breath carrying two decisions: the
 * cancel ends whatever was held, and the instruction half must still be
 * draft-captured — before this existed, the operator's words vanished from
 * the harness while remaining in the talker's conversation.
 *
 * P25: matches are now MERGED where they overlap. The cancel vocabulary
 * contains nested phrases — "cancel that" sits inside "no, cancel that" — and
 * cutting at the earliest match end used to stop between them, leaving the
 * tail ("that") looking like an instruction. The visible effect was that the
 * confirmation card's Cancel button, which sends the fixed utterance
 * "no, cancel that", cleared the draft and then instantly re-drafted the
 * fragment as a FRESH proposal: the card reappeared and could never be
 * dismissed (operator-reported). Cutting at the end of the merged phrase fixes
 * every shape of it — "no, cancel that. Tell the worker to stop." now yields
 * "Tell the worker to stop." rather than "that. Tell the worker to stop."
 *
 * Purely mechanical: this function only LOCATES the boundary. It never touches
 * the release path — a residue can only ever join the draft, which still
 * requires its own confirmation to release.
 */
export function extractPostCancelInstruction(raw: string): string | null {
  let text = raw.trim();
  for (;;) {
    if (!text) return null;
    const spans: Array<{ start: number; end: number }> = [];
    for (const pattern of CANCEL_PATTERNS) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const re = new RegExp(pattern.source, flags);
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        spans.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    if (spans.length === 0) break;
    spans.sort((a, b) => a.start - b.start);
    let end = spans[0].end;
    for (const span of spans) {
      if (span.start > end) break; // a separate, later cancel phrase: next pass
      if (span.end > end) end = span.end;
    }
    text = text.slice(end).trim();
  }
  if (!text) return null;
  const residue = text.replace(/^[,.;:!—-]+\s*/, '').trim();
  if (!residue) return null;
  return DANGLING_OBJECT.test(residue) ? null : residue;
}

/**
 * True when a question-classified utterance is about the send in flight and
 * therefore must not replace the pending proposal ("did you send it?" keeps
 * the proposal alive; "could you ask the worker to rebase?" does not — it is
 * a new instruction in polite form).
 */
export function isMetaSendQuestion(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (!QUESTION_TRAILING.test(text) && !QUESTION_LEADING.test(text)) return false;
  return META_SEND_QUESTION.test(text);
}

/**
 * Mechanical subset selection for the operator's draft (plan §4.2 invariant
 * 2): "just the second one" selects a subset of the draft's utterance ids so
 * the harness can release exactly that part, verbatim. The vocabulary is a
 * fixed, tightly anchored set of ordinal shapes — the same design as the
 * confirm/cancel patterns above. Anything outside these shapes selects
 * nothing (returns null): an instruction containing an ordinal, a question,
 * or a plain yes never selects, so the gate cannot be widened by accident.
 * Questions never select (checked by the caller against the classification);
 * a plain confirm selects the whole draft implicitly.
 */
const ORDINAL_GROUP = '(first|second|third|fourth|fifth|last)';
const BARE_SELECTION_PATTERN = new RegExp(
  `^(?:(?:just|only)\\s+)?(?:please\\s+)?(?:(?:send|relay|pass)\\s+)?(?:me\\s+)?the\\s+${ORDINAL_GROUP}\\s*(?:one|part)?\\s*[.!,]?\\s*$`,
  'i'
);
const CONFIRM_PREFIXED_SELECTION_PATTERN = new RegExp(
  `^(?:yes|yeah|yep|yup|sure|ok|okay)\\s*[,;:!.]*\\s*(?:(?:just|only)\\s+)?(?:please\\s+)?(?:(?:send|relay|pass)\\s+)?(?:me\\s+)?the\\s+${ORDINAL_GROUP}\\s*(?:one|part)?\\s*[.!,]?\\s*$`,
  'i'
);
const ORDINAL_ORDER: OrdinalPosition[] = ['first', 'second', 'third', 'fourth', 'fifth'];

export function resolveDraftSelection(raw: string): DraftSelection | null {
  const text = raw.trim();
  if (!text) return null;
  const match = BARE_SELECTION_PATTERN.exec(text) ?? CONFIRM_PREFIXED_SELECTION_PATTERN.exec(text);
  const word = match?.[1]?.toLowerCase() as OrdinalPosition | undefined;
  if (!word) return null;
  return { kind: 'ordinal', position: word === 'last' ? 'last' : ORDINAL_ORDER[ORDINAL_ORDER.indexOf(word)] };
}
