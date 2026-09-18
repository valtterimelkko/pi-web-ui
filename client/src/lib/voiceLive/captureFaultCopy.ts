import type { CaptureFaultReason } from './captureSession';

/**
 * What the operator is told when capture cannot start.
 *
 * This exists as a pure function because the previous copy lied in a way that
 * mattered: it promised "push-to-talk and typing still work" after a capture
 * failure, but push-to-talk drives THE SAME capture path — so on 2026-09-18 the
 * deployed UI told the operator that push-to-talk was fine while push-to-talk
 * could not work either. The claim is now derived from the named reason:
 * a worklet that will not load blocks every microphone mode, and the only thing
 * genuinely still available is typed input (and the legacy relay lane, which is
 * a different capture path and keeps working).
 */
export interface CaptureUnavailableInput {
  /** The browser's or the fault's own words, when there are any. */
  detail?: string | null;
  /** The named cause, when one was identified. */
  reason?: CaptureFaultReason | null;
  /** The mode the operator had chosen, for the sentence that fits. */
  mode?: string;
}

export function captureUnavailableMessage(input: CaptureUnavailableInput): string {
  const detailText = input.detail ? ` — ${input.detail}` : '';

  if (input.reason === 'worklet_unavailable') {
    return (
      `Microphone unavailable${detailText}. The capture worklet could not be loaded, ` +
      'which blocks every microphone mode, including push-to-talk. Nothing was sent to the worker.'
    );
  }

  const pttNote =
    input.mode === 'push-to-talk'
      ? 'Push-to-talk runs through the same microphone path, so it is affected by the same failure.'
      : 'Push-to-talk uses the same microphone path and is affected by the same failure.';

  return `Microphone unavailable${detailText}. ${pttNote} Nothing was sent to the worker.`;
}
