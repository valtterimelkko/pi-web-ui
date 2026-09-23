import { useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import { Mic, MicOff, RefreshCw, Square, VolumeX, Radio, Keyboard, AlertTriangle, BellRing, Clock, HelpCircle } from 'lucide-react';
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
import { contentScopeFor } from '../../lib/spokenLedger';
import { useVoiceLiveLane } from '../../hooks/useVoiceLiveLane';
import { ProposalCard } from './ProposalCard';
import { ParkingLotDrawer } from './ParkingLotDrawer';
import { captureUnavailableMessage } from '../../lib/voiceLive/captureFaultCopy';
import { receiptVerdict, type ReceiptTone } from './DriveModeVoiceLive';
import { laneFloor } from './voiceLanes';
import type {
  VoiceCaptureMode,
  VoiceErrorCode,
  VoiceReceipt,
} from '@pi-web-ui/shared';
import type { VoiceLiveSurfaceState } from '../../lib/voiceLive/surface';

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
 * The Voice Mode surface — talking while working (plan Phase 4; native-primary
 * engine binding since Phase 2, 2026-09-22).
 *
 * Two lanes, one floor:
 *   - Capture never stops: the mic is always one tap away, including while
 *     speech plays. Tapping while speech plays is the BARGE-IN gesture — the
 *     floor changes hands and the arbiter ducks (restoring at the next chunk
 *     boundary). There is deliberately no state in which the mic control is
 *     disabled because the surface is speaking.
 *   - Everything the operator hears goes through the speech arbiter (§4.1
 *     ladder); everything the operator says goes to the ACTIVE ENGINE. NOTHING
 *     in this component sends to the worker except through a confirm-gated
 *     release path (the native proposal card, or the cascade talker's card —
 *     whichever engine is actually operating).
 *
 * NATIVE PRIMARY (plan §3.1): the familiar controls are bound to the NATIVE
 * Live engine (the VoiceLiveSurface lane). There is no separate default lane
 * selector: the engine badge reports which engine is actually operating, with
 * evidence from the lane itself — never a configured label. The cascade talker
 * remains as an EXPLICIT fallback only: it never engages silently, it never
 * receives a live-voice candidate automatically, and a forced failure degrades
 * visibly with the draft preserved and still pending.
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

  // ── NATIVE PRIMARY ENGINE BINDING (Phase 2) ─────────────────────────────
  // The native voice lane owns the main controls. The cascade talker hook
  // stays mounted ONLY as the explicit fallback (floorEnabled=false while the
  // native engine is primary, so the two engines never fight over the floor).
  const voiceRuntime = talkerRuntimeFor(sdkType ?? undefined);
  const nativeLane = useVoiceLiveLane({
    workerSessionId: sessionId,
    ...(voiceRuntime ? { runtime: voiceRuntime } : {}),
  });
  const nativeSurface = nativeLane.surface;
  const nativeState = useSyncExternalStore<VoiceLiveSurfaceState>(
    useCallback((onChange) => nativeSurface.subscribe(onChange), [nativeSurface]),
    useCallback(() => nativeSurface.getState(), [nativeSurface]),
    useCallback(() => nativeSurface.getState(), [nativeSurface]),
  );
  // The explicit fallback gesture's record. It is ONLY ever set by the
  // operator pressing the fallback control — never derived from a failure.
  const [fallbackActive, setFallbackActive] = useState(false);
  const engine: 'native' | 'cascade-fallback' = fallbackActive ? 'cascade-fallback' : 'native';
  const nativePrimary = engine === 'native';

  const voice = useVoiceTurn(
    sessionId,
    sdkType,
    focus.focused,
    laneEnabled ? sessionId : undefined,
    // The cascade engine owns the floor ONLY while it is the explicit fallback.
    !nativePrimary,
  );
  // The layout mode is the operator's persisted preference; the surface only
  // offers the switch (the overlay decides whether a split is rendered, and a
  // narrow window degrades the desktop mode back to this layout).
  const voiceLayout = useVoiceLayout();
  // Read-aloud and the answer reader are per-lane in multi-lane mode: the
  // arbiter's intent ids carry the session so the strip can attribute speech.
  // One scope per LANE for spoken content: two lanes answering identically are
  // two events (both speak), while this lane's auto path and its read-aloud
  // still share a record so the same answer is never said twice.
  const speechScope = contentScopeFor(laneEnabled ? sessionId : undefined);
  const readAloud = useReadAloud(laneEnabled ? `drive-mode-${sessionId}` : 'drive-mode', speechScope);
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
  // ── ACTIVE-ENGINE capture state (drives the familiar visuals) ───────────
  const nativeCapture = nativeState.capture;
  const nativeCtl = nativeState.controller;
  const nativeListening = nativeCapture === 'live';
  // Push-to-talk is RETAINED on the main control: in PTT mode the familiar
  // round mic becomes the hold-to-talk control (open mic stays the default).
  const nativePtt = nativePrimary && nativeCtl.captureMode === 'push-to-talk';
  const isRecording = nativePrimary ? nativeListening : voice.state === 'recording';
  // The acquisition window: the browser can already be capturing while the
  // recorder is still being set up. Shown, never silently reported as idle.
  const isStarting = nativePrimary ? nativeCapture === 'starting' : voice.state === 'starting';
  // Who holds the floor, per the ACTIVE engine (native: the VAD boundary that
  // also feeds the arbiter; cascade: the dictation recording state).
  const activeOperatorSpeaking = nativePrimary ? nativeCtl.operatorSpeaking : voice.operatorSpeaking;

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
  // The familiar control binds to whichever engine is actually operating: in
  // native mode the level rides the voice wire (the live engine speaks the
  // talker's replies at this verbosity); in cascade fallback it keeps today's
  // store behaviour. Same control, same position — the active binding.
  const activeReadingLevel: ReadingLevel = nativePrimary ? nativeCtl.readingLevel : readingLevel;
  const handleActiveReadingLevel = useCallback(
    (level: ReadingLevel) => {
      if (nativePrimary) {
        nativeSurface.controller.setReadingLevel(level);
        return;
      }
      handleReadingLevel(level);
    },
    [nativePrimary, nativeSurface, handleReadingLevel]
  );
  const { spokenKind, fallbackNote, heldWhileFocused, exitRecap, dismissRecap } = useAnswerReader({
    isStreaming,
    messages,
    level: readingLevel,
    focused: focus.focused,
    requestDigest,
    ...(laneEnabled ? { intentIdPrefix: sessionId } : {}),
    ...(laneEnabled ? { contentScope: speechScope } : {}),
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
    if (isStarting || isRecording || (!nativePrimary && voice.state === 'processing')) {
      if (phase !== 'dictate') setPhase('dictate');
    } else if (isStreaming) {
      if (phase !== 'agent-working') setPhase('agent-working');
    } else if (phase === 'agent-working') {
      setPhase('read-aloud-ready');
    } else if (phase === 'audio-playing' && readAloud.state === 'idle') {
      setPhase('dictate');
    }
  }, [laneEnabled, voice.state, nativePrimary, isStarting, isRecording, isStreaming, readAloud.state, phase, setPhase]);

  // ---------------------------------------------------------------------------
  // The four states, derived from what the surface receives (§4.1).
  // ---------------------------------------------------------------------------
  const [floorView, setFloorView] = useState<FloorView>(() =>
    deriveFloorState({
      operatorSpeaking: activeOperatorSpeaking,
      arbiter: arbiterFloorSignals(speechArbiter.getState()),
      workerStreaming: isStreaming,
    })
  );
  useEffect(() => {
    const sync = () => {
      setFloorView(
        deriveFloorState({
          operatorSpeaking: activeOperatorSpeaking,
          arbiter: arbiterFloorSignals(speechArbiter.getState()),
          workerStreaming: isStreaming,
        })
      );
    };
    sync();
    return speechArbiter.subscribe(sync);
  }, [activeOperatorSpeaking, isStreaming]);

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

  // ── Native-primary engine actions ──────────────────────────────────────────
  // The native start sequence (identical to the lane surface's own start
  // control): open the lane on the wire FIRST, then start capture — a lane
  // that is never opened server-side is not a lane at all.
  const startNativeListening = useCallback(async () => {
    const lane = nativeSurface.startLane();
    if (lane === 'unsupported') return;
    await nativeSurface.startCapture();
    const after = nativeSurface.getState();
    if (
      after.capture === 'live' &&
      (after.lane.state === 'unavailable' || after.lane.state === 'unsupported')
    ) {
      await nativeSurface.stopCapture('the voice lane is unavailable');
    }
  }, [nativeSurface]);

  // Multi-lane floor participation for the NATIVE capture: the same handoff
  // contract the cascade lane honours (one capturing lane per tab; taking the
  // mic elsewhere finalises this lane's words into ITS engine — never drops).
  useEffect(() => {
    if (!laneEnabled || !nativePrimary) return;
    laneFloor.registerLane(sessionId);
    return () => laneFloor.unregisterLane(sessionId);
  }, [laneEnabled, nativePrimary, sessionId]);

  useEffect(() => {
    if (!laneEnabled || !nativePrimary) return;
    return laneFloor.setCaptureControls(sessionId, {
      stopCapture: () => {
        void nativeSurface.stopCapture('lane handoff');
      },
    });
  }, [laneEnabled, nativePrimary, sessionId, nativeSurface]);

  useEffect(() => {
    if (!laneEnabled || !nativePrimary) return;
    laneFloor.setLaneCapture(sessionId, nativeListening);
    return () => {
      laneFloor.setLaneCapture(sessionId, false);
    };
  }, [laneEnabled, nativePrimary, sessionId, nativeListening]);

  // Eyes-free presentation (H2): the surface that is actually mounted AND
  // addressed reads a fresh proposal back by itself. A background lane's
  // proposal must never speak over the addressed one, and the cascade
  // fallback's own card flow owns presentation while IT holds the floor.
  useEffect(() => {
    nativeSurface.setAutoReadBackActive(addressed && nativePrimary);
    return () => nativeSurface.setAutoReadBackActive(false);
  }, [addressed, nativePrimary, nativeSurface]);

  // The mic can START the native engine only when the lane can be served at
  // all. A runtime the voice wire does not serve, a browser that cannot
  // capture, and a server-refused lane are the visible degraded states below
  // — the mic does nothing there, and the explanation names the cause.
  const nativeStartable =
    nativePrimary && !!voiceRuntime &&
    nativeState.lane.state !== 'unavailable' &&
    nativeState.lane.state !== 'unsupported';

  const handleMicClick = useCallback(() => {
    // Taking the floor is ALWAYS available — including while speech plays.
    // Barge-in ducks via the arbiter and restores at the next chunk boundary.
    if (!nativePrimary) {
      voice.toggle();
      return;
    }
    if (!nativeStartable || nativePtt) return; // PTT: the hold gesture talks; a click is inert
    if (laneEnabled) laneFloor.yieldFloorTo(sessionId);
    if (nativeListening) {
      void nativeSurface.stopCapture('operator paused listening');
    } else if (nativeCapture !== 'starting') {
      void startNativeListening();
    }
  }, [nativePrimary, nativeStartable, nativePtt, nativeListening, nativeCapture, nativeSurface, startNativeListening, voice, laneEnabled, sessionId]);

  const handleMicHoldStart = useCallback(() => {
    if (!nativePrimary || !nativePtt || !nativeStartable) return;
    if (laneEnabled) laneFloor.yieldFloorTo(sessionId);
    void nativeSurface.beginPushToTalk();
  }, [nativePrimary, nativePtt, nativeStartable, nativeSurface, laneEnabled, sessionId]);

  const handleMicHoldEnd = useCallback(() => {
    if (!nativePrimary || !nativePtt) return;
    void nativeSurface.endPushToTalk();
  }, [nativePrimary, nativePtt, nativeSurface]);

  const handleCaptureMode = useCallback(
    (mode: VoiceCaptureMode) => {
      nativeSurface.controller.setCaptureMode(mode);
    },
    [nativeSurface],
  );

  const activateFallback = useCallback(() => {
    // The EXPLICIT degradation. Nothing is sent by this transition: the
    // cascade engine starts empty, and any live-voice candidate stays exactly
    // where it was — pending in the native lane, awaiting a fresh operator.
    setFallbackActive(true);
  }, []);

  const returnToNative = useCallback(() => {
    // The explicit way back: a fresh lane attempt. If the engine is still
    // unavailable, the surface degrades again — visibly, with the reason.
    nativeSurface.retryLane();
    setFallbackActive(false);
  }, [nativeSurface]);

  // ── Native readout derivations (evidence-first, mirrors the lane surface) ──
  const nativeProposal = nativeCtl.proposal;
  const nativeProposalStatus = nativeProposal
    ? nativeProposal.superseded
      ? 'stale'
      : nativeProposal.proposal.presentation.completed
        ? 'presented'
        : 'pending'
    : 'stale';
  const lastNativeReceipt: VoiceReceipt | undefined =
    nativeCtl.receipts[nativeCtl.receipts.length - 1];
  // A verdict belongs to the confirmation it answers: a NEWER proposal makes
  // the old receipt history (a delivered figure must not sit beside a fresh
  // confirm button claiming a delivery that has not happened).
  const nativeReceiptIsCurrent =
    lastNativeReceipt !== undefined &&
    (nativeProposal === null || nativeProposal.proposal.proposalId === lastNativeReceipt.proposalId);
  const shownNativeReceipt = nativeReceiptIsCurrent ? lastNativeReceipt : undefined;
  const nativeVerdict = shownNativeReceipt ? receiptVerdict(shownNativeReceipt) : null;
  const NativeVerdictIcon =
    nativeVerdict?.tone === 'delivered'
      ? BellRing
      : nativeVerdict?.tone === 'queued'
        ? Clock
        : nativeVerdict?.tone === 'unknown'
          ? HelpCircle
          : AlertTriangle;
  const lastNativeCaption = nativeCtl.captions[nativeCtl.captions.length - 1];
  const lastNativeTransportRefusal = nativeCtl.transportRefusals[nativeCtl.transportRefusals.length - 1];
  const nativeLaneUnavailable = nativePrimary && !nativeStartable;
  // Mic busy/disabled semantics per engine: capture acquisition is the only
  // busy window; an unservable native lane disables the click (the degraded
  // banner explains and offers the explicit fallback); push-to-talk NEVER
  // disables mid-hold — a disabled button would strand the capture open.
  const micBusy = isStarting || (!nativePrimary && voice.state === 'processing');
  const micDisabled = nativePtt
    ? !nativeStartable
    : micBusy || (nativePrimary && !nativeStartable);
  const RECEIPT_TONE_CLASS: Record<ReceiptTone, string> = {
    delivered: 'text-emerald-600 dark:text-emerald-400',
    queued: 'text-content-muted dark:text-content-muted-dark',
    refused: 'text-amber-600 dark:text-amber-400',
    unknown: 'text-amber-600 dark:text-amber-400',
  };
  const LANE_REFUSAL_FALLBACK: Partial<Record<VoiceErrorCode, string>> = {
    voice_lane_capacity: 'The voice lane table is at capacity; try again shortly.',
  };

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
      data-engine={engine}
      data-capture-mode={nativePrimary ? nativeCtl.captureMode : undefined}
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
            title="Point voice mode at a different worker session"
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-800 bg-blue-50 dark:bg-blue-950 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors select-none touch-manipulation"
            type="button"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Switch session
          </button>
        )}
      </div>

      {/* WHICH ENGINE IS OPERATING — with evidence from the lane itself, never
          a configured label (plan §3.1). The native engine is the primary; the
          cascade appears here only as the explicit fallback. */}
      <div
        data-testid="voice-engine-badge"
        data-engine={engine}
        data-lane-state={nativeState.lane.state}
        data-capture={nativeCapture}
        data-wire-state={nativeCtl.wireState}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${
          nativePrimary
            ? nativeState.lane.state === 'live'
              ? 'border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950'
              : 'border-outline-default dark:border-outline-default-dark text-content-muted dark:text-content-muted-dark'
            : 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950'
        }`}
      >
        {nativePrimary ? (
          <>
            <Radio size={12} aria-hidden className={nativeListening ? 'text-pi-primary animate-pulse' : undefined} />
            {voiceRuntime === undefined
              ? `Live voice — not served for ${sdkType ?? 'this'} sessions`
              : nativeState.lane.state === 'live'
                ? `Live voice — connected${nativeListening ? ' · listening' : ''}`
                : nativeState.lane.state === 'connecting'
                  ? 'Live voice — connecting'
                  : nativeState.lane.state === 'unavailable'
                    ? 'Live voice — unavailable'
                    : nativeState.lane.state === 'unsupported'
                      ? 'Live voice — unavailable on this browser'
                      : 'Live voice'}
          </>
        ) : (
          'Cascade fallback — the live engine is not serving this lane'
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

      {/* The reading level — how much of what the voice says is spoken, and
          which level the answer in flight is being read at. Bound to the
          ACTIVE engine: native mode rides the voice wire; cascade fallback
          keeps the persisted store behaviour (P17). */}
      <div className={compact ? 'mb-2' : 'mb-4'}>
        <ReadingLevelControl
          level={activeReadingLevel}
          onSelect={handleActiveReadingLevel}
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
          already exists and a second tap must not open a second one — and
          while the native lane cannot be served at all (refused, unsupported
          runtime/browser): the degraded state below explains, and the
          fallback is one explicit gesture away. In push-to-talk mode the
          familiar round control IS the hold-to-talk button. */}
      <button
        onClick={handleMicClick}
        onPointerDown={nativePtt ? (e) => { e.preventDefault(); handleMicHoldStart(); } : undefined}
        onPointerUp={nativePtt ? () => handleMicHoldEnd() : undefined}
        onPointerLeave={nativePtt ? () => handleMicHoldEnd() : undefined}
        disabled={micDisabled}
        aria-busy={micBusy || undefined}
        data-testid="drive-mic"
        data-mode={nativePrimary ? nativeCtl.captureMode : undefined}
        className={`rounded-full flex items-center justify-center transition-all duration-200 select-none touch-manipulation ${
          compact ? 'w-20 h-20' : 'w-28 h-28'
        } ${
          micBusy && !nativePtt ? 'cursor-wait' : 'active:scale-95'
        } ${
          isRecording
            ? 'bg-red-50 dark:bg-red-950 border-4 border-red-500 animate-pulse'
            : isStarting
            ? 'bg-amber-50 dark:bg-amber-950 border-4 border-amber-400'
            : 'bg-gray-100 dark:bg-gray-800 border-4 border-gray-200 dark:border-gray-700'
        }`}
        aria-label={
          isStarting
            ? 'Starting microphone'
            : nativePtt
              ? isRecording
                ? 'Release to stop talking'
                : 'Hold to talk'
              : isRecording
                ? 'Stop recording'
                : 'Start recording'
        }
        type="button"
      >
        {voice.state === 'error' || (nativePrimary && nativeCapture === 'error') ? (
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

      {/* NATIVE PRIMARY: capture-mode choice (open mic default, push-to-talk
          retained) and the honest listening line, bound to the active engine. */}
      {nativePrimary && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Capture mode">
            {(['open-mic', 'push-to-talk'] as VoiceCaptureMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={nativeCtl.captureMode === mode}
                data-testid={`drive-capture-mode-${mode}`}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                  nativeCtl.captureMode === mode
                    ? 'border-pi-primary text-pi-primary'
                    : 'border-outline-default dark:border-outline-default-dark text-content-muted dark:text-content-muted-dark'
                }`}
                onClick={() => handleCaptureMode(mode)}
              >
                {mode === 'open-mic' ? 'Open mic' : 'Push to talk'}
              </button>
            ))}
          </div>
        </div>
      )}
      {nativePrimary && (
        <p
          data-testid="drive-native-listening-state"
          data-listening={nativeListening ? 'true' : 'false'}
          data-capture={nativeCapture}
          className={`mt-1.5 text-xs ${
            nativeListening ? 'text-content-muted dark:text-content-muted-dark' : 'text-amber-600 dark:text-amber-400'
          }`}
        >
          {nativeListening
            ? nativePtt
              ? 'Listening while you hold the button.'
              : 'Listening — open mic. Talking over the voice ducks it; it never stops you being heard.'
            : nativeCapture === 'error'
              ? captureUnavailableMessage({
                  detail: nativeState.captureDetail,
                  reason: nativeState.captureFaultReason,
                  mode: nativeCtl.captureMode,
                })
              : nativeCapture === 'suspended'
                ? `Listening suspended${nativeState.captureDetail ? ` — ${nativeState.captureDetail}` : ''}. Nothing is being heard until you start it again.`
                : 'Not listening yet. Tap the microphone to talk to the live voice.'}
        </p>
      )}

      {/* The contract, taught where the operator speaks (P26). Display and
          teaching only — it changes no behaviour. Worded per ACTIVE engine: */}
      <p
        data-testid="voice-contract-hint"
        className="mt-3 max-w-md text-center text-xs leading-relaxed text-content-muted dark:text-content-muted-dark"
      >
        {nativePrimary
          ? 'Talk naturally. Say “relay to worker” and then your message — the live voice shows you the words it will send, and nothing goes until you approve.'
          : 'Say it however you like — your words are passed on as spoken, tidied only when they ramble, never rewritten. The worker never knows this voice exists.'}
      </p>

      {/* ── NATIVE PRIMARY READOUT (replaces the old competing free-lane
          selector): the native engine's own evidence surfaces — availability,
          candidates, read-back, receipts, captions — rendered where the main
          surface has always shown approval state. */}
      {nativeLaneUnavailable && (
        <div
          data-testid="voice-engine-fallback-banner"
          data-lane-state={nativeState.lane.state}
          className="mt-4 w-full max-w-md rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3"
          role="status"
        >
          <p className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle size={14} aria-hidden />
            {voiceRuntime === undefined
              ? `Live voice is not available for ${sdkType ?? 'this'} sessions yet`
              : nativeState.lane.state === 'unsupported'
                ? 'Live voice is unavailable on this browser'
                : 'Live voice is unavailable'}
          </p>
          <p className="mt-1 text-xs text-amber-800 dark:text-amber-200" data-testid="voice-engine-fallback-detail">
            {voiceRuntime === undefined
              ? 'The voice wire does not serve this session type. The cascade fallback below is explicit and always yours to choose.'
              : (nativeState.lane.detail ?? 'no reason was reported')}
          </p>
          <p className="mt-1 text-xs text-content-muted dark:text-content-muted-dark">
            Nothing was sent to the worker by this failure. Any live-voice draft stays where it is, still awaiting your
            approval.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              data-testid="voice-engine-fallback-activate"
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-amber-100 dark:bg-amber-900 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-800 transition-colors select-none touch-manipulation"
              onClick={activateFallback}
            >
              <Keyboard size={13} aria-hidden />
              Use the cascade microphone (fallback)
            </button>
            {nativeState.lane.state === 'unavailable' && (
              <button
                type="button"
                data-testid="voice-engine-retry"
                className="inline-flex items-center gap-1.5 rounded-lg border border-outline-default dark:border-outline-default-dark px-3 py-1.5 text-xs font-medium text-content-primary dark:text-content-primary-dark hover:bg-surface-subtle dark:hover:bg-surface-dark-subtle transition-colors select-none touch-manipulation"
                onClick={returnToNative}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Try live voice again
              </button>
            )}
          </div>
        </div>
      )}

      {/* The native candidate — the host's proposal, presented through the
          same approval contract as the lane surface: read-back first, exact
          variants, version-bound confirmation. Survives engine failures
          untouched: a failed lane never releases, retargets or rewrites it. */}
      {nativePrimary && nativeProposal && (
        <div className="mt-4 w-full flex justify-center">
          <ProposalCard
            proposal={nativeProposal.proposal}
            status={nativeProposalStatus}
            staleDetail={nativeProposal.superseded ? 'a newer proposal replaced this one' : undefined}
            readingBack={
              nativeState.readBack.state === 'reading' &&
              nativeState.readBack.proposalId === nativeProposal.proposal.proposalId
            }
            readBackSupported={nativeState.readBack.supported}
            onConfirm={(variant) => nativeSurface.controller.confirmProposal({ variant })}
            onCancel={() => nativeSurface.controller.cancelProposal()}
            onReadBack={(variant) => void nativeSurface.readBackProposal(variant)}
          />
        </div>
      )}

      {/* PRESERVED DRAFT (fallback mode): a live-voice candidate the operator
          never approved stays visible — and unmistakably UNSENT — while the
          cascade fallback is active. It is read-only here: the native engine
          still owns it; the operator re-dictates or returns to live voice. */}
      {!nativePrimary && nativeProposal && (
        <div
          data-testid="voice-engine-preserved-draft"
          className="mt-4 w-full max-w-md rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3"
          role="status"
        >
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            Live-voice draft preserved — not sent
          </p>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-200 break-words">
            “{nativeProposal.proposal.presentedVariant === 'original'
              ? nativeProposal.proposal.original
              : nativeProposal.proposal.tidied}”
          </p>
          <p className="mt-1 text-xs text-content-muted dark:text-content-muted-dark">
            Still awaiting your approval on the live engine; nothing went to the worker. Say it again here, or try
            live voice again.
          </p>
        </div>
      )}
      {nativePrimary && nativeProposal && nativeState.readBack.state === 'interrupted' && (
        <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-testid="drive-native-readback-interrupted">
          Read-back stopped early
          {nativeState.readBack.stoppedAtChar !== undefined ? ` at character ${nativeState.readBack.stoppedAtChar}` : ''}
          {nativeState.readBack.detail ? ` — ${nativeState.readBack.detail}` : ''}. Confirm stays refused until it is
          read in full.
        </p>
      )}
      {nativePrimary && nativeProposal && nativeState.readBack.state === 'unsupported' && (
        <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-testid="drive-native-readback-unsupported">
          {nativeState.readBack.detail ?? 'This browser cannot read it back aloud'} — the confirmation stays refused
          until the read-back rule is satisfied.
        </p>
      )}

      {/* The native delivery verdict: every outcome rendered honestly, only
          `delivered` toned as delivery (N6). */}
      {nativePrimary && shownNativeReceipt && nativeVerdict && (
        <p
          className={`mt-1.5 inline-flex items-start gap-1 text-[11px] ${RECEIPT_TONE_CLASS[nativeVerdict.tone]}`}
          data-testid="drive-native-receipt"
          data-outcome={shownNativeReceipt.outcome}
          data-verdict-tone={nativeVerdict.tone}
          role="status"
        >
          <NativeVerdictIcon size={12} aria-hidden className="mt-[1px] shrink-0" />
          <span>
            {nativeVerdict.headline}
            {nativeVerdict.detail ? <span> · {nativeVerdict.detail}</span> : null}
          </span>
        </p>
      )}

      {/* Native captions — the live conversation, visible where the operator
          is already looking (the last exchange; the full record stays on the
          wire/controller ring). */}
      {nativePrimary && lastNativeCaption && (
        <p className="mt-2 text-xs italic text-content-muted dark:text-content-muted-dark" data-testid="drive-native-caption">
          {lastNativeCaption.speaker === 'operator' ? 'You' : 'Talker'}: {lastNativeCaption.text}
          {lastNativeCaption.final ? '' : ' …'}
        </p>
      )}

      {/* Native refusals and faults — rendered, never swallowed (M7/M8). */}
      {nativePrimary && lastNativeTransportRefusal && (
        <p
          className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400"
          data-testid="drive-native-transport-refusal"
          data-code={lastNativeTransportRefusal.code}
          data-fatal={lastNativeTransportRefusal.fatal ? 'true' : 'false'}
        >
          Voice transport {lastNativeTransportRefusal.fatal ? 'stopped' : 'refused a frame'}: {lastNativeTransportRefusal.code}
          {lastNativeTransportRefusal.message ? ` — ${lastNativeTransportRefusal.message}` : ''}
        </p>
      )}
      {nativePrimary && nativeState.captureFaults.length > 0 && (
        <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400" data-testid="drive-native-fault">
          <AlertTriangle size={12} aria-hidden />
          {nativeState.captureFaults[nativeState.captureFaults.length - 1].detail}
        </p>
      )}
      {nativePrimary && nativeCtl.lastError && (
        <p
          className="mt-1.5 text-[11px] text-red-600 dark:text-red-400"
          data-testid="drive-native-error"
          data-code={nativeCtl.lastError.code}
          data-fatal={nativeCtl.lastError.fatal ? 'true' : 'false'}
        >
          {nativeCtl.lastError.code}: {nativeCtl.lastError.message || LANE_REFUSAL_FALLBACK[nativeCtl.lastError.code] || 'the server gave no reason'}
        </p>
      )}
      {nativePrimary && nativeCtl.parking.items.length > 0 && (
        <div className="mt-4 w-full flex justify-center">
          <ParkingLotDrawer
            items={nativeCtl.parking.items}
            onPromote={(itemId) => nativeSurface.controller.promoteParkedItem(itemId)}
            onRequestList={() => nativeSurface.controller.requestParkingList()}
          />
        </div>
      )}
      {nativePrimary && !nativeListening && (
        <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-content-muted dark:text-content-muted-dark" data-testid="drive-native-typed-fallback">
          <Keyboard size={12} aria-hidden />
          Typed input stays in the composer — the voice lane never carries your words to the worker.
        </p>
      )}

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

      {/* Last released relay — the operator can see what actually went.
          The banner's colour and heading are decided by the SERVER's outcome:
          a refused relay must never read as sent (operator incident
          2026-09-16 — a green "Sent to the worker" box over a refusal). */}
      {voice.lastReleased && !voice.pendingProposal && (
        <div
          className={`mt-4 w-full max-w-md rounded-xl border px-4 py-3 ${
            voice.lastReleased.status === 'delivered'
              ? 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950'
              : voice.lastReleased.status === 'queued'
                ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950'
                : 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950'
          }`}
          data-testid="released-outcome"
          data-delivery={voice.lastReleased.status}
          role={voice.lastReleased.status === 'refused' || voice.lastReleased.status === 'unknown' ? 'alert' : undefined}
        >
          <div
            data-testid="released-outcome-heading"
            className={`text-sm font-medium ${
              voice.lastReleased.status === 'delivered'
                ? 'text-green-800 dark:text-green-200'
                : voice.lastReleased.status === 'queued'
                  ? 'text-blue-800 dark:text-blue-200'
                  : 'text-amber-800 dark:text-amber-200'
            }`}
          >
            {voice.lastReleased.status === 'delivered'
              ? 'Sent to the worker:'
              : voice.lastReleased.status === 'queued'
                ? 'Queued for the worker (it will get it after its current turn):'
                : voice.lastReleased.status === 'refused'
                  ? 'NOT sent to the worker — it did not reach it:'
                  : 'Relay outcome not reported by the server — it may not have been sent:'}
          </div>
          <div className="mt-1 text-sm text-gray-700 dark:text-gray-200 break-words">
            “{voice.lastReleased.text}” — {voice.lastReleased.outcome}
          </div>
        </div>
      )}

      {/* Failed-send banner — a spoken instruction is never silently dropped */}
      {voice.pendingText != null && (
        <div
          data-testid="send-failure"
          className="mt-4 w-full max-w-md rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-4 py-3"
          role="alert"
        >
          <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {voice.pendingReason === 'refused'
              ? 'Not sent — the worker did not accept the relay. Your words are kept:'
              : 'Message not sent — the connection was unavailable. Your words are kept:'}
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
