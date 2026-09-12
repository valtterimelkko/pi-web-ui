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

/** Explicit withdrawals of the pending proposal. */
const CANCEL_PATTERNS: RegExp[] = [
  /^\s*no\b[.!\s]*$/i,
  /\bnever\s?mind\b/i,
  /\bforget it\b/i,
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
