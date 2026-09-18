import { useCallback, useSyncExternalStore } from 'react';
import { Mic, MicOff, Radio, Keyboard, AlertTriangle, BellRing } from 'lucide-react';
import type { VoiceCaptureMode, VoiceReadingLevel } from '@pi-web-ui/shared';
import type { VoiceLiveSurface, VoiceLiveSurfaceState } from '../../lib/voiceLive/surface';
import { ProposalCard } from './ProposalCard';
import { ParkingLotDrawer } from './ParkingLotDrawer';

/**
 * DriveModeVoiceLive — the native-voice surface for one lane.
 *
 * Open mic is the default (intent §20), with push-to-talk retained as the
 * explicit fallback and always one tap away; typed input lives in the existing
 * composer and is deliberately not duplicated here. The “listening suspended”
 * state is honest: it is shown whenever capture is genuinely not running, and
 * the surface never claims to be hearing anything while it is not.
 *
 * The component renders `VoiceLiveSurface` state and calls its methods. It holds
 * no wire knowledge: confirmations, promotions, reading levels and activity all
 * go through the surface (and therefore through the contract's typed frames).
 */

export interface DriveModeVoiceLiveProps {
  surface: VoiceLiveSurface;
  workerLabel?: string;
}

const VOICE_LIVE_READING_LEVELS: readonly VoiceReadingLevel[] = ['verbatim', 'summary', 'headlines'];

const READING_LEVEL_LABELS: Record<VoiceReadingLevel, string> = {
  verbatim: 'Verbatim',
  summary: 'Summary',
  headlines: 'Headlines',
};

export function DriveModeVoiceLive({ surface, workerLabel }: DriveModeVoiceLiveProps) {
  const state = useSyncExternalStore<VoiceLiveSurfaceState>(
    useCallback((onChange) => surface.subscribe(onChange), [surface]),
    useCallback(() => surface.getState(), [surface]),
    useCallback(() => surface.getState(), [surface]),
  );
  const controller = surface.controller;
  const controllerSnapshot = state.controller;

  const captureMode: VoiceCaptureMode = controllerSnapshot.captureMode;
  const listening = state.capture === 'live';
  const proposal = controllerSnapshot.proposal;
  const status = proposal ? (proposal.superseded ? 'stale' : proposal.proposal.presentation.completed ? 'presented' : 'pending') : 'stale';
  // M7: honest reachability. When the lane cannot be served at all, the surface
  // says so (with the host's/server's own reason) instead of offering a control
  // that cannot work.
  const laneUnavailable = state.lane.state === 'unavailable' || state.lane.state === 'unsupported';
  const lastTransportRefusal = controllerSnapshot.transportRefusals[controllerSnapshot.transportRefusals.length - 1];

  // Both publish through the surface, so `useSyncExternalStore` re-renders.
  const startListening = useCallback(async () => {
    // Open the lane on the wire FIRST (voice_session_start), then start capture:
    // a lane that is never opened server-side is not a lane at all, and capture
    // for it would be a microphone open onto nothing.
    const lane = surface.startLane();
    if (lane === 'unsupported') return;
    await surface.startCapture();
    const after = surface.getState();
    if (
      after.capture === 'live' &&
      (after.lane.state === 'unavailable' || after.lane.state === 'unsupported')
    ) {
      await surface.stopCapture('the voice lane is unavailable');
    }
  }, [surface]);

  const stopListening = useCallback(async () => {
    await surface.stopCapture('operator paused listening');
  }, [surface]);

  const lastCaption = controllerSnapshot.captions[controllerSnapshot.captions.length - 1];

  return (
    <div className="flex w-full flex-col gap-3" data-testid="drive-mode-voice-live">
      <section
        className="w-full max-w-md rounded-2xl border border-outline-default dark:border-outline-default-dark bg-surface dark:bg-surface-dark px-4 py-3"
        aria-label="Native voice lane"
        data-testid="voice-live-status"
        data-lane={state.lane.state}
      >
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {listening ? (
              <Radio size={15} aria-hidden className="text-pi-primary animate-pulse" />
            ) : (
              <MicOff size={15} aria-hidden className="text-content-muted dark:text-content-muted-dark" />
            )}
            <span className="text-xs font-semibold uppercase tracking-wider text-content-primary dark:text-content-primary-dark">
              Voice Mode{workerLabel ? ` — ${workerLabel}` : ''}
            </span>
          </div>
          <span
            className="text-[11px] text-content-muted dark:text-content-muted-dark"
            data-testid="voice-live-wire-state"
            data-state={controllerSnapshot.wireState}
          >
            {controllerSnapshot.wireState}
            {controllerSnapshot.workerActivity !== 'unknown' ? ` · worker ${controllerSnapshot.workerActivity}` : ''}
          </span>
        </header>

        {/* M7: the honest unavailable state. A lane that cannot start is named,
            with the host's or the server's own words, and offers a retry; the
            surrounding Drive Mode surface is untouched by the failure. */}
        {laneUnavailable && (
          <div
            className="mt-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2"
            data-testid="voice-live-unavailable"
            data-reason={state.lane.state}
            role="status"
          >
            <p className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 dark:text-amber-200">
              <AlertTriangle size={13} aria-hidden />
              {state.lane.state === 'unsupported'
                ? 'Native voice lane unavailable on this browser'
                : 'Native voice lane unavailable'}
            </p>
            <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-200" data-testid="voice-live-unavailable-detail">
              {state.lane.detail ?? 'no reason was reported'}
            </p>
            <p className="mt-1 text-[11px] text-content-muted dark:text-content-muted-dark">
              Voice Mode's existing microphone path is unaffected; nothing here was sent to the worker.
            </p>
            {state.lane.state === 'unavailable' && (
              <button
                type="button"
                data-testid="voice-live-retry"
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-400 dark:border-amber-700 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-200"
                onClick={() => {
                  surface.retryLane();
                }}
              >
                <Mic size={13} aria-hidden />
                Try the lane again
              </button>
            )}
          </div>
        )}

        {/* Honest capture state: never claim to listen while suspended; and no
            capture controls at all when the lane cannot be served (M7). */}
        {!laneUnavailable && (
          <>
            <p
              className={`mt-2 text-xs ${
                listening ? 'text-content-muted dark:text-content-muted-dark' : 'text-amber-600 dark:text-amber-400'
              }`}
              data-testid="voice-live-listening-state"
              data-listening={listening ? 'true' : 'false'}
              data-capture={state.capture}
            >
              {listening
                ? captureMode === 'push-to-talk'
                  ? 'Listening while you hold the button.'
                  : 'Listening — open mic. Talking over the talker ducks it; it never stops you being heard.'
                : state.capture === 'error'
                  ? `Microphone unavailable — ${state.captureDetail ?? 'unknown error'}. Push-to-talk and typing still work.`
                  : state.capture === 'suspended'
                    ? `Listening suspended${state.captureDetail ? ` — ${state.captureDetail}` : ''}. Push-to-talk and typing still work.`
                    : 'Not listening yet. Start the microphone, or type in the composer.'}
            </p>

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {listening ? (
            <button
              type="button"
              data-testid="voice-live-stop"
              className="inline-flex items-center gap-1.5 rounded-lg border border-outline-default dark:border-outline-default-dark px-3 py-1.5 text-xs"
              onClick={stopListening}
            >
              <MicOff size={13} aria-hidden />
              Pause listening
            </button>
          ) : (
            <button
              type="button"
              data-testid="voice-live-start"
              className="inline-flex items-center gap-1.5 rounded-lg bg-pi-primary px-3 py-1.5 text-xs font-semibold text-white"
              onClick={startListening}
            >
              <Mic size={13} aria-hidden />
              Start listening
            </button>
          )}
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Capture mode">
            {(['open-mic', 'push-to-talk'] as VoiceCaptureMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={captureMode === mode}
                data-testid={`voice-live-mode-${mode}`}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                  captureMode === mode
                    ? 'border-pi-primary text-pi-primary'
                    : 'border-outline-default dark:border-outline-default-dark text-content-muted dark:text-content-muted-dark'
                }`}
                onClick={() => controller.setCaptureMode(mode)}
              >
                {mode === 'open-mic' ? 'Open mic' : 'Push to talk'}
              </button>
            ))}
          </div>
        </div>

        {captureMode === 'push-to-talk' && (
          <button
            type="button"
            data-testid="voice-live-push-to-talk"
            className="mt-2 w-full rounded-lg border border-pi-primary px-3 py-2 text-xs font-semibold text-pi-primary active:bg-pi-primary/10"
            onPointerDown={() => void surface.beginPushToTalk()}
            onPointerUp={() => void surface.endPushToTalk()}
            onPointerLeave={() => void surface.endPushToTalk()}
          >
            Hold to talk
          </button>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Reading level">
            {VOICE_LIVE_READING_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={controllerSnapshot.readingLevel === level}
                data-testid={`voice-live-level-${level}`}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  controllerSnapshot.readingLevel === level
                    ? 'border-pi-primary text-pi-primary'
                    : 'border-outline-default dark:border-outline-default-dark text-content-muted dark:text-content-muted-dark'
                }`}
                onClick={() => controller.setReadingLevel(level)}
              >
                {READING_LEVEL_LABELS[level]}
              </button>
            ))}
          </div>
          {state.lastChime && (
            <span
              className="inline-flex items-center gap-1 text-[11px] text-content-muted dark:text-content-muted-dark"
              data-testid="voice-live-chime"
              data-chime={state.lastChime}
            >
              <BellRing size={12} aria-hidden />
              {state.lastChime}
            </span>
          )}
        </div>
        </>
        )}

        {/* The read-back of the composed draft: the click starts playback, and
            the surface reports "presented" only when the utterance ends (H3). */}
        {controllerSnapshot.proposal && state.readBack.state === 'interrupted' && (
          <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-testid="voice-live-readback-interrupted">
            Read-back stopped early
            {state.readBack.stoppedAtChar !== undefined ? ` at character ${state.readBack.stoppedAtChar}` : ''}
            {state.readBack.detail ? ` — ${state.readBack.detail}` : ''}. Confirm stays refused until it is read in
            full.
          </p>
        )}
        {controllerSnapshot.proposal && state.readBack.state === 'unsupported' && (
          <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-testid="voice-live-readback-unsupported">
            {state.readBack.detail ?? 'This browser cannot read it back aloud'} — the confirmation stays refused until
            the read-back rule is satisfied.
          </p>
        )}

        {/* Transport-level refusals (M8): the server refused a frame before it
            could name a lane (e.g. the voice-frame rate budget). Rendered, not
            dropped, and clearly not a lane event. */}
        {lastTransportRefusal && (
          <p
            className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400"
            data-testid="voice-live-transport-refusal"
            data-code={lastTransportRefusal.code}
            data-fatal={lastTransportRefusal.fatal ? 'true' : 'false'}
          >
            Voice transport {lastTransportRefusal.fatal ? 'stopped' : 'refused a frame'}: {lastTransportRefusal.code}
            {lastTransportRefusal.message ? ` — ${lastTransportRefusal.message}` : ''}
          </p>
        )}

        {lastCaption && (
          <p
            className="mt-2 text-xs italic text-content-muted dark:text-content-muted-dark"
            data-testid="voice-live-caption"
          >
            {lastCaption.speaker === 'operator' ? 'You' : 'Talker'}: {lastCaption.text}
            {lastCaption.final ? '' : ' …'}
          </p>
        )}

        {state.captureFaults.length > 0 && (
          <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400" data-testid="voice-live-fault">
            <AlertTriangle size={12} aria-hidden />
            {state.captureFaults[state.captureFaults.length - 1].detail}
          </p>
        )}
        {controllerSnapshot.lastError && (
          <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400" data-testid="voice-live-error">
            {controllerSnapshot.lastError.code}: {controllerSnapshot.lastError.message}
          </p>
        )}
        {controllerSnapshot.refusals.length > 0 && (
          <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-testid="voice-live-refusal">
            Refused: {controllerSnapshot.refusals[controllerSnapshot.refusals.length - 1].detail}
          </p>
        )}
      </section>

      {proposal && (
        <ProposalCard
          proposal={proposal.proposal}
          status={status}
          staleDetail={proposal.superseded ? 'a newer proposal replaced this one' : undefined}
          readingBack={
            state.readBack.state === 'reading' &&
            state.readBack.proposalId === proposal.proposal.proposalId
          }
          readBackSupported={state.readBack.supported}
          onConfirm={(variant) => controller.confirmProposal({ variant })}
          onCancel={() => controller.cancelProposal()}
          onReadBack={(variant) => void surface.readBackProposal(variant)}
        />
      )}

      {controllerSnapshot.parking.items.length > 0 && (
        <ParkingLotDrawer
          items={controllerSnapshot.parking.items}
          onPromote={(itemId) => controller.promoteParkedItem(itemId)}
          onRequestList={() => controller.requestParkingList()}
        />
      )}

      {!listening && (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-content-muted dark:text-content-muted-dark" data-testid="voice-live-typed-fallback">
          <Keyboard size={12} aria-hidden />
          Typed input stays in the composer — the voice lane never carries your words to the worker.
        </p>
      )}
    </div>
  );
}
