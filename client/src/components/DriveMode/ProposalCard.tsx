import { useState } from 'react';
import { Check, X, Volume2, AlertTriangle, Send } from 'lucide-react';
import type { VoiceCreatedProposal, VoiceProposalVariant } from '@pi-web-ui/shared';
import type { ProposalPresentationStatus } from '../../lib/voiceLive/controller';

/**
 * ProposalCard — the operator's decision surface for ONE live proposal.
 *
 * It renders the identity the release will be bound to (`proposalId`, the
 * proposal's own `version`, the SHA-256 of the presented variant's bytes) and
 * both retained variants, because §18.2's read-back rule is only meaningful if
 * the operator can see the actual bytes. Confirm/cancel are gestures: they call
 * the surface, which builds the typed frame — this component never constructs a
 * wire message and never holds the operator's words.
 *
 * PRESENTED vs STALE is the card's honesty requirement and is visible, not a
 * tooltip:
 *   - `presented` — the read-back of this identity completed in full;
 *   - `pending`   — a confirmation now would be refused (`voice_presentation_incomplete`),
 *                   so the primary action is disabled and says why;
 *   - `stale`     — a newer proposal replaced this one (or it was resolved);
 *                   nothing on this card can release anything.
 */

export interface ProposalCardProps {
  proposal: VoiceCreatedProposal;
  status: ProposalPresentationStatus;
  /** Why it is stale (shown verbatim; never a reassurance). */
  staleDetail?: string;
  /** True while a confirmation is in flight. */
  busy?: boolean;
  /** True while a read-back of this proposal is playing (H3). */
  readingBack?: boolean;
  /** False when this host cannot speak the read-back at all. */
  readBackSupported?: boolean;
  onConfirm: (variant: VoiceProposalVariant) => void;
  onCancel: () => void;
  /**
   * Ask the surface to read this variant back aloud. The click starts playback
   * and nothing else: only the playback's own completion may report the
   * proposal as presented (H3), which is why the card has no report callback.
   */
  onReadBack?: (variant: VoiceProposalVariant) => void;
}

const STATUS_LABEL: Record<ProposalPresentationStatus, string> = {
  presented: 'Read back in full — check the words before you confirm',
  pending: 'Not read back in full yet — confirmation will be refused',
  stale: 'Stale — this proposal is no longer live',
};

export function ProposalCard({
  proposal,
  status,
  staleDetail,
  busy = false,
  readingBack = false,
  readBackSupported = true,
  onConfirm,
  onCancel,
  onReadBack,
}: ProposalCardProps) {
  const [view, setView] = useState<VoiceProposalVariant>(proposal.presentedVariant);
  const shown = view === 'original' ? proposal.original : proposal.tidied;
  const tidiedDiffers = proposal.original !== proposal.tidied;
  const canConfirm = status === 'presented' && !busy;

  return (
    <div
      className="w-full max-w-md rounded-2xl border border-outline-default dark:border-outline-default-dark bg-surface dark:bg-surface-dark shadow-xs px-4 py-3.5"
      role="region"
      aria-label="Live proposal"
      data-testid="proposal-card"
      data-proposal-id={proposal.proposalId}
      data-proposal-version={String(proposal.version)}
      data-proposal-sha256={proposal.sha256}
      data-presentation-status={status}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-content-primary dark:text-content-primary-dark uppercase tracking-wider">
          One thing for the worker
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Proposal variant">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'original'}
            data-testid="proposal-variant-original"
            className={`text-[11px] px-2 py-0.5 rounded-full border ${
              view === 'original'
                ? 'border-pi-primary text-pi-primary'
                : 'border-outline-default dark:border-outline-default-dark text-content-muted dark:text-content-muted-dark'
            }`}
            onClick={() => setView('original')}
          >
            your words
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'tidied'}
            data-testid="proposal-variant-tidied"
            className={`text-[11px] px-2 py-0.5 rounded-full border ${
              view === 'tidied'
                ? 'border-pi-primary text-pi-primary'
                : 'border-outline-default dark:border-outline-default-dark text-content-muted dark:text-content-muted-dark'
            }`}
            onClick={() => setView('tidied')}
          >
            tidied
          </button>
        </div>
      </div>

      <blockquote
        className="mt-2 border-l-2 border-pi-primary pl-3 text-sm text-content-primary dark:text-content-primary-dark break-words whitespace-pre-wrap font-mono"
        data-testid="proposal-text"
        data-variant={view}
      >
        {shown}
      </blockquote>

      {tidiedDiffers && view === 'tidied' && (
        <div
          className="mt-2 text-xs text-content-muted dark:text-content-muted-dark"
          data-testid="proposal-tidy-note"
        >
          A visible tidy happened — switch to <em>your words</em> to release the original.
        </div>
      )}

      <div
        className={`mt-2.5 flex items-start gap-1.5 text-xs ${
          status === 'presented'
            ? 'text-content-muted dark:text-content-muted-dark'
            : 'text-amber-600 dark:text-amber-400'
        }`}
        data-testid="proposal-status"
        data-status={status}
      >
        {status === 'presented' ? (
          <Check size={14} aria-hidden className="mt-px" />
        ) : (
          <AlertTriangle size={14} aria-hidden className="mt-px" />
        )}
        <span>
          {STATUS_LABEL[status]}
          {status === 'stale' && staleDetail ? ` — ${staleDetail}` : ''}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-content-muted dark:text-content-muted-dark">
        <span data-testid="proposal-id" title={proposal.proposalId}>
          id {proposal.proposalId}
        </span>
        <span data-testid="proposal-version">v{proposal.version}</span>
        <span data-testid="proposal-sha" title={proposal.sha256}>
          sha {proposal.sha256.slice(0, 12)}…
        </span>
        <span data-testid="proposal-route">{proposal.promotionRoute}</span>
        {proposal.presentation.completed ? (
          <span data-testid="proposal-presented-variant">
            presented: {proposal.presentedVariant}
          </span>
        ) : (
          <span data-testid="proposal-not-presented">not presented in full</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="proposal-confirm"
          disabled={!canConfirm}
          title={
            status === 'presented'
              ? 'Release exactly these bytes'
              : 'Refused until the read-back is complete'
          }
          className="inline-flex items-center gap-1.5 rounded-lg bg-pi-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          onClick={() => onConfirm(view)}
        >
          <Send size={13} aria-hidden />
          Confirm
        </button>
        {onReadBack && (
          <button
            type="button"
            data-testid="proposal-readback"
            data-reading={readingBack ? 'true' : 'false'}
            disabled={status === 'stale' || readingBack || !readBackSupported}
            title={readBackSupported ? undefined : 'This browser cannot read it back aloud'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-outline-default dark:border-outline-default-dark px-3 py-1.5 text-xs disabled:opacity-50"
            onClick={() => {
              // Starts the read-back and NOTHING ELSE. "Presented" is decided by
              // the playback reaching its end (surface.reportPresentation), so a
              // click can never fabricate a completed presentation (H3).
              onReadBack(view);
            }}
          >
            <Volume2 size={13} aria-hidden />
            {readingBack ? 'Reading it back…' : 'Read it back'}
          </button>
        )}
        <button
          type="button"
          data-testid="proposal-cancel"
          className="inline-flex items-center gap-1.5 rounded-lg border border-outline-default dark:border-outline-default-dark px-3 py-1.5 text-xs"
          onClick={onCancel}
        >
          <X size={13} aria-hidden />
          Cancel
        </button>
      </div>
    </div>
  );
}
