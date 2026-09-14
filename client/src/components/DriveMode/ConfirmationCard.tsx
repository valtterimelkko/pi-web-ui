import { useState } from 'react';
import { Check, X, Send } from 'lucide-react';

/**
 * ConfirmationCard — the explicit, quoted confirmation gate (plan §4.1/D4).
 *
 * The pending proposal is shown exactly — whatever Confirm releases is what
 * this card quoted, byte for byte — with three ways to respond and nothing
 * else:
 *   - Confirm: the explicit confirm gesture (releases the server's own stored
 *     proposal — this button never sends proposal text);
 *   - Cancel: the explicit cancel gesture;
 *   - Text fallback: the operator's typed words go to the talker exactly as
 *     typed. An ambiguous response therefore acts on nothing by construction:
 *     the card never interprets, and the server releases only on a
 *     confirmation-classified utterance.
 *
 * P26 — the card tells the truth about what will be sent. When the harness's
 * mechanical transform tidied the operator's words (removed a commission
 * frame, hesitation, filler), the header says "tidied" and shows what was
 * removed, so the tidying is visible and correctable — never silent, and
 * never an untrue "exactly" claim. When nothing was removed (or an older
 * server reports nothing), the claim stays "your words, exactly" — which is
 * then true. The card must not cry wolf.
 */
export interface ConfirmationCardProps {
  /** The exact text Confirm will release — quoted as shown. */
  proposalText: string;
  /** True when the harness tidied the operator's words before this proposal.
   *  Absent or false: the untouched-words claim stands (an old server relays
   *  verbatim, so there the claim is true — never guessed, never faked). */
  cleaned?: boolean;
  /** What the tidying removed, shown on the card so the operator can see it
   *  without a click. Only rendered when `cleaned` is true. */
  removed?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The operator's typed words, passed verbatim. */
  onSubmitText: (text: string) => void;
}

export function ConfirmationCard({
  proposalText,
  cleaned,
  removed,
  onConfirm,
  onCancel,
  onSubmitText,
}: ConfirmationCardProps) {
  const [draft, setDraft] = useState('');

  const submitDraft = () => {
    if (!draft.trim()) return;
    onSubmitText(draft);
    setDraft('');
  };

  return (
    <div
      className="w-full max-w-md rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950 px-4 py-3"
      role="region"
      aria-label="Pending proposal"
      data-testid="confirmation-card"
    >
      <div className="text-sm font-medium text-blue-800 dark:text-blue-200">
        {cleaned
          ? 'Ready to send — your words, tidied:'
          : 'Ready to send — your words, exactly:'}
      </div>
      <blockquote
        className="mt-1 border-l-4 border-blue-400 dark:border-blue-600 pl-3 text-sm text-gray-800 dark:text-gray-100 break-words whitespace-pre-wrap"
        data-testid="pending-proposal-text"
      >
        {proposalText}
      </blockquote>
      {cleaned && removed?.trim() && (
        <div
          className="mt-2 text-xs text-gray-600 dark:text-gray-300"
          data-testid="relay-tidied-note"
        >
          Taken out of your words:{' '}
          <span
            className="line-through opacity-75 break-words"
            data-testid="relay-removed-text"
          >
            {removed}
          </span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onConfirm}
          className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 active:scale-[0.98] transition-colors select-none touch-manipulation flex items-center gap-1.5"
          type="button"
        >
          <Check className="w-4 h-4" />
          Confirm
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-100 text-sm font-medium hover:bg-gray-300 dark:hover:bg-gray-600 active:scale-[0.98] transition-colors select-none touch-manipulation flex items-center gap-1.5"
          type="button"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitDraft();
          }}
          placeholder='Type instead — e.g. "yes" or a change of mind'
          aria-label="Type a reply instead of speaking"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          type="text"
        />
        <button
          onClick={submitDraft}
          className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 active:scale-[0.98] transition-colors select-none touch-manipulation flex items-center gap-1"
          type="button"
        >
          <Send className="w-3.5 h-3.5" />
          Send reply
        </button>
      </div>
    </div>
  );
}
