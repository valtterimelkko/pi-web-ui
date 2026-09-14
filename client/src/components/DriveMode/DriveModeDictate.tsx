import { useEffect, useCallback, useState } from 'react';
import { Mic, MicOff, Square, VolumeX } from 'lucide-react';
import { useDriveModeStore } from '../../store/driveModeStore';
import { useSessionStore } from '../../store/sessionStore';
import { useReadAloud } from '../../hooks/useReadAloud';
import { useTurnDigest } from '../../hooks/useTurnDigest';
import { useVoiceTurn, talkerRuntimeFor } from './useVoiceTurn';
import { ConfirmationCard } from './ConfirmationCard';
import { FloorBanner } from './FloorBanner';
import { ReadingLevelControl } from './ReadingLevelControl';
import { useAnswerReader } from './useAnswerReader';
import {
  useReadingLevelStore,
  type ReadingLevel,
} from './readingLevel';
import { deriveFloorState, arbiterFloorSignals, type FloorView } from './voiceFloor';
import { speechArbiter } from '../../lib/speechArbiter';
import { getLastAssistantText } from '../../lib/driveModeUtils';

export interface DriveModeDictateProps {
  sessionId: string;
  /** The active session's runtime family — routes talker turns. */
  sdkType?: string | null;
  modelName: string;
  sessionDisplayName: string;
  onExit: () => void;
  onAbort?: () => void;
}

/**
 * The Voice Mode surface — talking while working (plan Phase 4).
 *
 * Two lanes, one floor:
 *   - Capture never stops: the mic is always one tap away, including while
 *     speech plays. Tapping while speech plays is the BARGE-IN gesture — the
 *     floor changes hands and the arbiter ducks (restoring at the next chunk
 *     boundary). There is deliberately no state in which the mic control is
 *     disabled because the surface is speaking.
 *   - Everything the operator hears goes through the speech arbiter (§4.1
 *     ladder); everything the operator says goes to the talker verbatim.
 *     NOTHING in this component sends to the worker except through the
 *     talker's confirm-gated release path.
 */
export function DriveModeDictate({
  sessionId,
  sdkType,
  modelName,
  sessionDisplayName,
  onExit,
  onAbort,
}: DriveModeDictateProps) {
  const voice = useVoiceTurn(sessionId, sdkType);
  const readAloud = useReadAloud('drive-mode');
  const phase = useDriveModeStore((s) => s.phase);
  const setPhase = useDriveModeStore((s) => s.setPhase);
  const isStreaming = useSessionStore((s) => s.isStreaming);
  const messages = useSessionStore((s) => s.messages);
  const readingLevel = useReadingLevelStore((s) => s.level);
  const setReadingLevel = useReadingLevelStore((s) => s.setLevel);

  const lastAssistantText = getLastAssistantText(messages);
  const isRecording = voice.state === 'recording';

  // The talker in the reading path (P17): how much of the worker's output is
  // spoken is the operator's choice, applied at turn end and — when they change
  // it mid-answer — at the next chunk boundary. Playback only: nothing here can
  // gate capture, and nothing here can condense the operator's words.
  const talkerRuntime = talkerRuntimeFor(sdkType ?? undefined);
  const { requestDigest } = useTurnDigest(sessionId, talkerRuntime);
  const { spokenKind, fallbackNote } = useAnswerReader({
    isStreaming,
    lastAssistantText,
    level: readingLevel,
    requestDigest,
  });
  const handleReadingLevel = useCallback(
    (level: ReadingLevel) => setReadingLevel(level),
    [setReadingLevel]
  );

  // Vibrate when recording starts
  useEffect(() => {
    if (isRecording) {
      navigator.vibrate?.(100);
    }
  }, [isRecording]);

  // ---------------------------------------------------------------------------
  // Store phase bookkeeping. Kept for store-contract coherence with the rest
  // of the app — NOTHING in this surface is gated on `phase` any more: the
  // old agent-working block is replaced by the floor banner below, and the
  // mic stays usable in every state.
  //
  // ONE writer with explicit precedence (P13): the previous three competing
  // effects each called setPhase unconditionally and shared `phase` in their
  // dependency arrays, so when the operator barged in (recording) while the
  // worker streamed, 'dictate' and 'agent-working' re-fired each other in an
  // unbounded nested-update loop — React error #185, full-screen error
  // boundary. Precedence: capture (recording/processing) > worker streaming
  // > audio-playing handback; every write is conditional on a real change.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (isRecording || voice.state === 'processing') {
      if (phase !== 'dictate') setPhase('dictate');
    } else if (isStreaming) {
      if (phase !== 'agent-working') setPhase('agent-working');
    } else if (phase === 'agent-working') {
      setPhase('read-aloud-ready');
    } else if (phase === 'audio-playing' && readAloud.state === 'idle') {
      setPhase('dictate');
    }
  }, [voice.state, isRecording, isStreaming, readAloud.state, phase, setPhase]);

  // ---------------------------------------------------------------------------
  // The four states, derived from what the surface receives (§4.1).
  // ---------------------------------------------------------------------------
  const [floorView, setFloorView] = useState<FloorView>(() =>
    deriveFloorState({
      operatorSpeaking: voice.operatorSpeaking,
      arbiter: arbiterFloorSignals(speechArbiter.getState()),
      workerStreaming: isStreaming,
    })
  );
  useEffect(() => {
    const sync = () => {
      setFloorView(
        deriveFloorState({
          operatorSpeaking: voice.operatorSpeaking,
          arbiter: arbiterFloorSignals(speechArbiter.getState()),
          workerStreaming: isStreaming,
        })
      );
    };
    sync();
    return speechArbiter.subscribe(sync);
  }, [voice.operatorSpeaking, isStreaming]);

  // Is there speech to stop? Playing, waiting (queued / held), or ducked under
  // the operator's floor all count — the control is offered whenever a hard
  // cancel would do something. Playback state only; never capture.
  const talkerBusy =
    floorView.state === 'talker-speaking' ||
    floorView.state === 'answer-ready-held' ||
    (floorView.state === 'you-have-the-floor' && (floorView.ducked || floorView.speechHeld));

  // ---------------------------------------------------------------------------
  // The worker's completed answer speaks at the next natural gap (§4.1 rule 3)
  // — now through the answer reader, so the operator's reading level decides
  // whether it is read, digested, or reduced to the one Headlines line. This
  // component no longer submits it directly: the reader owns the plan, the
  // digest request, and the mid-speech level flip. The claim on the answer is
  // made there, at the decision, so stopping playback later never re-opens it
  // (P15) and read-aloud never collides with it (P16).
  // ---------------------------------------------------------------------------

  const handleMicClick = useCallback(() => {
    // Taking the floor is ALWAYS available — including while speech plays.
    // Barge-in ducks via the arbiter and restores at the next chunk boundary;
    // there is deliberately NO hard stop here (that was the old behaviour).
    voice.toggle();
  }, [voice]);

  const handleReadAloud = useCallback(() => {
    if (readAloud.state === 'playing') {
      readAloud.stop();
      setPhase('dictate');
      return;
    }
    if (lastAssistantText) {
      readAloud.play(lastAssistantText);
      setPhase('audio-playing');
    }
  }, [readAloud, lastAssistantText, setPhase]);

  const handleToggleSpeed = useCallback(() => {
    readAloud.toggleSpeed();
  }, [readAloud]);

  // Stop the talker: stop the current chunk AND discard the queue, and do not
  // resume the cancelled item. This is `stopAll()` — the arbiter's only hard
  // cancel — and nothing else: it never touches capture, the operator's floor,
  // or anything server-side. The shared spoken ledger already records the
  // answer at submission time, so a cancelled answer is never re-submitted and
  // no suppression is layered on top (verified by the P15 stop-talker tests).
  const handleStopTalker = useCallback(() => {
    speechArbiter.stopAll();
  }, []);

  const showAnswerControls = lastAssistantText != null || readAloud.state !== 'idle';

  return (
    <div className="flex flex-col items-center h-full w-full px-4 py-6 relative overflow-y-auto">
      {/* Exit button */}
      <button
        onClick={onExit}
        className="absolute top-4 right-4 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        type="button"
      >
        ✕ Exit
      </button>

      {/* Session info */}
      <div className="flex flex-col items-center mt-8 mb-4">
        <div className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {sessionDisplayName}
        </div>
        <div className="text-sm text-gray-500 dark:text-gray-400">{modelName}</div>
      </div>

      {/* The reading level — how much of the worker's output is spoken, and
          which level the answer in flight is being read at. Persisted as the
          operator's default (P17). */}
      <div className="mb-4">
        <ReadingLevelControl
          level={readingLevel}
          onSelect={handleReadingLevel}
          spokenKind={spokenKind}
          fallbackNote={fallbackNote}
        />
      </div>

      {/* The four states — who has the floor, at a glance */}
      <div className="mb-6">
        <FloorBanner view={floorView} />
      </div>

      {/* Mic button — never disabled because the surface is speaking */}
      <button
        onClick={handleMicClick}
        disabled={voice.state === 'processing'}
        className={`w-28 h-28 rounded-full flex items-center justify-center transition-all duration-200 select-none touch-manipulation ${
          voice.state === 'processing' ? 'cursor-not-allowed' : 'active:scale-95'
        } ${
          isRecording
            ? 'bg-red-50 dark:bg-red-950 border-4 border-red-500 animate-pulse'
            : 'bg-gray-100 dark:bg-gray-800 border-4 border-gray-200 dark:border-gray-700'
        }`}
        aria-label={isRecording ? 'Stop recording' : 'Start recording'}
        type="button"
      >
        {voice.state === 'error' ? (
          <MicOff
            className={`w-10 h-10 ${
              isRecording ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
            }`}
          />
        ) : (
          <Mic
            className={`w-10 h-10 ${
              isRecording ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
            }`}
          />
        )}
      </button>

      {/* Refusal — surfaced honestly (never swallowed) */}
      {voice.refusal && (
        <div className="mt-4 w-full max-w-md rounded-xl border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-4 py-3" role="alert">
          <div className="text-sm text-red-700 dark:text-red-300">{voice.refusal}</div>
        </div>
      )}

      {/* Dictation error */}
      {voice.state === 'error' && voice.errorMessage && (
        <div className="mt-2 text-sm text-red-600 dark:text-red-400 text-center" role="alert">
          {voice.errorMessage}
        </div>
      )}

      {/* Transport controls — siblings: stop the worker, or stop the talker.
          Stop talker is a playback control only: it silences current speech
          and clears the queue (the arbiter's one hard cancel), never capture,
          never the floor, never the server. */}
      {((isStreaming && onAbort) || talkerBusy) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          {isStreaming && onAbort && (
            <button
              onClick={onAbort}
              className="px-6 py-3 rounded-xl bg-red-600 text-white text-base font-medium hover:bg-red-700 active:scale-[0.98] transition-colors flex items-center gap-2 select-none touch-manipulation"
              type="button"
            >
              <Square className="w-4 h-4 fill-current" />
              Stop worker
            </button>
          )}
          {talkerBusy && (
            <button
              onClick={handleStopTalker}
              className="px-6 py-3 rounded-xl bg-amber-600 text-white text-base font-medium hover:bg-amber-700 active:scale-[0.98] transition-colors flex items-center gap-2 select-none touch-manipulation"
              type="button"
              data-testid="stop-talker"
            >
              <VolumeX className="w-4 h-4" />
              Stop talker
            </button>
          )}
        </div>
      )}

      {/* The confirmation card — explicit, verbatim, ambiguous does nothing */}
      {voice.pendingProposal && (
        <div className="mt-4 w-full flex justify-center">
          <ConfirmationCard
            proposalText={voice.pendingProposal.text}
            onConfirm={voice.confirmPending}
            onCancel={voice.cancelPending}
            onSubmitText={voice.sendText}
          />
        </div>
      )}

      {/* Last released relay — the operator can see what actually went */}
      {voice.lastReleased && !voice.pendingProposal && (
        <div
          className="mt-4 w-full max-w-md rounded-xl border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950 px-4 py-3"
          data-testid="released-outcome"
        >
          <div className="text-sm font-medium text-green-800 dark:text-green-200">Sent to the worker:</div>
          <div className="mt-1 text-sm text-gray-700 dark:text-gray-200 break-words">
            “{voice.lastReleased.text}” — {voice.lastReleased.outcome}
          </div>
        </div>
      )}

      {/* Failed-send banner — a spoken instruction is never silently dropped */}
      {voice.pendingText != null && (
        <div
          className="mt-4 w-full max-w-md rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3"
          role="alert"
        >
          <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Message not sent — the connection was unavailable. Your words are kept:
          </div>
          <div className="mt-1 text-sm text-gray-700 dark:text-gray-200 break-words">
            {voice.pendingText}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={voice.retryLastSend}
              className="px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 active:scale-[0.98] transition-colors select-none touch-manipulation"
              type="button"
            >
              Try again
            </button>
            <button
              onClick={voice.discardPending}
              className="px-3 py-2 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors select-none touch-manipulation"
              type="button"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Answer controls — the answer is ready whenever it exists, not only
          in a dedicated phase; listening is one tap while work continues. */}
      {showAnswerControls && (
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={handleReadAloud}
            disabled={readAloud.state !== 'playing' && !lastAssistantText}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              readAloud.state === 'playing'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
            type="button"
          >
            {readAloud.state === 'playing' ? 'Stop Reading' : '🔊 Read Aloud'}
          </button>
          <button
            onClick={handleToggleSpeed}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            type="button"
          >
            {readAloud.speedEnabled ? '1.25x' : '1x'}
          </button>
        </div>
      )}
    </div>
  );
}
