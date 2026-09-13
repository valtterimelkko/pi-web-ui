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
import type { DraftSelection, OrdinalPosition } from './pending-proposal.js';

/** Explicit withdrawals of the pending proposal. */
const CANCEL_PATTERNS: RegExp[] = [
  /^\s*no\b[.!\s]*$/i,
  /\bnever\s?mind\b/i,
  /\bforget it\b/i,
  /\bforget (?:that|this)\b/i,
  /\bscratch (that|it)\b/i,
  /\bdon'?t send\b/i,
  /\bdo not send\b/i,
  /\bcancel that\b/i,
  /\bno,?\s*(wait|hold|stop|don'?t|cancel)\b/i,
  /\bactually,?\s*no\b/i,
];

/**
 * Affirmations and send-imperatives. Deliberately conservative shapes; see the
 * ordered guards below for what keeps an instruction from being mistaken for
 * one of these.
 */
const CONFIRM_PATTERN =
  /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|go on|send it|send that|send it over|do it|do that|please do|confirmed|confirm|that'?s right|affirmative|carry on|off you go)\b/i;

/**
 * Operator pushback on the gate itself ("just do it, don't ask me every
 * single time"). With a live proposal this is an authorisation; this pattern
 * is what keeps the mandatory pushback turn working despite its length.
 */
const PUSHBACK_PATTERN =
  /\b(just do it|just send it|stop asking|don'?t ask(ing)?( me)?( every| each)?|no more asking|every (single )?time)\b/i;

/** Questions are never confirmations ("did you send it?" must not release). */
const QUESTION_TRAILING = /\?\s*$/;
const QUESTION_LEADING =
  /^\s*(what|why|how|when|where|who|which|is|are|was|were|did|does|do\s+(you|i|we|they|he|she)|can|could|should|would|will|has|have|had|shall|may|any)\b/i;

/**
 * Discourse markers stripped before deciding whether a confirmation-shaped
 * utterance carries substantial new content ("ok so tell the worker to
 * rebase" is an instruction, not an authorisation of the previous one).
 */
const LEADING_MARKERS = /^(?:\s*(?:yes|yeah|yep|yup|ok|okay|well|so|right|and|um|uh|ah)[,;\s—-]*)+/i;

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

  const matchesConfirm = CONFIRM_PATTERN.test(text);

  if (isQuestion) {
    return 'question';
  }

  if (matchesConfirm) {
    // Pushback utterances are confirmations even though they are long.
    if (PUSHBACK_PATTERN.test(text)) return 'confirm';
    // Otherwise a confirmation shape must not carry substantial new content:
    // strip leading discourse markers and require the remainder to be short.
    const remainder = text.replace(LEADING_MARKERS, '').trim();
    const remainderWords = remainder ? remainder.split(/\s+/).length : 0;
    if (remainderWords <= 3) return 'confirm';
    return 'statement';
  }

  return 'statement';
}

/**
 * Locate the instruction residue AFTER the cancel boundary of a
 * cancel-classified utterance (finding F1, P7). "Never mind, forget it. Tell
 * the worker to rebase instead." is ONE breath carrying two decisions: the
 * cancel ends whatever was held, and the instruction half must still be
 * draft-captured — before this existed, the operator's words vanished from
 * the harness while remaining in the talker's conversation.
 *
 * Purely mechanical: repeatedly cut at the EARLIEST cancel-pattern match end
 * until the remainder no longer classifies as cancel (a cancel run — "no,
 * wait — cancel that" — is skipped whole), then strip leftover leading
 * punctuation. Returns the trimmed residue, or null when the utterance is a
 * pure cancel or cancels itself down to nothing (an instruction that takes
 * itself back mid-breath cancels wholly — the last cancel phrase wins, same
 * as the pre-fix classifier). This function only LOCATES the boundary; the
 * caller classifies the residue and decides what it means. It never touches
 * the release path: a residue can only ever join the draft, which still
 * requires its own confirmation to release.
 */
export function extractPostCancelInstruction(raw: string): string | null {
  let text = raw.trim();
  for (;;) {
    if (!text) return null;
    if (!CANCEL_PATTERNS.some(p => p.test(text))) break;
    let earliestEnd: number | null = null;
    for (const pattern of CANCEL_PATTERNS) {
      const m = pattern.exec(text);
      if (m && (earliestEnd === null || m.index + m[0].length < earliestEnd)) {
        earliestEnd = m.index + m[0].length;
      }
    }
    if (earliestEnd === null) return null; // unreachable while the .some() matched
    text = text.slice(earliestEnd).trim();
  }
  if (!text) return null;
  return text.replace(/^[,.;:!—-]+\s*/, '').trim() || null;
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
