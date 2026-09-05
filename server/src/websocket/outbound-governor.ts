/**
 * OutboundGovernor — WS-path memory robustness (2026-09-05 plan, F2).
 *
 * Bounds per-client outbound memory on the browser WebSocket path. The
 * incident shape: a consumer that stops draining its socket while a turn is
 * streaming caused the server to retain every already-created serialised
 * frame in userland buffers until the V8 heap cap. `ws.send()` provides
 * `bufferedAmount` but no backpressure policy of its own.
 *
 * Policy (lossless until close):
 * - Healthy socket (bufferedAmount ≤ lowWater): send directly.
 * - Backpressured socket (bufferedAmount > softCap): COALESCABLE frames
 *   (session_event envelopes whose event is a `message_update`) are queued
 *   FIFO per client instead of written; everything else — control, terminal,
 *   tool, goal events — is still written immediately (after flushing any
 *   queued older frames, preserving order).
 * - A later send or an explicit flushPending() drains the queue once the
 *   socket recovers below low water.
 * - Bounds: bufferedAmount > hardCap, or the pending queue itself exceeding
 *   pendingMaxBytes, closes that one client with 1013 ("try again later").
 *   The browser reconnects automatically and re-syncs from history; the agent
 *   turn never depends on observer delivery.
 */

export interface GovernedSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface OutboundSendContext {
  /** True only for replaceable streaming updates — never for control/terminal frames. */
  coalescable: boolean;
  clientId?: string;
  onSlowClientClosed?: (clientId: string | undefined, reason: string) => void;
}

export interface OutboundGovernorOptions {
  softCapBytes?: number;
  hardCapBytes?: number;
  pendingMaxBytes?: number;
  lowWaterBytes?: number;
  /** Default slow-consumer callback; a per-send context callback takes precedence. */
  onSlowClientClosed?: (clientId: string | undefined, reason: string) => void;
}

interface PendingState {
  queue: string[];
  queuedBytes: number;
  closed: boolean;
}

const DEFAULT_SOFT_CAP_BYTES = 4 * 1024 * 1024;
const DEFAULT_HARD_CAP_BYTES = 16 * 1024 * 1024;
const DEFAULT_PENDING_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_LOW_WATER_BYTES = 256 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

/**
 * WS-path memory robustness (shed mode): reduce a browser message_update
 * envelope to ids-only while the shared shed monitor (event-loop lag OR heap
 * pressure) is armed — the browser twin of the broker's shedMessageUpdate.
 * Terminal/tool/control frames are never passed here.
 */
export function shedBrowserMessageUpdate<T extends { type?: unknown; sessionId?: unknown; event?: { type?: unknown; message?: { id?: unknown } | null } }>(envelope: T): T {
  const id = envelope.event?.message?.id;
  return {
    ...envelope,
    event: {
      type: 'message_update',
      message: id === undefined ? {} : { id },
      payloadShed: true,
    },
  } as T;
}

export class OutboundGovernor {
  private readonly states = new WeakMap<GovernedSocket, PendingState>();
  private readonly softCapBytes: number;
  private readonly hardCapBytes: number;
  private readonly pendingMaxBytes: number;
  private readonly lowWaterBytes: number;
  private readonly onSlowClientClosed?: (clientId: string | undefined, reason: string) => void;

  constructor(options: OutboundGovernorOptions = {}) {
    this.softCapBytes = Math.max(0, options.softCapBytes ?? DEFAULT_SOFT_CAP_BYTES);
    this.hardCapBytes = Math.max(1, options.hardCapBytes ?? DEFAULT_HARD_CAP_BYTES);
    this.pendingMaxBytes = Math.max(1, options.pendingMaxBytes ?? DEFAULT_PENDING_MAX_BYTES);
    this.lowWaterBytes = Math.max(0, options.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES);
    this.onSlowClientClosed = options.onSlowClientClosed;
  }

  /** Queued-frame count for a socket (observability/tests). */
  pendingFrames(ws: GovernedSocket): number {
    return this.states.get(ws)?.queue.length ?? 0;
  }

  /** Queued bytes for a socket (observability/tests). */
  pendingBytes(ws: GovernedSocket): number {
    return this.states.get(ws)?.queuedBytes ?? 0;
  }

  /** Drain a pending queue once the socket has recovered below low water. */
  flushPending(ws: GovernedSocket): void {
    const state = this.states.get(ws);
    if (!state || state.closed || state.queue.length === 0) return;
    if (ws.readyState !== 1 /* WebSocket.OPEN */ || ws.bufferedAmount > this.lowWaterBytes) return;
    this.drain(ws, state);
  }

  /**
   * Deliver one already-serialised frame under the bounded-send policy.
   * Returns what happened: sent directly, queued for later flush, or the
   * client was closed as a stuck consumer.
   */
  send(ws: GovernedSocket, serialized: string, context: OutboundSendContext): 'sent' | 'queued' | 'closed' {
    let state = this.states.get(ws);
    if (!state) {
      state = { queue: [], queuedBytes: 0, closed: false };
      this.states.set(ws, state);
    }
    if (state.closed || ws.readyState !== 1 /* WebSocket.OPEN */) return 'closed';

    const buffered = ws.bufferedAmount;
    if (buffered > this.hardCapBytes) {
      return this.closeSlow(ws, state, context, `slow consumer closed: bufferedAmount=${buffered} exceeds hard cap ${this.hardCapBytes}`);
    }

    if (context.coalescable && buffered > this.softCapBytes) {
      state.queue.push(serialized);
      state.queuedBytes += byteLength(serialized);
      if (state.queuedBytes > this.pendingMaxBytes) {
        return this.closeSlow(ws, state, context, `slow consumer closed: pending queue ${state.queuedBytes} exceeds cap ${this.pendingMaxBytes}`);
      }
      return 'queued';
    }

    // Deliver now. If older frames are queued, flush them first so this
    // consumer observes strict ordering (the queue only holds streaming
    // updates, which are semantically earlier than this frame).
    if (state.queue.length > 0) this.drain(ws, state);
    ws.send(serialized);
    return 'sent';
  }

  private drain(ws: GovernedSocket, state: PendingState): void {
    for (const frame of state.queue) ws.send(frame);
    state.queue = [];
    state.queuedBytes = 0;
  }

  private closeSlow(
    ws: GovernedSocket,
    state: PendingState,
    context: OutboundSendContext,
    reason: string,
  ): 'closed' {
    state.closed = true;
    state.queue = [];
    state.queuedBytes = 0;
    try {
      ws.close(1013, reason.slice(0, 120));
    } catch {
      // A socket that rejects close() is dead anyway; nothing else to do.
    }
    try {
      (context.onSlowClientClosed ?? this.onSlowClientClosed)?.(context.clientId, reason);
    } catch {
      // Callback failures must never affect delivery semantics.
    }
    return 'closed';
  }
}
