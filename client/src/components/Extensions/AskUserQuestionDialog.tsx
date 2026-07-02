import { useState, useEffect } from 'react';
import { Check, HelpCircle } from 'lucide-react';

/**
 * AskUserQuestion option (mirrors the Claude SDK AskUserQuestionInput shape).
 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  /** Optional preview content. Rendered as escaped plain text — never raw HTML. */
  preview?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserAnswerValue {
  /** Answers keyed by exact question text; multi-select values are comma-separated. */
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

interface AskUserQuestionDialogProps {
  questions: AskUserQuestion[];
  onSubmit: (value: AskUserAnswerValue) => void;
  onCancel: () => void;
  /** Epoch ms when the ask-user window ends (receivedAt + timeout). */
  expiresAt?: number;
  /** Server signalled the dialog closed for a non-answer reason (extension_ui_cancel). */
  expired?: boolean;
  /** Why the dialog closed ('timeout' | 'aborted' | 'turn_end' | 'disconnected'). */
  expiredReason?: string;
  /** Dismiss the expired dialog. The request is already dead — no server round-trip. */
  onDismissExpired?: () => void;
}

/**
 * Render Claude's AskUserQuestion (1–4 questions, each 2–4 options, optional
 * multi-select / previews) as an interactive modal.
 *
 * - Submit is disabled until every question has an answer (selection or freeform).
 * - A freeform "Other" entry overrides the structured selection for that question.
 * - Previews are rendered as plain text (React-escaped); raw HTML is never used.
 * - Content scrolls internally so tall dialogs stay usable on narrow widths.
 * - A soft deadline warning appears only in the final 60s (server drives expiry).
 * - On `expired`, the dialog switches to an expired state that keeps the user's
 *   draft visible and offers a dismiss (no submit) — the server already moved on.
 */
export function AskUserQuestionDialog({
  questions,
  onSubmit,
  onCancel,
  expiresAt,
  expired,
  expiredReason,
  onDismissExpired,
}: AskUserQuestionDialogProps) {
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [previewFor, setPreviewFor] = useState<Record<string, string>>({});
  // Ticking clock for the soft deadline indicator. Only runs while a deadline is
  // known and the dialog is not already expired.
  const [now, setNow] = useState<number>(() => Date.now());

  // Reset local state whenever a new request (new questions array) arrives.
  useEffect(() => {
    setSelection({});
    setFreeform({});
    setNotes({});
    setPreviewFor({});
  }, [questions]);

  useEffect(() => {
    if (!expiresAt || expired) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [expiresAt, expired]);

  const remainingMs = expiresAt !== undefined ? Math.max(0, expiresAt - now) : null;
  const nearExpiry = !expired && remainingMs !== null && remainingMs > 0 && remainingMs < 60_000;

  const selectedLabels = (question: string): string[] => selection[question] ?? [];

  const toggle = (question: AskUserQuestion, label: string): void => {
    setSelection((prev) => {
      const cur = prev[question.question] ?? [];
      if (question.multiSelect) {
        const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
        return { ...prev, [question.question]: next };
      }
      // single-select: clicking the active option clears it, otherwise replaces
      return { ...prev, [question.question]: cur[0] === label ? [] : [label] };
    });
    setPreviewFor((prev) => ({ ...prev, [question.question]: label }));
  };

  const isAnswered = (q: AskUserQuestion): boolean =>
    (freeform[q.question] ?? '').trim().length > 0 || selectedLabels(q.question).length > 0;

  const allAnswered = questions.every(isAnswered);

  const handleSubmit = (): void => {
    const answers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string }> = {};
    for (const q of questions) {
      const ff = (freeform[q.question] ?? '').trim();
      answers[q.question] = ff || selectedLabels(q.question).join(', ');
      const note = (notes[q.question] ?? '').trim();
      if (note) annotations[q.question] = { notes: note };
    }
    onSubmit({ answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) });
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Claude question"
        className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 w-full max-w-lg shadow-xl flex flex-col max-h-[85vh]"
      >
        {/* Header */}
        <div className="flex items-center gap-3 p-4 border-b border-gray-200 dark:border-gray-700">
          <HelpCircle className="w-5 h-5 text-blue-600 flex-shrink-0" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {questions.length > 1 ? `${questions.length} questions` : 'Claude has a question'}
          </h3>
        </div>

        {/* Expired banner: the assistant already moved on. Keep the draft below. */}
        {expired && (
          <div role="status" className="mx-4 mt-4 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-200">
            This question {expiredReason ? `expired (${expiredReason})` : 'expired'} and the assistant moved on.
            Your draft is kept below — copy it or send it as a normal message.
          </div>
        )}

        {/* Soft near-expiry warning (final 60s only). The server still drives expiry. */}
        {nearExpiry && remainingMs !== null && (
          <div role="status" className="mx-4 mt-4 p-2 rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 text-xs text-amber-800 dark:text-amber-200">
            Closing in {Math.ceil(remainingMs / 1000)}s — answer soon or this will expire.
          </div>
        )}

        {/* Scrollable content */}
        <div className="p-4 overflow-y-auto flex-1 space-y-6">
          {questions.map((q, idx) => {
            const labels = selectedLabels(q.question);
            const previewLabel = previewFor[q.question];
            const previewOpt = q.options.find((o) => o.label === previewLabel && o.preview);
            return (
              <fieldset key={q.question} className="space-y-2">
                <legend className="flex items-center gap-2 mb-1">
                  <span className="inline-block text-xs font-medium px-2 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200">
                    {q.header}
                  </span>
                  {questions.length > 1 && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      Question {idx + 1} of {questions.length}
                    </span>
                  )}
                </legend>
                <div className="text-sm text-gray-800 dark:text-gray-200 font-medium">{q.question}</div>

                <div className="space-y-2">
                  {q.options.map((opt) => {
                    const selected = labels.includes(opt.label);
                    return (
                      <button
                        type="button"
                        key={opt.label}
                        aria-pressed={selected}
                        onClick={() => toggle(q, opt.label)}
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${
                          selected
                            ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-500'
                            : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-gray-900 dark:text-gray-100">{opt.label}</span>
                          {selected && <Check className="w-4 h-4 text-blue-600 flex-shrink-0" />}
                        </div>
                        {opt.description && (
                          <span className="block text-xs text-gray-500 dark:text-gray-400 mt-1">
                            {opt.description}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Freeform "Other" entry — overrides the structured selection when filled */}
                <input
                  type="text"
                  value={freeform[q.question] ?? ''}
                  onChange={(e) => setFreeform((p) => ({ ...p, [q.question]: e.target.value }))}
                  placeholder="Other (type your own answer)"
                  className="w-full px-3 py-2 mt-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />

                {/* Optional notes — forwarded to the backend as annotations[question].notes */}
                <input
                  type="text"
                  value={notes[q.question] ?? ''}
                  onChange={(e) => setNotes((p) => ({ ...p, [q.question]: e.target.value }))}
                  placeholder="Notes (optional)"
                  className="w-full px-3 py-2 mt-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />

                {/* Preview: plain text only. React escapes it; raw HTML is never injected. */}
                {previewOpt?.preview && (
                  <pre className="mt-2 p-3 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-xs font-mono text-gray-700 dark:text-gray-300 overflow-auto max-h-48 whitespace-pre-wrap break-words">
                    {previewOpt.preview}
                  </pre>
                )}
              </fieldset>
            );
          })}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-700">
          {expired ? (
            <button
              type="button"
              onClick={() => onDismissExpired?.()}
              className="px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg transition-colors"
            >
              Dismiss
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!allAnswered}
                className="px-4 py-2 bg-gray-900 hover:bg-gray-800 disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                Submit
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
