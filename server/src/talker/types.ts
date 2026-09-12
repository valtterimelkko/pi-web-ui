/**
 * Shared types for the server-side voice talker harness (Drive Mode Two-Lane
 * plan, H1). See docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md §10.9 for the design
 * and the evidence behind every rule encoded here.
 *
 * Governing principle (plan §10.9): mechanical where a failure is a correctness
 * failure; instructed where a failure is a quality failure. The relay
 * authorisation gate is mechanical — the model has no code path to the worker.
 */

/** Raw worker state material, gathered by an observer outside this module. */
export interface WorkerStateSnapshot {
  /** Preformatted elapsed label, e.g. "14m". Providers may compute from startedAtEpochMs. */
  elapsedLabel?: string;
  startedAtEpochMs?: number;
  /** Current worker activity, one line. */
  activity?: string;
  /** Recent tool/activity events, newest last. Bounded by renderStateView. */
  recentEvents?: string[];
  /** Background children with statuses, preformatted. Bounded by renderStateView. */
  children?: string[];
  /** Pending items, preformatted. Bounded by renderStateView. */
  pendingItems?: string[];
  /** The worker's last assistant text. Clipped by renderStateView. */
  lastAssistantText?: string;
}

/**
 * Harness state injected into every projection. Built by the TalkerSession
 * from the pending-proposal store — never from model memory or history.
 */
export interface HarnessView {
  pendingUtterance: string | null;
  pendingAgeTurns: number | null;
  lastReleased: { text: string; outcome: string } | null;
}

export type DeliveryMechanism = 'steer' | 'prompt' | 'follow_up';

export type DeliveryOutcome =
  | { outcome: 'delivered'; mechanism: Exclude<DeliveryMechanism, 'follow_up'>; disclosure?: string }
  | { outcome: 'queued'; mechanism: 'follow_up'; disclosure: string }
  | { outcome: 'refused'; reason: string };

/** Seam the harness calls to hand a confirmed relay to the worker runtime. */
export interface WorkerDelivery {
  describe(): string;
  deliver(input: { workerSessionId: string; text: string }): Promise<DeliveryOutcome>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelTurnResult {
  text: string;
  ttftMs: number | null;
  totalMs: number;
}

/** Seam for the talker's side completion (the production shape: one direct model call). */
export interface TalkerModelClient {
  completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult>;
}

export type UtteranceClass = 'confirm' | 'cancel' | 'question' | 'statement';

export interface TurnLatency {
  ttftMs: number | null;
  totalMs: number;
}

export interface ReleasedInfo {
  utteranceId: number;
  text: string;
  delivery: DeliveryOutcome;
}

export interface TalkerTurnResult {
  /** What the operator hears this turn. */
  reply: string;
  utteranceClass: UtteranceClass;
  /** Non-null only on a confirmed release turn. */
  released: ReleasedInfo | null;
  /** True when the operator's utterance cancelled a pending proposal. */
  cancelled: boolean;
  modelCalled: boolean;
  latency: TurnLatency | null;
  error?: string;
}
