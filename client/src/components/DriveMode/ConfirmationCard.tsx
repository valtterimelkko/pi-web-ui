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
  /** What the tidying removed — the removed FRAGMENTS only, joined (the
   *  server reports fragments, never the operator's whole utterance). Shown on
   *  the card so the operator can see it without a click. Only rendered when
   *  `cleaned` is true. */
  removed?: string;
  /**
   * D2 — the operator's exact words: the bytes an original-variant release
   * sends. Present only when the server reported a visible tidy, so there is a
   * real choice. The card offers it as a VIEW-ONLY disclosure plus one explicit
   * secondary action; the primary Confirm still sends `proposalText`.
   */
  original?: string;
  /**
   * D-card — the identity of the exact bytes this card displays (the server's
   * draft version and content hash). Rendered only as observable attributes:
   * the echo itself is the confirm gesture's job (useVoiceTurn reads the same
   * proposal state), the card just makes the identity visible and testable.
   * Absent on an older server.
   */
  version?: number;
  hash?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The operator's typed words, passed verbatim. */
  onSubmitText: (text: string) => void;
  /** Release the operator's original words instead of the tidied relay text
   *  (CONFIRM + releaseVariant 'original' on the surface). Optional: absent on
   *  an older surface, in which case no original action is offered. */
  onSendOriginal?: () => void;
}

export function ConfirmationCard({
  proposalText,
  cleaned,
  removed,
  original,
  version,
  hash,
  onConfirm,
  onCancel,
  onSubmitText,
  onSendOriginal,
}: ConfirmationCardProps) {
  const [draft, setDraft] = useState('');

  const submitDraft = () => {
    if (!draft.trim()) return;
    onSubmitText(draft);
    setDraft('');
  };

  // A choice only exists when the harness visibly tidied AND the raw words
  // differ from what the card quotes. Both facts come from the server's own
  // report — the client never derives relay text and never guesses.
  const offersOriginal = Boolean(
    cleaned && original && original !== proposalText && onSendOriginal
  );

  return (
    <div
      className="w-full max-w-md rounded-xl border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950 px-4 py-3"
      role="region"
      aria-label="Pending proposal"
      data-testid="confirmation-card"
      {...(version !== undefined ? { 'data-proposal-version': String(version) } : {})}
      {...(hash !== undefined ? { 'data-proposal-hash': hash } : {})}
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
      {offersOriginal && (
        <details
          className="mt-2 text-xs text-gray-600 dark:text-gray-300"
          data-testid="relay-original-disclosure"
        >
          <summary className="cursor-pointer select-none hover:text-gray-800 dark:hover:text-gray-100">
            Show your exact words
          </summary>
          <div
            className="mt-1 border-l-4 border-gray-300 dark:border-gray-600 pl-3 text-sm text-gray-800 dark:text-gray-100 break-words whitespace-pre-wrap"
            data-testid="relay-original-text"
          >
            {original}
          </div>
          <button
            onClick={() => onSendOriginal?.()}
            className="mt-2 px-3 py-1.5 rounded-lg border border-gray-400 dark:border-gray-500 text-gray-700 dark:text-gray-200 font-medium hover:bg-gray-100 dark:hover:bg-gray-800 active:scale-[0.98] transition-colors select-none touch-manipulation flex items-center gap-1.5"
            type="button"
          >
            <Send className="w-3.5 h-3.5" />
            Send my exact words
          </button>
        </details>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onConfirm}
          className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 active:scale-[0.98] transition-colors select-none touch-manipulation flex items-center gap-1.5"
          type="button"
        >
          <Check className="w-4 h-4" />
          {offersOriginal ? 'Confirm — send tidied' : 'Confirm'}
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
