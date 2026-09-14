/**
 * focusHold — the operator's focus/hold control (P18 package C, deliverable 2).
 *
 * Focus is the concentrated-Q&A case: the operator is talking with the talker
 * and does NOT want the worker's answers read out. While focus is on:
 *
 *   - the worker's answers are transcript-only (never spoken);
 *   - the talker holds the floor (its own replies still speak);
 *   - CAPTURE IS UNTOUCHED — focus gates playback only, never the mic. The
 *     operator can keep talking the whole time;
 *   - nothing that arrives is LOST: every answer is held, and leaving focus
 *     surfaces what arrived explicitly (visible, and spoken at the operator's
 *     reading level).
 *
 * The discipline that matters: this is the OPERATOR'S control. The talker may
 * be told that focus is on (so it can suggest leaving it when something needs
 * attention), but there is no path from the model, or from any server message,
 * to the switch. The operator presses; the model proposes.
 *
 * This module is the vocabulary of that control — labels, the spoken marker,
 * and the (very thin) state hook. The answer-holding itself lives in
 * useAnswerReader, because that hook owns the answer speech path.
 */

import { useCallback, useState } from 'react';

/** One answer that arrived while focus was on, held for the exit recap. */
export interface HeldAnswer {
  id: string;
  text: string;
}

/** The control's two states, in the operator's words. */
export const FOCUS_ON_LABEL = 'Focus on';
export const FOCUS_OFF_LABEL = 'Leave focus';

/**
 * The spoken marker when focus is left. Mechanical (produced from harness
 * state, never by a model), because its one job is to make sure the operator
 * knows that something happened while they were away — the failure this
 * whole package exists to prevent is "exit focus" silently meaning "the thing
 * that happened while you were away disappeared".
 */
export function focusRecapAnnouncement(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? 'While you were focused, one answer arrived.'
    : `While you were focused, ${count} answers arrived.`;
}

/** What the control's status line says, including the count of held answers. */
export function focusStatusText(focused: boolean, heldCount: number): string {
  if (!focused) return 'Focus is off — the worker’s answers are read out.';
  const held =
    heldCount === 0
      ? 'nothing has arrived yet'
      : heldCount === 1
        ? 'one answer has arrived and is held'
        : `${heldCount} answers have arrived and are held`;
  return `Focus is on — the worker’s answers stay in the transcript (${held}).`;
}

/** The discipline line, stated where the operator can see it. */
export const FOCUS_DISCIPLINE_HINT =
  'Only you can switch focus — the talker can suggest leaving it, never press it.';

export interface FocusHold {
  focused: boolean;
  toggle: () => void;
}

/** The operator's press. Session-local by design: focus is a working posture,
 *  not a stored preference. */
export function useFocusHold(initial = false): FocusHold {
  const [focused, setFocused] = useState(initial);
  const toggle = useCallback(() => setFocused((was) => !was), []);
  return { focused, toggle };
}
