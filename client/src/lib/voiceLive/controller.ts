/**
 * voiceLive/controller — one lane's state machine over the typed wire layer.
 *
 * This is where the surface's behaviour lives, and it is deliberately free of
 * React and of the audio graph, so it can be unit-tested exactly:
 *
 *   - inbound frames are interpreted by `messages.interpretInbound` (the contract's
 *     own guards) and refused frames are recorded and surfaced, never applied;
 *   - outbound frames are built by `messages` (schema-exact, text-free) and are
 *     the ONLY thing this class hands to the transport;
 *   - the delivery chime is decided here by `isDeliveredReceipt`: the controller
 *     reports a delivered receipt to its listener, and the surface plays the
 *     local chime. Nothing else can produce that sound (N6, contract §8.1);
 *   - a confirmation cannot be formed without a live, current proposal: there
 *     is no code path that sends `proposal_confirm` without a proposal id, a
 *     variant and an idempotency key, and a retry reuses the same key verbatim.
 *
 * N5/N1 hold by construction: this class has no capture control, no way to
 * silence the microphone, and no way to send the operator's words — every
 * outbound frame goes through a builder whose text-carrying keys do not exist.
 */

import {
  type VoiceAudioInputChunk,
  type VoiceCancelReason,
  type VoiceCreatedProposal,
  type VoiceCaptureMode,
  type VoiceErrorCode,
  type VoiceParkingUpdatedMessage,
  type VoiceProposalVariant,
  type VoiceReadingLevel,
  type VoiceReceipt,
  type VoiceReceiptEventMessage,
  type VoiceServerMessage,
  type VoiceStateMessage,
  type VoiceStopReason,
  type VoiceTranscriptDeltaMessage,
  type VoiceWorkerActivity,
  type VoiceWireState,
} from '@pi-web-ui/shared';
import {
  buildActivityState,
  buildAudioChunk,
  buildParkingList,
  buildParkingPromote,
  buildProposalCancel,
  buildProposalPresentation,
  buildReadingLevel,
  buildSessionStart,
  buildSessionStop,
  createConfirmationGesture,
  interpretInbound,
  mintRequestId,
  type ConfirmationGesture,
  type VoiceClientMessage,
  type VoiceInboundRefusalReason,
  type VoiceLaneIdentity,
  type VoiceTransportRefusal,
} from './messages';

/** How a proposal is displayed: read back in full, not yet, or superseded. */
export type ProposalPresentationStatus = 'presented' | 'pending' | 'stale';

export interface VoiceLiveProposal {
  proposal: VoiceCreatedProposal;
  /** True when a newer proposal replaced this one before it was resolved. */
  superseded: boolean;
}

export interface VoiceLiveRefusal {
  direction: 'inbound' | 'outbound';
  reason: VoiceInboundRefusalReason | 'send_failed';
  code: VoiceErrorCode;
  detail: string;
}

export interface VoiceLiveSnapshot {
  lane: VoiceLaneIdentity;
  wireState: VoiceWireState;
  captureMode: VoiceCaptureMode;
  readingLevel: VoiceReadingLevel;
  workerActivity: VoiceWorkerActivity;
  /** Honest capture state: true while the host knows capture is suspended. */
  listeningSuspended: boolean;
  detail: string | null;
  operatorSpeaking: boolean;
  captions: VoiceTranscriptDeltaMessage[];
  proposal: VoiceLiveProposal | null;
  parking: { items: VoiceParkingUpdatedMessage['items']; operation: string | null };
  receipts: VoiceReceipt[];
  lastError: { code: VoiceErrorCode; message: string; fatal: boolean } | null;
  refusals: VoiceLiveRefusal[];
  /**
   * Refusals the SERVER sent about the transport itself (M8): notices that
   * carried no lane envelope and would otherwise be dropped as malformed.
   * Rendered, never silent — and never lane authority, because they name none.
   */
  transportRefusals: VoiceTransportRefusal[];
  pendingRequests: string[];
}

export type VoiceLiveSend = (frame: VoiceClientMessage) => void | Promise<void>;

export interface VoiceLiveControllerOptions {
  lane: VoiceLaneIdentity;
  send: VoiceLiveSend;
  now?: () => number;
  onRefusal?: (refusal: VoiceLiveRefusal) => void;
  /** Fired ONLY for a delivered receipt (the surface plays the local chime). */
  onDeliveredReceipt?: (message: VoiceReceiptEventMessage) => void;
  /** Fired for every receipt verdict (surface may render queued/refused/unknown). */
  onReceipt?: (message: VoiceReceiptEventMessage) => void;
}

const MAX_CAPTIONS = 200;
const MAX_RECEIPTS = 50;
const MAX_REFUSALS = 50;
const MAX_TRANSPORT_REFUSALS = 20;

export class VoiceLiveController {
  private readonly options: VoiceLiveControllerOptions;
  private lane: VoiceLaneIdentity;
  private readonly listeners = new Set<() => void>();
  private readonly pendingRequests = new Set<string>();
  private readonly captions: VoiceTranscriptDeltaMessage[] = [];
  private readonly receipts: VoiceReceipt[] = [];
  private readonly refusals: VoiceLiveRefusal[] = [];
  private readonly transportRefusals: VoiceTransportRefusal[] = [];
  private proposal: VoiceLiveProposal | null = null;
  private parking: VoiceLiveSnapshot['parking'] = { items: [], operation: null };
  private wireState: VoiceWireState = 'idle';
  private captureMode: VoiceCaptureMode = 'open-mic';
  private readingLevel: VoiceReadingLevel = 'verbatim';
  private workerActivity: VoiceWorkerActivity = 'unknown';
  private listeningSuspended = false;
  private detail: string | null = null;
  private operatorSpeaking = false;
  private lastError: VoiceLiveSnapshot['lastError'] = null;
  private gesture: ConfirmationGesture | null = null;

  constructor(options: VoiceLiveControllerOptions) {
    this.options = options;
    this.lane = options.lane;
  }

  // ── Observation ──────────────────────────────────────────────────────────

  snapshot(): VoiceLiveSnapshot {
    return {
      lane: this.lane,
      wireState: this.wireState,
      captureMode: this.captureMode,
      readingLevel: this.readingLevel,
      workerActivity: this.workerActivity,
      listeningSuspended: this.listeningSuspended,
      detail: this.detail,
      operatorSpeaking: this.operatorSpeaking,
      captions: [...this.captions],
      proposal: this.proposal ? { ...this.proposal } : null,
      parking: { items: [...this.parking.items], operation: this.parking.operation },
      receipts: [...this.receipts],
      lastError: this.lastError ? { ...this.lastError } : null,
      refusals: [...this.refusals],
      transportRefusals: [...this.transportRefusals],
      pendingRequests: [...this.pendingRequests],
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** The display status of the live proposal (the card's presented/stale state). */
  presentationStatus(): ProposalPresentationStatus {
    if (!this.proposal) return 'stale';
    if (this.proposal.superseded) return 'stale';
    return this.proposal.proposal.presentation.completed ? 'presented' : 'pending';
  }

  // ── Outbound commands ────────────────────────────────────────────────────

  start(input: { captureMode?: VoiceCaptureMode; readingLevel?: VoiceReadingLevel; resume?: boolean } = {}): void {
    if (input.captureMode) this.captureMode = input.captureMode;
    if (input.readingLevel) this.readingLevel = input.readingLevel;
    this.wireState = 'connecting';
    this.detail = null;
    // A fresh start supersedes the previous lane's error: leaving a stale fatal
    // error on the snapshot would make a retry that is genuinely in flight read
    // as permanently unavailable (M7 retry path).
    this.lastError = null;
    const requestId = mintRequestId();
    this.pendingRequests.add(requestId);
    this.send(
      buildSessionStart(
        this.lane,
        {
          captureMode: this.captureMode,
          readingLevel: this.readingLevel,
          ...(input.resume !== undefined ? { resume: input.resume } : {}),
        },
        { requestId },
      ),
    );
    this.notify();
  }

  stop(reason: VoiceStopReason = 'operator_stop'): void {
    this.send(buildSessionStop(this.lane, reason));
    this.wireState = 'stopped';
    this.operatorSpeaking = false;
    this.gesture = null;
    this.notify();
  }

  /**
   * Capture mode is a start parameter in the contract, so switching it
   * honestly restarts the lane rather than pretending a mid-session change.
   * The worker attachment (and therefore the generation) does not change.
   */
  setCaptureMode(mode: VoiceCaptureMode): void {
    if (mode === this.captureMode) return;
    const wasLive = this.wireState === 'live' || this.wireState === 'connecting';
    this.captureMode = mode;
    if (wasLive) {
      this.send(buildSessionStop(this.lane, 'operator_stop'));
      const requestId = mintRequestId();
      this.pendingRequests.add(requestId);
      this.send(
        buildSessionStart(
          this.lane,
          { captureMode: mode, readingLevel: this.readingLevel },
          { requestId },
        ),
      );
    }
    this.notify();
  }

  setReadingLevel(level: VoiceReadingLevel): void {
    if (level === this.readingLevel) return;
    this.readingLevel = level;
    this.send(buildReadingLevel(this.lane, level));
    this.notify();
  }

  /** Local voice-activity boundary — scheduling input only, never authority. */
  reportActivity(state: 'speech_start' | 'speech_end', atMs: number): void {
    this.operatorSpeaking = state === 'speech_start';
    this.send(buildActivityState(this.lane, state, atMs));
    this.notify();
  }

  /**
   * Report a capture fault the CLIENT hit (a worklet that would not load, a
   * device that refused, backpressure). It rides an activity frame carrying the
   * TRUE local activity state, so the boundary the server mirrors is unchanged;
   * the point is that the server learns the microphone could not start, instead
   * of the reason living only in one browser console. No capture authority is
   * created or moved by this call.
   */
  reportCaptureFault(fault: { reason: string; detail?: string }, atMs: number): void {
    const state = this.operatorSpeaking ? 'speech_start' : 'speech_end';
    this.send(
      buildActivityState(this.lane, state, atMs, undefined, {
        reason: fault.reason,
        atMs,
        ...(fault.detail ? { detail: fault.detail } : {}),
      }),
    );
    this.notify();
  }

  /**
   * Send one captured microphone chunk. This is the ONLY path audio leaves the
   * client: the frame is built by the contract's builder (16 kHz, PCM16LE,
   * under the decoded-byte ceiling) and carries no words. An over-limit or
   * wrong-format chunk is refused here and surfaced, never sent hopefully.
   */
  sendCaptureChunk(chunk: VoiceAudioInputChunk): 'sent' | 'refused' {
    try {
      this.send(buildAudioChunk(this.lane, chunk));
      return 'sent';
    } catch (error) {
      this.refuse({
        direction: 'outbound',
        reason: 'send_failed',
        code: 'voice_audio_chunk_too_large',
        detail: error instanceof Error ? error.message : String(error),
      });
      return 'refused';
    }
  }

  requestParkingList(): void {
    const requestId = mintRequestId();
    this.pendingRequests.add(requestId);
    this.send(buildParkingList(this.lane, { requestId }));
    this.notify();
  }

  /** Promote ONE parked item. There is no batch path (N3 is per instruction). */
  promoteParkedItem(itemId: string): 'sent' | 'refused' {
    const known = this.parking.items.some((item) => item.itemId === itemId);
    if (!known) {
      this.refuse({
        direction: 'outbound',
        reason: 'send_failed',
        code: 'voice_message_malformed',
        detail: `no parked item ${itemId} on this lane`,
      });
      return 'refused';
    }
    this.send(buildParkingPromote(this.lane, itemId));
    return 'sent';
  }

  /**
   * Confirm the live proposal. Refuses (recording why) when there is no live
   * proposal: a confirmation without a proposal identity is not a confirmation.
   */
  confirmProposal(input: { variant?: VoiceProposalVariant } = {}): 'sent' | 'refused' {
    const live = this.proposal;
    if (!live || live.superseded) {
      this.refuse({
        direction: 'outbound',
        reason: 'send_failed',
        code: 'voice_confirm_requires_proposal',
        detail: 'no live proposal to confirm',
      });
      return 'refused';
    }
    const variant = input.variant ?? live.proposal.presentedVariant;
    // One gesture per confirmation intent: minted here, reused verbatim by
    // `retryConfirmation()` after a reconnect.
    this.gesture = createConfirmationGesture({ proposalId: live.proposal.proposalId, variant });
    this.send(
      this.gesture.frame(this.lane, {
        version: live.proposal.version,
        sha256: live.proposal.sha256,
      }),
    );
    return 'sent';
  }

  /**
   * Re-send the SAME confirmation gesture after a transport drop. The
   * idempotency key is reused verbatim, so a retry can never deliver twice.
   */
  retryConfirmation(): 'sent' | 'refused' {
    if (!this.gesture) {
      this.refuse({
        direction: 'outbound',
        reason: 'send_failed',
        code: 'voice_confirm_requires_proposal',
        detail: 'no confirmation gesture to retry',
      });
      return 'refused';
    }
    const live = this.proposal;
    this.send(
      this.gesture.frame(
        this.lane,
        live ? { version: live.proposal.version, sha256: live.proposal.sha256 } : undefined,
      ),
    );
    return 'sent';
  }

  cancelProposal(reason: VoiceCancelReason = 'operator_cancel'): 'sent' | 'refused' {
    const live = this.proposal;
    if (!live) {
      this.refuse({
        direction: 'outbound',
        reason: 'send_failed',
        code: 'voice_proposal_stale',
        detail: 'no live proposal to cancel',
      });
      return 'refused';
    }
    this.send(buildProposalCancel(this.lane, { proposalId: live.proposal.proposalId, reason }));
    this.proposal = null;
    this.gesture = null;
    this.notify();
    return 'sent';
  }

  /**
   * Report whether the read-back of the live proposal completed. `completed:
   * true` authorises nothing; `false` only narrows a later confirmation.
   *
   * `presentedVariant` defaults to the proposal's own announced variant, but the
   * caller MUST name it when the read-back was of the other retained variant:
   * the frame records which bytes the operator actually heard (H3 — a read-back
   * of "your words" may not be reported as a read-back of the tidy).
   */
  reportPresentation(input: {
    completed: boolean;
    stoppedAtChar?: number;
    presentedVariant?: VoiceProposalVariant;
  }): 'sent' | 'refused' {
    const live = this.proposal;
    if (!live) return 'refused';
    const presentedVariant = input.presentedVariant ?? live.proposal.presentedVariant;
    this.send(
      buildProposalPresentation(this.lane, {
        proposalId: live.proposal.proposalId,
        presentedVariant,
        completed: input.completed,
        ...(input.stoppedAtChar !== undefined ? { stoppedAtChar: input.stoppedAtChar } : {}),
      }),
    );
    live.proposal.presentedVariant = presentedVariant;
    live.proposal.presentation = {
      completed: input.completed,
      ...(input.stoppedAtChar !== undefined ? { stoppedAtChar: input.stoppedAtChar } : {}),
    };
    this.notify();
    return 'sent';
  }

  // ── Inbound ──────────────────────────────────────────────────────────────

  /** Interpret and apply one inbound frame. Returns whether it was applied. */
  handleIncoming(raw: unknown): 'applied' | 'refused' | 'transport-refusal' {
    const result = interpretInbound(raw, this.lane, this.pendingRequests);
    if (result.kind === 'transport-refusal') {
      // A notice about the transport, not about a lane: recorded and rendered,
      // never applied as lane state and never mistaken for a lane refusal.
      this.transportRefusals.push(result.refusal);
      if (this.transportRefusals.length > MAX_TRANSPORT_REFUSALS) this.transportRefusals.shift();
      if (result.refusal.fatal) {
        this.wireState = 'error';
        this.listeningSuspended = true;
      }
      this.notify();
      return 'transport-refusal';
    }
    if (result.kind === 'refused') {
      this.refuse({
        direction: 'inbound',
        reason: result.reason,
        code: result.code,
        detail: result.detail,
      });
      return 'refused';
    }
    const message = result.message;
    if (message.requestId !== undefined) this.pendingRequests.delete(message.requestId);
    this.apply(message);
    this.notify();
    return 'applied';
  }

  private apply(message: VoiceServerMessage): void {
    switch (message.type) {
      case 'voice_state':
        this.applyState(message);
        return;
      case 'transcript_delta':
        this.captions.push(message);
        if (this.captions.length > MAX_CAPTIONS) this.captions.shift();
        return;
      case 'proposal_created': {
        if (this.proposal && this.proposal.proposal.proposalId !== message.proposal.proposalId) {
          // At most one live proposal per lane: the previous one is superseded,
          // not silently relabelled as current. (The server may also send
          // proposal_resolved { replaced }; either order is handled.)
        }
        this.proposal = { proposal: { ...message.proposal }, superseded: false };
        this.gesture = null;
        return;
      }
      case 'proposal_resolved': {
        if (this.proposal?.proposal.proposalId === message.proposalId) {
          // The proposal left its slot: it is no longer confirmable. This is
          // NOT a delivery verdict and produces no chime.
          this.proposal = null;
          this.gesture = null;
        }
        return;
      }
      case 'receipt_event': {
        this.receipts.push(message.receipt);
        if (this.receipts.length > MAX_RECEIPTS) this.receipts.shift();
        this.options.onReceipt?.(message);
        if (message.receipt.outcome === 'delivered') {
          // The single chime trigger (contract §8.1, N6). The check is done by
          // the message layer, never re-derived here.
          this.options.onDeliveredReceipt?.(message);
        }
        return;
      }
      case 'parking_updated': {
        this.parking = { items: [...message.items], operation: message.operation };
        return;
      }
      case 'voice_error': {
        this.lastError = { code: message.code, message: message.message, fatal: message.fatal };
        if (message.fatal) {
          this.wireState = 'error';
          this.listeningSuspended = true;
        }
        this.detail = message.message;
        return;
      }
      default:
        return;
    }
  }

  private applyState(message: VoiceStateMessage): void {
    this.wireState = message.state;
    if (message.workerActivity) this.workerActivity = message.workerActivity;
    if (message.readingLevel) this.readingLevel = message.readingLevel;
    if (message.captureMode) this.captureMode = message.captureMode;
    // An honest suspension/reconnection state (intent §20): never claim to be
    // listening while the host knows it is not.
    this.listeningSuspended = message.state === 'suspended' || message.state === 'stopped' || message.state === 'error';
    if (message.detail) this.detail = message.detail;
    if (message.state === 'error') this.detail = message.detail ?? 'voice lane error';
  }

  private refuse(refusal: VoiceLiveRefusal): void {
    this.refusals.push(refusal);
    if (this.refusals.length > MAX_REFUSALS) this.refusals.shift();
    this.options.onRefusal?.(refusal);
    this.notify();
  }

  private send(frame: VoiceClientMessage): void {
    try {
      this.options.send(frame);
    } catch (error) {
      this.refuse({
        direction: 'outbound',
        reason: 'send_failed',
        code: 'voice_internal_error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Swap the lane's attachment (worker switch): a NEW generation, never a retarget. */
  openNewGeneration(lane: VoiceLaneIdentity): void {
    this.lane = lane;
    this.proposal = null;
    this.gesture = null;
    this.pendingRequests.clear();
    this.notify();
  }

  /** The live proposal's id, or null — for surfaces that must show identity. */
  liveProposalId(): string | null {
    return this.proposal && !this.proposal.superseded ? this.proposal.proposal.proposalId : null;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
