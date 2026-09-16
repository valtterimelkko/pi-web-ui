import { useEffect, useCallback, useState } from 'react';
import { Mic, MicOff, Square, VolumeX } from 'lucide-react';
import { useDriveModeStore } from '../../store/driveModeStore';
import { useSessionStore } from '../../store/sessionStore';
import { useReadAloud } from '../../hooks/useReadAloud';
import { useTurnDigest } from '../../hooks/useTurnDigest';
import { useVoiceTurn, talkerRuntimeFor } from './useVoiceTurn';
import { ConfirmationCard } from './ConfirmationCard';
import { FloorBanner } from './FloorBanner';
import { FocusControl, FocusRecap } from './FocusControl';
import { useFocusHold } from './focusHold';
import { ReadingLevelControl } from './ReadingLevelControl';
import {
  useReadingLevelStore,
  type ReadingLevel,
} from './readingLevel';
import { deriveFloorState, arbiterFloorSignals, type FloorView } from './voiceFloor';
import { VoiceLayoutToggle } from './VoiceLayoutToggle';
import { useVoiceLayout } from './useVoiceLayout';
import { speechArbiter } from '../../lib/speechArbiter';
import { getTurnAssistantText, useAnswerReader } from './useAnswerReader';

export interface DriveModeDictateProps {
  sessionId: string;
  /** The active session's runtime family — routes talker turns. */
  sdkType?: string | null;
  modelName: string;
  sessionDisplayName: string;
  onExit: () => void;
  onAbort?: () => void;
  /** Multi-lane (one tab, several workers): this surface is one lane of the
   *  in-page lane set. Per-lane transcript, reading level, focus and card;
   *  the floor flows through the lane coordinator. */
  laneEnabled?: boolean;
  /** Multi-lane: the operator is addressing THIS lane. A non-addressed lane
   *  stays mounted (its card, capture and focus live on) but hidden. */
  addressed?: boolean;
  /** Hand this surface to a different worker session, in place. The control
   *  is offered only when the overlay can honour it (no dead buttons), and
   *  the overlay owns what switching means. */
  onSwitchSession?: () => void;
  /** The desktop arrangement shares the column with the session pane, so the
   *  controls tighten up rather than pushing the pane or a lane out of view. */
  compact?: boolean;
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
  onSwitchSession,
  compact = false,
  laneEnabled = false,
  addressed = true,
}: DriveModeDictateProps) {
  // P18/2 — the operator's focus/hold control. Session-local, pressed only by
  // the operator: while it is on, the worker's answers are transcript-only and
  // held; on exit what arrived is surfaced explicitly. The talker is TOLD (so
  // it can suggest leaving focus) but has no way to switch it.
  const focus = useFocusHold();
  const voice = useVoiceTurn(sessionId, sdkType, focus.focused, laneEnabled ? sessionId : undefined);
  // The layout mode is the operator's persisted preference; the surface only
  // offers the switch (the overlay decides whether a split is rendered, and a
  // narrow window degrades the desktop mode back to this layout).
  const voiceLayout = useVoiceLayout();
  // Read-aloud and the answer reader are per-lane in multi-lane mode: the
  // arbiter's intent ids carry the session so the strip can attribute speech.
  const readAloud = useReadAloud(laneEnabled ? `drive-mode-${sessionId}` : 'drive-mode');
  const phase = useDriveModeStore((s) => s.phase);
  const setPhase = useDriveModeStore((s) => s.setPhase);
  // Per-lane transcript: in lane mode the surface reads ITS session's
  // messages and streaming state from the per-session projections (kept
  // fresh for subscribed background sessions), never the global current
  // session — lane A's answer must never become lane B's.
  const globalIsStreaming = useSessionStore((s) => s.isStreaming);
  const globalMessages = useSessionStore((s) => s.messages);
  const laneStreaming = useSessionStore(
    (s) => !!((s as { streamingSessions?: Record<string, boolean> }).streamingSessions?.[sessionId])
  );
  const laneMessages = useSessionStore(
    (s) => (s as { sessionMessages?: Record<string, typeof s.messages> }).sessionMessages?.[sessionId]
  );
  const isStreaming = laneEnabled ? laneStreaming : globalIsStreaming;
  const messages = laneEnabled ? (laneMessages ?? globalMessages) : globalMessages;

  // P19 — the answer is the whole turn, not the last message: read-aloud and
  // the answer controls operate on everything the worker has said since the
  // operator's last message, interim updates included. The answer reader scans
  // the conversation itself, so its accounted-turn boundary lives in one place.
  const turnAssistantText = getTurnAssistantText(messages);
  const isRecording = voice.state === 'recording';
  // The acquisition window: the browser can already be capturing while the
  // recorder is still being set up. Shown, never silently reported as idle.
  const isStarting = voice.state === 'starting';

  // The talker in the reading path (P17): how much of the worker's output is
  // spoken is the operator's choice, applied at turn end and — when they change
  // it mid-answer — at the next chunk boundary. Playback only: nothing here can
  // gate capture, and nothing here can condense the operator's words.
  const talkerRuntime = talkerRuntimeFor(sdkType ?? undefined);
  const { requestDigest } = useTurnDigest(sessionId, talkerRuntime);
  // Per-lane reading level: each lane carries its own choice over the shared
  // persisted default. Single-lane is exactly today's store field.
  const storeLevel = useReadingLevelStore((s) => s.level);
  const laneLevel = useReadingLevelStore(
    (s) => ((s as { levels?: Record<string, typeof s.level> }).levels ?? {})[sessionId]
  );
  const readingLevel = laneEnabled ? (laneLevel ?? storeLevel) : storeLevel;
  const setReadingLevel = useReadingLevelStore((s) => s.setLevel);
  const setLevelFor = useReadingLevelStore((s) => s.setLevelFor);
  const handleReadingLevel = useCallback(
    (level: ReadingLevel) => (laneEnabled ? setLevelFor(sessionId, level) : setReadingLevel(level)),
    [laneEnabled, sessionId, setLevelFor, setReadingLevel]
  );
  const { spokenKind, fallbackNote, heldWhileFocused, exitRecap, dismissRecap } = useAnswerReader({
    isStreaming,
    messages,
    level: readingLevel,
    focused: focus.focused,
    requestDigest,
    ...(laneEnabled ? { intentIdPrefix: sessionId } : {}),
  });

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
  //
  // Multi-lane: lane surfaces do not write the phase at all — with several
  // lanes mounted there is no single phase to summarise, and cross-lane
  // fights would reintroduce the ping-pong.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (laneEnabled) return;
    if (isStarting || isRecording || voice.state === 'processing') {
      if (phase !== 'dictate') setPhase('dictate');
    } else if (isStreaming) {
      if (phase !== 'agent-working') setPhase('agent-working');
    } else if (phase === 'agent-working') {
      setPhase('read-aloud-ready');
    } else if (phase === 'audio-playing' && readAloud.state === 'idle') {
      setPhase('dictate');
    }
  }, [laneEnabled, voice.state, isStarting, isRecording, isStreaming, readAloud.state, phase, setPhase]);

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
    if (turnAssistantText) {
      readAloud.play(turnAssistantText);
      setPhase('audio-playing');
    }
  }, [readAloud, turnAssistantText, setPhase]);

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

  const showAnswerControls = turnAssistantText != null || readAloud.state !== 'idle';

  return (
    <div
      data-testid="drive-mode-surface"
      data-compact={compact ? 'true' : undefined}
      data-drive-session={laneEnabled ? sessionId : undefined}
      hidden={laneEnabled && !addressed ? true : undefined}
      className={`flex flex-col items-center h-full w-full px-4 relative overflow-y-auto ${
        compact ? 'py-3' : 'py-6'
      }`}
    >
      {/* Exit button */}
      <button
        onClick={onExit}
        className="absolute top-4 right-4 text-xs font-medium text-content-muted dark:text-content-muted-dark hover:text-content-primary dark:hover:text-content-primary-dark transition-colors px-2.5 py-1 rounded-lg hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle"
        type="button"
      >
        ✕ Exit
      </button>

      {/* Session info — the worker this surface is attached to, and the
          in-place switch control (operator, 2026-09-16): change which worker
          voice mode talks to without exiting and rebuilding the lanes. */}
      <div className={`flex flex-col items-center ${compact ? 'mt-2 mb-2' : 'mt-8 mb-4'}`}>
        <div className="text-base font-semibold text-content-primary dark:text-content-primary-dark">
          {sessionDisplayName}
        </div>
        <div className="text-xs text-content-muted dark:text-content-muted-dark font-mono mt-0.5">{modelName}</div>
        {onSwitchSession && (
          <button
            onClick={onSwitchSession}
            data-testid="drive-switch-session"
            className="mt-2 px-3 py-1.5 rounded-lg text-xs font-medium text-content-secondary dark:text-content-secondary-dark border border-outline-default dark:border-outline-default-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle transition-colors select-none touch-manipulation"
            type="button"
          >
            Switch session
          </button>
        )}
      </div>

      {/* The two modes: the existing voice-only surface, or the desktop
          arrangement that shows the live session under it. Persisted — set once. */}
      <div className={compact ? 'mb-2' : 'mb-4'}>
        <VoiceLayoutToggle
          mode={voiceLayout.mode}
          onSelect={voiceLayout.setMode}
          degraded={voiceLayout.mode === 'desktop' && voiceLayout.layout === 'mobile'}
        />
      </div>

      {/* The reading level — how much of the worker's output is spoken, and
          which level the answer in flight is being read at. Persisted as the
          operator's default (P17). */}
      <div className={compact ? 'mb-2' : 'mb-4'}>
        <ReadingLevelControl
          level={readingLevel}
          onSelect={handleReadingLevel}
          spokenKind={spokenKind}
          fallbackNote={fallbackNote}
        />
      </div>

      {/* Focus/hold (P18): concentrate on the conversation, keep the worker's
          answers in the transcript, and have everything that arrived surfaced
          on exit. Playback only — the mic is never gated. */}
      <div className={compact ? 'mb-2' : 'mb-4'}>
        <FocusControl
          focused={focus.focused}
          onToggle={focus.toggle}
          heldCount={heldWhileFocused.length}
        />
      </div>

      {/* The four states — who has the floor, at a glance */}
      <div className={compact ? 'mb-3' : 'mb-6'}>
        <FloorBanner view={floorView} />
      </div>

      {/* Mic button — never disabled because the surface is speaking. It IS
          disabled while the device is being acquired: at that point the lane
          already exists and a second tap must not open a second one. */}
      <button
        onClick={handleMicClick}
        disabled={voice.state === 'processing' || isStarting}
        aria-busy={isStarting || undefined}
        data-testid="drive-mic"
        className={`rounded-full flex items-center justify-center transition-all duration-200 select-none touch-manipulation ${
          compact ? 'w-20 h-20' : 'w-28 h-28'
        } ${
          voice.state === 'processing' || isStarting ? 'cursor-wait' : 'active:scale-95'
        } ${
          isRecording
            ? 'bg-red-50 dark:bg-red-950 border-4 border-red-500 animate-pulse'
            : isStarting
            ? 'bg-amber-50 dark:bg-amber-950 border-4 border-amber-400'
            : 'bg-gray-100 dark:bg-gray-800 border-4 border-gray-200 dark:border-gray-700'
        }`}
        aria-label={isStarting ? 'Starting microphone' : isRecording ? 'Stop recording' : 'Start recording'}
        type="button"
      >
        {voice.state === 'error' ? (
          <MicOff
            className={`${compact ? 'w-7 h-7' : 'w-10 h-10'} ${
              isRecording ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
            }`}
          />
        ) : (
          <Mic
            className={`${compact ? 'w-7 h-7' : 'w-10 h-10'} ${
              isRecording
                ? 'text-red-500'
                : isStarting
                ? 'text-amber-500 animate-pulse'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          />
        )}
      </button>

      {/* The acquisition window, named. The browser's own recording indicator
          can be on before the lane is ready; the surface says so instead of
          looking untouched. */}
      {isStarting && (
        <p data-testid="mic-starting-hint" className="mt-2 text-sm text-amber-600 dark:text-amber-400">
          Starting microphone…
        </p>
      )}

      {/* The contract, taught where the operator speaks (P26). Display and
          teaching only — it changes no behaviour: capture, the send path and
          the confirm gate are exactly as before. The three facts it must
          convey: the words are passed on (not re-invented); they may be
          tidied; the worker never knows this lane exists. */}
      <p
        data-testid="voice-contract-hint"
        className="mt-3 max-w-md text-center text-xs leading-relaxed text-content-muted dark:text-content-muted-dark"
      >
        Say it however you like — your words are passed on as spoken, tidied
        only when they ramble, never rewritten. The worker never knows this
        voice exists.
      </p>

      {/* The exit recap (P18/2): everything that arrived while focus was on,
          surfaced explicitly — the thing that happened while you were away
          never disappears. */}
      {exitRecap && (
        <FocusRecap items={exitRecap} onDismiss={dismissRecap} />
      )}

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
              className="px-6 py-3 rounded-xl bg-red-600 text-white text-base font-medium hover:bg-red-700 active:scale-[0.98] transition-colors flex items-center gap-2 select-none touch-manipulation shadow-xs"
              type="button"
            >
              <Square className="w-4 h-4 fill-current" />
              Stop worker
            </button>
          )}
          {talkerBusy && (
            <button
              onClick={handleStopTalker}
              className="px-6 py-3 rounded-xl bg-amber-600 text-white text-base font-medium hover:bg-amber-700 active:scale-[0.98] transition-colors flex items-center gap-2 select-none touch-manipulation shadow-xs"
              type="button"
              data-testid="stop-talker"
            >
              <VolumeX className="w-4 h-4" />
              Stop talker
            </button>
          )}
        </div>
      )}

      {/* The confirmation card — explicit, exact, ambiguous does nothing.
          The cleaning facts pass through when the server reported them (P26);
          when absent, the card's exact-words claim stands, truthfully. */}
      {voice.pendingProposal && (
        <div className="mt-4 w-full flex justify-center">
          <ConfirmationCard
            proposalText={voice.pendingProposal.text}
            cleaned={voice.pendingProposal.cleaned}
            removed={voice.pendingProposal.removed}
            original={voice.pendingProposal.original}
            version={voice.pendingProposal.version}
            hash={voice.pendingProposal.hash}
            onConfirm={voice.confirmPending}
            onCancel={voice.cancelPending}
            onSubmitText={voice.sendText}
            onSendOriginal={voice.releaseOriginal}
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
            disabled={readAloud.state !== 'playing' && !turnAssistantText}
            className={`px-4 py-2 rounded-xl text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              readAloud.state === 'playing'
                ? 'bg-pi-primary/15 text-pi-primary border border-pi-primary/30'
                : 'bg-pi-primary text-white hover:bg-pi-hover shadow-xs'
            }`}
            type="button"
          >
            {readAloud.state === 'playing' ? 'Stop Reading' : '🔊 Read Aloud'}
          </button>
          <button
            onClick={handleToggleSpeed}
            className="px-3 py-2 rounded-xl text-xs font-medium border border-outline-default dark:border-outline-default-dark bg-surface dark:bg-surface-dark text-content-primary dark:text-content-primary-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle transition-colors font-mono"
            type="button"
          >
            {readAloud.speedEnabled ? '1.25x' : '1x'}
          </button>
        </div>
      )}
    </div>
  );
}
