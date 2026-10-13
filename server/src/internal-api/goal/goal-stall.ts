/**
 * Contract 1.62.0 (PARENT-ORCHESTRATION-MACHINERY-PLAN W2-b) — stalled goals.
 *
 * A goal child read `running` for 26–46 minutes while its session sat idle and
 * no watch fired (F3). This monitor tracks goals observed `running` and, once
 * the session has shown no activity for `GOAL_STALL_MINUTES`, publishes ONE
 * `goal_state` carrying top-level `stalled: true` + `stalledForMs` (watch
 * `dataMatch` is shallow) — the status stays `running`, no new status value.
 * Re-armed when the session is active again.
 *
 * Activity = any broker event for the goal's key (fed through `observe`), or a
 * sweep sampling the session busy. The sweep is a cheap in-memory pass over the
 * tracked running goals; the (async) re-read of the projection happens only for
 * goals that have crossed the threshold.
 */
import type { SessionGoalProjection } from './types.js';

export interface GoalStallConfig {
  thresholdMs: number;
  sweepIntervalMs: number;
}

const DEFAULT_STALL_MINUTES = 10;
const MIN_STALL_MINUTES = 2;

/** `GOAL_STALL_MINUTES` (default 10; never below 2). */
export function loadGoalStallConfig(env: Record<string, string | undefined> = process.env): GoalStallConfig {
  const parsed = Number.parseFloat(env.GOAL_STALL_MINUTES ?? '');
  const minutes = Number.isFinite(parsed) ? Math.max(MIN_STALL_MINUTES, parsed) : DEFAULT_STALL_MINUTES;
  const thresholdMs = minutes * 60_000;
  return { thresholdMs, sweepIntervalMs: Math.max(5_000, Math.min(30_000, Math.floor(thresholdMs / 4))) };
}

export interface GoalStallResolution {
  busy: boolean;
  projection: SessionGoalProjection | null;
}

export interface GoalStallMonitorDeps {
  config: GoalStallConfig;
  now?: () => number;
  /** Current busy truth + goal projection for a broker key; throw/null = skip this tick. */
  resolve: (key: string) => Promise<GoalStallResolution | null>;
  publish: (key: string, event: { type: string; timestamp: number; data: unknown }) => void;
}

export interface GoalStallMonitor {
  /** Feed every broker event (key, event type, event data). Cheap and synchronous. */
  observe(key: string, eventType: string, data: unknown): void;
  sweepOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

interface Tracked {
  lastActivityAt: number;
  stalledEmitted: boolean;
}

export function createGoalStallMonitor(deps: GoalStallMonitorDeps): GoalStallMonitor {
  const now = deps.now ?? Date.now;
  const tracked = new Map<string, Tracked>();
  let timer: NodeJS.Timeout | undefined;

  const monitor: GoalStallMonitor = {
    observe(key, eventType, data) {
      if (eventType === 'goal_state' || eventType === 'goal_end') {
        const d = (data ?? {}) as { status?: unknown; stalled?: unknown };
        if (d.stalled === true) return; // our own stall event is not activity
        if (eventType === 'goal_state' && d.status === 'running') {
          tracked.set(key, { lastActivityAt: now(), stalledEmitted: false });
        } else {
          tracked.delete(key);
        }
        return;
      }
      const entry = tracked.get(key);
      if (entry) {
        entry.lastActivityAt = now();
        entry.stalledEmitted = false;
      }
    },

    async sweepOnce() {
      for (const key of [...tracked.keys()]) {
        try {
          const before = tracked.get(key);
          if (!before) continue;
          // Cheap in-memory gate: only goals past the threshold (or already in
          // a stall episode, to detect re-arming) cost a re-read.
          if (!before.stalledEmitted && now() - before.lastActivityAt < deps.config.thresholdMs) continue;
          const resolved = await deps.resolve(key);
          if (!resolved) continue;
          if (!resolved.projection || resolved.projection.status !== 'running') {
            tracked.delete(key);
            continue;
          }
          const current = tracked.get(key);
          if (!current) continue;
          if (resolved.busy) {
            current.lastActivityAt = now();
            current.stalledEmitted = false;
            continue;
          }
          const idleMs = now() - current.lastActivityAt;
          if (current.stalledEmitted || idleMs < deps.config.thresholdMs) continue;
          current.stalledEmitted = true;
          deps.publish(key, {
            type: 'goal_state',
            timestamp: now(),
            data: { ...resolved.projection, stalled: true, stalledForMs: idleMs },
          });
        } catch {
          /* per-session isolation: one bad session cannot stop the sweep */
        }
      }
    },

    start() {
      if (timer) return;
      timer = setInterval(() => { void monitor.sweepOnce(); }, deps.config.sweepIntervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return monitor;
}
