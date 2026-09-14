/**
 * FocusControl / FocusRecap — the UI of the operator's focus/hold control
 * (P18 package C, deliverable 2).
 *
 * The control is the operator's press and nothing else: the talker can suggest
 * leaving focus, but only this button changes it. The status line keeps the
 * count of held answers visible WHILE focus is on, so it is obvious that
 * something is waiting even before the operator leaves focus.
 *
 * The recap is the explicit surfacing on exit: the answers that arrived while
 * focused, verbatim, with the count. It stays until dismissed — the whole
 * point is that "exit focus" never means "the thing that happened while you
 * were away disappeared".
 */
import { Eye, EyeOff, Inbox } from 'lucide-react';
import {
  FOCUS_DISCIPLINE_HINT,
  FOCUS_OFF_LABEL,
  FOCUS_ON_LABEL,
  focusStatusText,
  type HeldAnswer,
} from './focusHold';

export interface FocusControlProps {
  focused: boolean;
  onToggle: () => void;
  /** Answers that have arrived and are being held while focus is on. */
  heldCount: number;
}

export function FocusControl({ focused, onToggle, heldCount }: FocusControlProps) {
  return (
    <div className="flex flex-col items-center gap-2" data-testid="focus-control">
      <button
        type="button"
        data-testid="focus-toggle"
        aria-pressed={focused}
        onClick={onToggle}
        className={`px-4 py-2 rounded-full text-sm font-medium transition-colors select-none touch-manipulation flex items-center gap-2 ${
          focused
            ? 'bg-purple-600 text-white hover:bg-purple-700'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700'
        }`}
      >
        {focused ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        {focused ? FOCUS_OFF_LABEL : FOCUS_ON_LABEL}
      </button>

      <div
        data-testid="focus-status"
        role="status"
        aria-live="polite"
        className="text-xs text-gray-500 dark:text-gray-400 text-center max-w-xs"
      >
        {focusStatusText(focused, heldCount)}
      </div>

      <div data-testid="focus-hint" className="text-[11px] text-gray-400 dark:text-gray-500 text-center max-w-xs">
        {FOCUS_DISCIPLINE_HINT}
      </div>
    </div>
  );
}

export interface FocusRecapProps {
  items: HeldAnswer[];
  onDismiss: () => void;
}

/**
 * The exit recap: what arrived while the operator was focused. Every item's
 * own words, in arrival order — the transcript is the channel of record, and
 * this is its spoken counterpart made visible.
 */
export function FocusRecap({ items, onDismiss }: FocusRecapProps) {
  return (
    <div
      data-testid="focus-recap"
      role="region"
      aria-label="Answers that arrived while you were focused"
      className="mt-4 w-full max-w-md rounded-xl border border-purple-300 dark:border-purple-700 bg-purple-50 dark:bg-purple-950 px-4 py-3"
    >
      <div className="flex items-start gap-2">
        <Inbox className="w-4 h-4 mt-0.5 text-purple-700 dark:text-purple-300" />
        <div className="text-sm font-medium text-purple-800 dark:text-purple-200">
          While you were focused, {items.length === 1 ? 'one answer arrived' : `${items.length} answers arrived`}:
        </div>
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((item) => (
          <li
            key={item.id}
            data-testid="focus-recap-item"
            className="text-sm text-gray-700 dark:text-gray-200 break-words whitespace-pre-wrap border-l-2 border-purple-300 dark:border-purple-700 pl-3"
          >
            {item.text}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <button
          onClick={onDismiss}
          type="button"
          data-testid="focus-recap-dismiss"
          className="px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors select-none touch-manipulation"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
