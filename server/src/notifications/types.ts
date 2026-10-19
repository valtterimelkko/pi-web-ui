/**
 * Notification Layer — stable contract.
 *
 * Pure types only: no runtime-service imports, no persistence, no transport.
 * This is the boundary every other notifications module (store, manager,
 * channels, routes) programs against. See docs/NOTIFICATIONS.md.
 */

/** The normalized runtimes Pi Web UI unifies into one event stream. */
export type NotificationRuntime = 'pi' | 'claude' | 'opencode' | 'antigravity' | 'commandcode';

/**
 * Acceptance limits for notification actions (contract CHANNEL.md §7; also
 * advertised on /capabilities as features.notificationActions). Single source
 * of truth for the route validation and the capability advertisement.
 */
export const NOTIFICATION_ACTION_LIMITS = {
  maxActions: 3,
  actionIdMaxLength: 32,
  actionLabelMaxLength: 32,
  actionRefMaxLength: 64,
} as const;

/** How a notification was produced. `agent_end` = the agent yielded control. */
export type NotificationKind = 'agent_end' | 'explicit';

/** A persisted per-session opt-in. Independent of pinning (see plan §1.7). */
export interface OptInRecord {
  sessionId: string;
  runtime: NotificationRuntime;
  sessionPath: string;
  optedInAt: string; // ISO timestamp
  /** Operator-friendly name surfaced in the message header. */
  label?: string;
  /** Surface that owns this opt-in; browser-contained sessions are never internal. */
  access?: 'internal' | 'browser';
}

/**
 * One tappable action on a notification (contract CHANNEL.md §7): rendered as
 * an inline-keyboard button; the owner's tap runs the notification's registered
 * handler once with the action id.
 */
export interface NotificationAction {
  /** Stable action id (`[A-Za-z0-9_-]{1,32}`); echoed to the handler as {action}. */
  id: string;
  /** Button label, ≤ 32 characters. */
  label: string;
}

/**
 * The recorded outcome of the owner's tap (first tap wins): the action id,
 * when it was applied, and the handler's result line (its JSON `message`, or
 * `Could not apply: <first stderr line>`).
 */
export interface NotificationActionTaken {
  action: string;
  at: string; // ISO timestamp
  result: string;
}

/** A single, already-formatted (Telegram-ready) notification. */
export interface Notification {
  /** Stable server id. Retries reuse it for at-least-once delivery accounting. */
  id: string;
  /** Absent for purely-explicit notifications (POST /api/v1/notifications). */
  sessionId?: string;
  runtime?: NotificationRuntime;
  kind: NotificationKind;
  title: string;
  /** Already-truncated body (<= channel limit). */
  body: string;
  /** Deep link back into the session in the web UI. */
  deepLink?: string;
  /** 1–3 tappable actions (explicit notifications only; all-or-none with actionHandler/actionRef). */
  actions?: NotificationAction[];
  /** Registered handler name (never a caller-chosen command); see action-handlers.ts. */
  actionHandler?: string;
  /** Opaque reference passed to the handler as {ref} (`[A-Za-z0-9_-]{1,64}`). */
  actionRef?: string;
  createdAt: string; // ISO timestamp
}

/** Delivery channels. Telegram first; the seam allows more later. */
export type DeliveryChannel = 'telegram';

/** Lifecycle of a queued send. */
export type DeliveryStatus = 'pending' | 'sent' | 'failed';

/** Per-delivery accounting record, durable across restarts. */
export interface DeliveryRecord {
  notificationId: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  attempts: number;
  lastError?: string;
  firstQueuedAt: string; // ISO timestamp
  deliveredAt?: string; // ISO timestamp (set on success)
}

/**
 * A notification paired with its delivery state — the atomic unit stored in
 * the outbox (while pending) and the delivery log (once terminal).
 */
export interface NotificationIngressIdentity {
  /** SHA-256 of the caller's Idempotency-Key; the raw key is never persisted. */
  keyHash: string;
  /** SHA-256 of the normalized explicit-notification payload. */
  fingerprint: string;
}

export interface QueuedNotification {
  notification: Notification;
  delivery: DeliveryRecord;
  /** Present only for idempotent explicit-notification submissions. */
  ingress?: NotificationIngressIdentity;
  /** The owner's action on a notification that carried actions (first tap wins). */
  actionTaken?: NotificationActionTaken;
}

/**
 * Channel adapter seam. New channels implement this; the router fans a
 * Notification out to all configured channels. `send` throws on failure so the
 * outbox can retry.
 */
export interface NotificationChannel {
  readonly id: DeliveryChannel;
  /** False when credentials/config are missing (channel is then skipped). */
  isConfigured(): boolean;
  send(n: Notification): Promise<void>;
}
