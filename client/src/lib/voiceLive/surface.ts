/**
 * voiceLive/surface — the framework-free orchestration of one voice lane.
 *
 * Everything a `DriveModeVoiceLive` React component needs, with no React in it,
 * so the wiring itself is testable with injected fakes:
 *
 *   microphone → capture worklet → CapturePipeline → controller.sendCaptureChunk
 *                                                        ↓ (session WebSocket)
 *   server audio chunks → PlaybackPipeline → ducked 24 kHz playback
 *   receipt delivered   → local chime (host-owned, never model audio)
 *   local VAD boundary  → arbiter.setOperatorSpeaking (duck) + voice_activity_state
 *
 * The two invariants this file is responsible for holding:
 *
 *   - CAPTURE IS UNCONDITIONAL FOR THE ARBITER (N5). The VAD tells the arbiter
 *     the operator holds the floor; nothing the arbiter does can reach the
 *     capture session. There is no call in this file that suspends capture in
 *     response to playback.
 *   - DUCKING IS THE FLOOR'S DECISION. The playback pipeline reads
 *     `speechFloor` (the arbiter) — it does not decide to duck on its own, and
 *     it never stops mid-utterance for a barge-in.
 *
 * Suspension is honest: `captureLifecycle` is 'suspended' only when capture is
 * genuinely stopped (socket down, lane stopped, permission refused), and the
 * component renders that state rather than claiming to listen.
 */

import type {
  VoiceAudioOutputChunkMessage,
  VoiceClientMessage,
  VoiceReceiptEventMessage,
  VoiceServerMessage,
} from '@pi-web-ui/shared';
import { type SpeechArbiter } from '../speechArbiter';
import {
  startCaptureSession,
  type CaptureFaultReason,
  type CaptureFaultReport,
  type CaptureSession,
  type CaptureStats,
} from './captureSession';
import {
  PlaybackPipeline,
  createWebAudioPlaybackBackend,
  type PlaybackBackend,
  type PlaybackFault,
  type PlaybackStats,
} from './playbackSession';
import { asSpeechFloorSource } from './speechFloor';
import {
  createDeliveryChime,
  createWebAudioChimeBackend,
  type ChimeVariant,
} from '../soundEffects';
import {
  VoiceLiveController,
  type VoiceLiveRefusal,
  type VoiceLiveSnapshot,
} from './controller';
import {
  createBrowserReadBackSpeaker,
  type ReadBackOutcome,
  type ReadBackSpeaker,
} from './readBack';
import type { VoiceLaneIdentity } from './messages';
import type { VoiceProposalVariant } from '@pi-web-ui/shared';

export type CaptureLifecycle = 'idle' | 'starting' | 'live' | 'suspended' | 'error';

/**
 * Whether the native lane can be served at all on this host/lane (M7). The
 * honest state the operator is owed instead of a dead-looking surface:
 *   - `unsupported` — this browser cannot run the lane (no microphone capture);
 *   - `unavailable` — a start was refused by the server (e.g. the live engine is
 *     disabled and the cascade serves the lane) or the engine never answered;
 *   - `unknown`     — no start has been attempted yet.
 */
export type LaneAvailabilityState =
  | 'unknown'
  | 'connecting'
  | 'live'
  | 'unavailable'
  | 'unsupported';

export interface LaneAvailability {
  state: LaneAvailabilityState;
  /** The host's or the server's own explanation; never invented here. */
  detail: string | null;
}

/** How the read-back of the live proposal is going (H3). */
export interface ReadBackState {
  state: 'idle' | 'reading' | 'completed' | 'interrupted' | 'unsupported';
  /** False when this host has no speech synthesis at all. */
  supported: boolean;
  variant: VoiceProposalVariant | null;
  proposalId: string | null;
  stoppedAtChar?: number;
  detail?: string;
}

export interface VoiceLiveSurfaceState {
  capture: CaptureLifecycle;
  captureDetail: string | null;
  /**
   * The NAMED cause of the last capture failure (`worklet_unavailable` when the
   * worklet would not load, `capture_failed` when it broke mid-stream). The
   * surface's copy is derived from this, so a failure can never be described by
   * a claim that is false for its cause.
   */
  captureFaultReason: CaptureFaultReason | null;
  captureStats: CaptureStats | null;
  playback: PlaybackStats | null;
  lastChime: ChimeVariant | null;
  captureFaults: CaptureFaultReport[];
  playbackFaults: PlaybackFault[];
  /** Whether the native lane can be served, and why not when it cannot (M7). */
  lane: LaneAvailability;
  /** The read-back of the live proposal: the only source of "presented" (H3). */
  readBack: ReadBackState;
  controller: VoiceLiveSnapshot;
}

/** Injection points so the wiring is testable without a browser. */
export interface VoiceLiveSurfaceFactories {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  startCaptureSession?: typeof startCaptureSession;
  createPlaybackBackend?: (context: BaseAudioContext) => PlaybackBackend;
  /** The host's own speech synthesis; `window.speechSynthesis` by default. */
  createReadBackSpeaker?: () => ReadBackSpeaker;
  /** How long a lane start may stay unanswered before it is honestly unavailable. */
  laneProbeTimeoutMs?: number;
  now?: () => number;
}

export interface VoiceLiveSurfaceOptions {
  lane: VoiceLaneIdentity;
  /** The session transport: the only outbound path. */
  send: (frame: VoiceClientMessage) => void | Promise<void>;
  /** The shared speech floor: the arbiter owns ducking (read-only here). */
  arbiter: SpeechArbiter;
  factories?: VoiceLiveSurfaceFactories;
  onStateChange?: (state: VoiceLiveSurfaceState) => void;
  onRefusal?: (refusal: VoiceLiveRefusal) => void;
  onReceipt?: (message: VoiceReceiptEventMessage) => void;
  /** Test seam: an already-built controller (its chime wiring is then external). */
  controller?: VoiceLiveController;
}

const MAX_FAULTS = 20;
/** A start that gets no answer at all is a failure, not a wait (M7). */
const DEFAULT_LANE_PROBE_MS = 12_000;

export class VoiceLiveSurface {
  /** Built here (or injected in tests) and wired to the delivery chime. */
  readonly controller: VoiceLiveController;
  private readonly arbiter: SpeechArbiter;
  private readonly factories: VoiceLiveSurfaceFactories;
  private readonly onStateChange: (state: VoiceLiveSurfaceState) => void;
  private readonly listeners = new Set<() => void>();
  private readonly captureFaults: CaptureFaultReport[] = [];
  private readonly playbackFaults: PlaybackFault[] = [];

  private audioContext: AudioContext | null = null;
  private playback: PlaybackPipeline | null = null;
  private capture: CaptureSession | null = null;
  private captureLifecycle: CaptureLifecycle = 'idle';
  private captureDetail: string | null = null;
  /** The named cause of the last capture failure; cleared by a fresh attempt. */
  private captureFaultReasonValue: CaptureFaultReason | null = null;
  private chime: ReturnType<typeof createDeliveryChime> | null = null;
  private lastChime: ChimeVariant | null = null;
  private captureStats: CaptureStats | null = null;
  private unsubscribeController: (() => void) | null = null;
  private readBackSpeaker: ReadBackSpeaker | null = null;
  private readBackToken = 0;
  private readBack: ReadBackState;
  /** The pending read-back's resolver, so a stop can settle it honestly. */
  private settleReadBack: ((outcome: ReadBackOutcome) => void) | null = null;
  private lane: LaneAvailability;
  /** Set when this host cannot capture at all; the lane is then `unsupported`. */
  private readonly captureUnsupportedDetail: string | null;
  private laneProbe: ReturnType<typeof setTimeout> | null = null;
  /**
   * The published snapshot is cached so `useSyncExternalStore` sees a stable
   * identity between changes (a fresh object on every read would loop).
   */
  private cachedState: VoiceLiveSurfaceState | null = null;

  constructor(options: VoiceLiveSurfaceOptions) {
    this.arbiter = options.arbiter;
    this.factories = options.factories ?? {};
    this.onStateChange = options.onStateChange ?? (() => {});
    this.captureUnsupportedDetail = this.detectCaptureSupport();
    this.lane = this.captureUnsupportedDetail
      ? { state: 'unsupported', detail: this.captureUnsupportedDetail }
      : { state: 'unknown', detail: null };
    this.readBackSpeaker = this.factories.createReadBackSpeaker
      ? this.factories.createReadBackSpeaker()
      : createBrowserReadBackSpeaker();
    this.readBack = { state: 'idle', supported: this.readBackSpeaker.supported, variant: null, proposalId: null };
    this.controller =
      options.controller ??
      new VoiceLiveController({
        lane: options.lane,
        send: options.send,
        ...(options.onRefusal ? { onRefusal: options.onRefusal } : {}),
        onReceipt: (message) => {
          options.onReceipt?.(message);
          // Delivered → the trusted chime. Everything else → its own distinct
          // tone, never the delivered figure (contract §8.1).
          if (message.receipt.outcome === 'delivered') this.playDeliveredChime();
          else this.playNotDeliveredChime(message.receipt.outcome);
        },
      });
    this.unsubscribeController = this.controller.subscribe(() => this.onControllerChange());
  }

  /**
   * Can this host capture at all? Checked against the injected seam first so a
   * test's virtual microphone counts as a real capability (the surface must not
   * call a test host "unsupported" because jsdom has no mediaDevices).
   */
  private detectCaptureSupport(): string | null {
    if (this.factories.getUserMedia || this.factories.startCaptureSession) return null;
    if (typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      return null;
    }
    return 'this browser exposes no microphone capture API';
  }

  /**
   * Every controller change re-reads the lane's availability and keeps the
   * read-back honest: a proposal that is no longer the live one must not be read
   * back (its bytes are not the bytes a confirmation would release).
   */
  private onControllerChange(): void {
    this.syncLaneAvailability();
    const snapshot = this.controller.snapshot();
    const reading = this.readBack.state === 'reading' ? this.readBack.proposalId : null;
    if (reading && (snapshot.proposal === null || snapshot.proposal.proposal.proposalId !== reading)) {
      this.stopReadBack();
    }
    this.publish();
  }

  // ── Observation ──────────────────────────────────────────────────────────

  getState(): VoiceLiveSurfaceState {
    return this.cachedState ?? this.refreshState();
  }

  private refreshState(): VoiceLiveSurfaceState {
      const state: VoiceLiveSurfaceState = {
        capture: this.captureLifecycle,
        captureDetail: this.captureDetail,
        captureFaultReason: this.captureFaultReasonValue,
      captureStats: this.capture ? this.capture.stats() : this.captureStats,
      playback: this.playback ? this.playback.stats() : null,
      lastChime: this.lastChime,
      captureFaults: [...this.captureFaults],
      playbackFaults: [...this.playbackFaults],
      lane: { ...this.lane },
      readBack: { ...this.readBack },
      controller: this.controller.snapshot(),
    };
    this.cachedState = state;
    return state;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private publish(): void {
    const state = this.refreshState();
    for (const fn of this.listeners) fn();
    this.onStateChange(state);
  }

  // ── Audio graph ──────────────────────────────────────────────────────────

  private ensureAudio(): AudioContext {
    if (this.audioContext) return this.audioContext;
    const context = this.factories.createAudioContext
      ? this.factories.createAudioContext()
      : new AudioContext();
    this.audioContext = context;

    const playbackBackend = this.factories.createPlaybackBackend
      ? this.factories.createPlaybackBackend(context)
      : createWebAudioPlaybackBackend(context);
    this.playback = new PlaybackPipeline({
      backend: playbackBackend,
      floor: asSpeechFloorSource(this.arbiter),
      onFault: (fault) => {
        this.playbackFaults.push(fault);
        if (this.playbackFaults.length > MAX_FAULTS) this.playbackFaults.shift();
        this.publish();
      },
    });

    const chimeBackend = createWebAudioChimeBackend(context);
    this.chime = createDeliveryChime({ backend: chimeBackend });
    return context;
  }

  /** Must be called from a user gesture: browsers require it to resume audio. */
  async resumeAudio(): Promise<void> {
    const context = this.ensureAudio();
    if (context.state === 'suspended') await context.resume();
  }

  // ── Capture ──────────────────────────────────────────────────────────────

  /**
   * Start continuous capture (open-mic). Capture is not a playback decision:
   * nothing but an explicit operator action or an error suspends it here.
   */
  async startCapture(options: { sendSilence?: boolean } = {}): Promise<'live' | 'error'> {
    if (this.capture) {
      if (options.sendSilence) this.capture.flush();
      return 'live';
    }
    this.captureLifecycle = 'starting';
    this.captureDetail = null;
    this.captureFaultReasonValue = null;
    this.publish();

    try {
      await this.resumeAudio();
      const getUserMedia =
        this.factories.getUserMedia ??
        ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
      const stream = await getUserMedia({ audio: true, video: false });
      const context = this.ensureAudio();
      const startSession = this.factories.startCaptureSession ?? startCaptureSession;
      const session = await startSession({
        context,
        stream,
        sink: (chunk) => {
          this.controller.sendCaptureChunk(chunk);
        },
        onActivity: (activity) => this.onOperatorActivity(activity.state, activity.atMs),
        onFault: (fault) => {
          this.captureFaults.push(fault);
          if (this.captureFaults.length > MAX_FAULTS) this.captureFaults.shift();
          // A named fault is the cause the copy is built from.
          this.captureFaultReasonValue = fault.reason;
          this.reportCaptureFault(fault);
          this.publish();
        },
        ...(options.sendSilence !== undefined ? { sendSilence: options.sendSilence } : {}),
        ...(this.factories.now ? { now: this.factories.now } : {}),
      });
      this.capture = session;
      this.captureLifecycle = 'live';
      this.publish();
      return 'live';
    } catch (error) {
      this.captureLifecycle = 'error';
      this.captureDetail = error instanceof Error ? error.message : String(error);
      // A thrown failure with no named fault is still a capture failure, and it
      // is named as one — never left for the copy to guess at.
      if (this.captureFaultReasonValue === null) {
        this.captureFaultReasonValue = 'capture_failed';
        const fault = { reason: 'capture_failed' as const, detail: this.captureDetail ?? undefined };
        this.captureFaults.push(fault);
        if (this.captureFaults.length > MAX_FAULTS) this.captureFaults.shift();
        this.reportCaptureFault(fault);
      }
      // Capture failing is not a reason to pretend; the surface shows the named
      // cause and says plainly what is still reachable (intent §20).
      this.publish();
      return 'error';
    }
  }

  /**
   * Put a capture fault on the wire. Reporting is strictly best-effort: a
   * transport that refuses the frame (or a lane that is not open yet) must never
   * turn a microphone problem into a second, different failure.
   */
  private reportCaptureFault(fault: { reason: string; detail?: string }): void {
    try {
      this.controller.reportCaptureFault(
        fault.detail === undefined ? { reason: fault.reason } : { reason: fault.reason, detail: fault.detail },
        this.factories.now ? this.factories.now() : Date.now(),
      );
    } catch {
      /* best effort: the operator-facing state is already set */
    }
  }

  /**
   * The operator's floor signal. One call site, two readers: the arbiter ducks
   * and the wire reports the boundary. Neither can reach capture.
   */
  private onOperatorActivity(state: 'speech_start' | 'speech_end', atMs: number): void {
    // The arbiter is the single owner of the ducking decision (N5).
    this.arbiter.setOperatorSpeaking(state === 'speech_start');
    // The wire learns about the boundary (scheduling input only).
    this.controller.reportActivity(state, atMs);
    this.publish();
  }

  /** Push-to-talk: capture only while the control is held, then flush. */
  async beginPushToTalk(): Promise<'live' | 'error'> {
    return this.startCapture({ sendSilence: true });
  }

  async endPushToTalk(): Promise<void> {
    this.capture?.flush();
    await this.stopCapture('push-to-talk released');
  }

  /**
   * Suspend capture explicitly (operator action, or the lane stopped). This is
   * the ONLY way capture stops, and it is never reachable from a playback or
   * ducking decision.
   */
  async stopCapture(reason = 'capture stopped'): Promise<void> {
    const session = this.capture;
    this.capture = null;
    this.captureStats = session ? session.stats() : null;
    if (session) await session.stop();
    this.captureLifecycle = 'suspended';
    this.captureDetail = reason;
    // The operator is no longer speaking the moment we stop hearing them.
    this.arbiter.setOperatorSpeaking(false);
    this.publish();
  }

  /** Stop everything and release the microphone (component unmount). */
  async dispose(): Promise<void> {
    this.stopReadBack();
    this.clearLaneProbe();
    await this.stopCapture('disposed');
    this.playback?.dispose();
    this.playback = null;
    this.unsubscribeController?.();
    this.unsubscribeController = null;
    this.listeners.clear();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close().catch(() => undefined);
    }
    this.audioContext = null;
  }

  // ── Lane start and availability (M7) ─────────────────────────────────────

  /**
   * Open the lane on the wire (`voice_session_start`) and watch for the engine's
   * answer. This is the call that makes the surface actually reachable: without
   * it the lane never exists server-side, and the honest states below are the
   * reason an operator sees why a lane did not start instead of a dead control.
   */
  startLane(input: { resume?: boolean } = {}): 'started' | 'unsupported' {
    if (this.captureUnsupportedDetail) {
      this.lane = { state: 'unsupported', detail: this.captureUnsupportedDetail };
      this.publish();
      return 'unsupported';
    }
    const snapshot = this.controller.snapshot();
    if (snapshot.wireState === 'live') {
      // The lane is already open. Starting it again would re-register the same
      // attachment for no reason, so this is a no-op: the operator's pause was
      // a CAPTURE pause, and resuming is the only thing left to do.
      this.lane = { state: 'live', detail: null };
      this.publish();
      return 'started';
    }
    if (snapshot.wireState === 'connecting') {
      // A start is already in flight; a second frame would open nothing new.
      return 'started';
    }
    this.controller.start({
      captureMode: snapshot.captureMode,
      readingLevel: snapshot.readingLevel,
      ...(input.resume !== undefined ? { resume: input.resume } : {}),
    });
    this.lane = { state: 'connecting', detail: null };
    this.armLaneProbe();
    this.publish();
    return 'started';
  }

  /** Try a lane that was reported unavailable again (a fresh start frame). */
  retryLane(): 'started' | 'unsupported' {
    this.clearLaneProbe();
    this.lane = this.captureUnsupportedDetail
      ? { state: 'unsupported', detail: this.captureUnsupportedDetail }
      : { state: 'unknown', detail: null };
    return this.startLane();
  }

  private armLaneProbe(): void {
    this.clearLaneProbe();
    const timeoutMs = this.factories.laneProbeTimeoutMs ?? DEFAULT_LANE_PROBE_MS;
    if (timeoutMs <= 0) return;
    this.laneProbe = setTimeout(() => {
      this.laneProbe = null;
      if (this.lane.state !== 'connecting' && this.lane.state !== 'unknown') return;
      this.lane = {
        state: 'unavailable',
        detail: `no answer from the voice engine within ${Math.round(timeoutMs / 1000)}s`,
      };
      // A lane that never became live must not leave a hot microphone behind.
      if (this.capture) void this.stopCapture('the voice lane did not become live');
      this.publish();
    }, timeoutMs);
  }

  private clearLaneProbe(): void {
    if (this.laneProbe !== null) {
      clearTimeout(this.laneProbe);
      this.laneProbe = null;
    }
  }

  /** Derive the lane's honest availability from the controller's own state. */
  private syncLaneAvailability(): void {
    if (this.captureUnsupportedDetail) {
      this.lane = { state: 'unsupported', detail: this.captureUnsupportedDetail };
      return;
    }
    const snapshot = this.controller.snapshot();
    // The lane's CURRENT wire state wins over an error recorded earlier: a new
    // start supersedes the previous lane's failure, and reporting the stale
    // error over a live lane would make a retry look impossible.
    switch (snapshot.wireState) {
      case 'live':
        this.clearLaneProbe();
        this.lane = { state: 'live', detail: null };
        return;
      case 'connecting':
      case 'reconnecting':
        this.lane = { state: 'connecting', detail: null };
        return;
      default:
        break;
    }
    if (snapshot.lastError?.fatal) {
      this.clearLaneProbe();
      this.lane = {
        state: 'unavailable',
        detail: `${snapshot.lastError.code}: ${snapshot.lastError.message}`,
      };
      this.stopCaptureForUnavailableLane();
      return;
    }
    if (snapshot.wireState === 'error') {
      this.clearLaneProbe();
      this.lane = {
        state: 'unavailable',
        detail: snapshot.detail ?? snapshot.lastError?.message ?? 'the voice lane reported an error',
      };
      this.stopCaptureForUnavailableLane();
      return;
    }
    if (snapshot.wireState === 'stopped' || snapshot.wireState === 'idle') {
      // No lane is open: the honest state is "nothing has been started", not a
      // leftover "live" from the previous attachment.
      this.lane = { state: 'unknown', detail: null };
    }
  }

  /** A lane that cannot be served must not keep the microphone open. */
  private stopCaptureForUnavailableLane(): void {
    if (this.capture) void this.stopCapture('the voice lane is unavailable');
  }

  // ── Read-back (H3) ───────────────────────────────────────────────────────

  /**
   * Read the live proposal's composed bytes aloud and report what happened.
   *
   * The contract's `proposal_presentation` is sent from the playback's OWN
   * lifecycle — `completed: true` only when the utterance reached its end — and
   * never from the click that started it. That is the difference the review
   * found (H3): "presented" must mean "the operator heard the bytes".
   */
  async readBackProposal(variant?: VoiceProposalVariant): Promise<ReadBackOutcome> {
    const live = this.controller.snapshot().proposal;
    if (!live || live.superseded) return 'no-proposal';
    const chosen = variant ?? live.proposal.presentedVariant;
    const text = chosen === 'original' ? live.proposal.original : live.proposal.tidied;
    const proposalId = live.proposal.proposalId;

    const speaker = this.ensureReadBackSpeaker();
    // One read-back at a time: a new attempt stops the old one without
    // reporting it (it was replaced, not heard).
    this.stopReadBack();

    if (!speaker.supported || text.trim().length === 0) {
      this.readBack = {
        state: 'unsupported',
        supported: speaker.supported,
        variant: chosen,
        proposalId,
        detail: speaker.supported
          ? 'there is nothing to read back for this proposal'
          : 'this browser cannot read it back aloud',
      };
      this.publish();
      return 'unsupported';
    }

    const token = (this.readBackToken += 1);
    this.readBack = { state: 'reading', supported: true, variant: chosen, proposalId };
    this.publish();

    return new Promise<ReadBackOutcome>((resolve) => {
      let stoppedAtChar: number | undefined;
      let settled = false;
      const settle = (outcome: ReadBackOutcome) => {
        if (settled) return;
        settled = true;
        if (this.settleReadBack === settle) this.settleReadBack = null;
        resolve(outcome);
      };
      // A stop (proposal replaced, unmount) must settle this promise itself:
      // the host is not required to call back after a cancel.
      this.settleReadBack = settle;
      const started = speaker.speak({
        text,
        onBoundary: (charIndex) => {
          stoppedAtChar = charIndex;
        },
        onEnd: () => {
          if (this.readBackToken !== token) {
            settle('interrupted');
            return;
          }
          this.readBack = { state: 'completed', supported: true, variant: chosen, proposalId };
          // THE ONLY completion report: the utterance ended.
          this.controller.reportPresentation({
            completed: true,
            presentedVariant: chosen,
          });
          this.publish();
          settle('completed');
        },
        onError: (reason) => {
          if (this.readBackToken !== token) {
            settle('interrupted');
            return;
          }
          this.readBack = {
            state: 'interrupted',
            supported: true,
            variant: chosen,
            proposalId,
            ...(stoppedAtChar !== undefined ? { stoppedAtChar } : {}),
            detail: reason,
          };
          // Narrowing only, and only while the proposal is still the live one.
          const current = this.controller.snapshot().proposal;
          if (current && !current.superseded && current.proposal.proposalId === proposalId) {
            this.controller.reportPresentation({
              completed: false,
              presentedVariant: chosen,
              ...(stoppedAtChar !== undefined ? { stoppedAtChar } : {}),
            });
          }
          this.publish();
          settle('interrupted');
        },
      });
      if (!started) {
        this.readBack = {
          state: 'interrupted',
          supported: true,
          variant: chosen,
          proposalId,
          detail: 'the host could not start playback',
        };
        this.publish();
        settle('interrupted');
      }
    });
  }

  /** Stop a read-back in flight (proposal changed, unmount). Reports nothing. */
  stopReadBack(): void {
    if (this.readBack.state === 'reading') {
      this.readBackToken += 1;
      this.ensureReadBackSpeaker().cancel();
      const settle = this.settleReadBack;
      this.settleReadBack = null;
      this.readBack = {
        state: 'idle',
        supported: this.readBackSpeaker?.supported ?? false,
        variant: null,
        proposalId: null,
      };
      settle?.('interrupted');
      this.publish();
      return;
    }
    if (this.readBack.state === 'unsupported') {
      this.readBack = {
        state: 'idle',
        supported: this.readBackSpeaker?.supported ?? false,
        variant: null,
        proposalId: null,
      };
      this.publish();
    }
  }

  private ensureReadBackSpeaker(): ReadBackSpeaker {
    if (!this.readBackSpeaker) {
      this.readBackSpeaker = this.factories.createReadBackSpeaker
        ? this.factories.createReadBackSpeaker()
        : createBrowserReadBackSpeaker();
    }
    return this.readBackSpeaker;
  }

  // ── Inbound wiring ───────────────────────────────────────────────────────

  /**
   * One inbound wire frame. Interpretation happens exactly once, in the
   * controller (the contract's own guards); this method only routes the audio
   * payload to the playback scheduler.
   */
  onWireMessage(raw: unknown): 'applied' | 'refused' | 'transport-refusal' {
    const outcome = this.controller.handleIncoming(raw);
    if (outcome !== 'applied') return outcome;
    const message = raw as VoiceServerMessage;
    if (message.type === 'voice_audio_chunk') {
      this.ensureAudio();
      this.playback?.pushChunk(message as VoiceAudioOutputChunkMessage);
    }
    this.publish();
    return outcome;
  }

  /** Called by the controller when a receipt says delivered (never earlier). */
  playDeliveredChime(): ChimeVariant | null {
    if (!this.chime) this.ensureAudio();
    const variant = this.chime?.play('delivered') ?? null;
    this.lastChime = variant;
    this.publish();
    return variant;
  }

  playNotDeliveredChime(variant: 'refused' | 'queued' | 'unknown'): void {
    if (!this.chime) this.ensureAudio();
    this.lastChime = this.chime?.play(variant) ?? null;
    this.publish();
  }

  /** Explicit operator stop for playback only (capture is untouched, N5). */
  stopPlayback(): void {
    this.playback?.stop();
    this.publish();
  }

  // ── Convenience pass-throughs for the component ──────────────────────────

  getController(): VoiceLiveController {
    return this.controller;
  }

  refusals(): VoiceLiveRefusal[] {
    return this.controller.snapshot().refusals;
  }
}
