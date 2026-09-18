/**
 * Voice Live mount (Voice Mode execution plan, Phase 5 / Track F; contract §6.4).
 *
 * This is the Phase-5 wiring the contract reserved: it constructs the Track B
 * service (`VoiceSessionService`), the thin `VoiceSessionRouter` and a kernel
 * delegate, and binds them to the authenticated WebSocket path. It is the
 * server side of the vertical slice — the browser client is NOT part of this
 * phase, and nothing here changes any non-voice path.
 *
 * WHAT LIVES HERE (and what deliberately does not):
 *
 *   1. The router handler. Every `voice_*` client frame is checked by the
 *      contract's own `checkVoiceEnvelope` (inside the router), resolved to a
 *      lane + attachment generation, and routed: audio/activity/lifecycle to
 *      the bridge service, kernel frames to the delegate below.
 *
 *   2. The kernel delegate (`VoiceKernelDelegate`). It owns the one
 *      `HostAuthorityKernel` (Track A) and the release predicate the contract
 *      requires: a confirmation is handed to `kernel.confirm` only when it
 *      resolves to a LIVE proposal for this frame's lane, its identity still
 *      matches, its read-back did not report itself incomplete, and the
 *      proposal has no prior release. Everything else is refused, and a
 *      refusal consumes nothing.
 *
 *   3. The operator-speech adapter. The lane's bridge events are observed; a
 *      FINAL operator transcript is mechanically classified (the talker's own
 *      classifier — never model output) and acted on:
 *        - `confirm`  → the lane's live proposal is confirmed and delivered;
 *        - `cancel`   → the lane's live proposal is cancelled;
 *        - a directed worker instruction (an explicit commission frame), while
 *          the worker is IDLE, becomes a proposal (promotion route `directed`)
 *          announced as `proposal_created`;
 *        - the same instruction while the worker is BUSY is PARKED, exactly as
 *          the parking lot defines itself (things flagged while the worker was
 *          busy), announced as `parking_updated`. Promotion later creates a
 *          proposal; nothing reaches the worker without its own confirmation.
 *
 *   4. One release path and only one. `confirmAndDeliver` is the sole caller of
 *      the worker delivery adapter, and it is reachable only from an
 *      authorised `HostAuthorityKernel.confirm`. Every step writes a
 *      structured evidence line (`voice-kernel {...}`) so a run can be
 *      audited afterwards: no delivery without a logged proposal id and a
 *      matching SHA.
 *
 * N1/N2/N8: the model has no path here. The only inputs to the gate are the
 * operator's own classified utterances and typed client frames that cannot
 * carry instruction text (the wire type has no text field; the contract's
 * runtime guard refuses one that tries).
 */

import type {
  VoiceBridgeEmittedEvent,
  VoiceBridgeService,
  VoiceClientMessage,
  VoiceCreatedProposal,
  VoiceErrorCode,
  VoiceParkedItem,
  VoiceProposalResolution,
  VoiceProposalVariant,
  VoiceReceipt,
  VoiceRouteContext,
  VoiceRuntime,
  VoiceServerMessage,
} from '../voice/contract.js';
import { VoiceSessionService } from '../voice/voice-session.js';
import { GeminiLiveBridge } from '../voice/gemini-live-bridge.js';
import type {
  GeminiLiveBridgeOptions,
  VoiceBridgeLike,
} from '../voice/types.js';
import { VoiceSessionRouter, mapBridgeEventToServerMessage, KERNEL_OWNED_CLIENT_MESSAGE_TYPES, type VoiceKernelDelegate } from '../voice/voice-router.js';
import { HostAuthorityKernel } from '../talker/policy-core.js';
import { classifyOperatorUtterance, isWorkerDirectedQuestion } from '../talker/utterance-classifier.js';
import { normaliseRelayText, type RelayNormalisation } from '../talker/relay-normalise.js';
import type { Proposal } from '../talker/proposal-store.js';
import type { ReleaseOutcome } from '../talker/release-store.js';
import type { DeliveryOutcome, WorkerDelivery } from '../talker/types.js';
import type { VoiceLogSink } from '../voice/types.js';
import type { VoiceModeEngine } from '../config.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';

// ── The commission-frame predicate (machine, narrow, model-free) ─────────────

/**
 * The removed fragments `normaliseRelayText` records for a commission frame —
 * "tell the worker to …", "ask it whether …", "let the worker know …",
 * "pass this to the worker: …". The frozen normaliser already decided the
 * segmentation; this only asks whether a commission frame was among the
 * fragments it removed, so the two cannot drift on what a frame IS. Anchored
 * at the fragment head so a frame-shaped phrase inside some other removal
 * cannot match.
 */
const COMMISSION_FRAME_REMOVAL =
  /^(?:tell|ask)\s+(?:the\s+worker|it)\b|^let\s+the\s+worker\s+know\b|^pass\s+(?:this|that|it)\s+(?:on\s+)?to\s+(?:the\s+worker|it|them)\b/i;

/**
 * Whether an operator utterance is a DIRECTED worker instruction (§18.1 route
 * 1: "ask it…", "tell it…", "send…") rather than ordinary conversational
 * speech. Two mechanical signals, both host-owned:
 *   - the frozen normaliser removed a commission frame from it; or
 *   - the classifier reads it as a worker-directed question.
 * An ordinary declarative sentence is neither, and thus never creates a
 * proposal (intent §18.1).
 */
export function isDirectedWorkerInstruction(
  raw: string,
  relay: RelayNormalisation = normaliseRelayText(raw)
): boolean {
  if (relay.removals.some((piece) => COMMISSION_FRAME_REMOVAL.test(piece))) return true;
  return isWorkerDirectedQuestion(raw);
}

// ── The mount's bridge factory ──────────────────────────────────────────────
//
// Finding F-1 (Wave 2) is now owned by the engine, not the mount: the bridge's
// `toolResponseScheduling` option defaults to `WHEN_IDLE`, so a declared tool
// call can never end the turn without speech. The Phase-5
// `withIdleToolAcknowledgements` session wrapper is deleted; Track B's option
// surface is the one place the scheduling decision lives.

/**
 * The mount's bridge factory: Track B's bridge, with the provider key seam kept
 * injectable. A missing key is left to the bridge's own honest error path
 * (nothing here guesses or hides it).
 */
export function createVoiceMountBridgeFactory(
  apiKeyProvider: () => string | undefined = () => process.env.GEMINI_API_KEY
): (options: GeminiLiveBridgeOptions) => VoiceBridgeLike {
  return (options) => new GeminiLiveBridge({ ...options, apiKeyProvider });
}

// ── Seams ───────────────────────────────────────────────────────────────────

/**
 * Phase 8 cascade hand-off. When the live engine cannot continue for a lane,
 * the Gemma talker cascade (the session registry, which is the single
 * server-side entry point for a worker's talker conversation) takes the lane
 * over. The sink records/announces the degradation; it carries no delivery
 * capability and is not an input to the release gate (N1/N8).
 */
export interface VoiceCascadeSink {
  noteEngineFallback(input: {
    laneId: string;
    workerSessionId: string;
    runtime: VoiceRuntime;
    reason: string;
    atMs: number;
  }): void;
}

export interface VoiceLiveMountOptions {
  /** The real worker delivery adapter (pi steer/prompt through the session manager). */
  delivery: WorkerDelivery;
  /**
   * True while the attached worker session is mid-run. Drives the parking rule
   * (a directed instruction arriving mid-run is parked, not relayed).
   */
  isWorkerBusy: (workerSessionId: string) => Promise<boolean>;
  /** Server logger sink for `server/src/voice/**`'s own diagnostics. */
  serviceLog?: VoiceLogSink;
  /**
   * Structured evidence line. Default is a no-op; the WebSocket mount supplies
   * `createLogEvidenceSink(logger)` so every run is auditable from the server
   * log. A test injects a collector instead.
   */
  evidence?: (event: Record<string, unknown>) => void;
  /** Clock seam (receipt timestamps in tests). */
  now?: () => number;
  /** Injectable service (tests); default constructs the real Track B service. */
  service?: VoiceBridgeService;
  /**
   * Which engine serves new lanes (plan Phase 8 flag). Default `gemini-live`
   * for direct construction; the server passes `config.voiceModeEngine`, whose
   * default is `cascade`. When `cascade`, a lane start never touches the live
   * bridge or the provider — the client is told the cascade is active.
   */
  engine?: VoiceModeEngine;
  /** Cascade hand-off sink (the talker session registry in production). */
  cascade?: VoiceCascadeSink;
  /** Operational metrics sink (Phase 8); default the process-wide registry. */
  metrics?: OperationalMetrics;
}

/** The bounded interval for surfacing refusals on a cascade lane (one per lane). */
const CASCADE_REFUSAL_SURFACE_INTERVAL_MS = 1_000;

const CASCADE_SERVING_DETAIL = 'the push-to-talk cascade is now serving this lane';

function fallbackDetail(lane: LaneRecord): string {
  const because = lane.fallbackReason ? ` (${lane.fallbackReason})` : '';
  return `live engine unavailable${because}; ${CASCADE_SERVING_DETAIL}`;
}

function configuredCascadeDetail(): string {
  return `live voice is disabled on this server (VOICE_MODE_ENGINE=cascade); ${CASCADE_SERVING_DETAIL}`;
}

function isKernelOwnedFrame(type: string): boolean {
  return (KERNEL_OWNED_CLIENT_MESSAGE_TYPES as readonly string[]).includes(type);
}

interface PresentationReport {
  completed: boolean;
  presentedVariant: VoiceProposalVariant;
  stoppedAtChar?: number;
}

interface LaneRecord {
  laneId: string;
  attachmentGeneration: number;
  workerSessionId: string;
  runtime: VoiceRuntime;
  /** Which engine serves this lane; a fatal live failure flips it to cascade. */
  engine: VoiceModeEngine;
  /** Set when the lane degraded to the cascade; null while live owns it. */
  fallbackReason: string | null;
  /** Bounded surfacing for frames arriving on a cascade lane. */
  lastCascadeRefusalAtMs: number | null;
  suppressedCascadeRefusals: number;
  /** Monotonic per-lane utterance counter (provenance for parked/proposed items). */
  utteranceSeq: number;
  /** Read-back reports by proposal id (contract §4.6: narrowing only). */
  presentations: Map<string, PresentationReport>;
  /** Idempotency key minted for a spoken confirmation, by proposal id. */
  spokenConfirmKeys: Map<string, string>;
}

interface LaneBinding {
  clientId: string;
  send: (message: VoiceServerMessage) => void;
}

type LaneResolution = { ok: true; lane: LaneRecord } | { ok: false; code: VoiceErrorCode };

/** Hard ceiling on distinct lanes one mount will remember (bounded state). */
const MAX_VOICE_LANES = 64;

function asWireParkedItem(item: { id: string; text: string; createdAt: number; sourceUtteranceId: number }): VoiceParkedItem {
  return {
    itemId: item.id,
    text: item.text,
    createdAtMs: item.createdAt,
    sourceUtteranceId: item.sourceUtteranceId,
  };
}

/** Kernel refusal reasons → the contract's refusal codes. */
function refusalCode(reason: 'not_found' | 'not_live' | 'stale' | 'original_not_offered'): VoiceErrorCode {
  switch (reason) {
    case 'original_not_offered':
    case 'stale':
    case 'not_live':
      return 'voice_proposal_stale';
    case 'not_found':
    default:
      return 'voice_confirm_requires_proposal';
  }
}

function toReleaseOutcome(outcome: DeliveryOutcome): ReleaseOutcome {
  if (outcome.outcome === 'delivered') {
    return {
      status: 'delivered',
      mechanism: outcome.mechanism,
      ...(outcome.disclosure !== undefined ? { disclosure: outcome.disclosure } : {}),
    };
  }
  if (outcome.outcome === 'queued') {
    return { status: 'queued', disclosure: outcome.disclosure };
  }
  return { status: 'refused', reason: outcome.reason };
}

// ── The mount ───────────────────────────────────────────────────────────────

export class VoiceLiveMount {
  /**
   * One kernel for the whole server: proposals, releases, parking lot and
   * threads are lane-scoped by `laneId` inside the kernel, and a single
   * instance is what makes the release log append-only across lanes.
   */
  readonly kernel: HostAuthorityKernel;

  private readonly delivery: WorkerDelivery;
  private readonly isWorkerBusy: (workerSessionId: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly evidence: (event: Record<string, unknown>) => void;
  private readonly serviceValue: VoiceBridgeService;
  private readonly router: VoiceSessionRouter;
  private readonly unsubscribe: () => void;
  private readonly engine: VoiceModeEngine;
  private readonly cascade: VoiceCascadeSink | null;
  private readonly metrics: OperationalMetrics;
  private readonly lanes = new Map<string, LaneRecord>();
  /** Where host-originated frames for a lane go (the socket that started it). */
  private readonly bindings = new Map<string, LaneBinding>();
  private disposed = false;

  constructor(options: VoiceLiveMountOptions) {
    this.delivery = options.delivery;
    this.isWorkerBusy = options.isWorkerBusy;
    this.now = options.now ?? (() => Date.now());
    this.evidence = options.evidence ?? (() => {});
    this.engine = options.engine ?? 'gemini-live';
    this.cascade = options.cascade ?? null;
    this.metrics = options.metrics ?? getOperationalMetrics();
    this.kernel = new HostAuthorityKernel({ now: this.now });
    this.serviceValue =
      options.service ??
      new VoiceSessionService({
        bridgeFactory: createVoiceMountBridgeFactory(),
        ...(options.serviceLog ? { log: options.serviceLog } : {}),
      });
    this.router = new VoiceSessionRouter({
      service: this.serviceValue,
      kernel: this.createKernelDelegate(),
    });
    this.unsubscribe = this.serviceValue.subscribe((event) => {
      void this.onBridgeEvent(event);
    });
  }

  /** The service instance (diagnostics/tests; the router is the only caller). */
  get service(): VoiceBridgeService {
    return this.serviceValue;
  }

  /**
   * Handle one client→server voice frame. Returns the refusal code (nothing
   * acted on) or null when accepted. The caller surfaces the code as
   * `voice_error` — never silence.
   */
  async route(
    clientId: string,
    context: VoiceRouteContext,
    message: VoiceClientMessage
  ): Promise<VoiceErrorCode | null> {
    if (this.disposed) return 'voice_internal_error';
    if (message.type === 'voice_session_start') {
      const refused = this.registerLane(
        message.laneId,
        message.attachmentGeneration,
        message.workerSessionId,
        message.runtime ?? 'pi'
      );
      if (refused !== null) return refused;
    } else if (!this.lanes.has(message.laneId)) {
      // A frame for a lane this server never accepted is refused before the
      // router sees it (the same answer the router gives for bridge frames).
      return 'voice_lane_unknown';
    }
    // Every accepted frame (re)binds the lane's host-originated output to the
    // socket that is speaking for it.
    this.bindings.set(message.laneId, { clientId, send: context.send });
    const lane = this.lanes.get(message.laneId);

    // Phase 8: a lane served by the cascade never touches the live service.
    // - a start is acknowledged honestly (configured cascade, or a lane that
    //   already fell back), and no provider session is ever opened;
    // - a stop is accepted as a no-op (nothing live is running);
    // - bridge-owned frames are bounded-refused with a surfaced `voice_error`;
    // - kernel-owned frames still route, so active drafts and parked items are
    //   never dropped by the fallback (N1/N8 unaffected: the gate is the same).
    if (lane && lane.engine === 'cascade' && message.type !== 'voice_session_start') {
      if (message.type === 'voice_session_stop') {
        this.evidence({ event: 'cascade_lane_stop', laneId: message.laneId, atMs: this.now() });
        return null;
      }
      if (!isKernelOwnedFrame(message.type)) {
        return this.refuseCascadeFrame(lane, message.type);
      }
    } else if (lane && lane.engine === 'cascade' && message.type === 'voice_session_start') {
      if (lane.fallbackReason === null) this.announceConfiguredCascade(lane);
      else this.sendToLane(lane.laneId, this.cascadeStateFrame(lane, fallbackDetail(lane)));
      return null;
    }

    const code = await this.router.handle(context, message);
    if (code !== null) {
      this.evidence({
        event: 'frame_refused',
        laneId: message.laneId,
        attachmentGeneration: message.attachmentGeneration,
        frameType: message.type,
        code,
        atMs: this.now(),
      });
    }
    return code;
  }

  /** The lane's serving engine (`gemini-live` until a fallback flips it). */
  getLaneEngine(laneId: string): VoiceModeEngine | null {
    return this.lanes.get(laneId)?.engine ?? null;
  }

  /** Why the lane degraded to the cascade; null while the live engine owns it. */
  getLaneFallbackReason(laneId: string): string | null {
    return this.lanes.get(laneId)?.fallbackReason ?? null;
  }

  /**
   * A client's socket went away. Its lanes are stopped (which closes provider
   * sessions and releases nothing), its bindings are dropped, and the kernel
   * keeps the lane's proposals/receipts: the worker continues either way.
   */
  async detachClient(clientId: string): Promise<void> {
    for (const [laneId, binding] of [...this.bindings]) {
      if (binding.clientId !== clientId) continue;
      this.bindings.delete(laneId);
      try {
        await this.serviceValue.stop(laneId, 'client_disconnect');
      } catch {
        /* a stop failure must never mask the disconnect */
      }
      this.evidence({ event: 'lane_detached', laneId, clientId, atMs: this.now() });
    }
  }

  /** Close every provider session and release resources. Kernel state stays owned by the kernel. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    await this.serviceValue.dispose();
  }

  // ── Lane registry ─────────────────────────────────────────────────────────

  private registerLane(
    laneId: string,
    attachmentGeneration: number,
    workerSessionId: string,
    runtime: VoiceRuntime
  ): VoiceErrorCode | null {
    const existing = this.lanes.get(laneId);
    if (!existing && this.lanes.size >= MAX_VOICE_LANES) {
      // Bounded lane table: an authenticated client cannot grow it without
      // limit. The refusal is surfaced, never silent (N9).
      this.evidence({
        event: 'lane_capacity_refused',
        laneId,
        lanes: this.lanes.size,
        atMs: this.now(),
      });
      return 'voice_internal_error';
    }
    if (existing && existing.attachmentGeneration === attachmentGeneration) {
      existing.workerSessionId = workerSessionId;
      existing.runtime = runtime;
      return null;
    }
    if (existing) {
      // A generation bump is a worker switch: the old lane's live proposal is
      // dropped by the kernel and reported as replaced (contract §4.2: a
      // proposal survives a stop only while the kernel keeps it).
      const live = this.kernel.proposals.live(laneId);
      if (live) {
        this.kernel.proposals.cancel(live.id);
        this.metrics.recordVoiceProposalReconciled();
        this.sendToLane(laneId, {
          type: 'proposal_resolved',
          version: 1,
          laneId,
          attachmentGeneration: existing.attachmentGeneration,
          proposalId: live.id,
          outcome: 'replaced',
        });
        this.evidence({
          event: 'proposal_resolved',
          laneId,
          proposalId: live.id,
          outcome: 'replaced',
          reason: 'worker_switch_generation_bump',
          atMs: this.now(),
        });
      }
    }
    this.lanes.set(laneId, {
      laneId,
      attachmentGeneration,
      workerSessionId,
      runtime,
      // A new attachment attempts the configured engine again; the cascade is
      // only sticky within one attachment generation.
      engine: this.engine,
      fallbackReason: null,
      lastCascadeRefusalAtMs: null,
      suppressedCascadeRefusals: 0,
      utteranceSeq: 0,
      presentations: new Map(),
      spokenConfirmKeys: new Map(),
    });
    return null;
  }

  // ── Phase 8: cascade mode and live-engine fallback ───────────────────────

  /** Tell the client honestly that the live engine is disabled by configuration. */
  private announceConfiguredCascade(lane: LaneRecord): void {
    const detail = configuredCascadeDetail();
    this.evidence({
      event: 'engine_configured_cascade',
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      engine: 'cascade',
      atMs: this.now(),
    });
    this.sendToLane(lane.laneId, this.cascadeStateFrame(lane, detail));
    this.sendToLane(lane.laneId, {
      type: 'voice_error',
      version: 1,
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      code: 'voice_provider_unavailable',
      message: detail,
      fatal: true,
    });
  }

  private cascadeStateFrame(lane: LaneRecord, detail: string): VoiceServerMessage {
    return {
      type: 'voice_state',
      version: 1,
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      state: 'error',
      detail,
    };
  }

  /**
   * Bounded refusal for a bridge-owned frame arriving on a cascade lane: one
   * surfaced `voice_error` per lane per second, with the suppressed count
   * riding the next one (the contract's §5.3 bounded-surfacing rule). Returns
   * null so the transport adds no second frame.
   */
  private refuseCascadeFrame(lane: LaneRecord, frameType: string): null {
    const now = this.now();
    const last = lane.lastCascadeRefusalAtMs;
    if (last !== null && now - last < CASCADE_REFUSAL_SURFACE_INTERVAL_MS) {
      lane.suppressedCascadeRefusals += 1;
      return null;
    }
    lane.lastCascadeRefusalAtMs = now;
    const suppressed = lane.suppressedCascadeRefusals;
    lane.suppressedCascadeRefusals = 0;
    const detail = `the live engine is not active for this lane; ${CASCADE_SERVING_DETAIL}`;
    this.sendToLane(lane.laneId, {
      type: 'voice_error',
      version: 1,
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      code: 'voice_not_started',
      message: suppressed > 0 ? `${detail} (${suppressed} similar voice frames suppressed)` : detail,
      fatal: false,
    });
    this.evidence({
      event: 'cascade_frame_refused',
      laneId: lane.laneId,
      frameType,
      suppressed,
      atMs: now,
    });
    return null;
  }

  /**
   * The live engine cannot continue for this lane (connect failure,
   * unrecoverable drop, quota exhaustion): the Gemma cascade takes the lane's
   * conversation over. Kernel state — active drafts and parked items — is
   * untouched; only the serving engine changes. The wire announcement is
   * emitted by {@link onBridgeEvent} for the fatal error and its state event.
   */
  private engageCascadeFallback(lane: LaneRecord, code: VoiceErrorCode, reason: string): void {
    if (lane.engine === 'cascade') return;
    lane.engine = 'cascade';
    lane.fallbackReason = `${code}: ${reason}`;
    lane.lastCascadeRefusalAtMs = null;
    lane.suppressedCascadeRefusals = 0;
    this.metrics.recordVoiceEngineFallback();
    this.evidence({
      event: 'engine_fallback',
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      workerSessionId: lane.workerSessionId,
      code,
      reason,
      engine: 'cascade',
      atMs: this.now(),
    });
    if (!this.cascade) return;
    try {
      this.cascade.noteEngineFallback({
        laneId: lane.laneId,
        workerSessionId: lane.workerSessionId,
        runtime: lane.runtime,
        reason: lane.fallbackReason,
        atMs: this.now(),
      });
    } catch (error) {
      // A cascade hand-off that cannot be recorded must not break the lane or
      // the announcement; it is surfaced as evidence and the fallback stands.
      this.evidence({
        event: 'engine_fallback_notify_failed',
        laneId: lane.laneId,
        message: error instanceof Error ? error.message : String(error),
        atMs: this.now(),
      });
    }
  }

  /** Resolve a frame's lane + generation against the lanes this mount accepted. */
  private resolveLane(message: VoiceClientMessage): LaneResolution {
    const lane = this.lanes.get(message.laneId);
    if (!lane) return { ok: false, code: 'voice_lane_unknown' };
    if (lane.attachmentGeneration !== message.attachmentGeneration) {
      return { ok: false, code: 'voice_generation_stale' };
    }
    return { ok: true, lane };
  }

  // ── The kernel delegate (kernel-owned client frames, contract §6.4) ────────

  private createKernelDelegate(): VoiceKernelDelegate {
    return {
      handle: async (context, message) => {
        const resolved = this.resolveLane(message);
        if (!resolved.ok) return resolved.code;
        const lane = resolved.lane;
        switch (message.type) {
          case 'proposal_presentation':
            return this.handlePresentation(lane, message);
          case 'proposal_confirm':
            return this.confirmAndDeliver(lane, {
              proposalId: message.proposalId,
              variant: message.variant,
              idempotencyKey: message.idempotencyKey,
              ...(message.proposalRef !== undefined ? { proposalRef: message.proposalRef } : {}),
              source: 'frame',
            });
          case 'proposal_cancel':
            return this.handleCancel(lane, message.proposalId);
          case 'parking_promote':
            return this.handleParkingPromote(lane, message.itemId);
          case 'parking_list':
            this.sendParking(lane.laneId, 'listed');
            return null;
          default:
            // The router routes only kernel-owned frames here; a bridge-owned
            // frame arriving would be a wiring bug and is refused loudly.
            void context;
            return 'voice_internal_error';
        }
      },
    };
  }

  private handlePresentation(
    lane: LaneRecord,
    message: Extract<VoiceClientMessage, { type: 'proposal_presentation' }>
  ): VoiceErrorCode | null {
    const proposal = this.kernel.proposals.get(message.proposalId);
    if (!proposal || proposal.laneId !== lane.laneId) return 'voice_proposal_stale';
    if (proposal.status !== 'draft' && proposal.status !== 'presented') return 'voice_proposal_stale';
    // Record the read-back fact (narrowing only: false can refuse a later
    // confirmation; true authorises nothing).
    lane.presentations.set(message.proposalId, {
      completed: message.completed,
      presentedVariant: message.presentedVariant,
      ...(message.stoppedAtChar !== undefined ? { stoppedAtChar: message.stoppedAtChar } : {}),
    });
    if (message.completed) {
      // The kernel records what the card actually showed.
      this.kernel.proposals.present(message.proposalId, message.presentedVariant);
    }
    this.evidence({
      event: 'presentation_reported',
      laneId: lane.laneId,
      proposalId: message.proposalId,
      completed: message.completed,
      presentedVariant: message.presentedVariant,
      atMs: this.now(),
    });
    return null;
  }

  private handleCancel(lane: LaneRecord, proposalId: string): VoiceErrorCode | null {
    const proposal = this.kernel.proposals.get(proposalId);
    if (!proposal || proposal.laneId !== lane.laneId) return 'voice_proposal_stale';
    this.kernel.proposals.cancel(proposalId);
    this.metrics.recordVoiceProposalReconciled();
    this.sendResolved(lane.laneId, proposalId, 'cancelled');
    this.evidence({
      event: 'proposal_cancelled',
      laneId: lane.laneId,
      proposalId,
      atMs: this.now(),
    });
    return null;
  }

  private handleParkingPromote(lane: LaneRecord, itemId: string): VoiceErrorCode | null {
    const parked = this.kernel.parkingLot.list().find((entry) => entry.id === itemId);
    if (!parked) {
      this.evidence({
        event: 'parking_promote_refused',
        laneId: lane.laneId,
        itemId,
        reason: 'parked_item_not_found',
        atMs: this.now(),
      });
      return 'voice_internal_error';
    }
    try {
      const proposal = this.kernel.promote({
        route: 'parked_item_promotion',
        laneId: lane.laneId,
        parkedItemId: itemId,
        sourceUtteranceId: parked.sourceUtteranceId,
        createdTurn: lane.utteranceSeq,
      });
      this.announceProposal(lane, proposal, { sourceItemId: itemId });
      this.sendParking(lane.laneId, 'promoted');
      return null;
    } catch (error) {
      this.evidence({
        event: 'parking_promote_refused',
        laneId: lane.laneId,
        itemId,
        message: error instanceof Error ? error.message : String(error),
        atMs: this.now(),
      });
      return 'voice_internal_error';
    }
  }

  // ── The release path (the ONLY caller of the delivery adapter) ─────────────

  private async confirmAndDeliver(
    lane: LaneRecord,
    request: {
      proposalId: string;
      variant: VoiceProposalVariant;
      idempotencyKey: string;
      proposalRef?: { version: number; sha256: string };
      source: 'frame' | 'speech';
    }
  ): Promise<VoiceErrorCode | null> {
    const proposal = this.kernel.proposals.get(request.proposalId);
    if (!proposal || proposal.laneId !== lane.laneId) {
      this.metrics.recordVoiceProposalRefused();
      this.evidence({
        event: 'confirm_refused',
        source: request.source,
        laneId: lane.laneId,
        proposalId: request.proposalId,
        code: 'voice_confirm_requires_proposal',
        atMs: this.now(),
      });
      return 'voice_confirm_requires_proposal';
    }
    // The card-identity echo, when the confirming gesture carries one, must
    // still describe the bytes on the card.
    if (
      request.proposalRef &&
      (request.proposalRef.version !== proposal.version || request.proposalRef.sha256 !== proposal.sha256)
    ) {
      this.metrics.recordVoiceProposalRefused();
      this.evidence({
        event: 'confirm_refused',
        source: request.source,
        laneId: lane.laneId,
        proposalId: request.proposalId,
        code: 'voice_proposal_stale',
        reason: 'identity_echo_mismatch',
        atMs: this.now(),
      });
      return 'voice_proposal_stale';
    }
    // The read-back gate (contract §4.6): an incomplete read-back only ever
    // narrows.
    const presentation = lane.presentations.get(request.proposalId);
    if (presentation && presentation.completed === false) {
      this.metrics.recordVoiceProposalRefused();
      this.evidence({
        event: 'confirm_refused',
        source: request.source,
        laneId: lane.laneId,
        proposalId: request.proposalId,
        code: 'voice_presentation_incomplete',
        atMs: this.now(),
      });
      return 'voice_presentation_incomplete';
    }

    const identity = request.proposalRef ?? { version: proposal.version, sha256: proposal.sha256 };
    const result = this.kernel.confirm({
      proposalId: request.proposalId,
      identity,
      idempotencyKey: request.idempotencyKey,
      variant: request.variant,
    });
    if (result.kind === 'duplicate_refusal') {
      this.metrics.recordVoiceProposalRefused();
      this.evidence({
        event: 'confirm_refused',
        source: request.source,
        laneId: lane.laneId,
        proposalId: request.proposalId,
        code: 'voice_proposal_stale',
        reason: 'duplicate_release',
        priorReceiptAtMs: result.prior?.receiptTimestamp ?? null,
        atMs: this.now(),
      });
      return 'voice_proposal_stale';
    }
    if (result.kind === 'refused') {
      const code = refusalCode(result.reason);
      this.metrics.recordVoiceProposalRefused();
      this.evidence({
        event: 'confirm_refused',
        source: request.source,
        laneId: lane.laneId,
        proposalId: request.proposalId,
        code,
        reason: result.reason,
        atMs: this.now(),
      });
      return code;
    }

    const authorised = result.proposal;
    this.metrics.recordVoiceProposalReleased();
    const bytes = request.variant === 'original' ? authorised.original : authorised.tidied;
    // THE GATE-LEAK PROOF: the delivery line carries the proposal id and the
    // SHA of the exact bytes, and it can only be written after an authorised
    // confirmation. A delivery without a matching preceding authorisation line
    // fails the run's audit.
    this.evidence({
      event: 'confirm_authorised',
      source: request.source,
      laneId: lane.laneId,
      proposalId: authorised.id,
      sha256: authorised.sha256,
      variant: request.variant,
      idempotencyKey: request.idempotencyKey,
      bytes,
      atMs: this.now(),
    });
    this.sendResolved(lane.laneId, authorised.id, 'released', request.idempotencyKey);
    this.evidence({
      event: 'delivery_attempt',
      laneId: lane.laneId,
      proposalId: authorised.id,
      sha256: authorised.sha256,
      idempotencyKey: request.idempotencyKey,
      bytes,
      atMs: this.now(),
    });

    let outcome: DeliveryOutcome;
    try {
      outcome = await this.delivery.deliver({ workerSessionId: lane.workerSessionId, text: bytes });
    } catch (error) {
      outcome = { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) };
    }

    let releaseRecorded = false;
    try {
      this.kernel.recordDelivery({
        proposalId: authorised.id,
        idempotencyKey: request.idempotencyKey,
        outcome: toReleaseOutcome(outcome),
      });
      releaseRecorded = true;
    } catch (error) {
      // A receipt that cannot be appended is a refusal of the record, not a
      // second delivery; it is surfaced loudly.
      this.evidence({
        event: 'receipt_record_failed',
        laneId: lane.laneId,
        proposalId: authorised.id,
        idempotencyKey: request.idempotencyKey,
        message: error instanceof Error ? error.message : String(error),
        atMs: this.now(),
      });
    }

    const receipt = this.buildReceipt(authorised.id, request.idempotencyKey, outcome);
    this.evidence({
      event: 'delivery_receipt',
      laneId: lane.laneId,
      proposalId: authorised.id,
      idempotencyKey: request.idempotencyKey,
      sha256: authorised.sha256,
      outcome: receipt.outcome,
      mechanism: receipt.mechanism ?? null,
      releaseRecorded,
      atMs: receipt.atMs,
    });
    this.sendToLane(lane.laneId, {
      type: 'receipt_event',
      version: 1,
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      receipt,
    });
    return null;
  }

  private buildReceipt(
    proposalId: string,
    idempotencyKey: string,
    outcome: DeliveryOutcome
  ): VoiceReceipt {
    const atMs = this.now();
    if (outcome.outcome === 'delivered') {
      return {
        releaseId: idempotencyKey,
        proposalId,
        idempotencyKey,
        outcome: 'delivered',
        mechanism: outcome.mechanism,
        ...(outcome.disclosure !== undefined ? { disclosure: outcome.disclosure } : {}),
        atMs,
      };
    }
    if (outcome.outcome === 'queued') {
      return {
        releaseId: idempotencyKey,
        proposalId,
        idempotencyKey,
        outcome: 'queued',
        mechanism: 'follow_up',
        disclosure: outcome.disclosure,
        atMs,
      };
    }
    return {
      releaseId: idempotencyKey,
      proposalId,
      idempotencyKey,
      outcome: 'refused',
      reason: outcome.reason,
      atMs,
    };
  }

  // ── Server → client helpers ────────────────────────────────────────────────

  private sendResolved(
    laneId: string,
    proposalId: string,
    outcome: VoiceProposalResolution,
    releaseId?: string
  ): void {
    this.sendToLane(laneId, {
      type: 'proposal_resolved',
      version: 1,
      laneId,
      attachmentGeneration: this.lanes.get(laneId)?.attachmentGeneration ?? 0,
      proposalId,
      outcome,
      ...(releaseId !== undefined ? { releaseId } : {}),
    });
  }

  private sendParking(laneId: string, operation: 'added' | 'promoted' | 'listed'): void {
    this.sendToLane(laneId, {
      type: 'parking_updated',
      version: 1,
      laneId,
      attachmentGeneration: this.lanes.get(laneId)?.attachmentGeneration ?? 0,
      operation,
      items: this.kernel.parkingLot.list().map(asWireParkedItem),
    });
  }

  private announceProposal(lane: LaneRecord, proposal: Proposal, extra?: { sourceItemId?: string }): void {
    this.metrics.recordVoiceProposalCreated();
    const promotionRoute =
      proposal.promotionRoute === 'direct_address'
        ? 'directed'
        : proposal.promotionRoute === 'accepted_offer'
          ? 'accepted_offer'
          : 'parked_item';
    const payload: VoiceCreatedProposal = {
      proposalId: proposal.id,
      version: proposal.version,
      sha256: proposal.sha256,
      promotionRoute,
      ...(extra?.sourceItemId !== undefined ? { sourceItemId: extra.sourceItemId } : {}),
      sourceUtteranceId: proposal.sourceUtteranceId,
      original: proposal.original,
      tidied: proposal.tidied,
      presentedVariant: 'tidied',
      presentation: { completed: false },
    };
    this.sendToLane(lane.laneId, {
      type: 'proposal_created',
      version: 1,
      laneId: lane.laneId,
      attachmentGeneration: lane.attachmentGeneration,
      proposal: payload,
    });
    this.evidence({
      event: 'proposal_created',
      laneId: lane.laneId,
      proposalId: proposal.id,
      version: proposal.version,
      sha256: proposal.sha256,
      promotionRoute,
      ...(extra?.sourceItemId !== undefined ? { sourceItemId: extra.sourceItemId } : {}),
      sourceUtteranceId: proposal.sourceUtteranceId,
      tidied: proposal.tidied,
      original: proposal.original,
      atMs: this.now(),
    });
  }

  private sendToLane(laneId: string, message: VoiceServerMessage): void {
    const binding = this.bindings.get(laneId);
    if (!binding) {
      this.evidence({
        event: 'lane_send_unbound',
        laneId,
        messageType: message.type,
        atMs: this.now(),
      });
      return;
    }
    try {
      binding.send(message);
    } catch (error) {
      this.evidence({
        event: 'lane_send_failed',
        laneId,
        messageType: message.type,
        message: error instanceof Error ? error.message : String(error),
        atMs: this.now(),
      });
    }
  }

  // ── The operator-speech adapter (bridge events) ────────────────────────────

  private async onBridgeEvent(event: VoiceBridgeEmittedEvent): Promise<void> {
    const lane = this.lanes.get(event.laneId);
    if (!lane || lane.attachmentGeneration !== event.attachmentGeneration) return;

    // Phase 8: a fatal provider error means the live engine cannot continue for
    // this lane (connect failure, unrecoverable drop, quota exhaustion). Engage
    // the cascade BEFORE the wire frames below are sent, so the error/state
    // frames the client receives carry the fallback announcement. Kernel state
    // — active drafts and parked items — is untouched: it lives in the kernel,
    // not in the provider session.
    if (event.kind === 'error' && event.fatal) {
      this.engageCascadeFallback(lane, event.code, event.message);
    }

    // 1. Relay the wire-visible half of the event (audio, transcripts, state,
    //    errors). `tool_call` deliberately has no wire form — it is how the
    //    kernel is driven, and the model has no send path.
    const wire = mapBridgeEventToServerMessage(event, this.serviceValue.getState(event.laneId));
    if (wire) {
      // The contract's voice_state/voice_error frames are the client's
      // announcement surface; once the lane has fallen back, the final frames
      // say which engine is serving it and why.
      if (lane.engine === 'cascade' && lane.fallbackReason !== null) {
        if (wire.type === 'voice_state' && wire.state === 'error') {
          wire.detail = fallbackDetail(lane);
        } else if (wire.type === 'voice_error' && wire.fatal) {
          wire.message = `${wire.message} — ${fallbackDetail(lane)}`;
        }
      }
      this.sendToLane(event.laneId, wire);
    }

    // 2. The operator-speech adapter consumes final operator transcripts.
    if (event.kind !== 'transcript' || event.speaker !== 'operator' || !event.final) return;
    const text = event.text.trim();
    if (!text) return;
    try {
      await this.handleOperatorUtterance(event.laneId, text, event.atMs);
    } catch (error) {
      this.evidence({
        event: 'operator_utterance_failed',
        laneId: event.laneId,
        message: error instanceof Error ? error.message : String(error),
        atMs: this.now(),
      });
    }
  }

  /**
   * The operator-speech adapter (bridge events). Wire-visible events are
   * relayed by {@link onBridgeEvent} before this runs; this method only
   * decides what the FINAL operator transcript mechanically means.
   */
  private async handleOperatorUtterance(laneId: string, text: string, atMs: number): Promise<void> {
    const lane = this.lanes.get(laneId);
    if (!lane) return;
    const utteranceId = (lane.utteranceSeq += 1);
    const utteranceClass = classifyOperatorUtterance(text);
    this.evidence({
      event: 'operator_utterance',
      laneId,
      utteranceId,
      utteranceClass,
      text,
      atMs,
    });

    if (utteranceClass === 'confirm') {
      const live = this.kernel.proposals.live(laneId);
      if (!live) {
        this.evidence({ event: 'spoken_confirm_no_proposal', laneId, utteranceId, atMs });
        return;
      }
      let idempotencyKey = lane.spokenConfirmKeys.get(live.id);
      if (!idempotencyKey) {
        idempotencyKey = `idem-speech-${laneId}-${live.id}-${live.version}`;
        lane.spokenConfirmKeys.set(live.id, idempotencyKey);
      }
      const code = await this.confirmAndDeliver(lane, {
        proposalId: live.id,
        variant: 'tidied',
        idempotencyKey,
        source: 'speech',
      });
      if (code !== null) {
        this.evidence({ event: 'spoken_confirm_refused', laneId, utteranceId, proposalId: live.id, code, atMs });
      }
      return;
    }

    if (utteranceClass === 'cancel') {
      const live = this.kernel.proposals.live(laneId);
      if (live) {
        this.kernel.proposals.cancel(live.id);
        this.metrics.recordVoiceProposalReconciled();
        this.sendResolved(laneId, live.id, 'cancelled');
        this.evidence({ event: 'proposal_cancelled', laneId, proposalId: live.id, reason: 'spoken_cancel', atMs });
      }
      return;
    }

    const relay = normaliseRelayText(text);
    if (!isDirectedWorkerInstruction(text, relay)) {
      // Conversational speech: the talker may answer it; nothing is held.
      return;
    }

    const busy = await this.isWorkerBusy(lane.workerSessionId).catch(() => false);
    if (busy) {
      // Flagged while the worker was busy: the parking lot holds it, and the
      // operator promotes it when the moment is right (S3).
      const item = this.kernel.ops.parkItem({ text: relay.text, sourceUtteranceId: utteranceId });
      this.sendParking(laneId, 'added');
      this.evidence({
        event: 'item_parked',
        laneId,
        utteranceId,
        itemId: item.id,
        text: item.text,
        original: text,
        workerBusy: true,
        atMs,
      });
      return;
    }

    const proposal = this.kernel.promote({
      route: 'direct_address',
      laneId,
      tidied: relay.text,
      ...(relay.changed ? { original: text } : {}),
      sourceUtteranceId: utteranceId,
      createdTurn: lane.utteranceSeq,
    });
    this.announceProposal(lane, proposal);
    this.evidence({
      event: 'promotion_authorised',
      laneId,
      utteranceId,
      proposalId: proposal.id,
      sha256: proposal.sha256,
      relayText: relay.text,
      relayRemovals: relay.removals,
      atMs,
    });
  }
}

// ── The default evidence sink (server log, one parseable line) ───────────────

export function createLogEvidenceSink(
  log: { info(message: string): void }
): (event: Record<string, unknown>) => void {
  return (event) => {
    log.info(`voice-kernel ${JSON.stringify(event)}`);
  };
}
