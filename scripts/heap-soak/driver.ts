/**
 * Load driver: production-like waves of Pi children across model lanes.
 *
 * Owner amendment (2026-09-26), implemented here:
 *  - Lane A (`zai/glm-5.3-flash`) is the backbone. The load target is a count
 *    of completed children per wave; whenever B/C fail, time out, or open
 *    their circuit, the backbone tops the wave up to the target. ONLY the
 *    backbone failing counts as the "all lanes down" anomaly.
 *  - Every child has a hard per-turn deadline; a child not done in time is
 *    aborted (best-effort delete) and counted as a lane timeout, never held
 *    open. Wave boundaries are time-based — the wave loop stops dispatching
 *    new attempts at its deadline regardless of any in-flight stragglers.
 *  - Each non-backbone lane has a small concurrency cap so a slow/congested
 *    free model cannot pile up resident sessions.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import {
  createBreakerState,
  recordFailure,
  recordSuccess,
} from '../../server/src/live-validation/heap-soak/circuit-breaker.js';
import { backboneLane as pickBackbone, pickLane } from '../../server/src/live-validation/heap-soak/lanes.js';
import { computeTopUpCount, isBackboneDownAnomaly } from '../../server/src/live-validation/heap-soak/wave-target.js';
import type {
  CircuitBreakerState,
  LaneDefinition,
  LaneEvent,
  LaneName,
  WaveTargetConfig,
} from '../../server/src/live-validation/heap-soak/types.js';

export const HEAP_SOAK_SOURCE_TAG_PREFIX = 'heap-soak:';

export interface DriverOptions {
  client: InternalApiClient;
  runId: string;
  childWorkspaceRoot: string;
  lanes: LaneDefinition[];
  waveTargetConfig: WaveTargetConfig;
  logEvent: (event: LaneEvent) => void;
  runStartMs: number;
  /** Injectable for tests / deterministic lane selection; defaults to Math.random. */
  rng?: () => number;
}

export interface DriverState {
  breakers: Map<LaneName, CircuitBreakerState>;
}

export function createDriverState(lanes: LaneDefinition[]): DriverState {
  const breakers = new Map<LaneName, CircuitBreakerState>();
  for (const lane of lanes) breakers.set(lane.name, createBreakerState(lane.name));
  return { breakers };
}

const TOOL_PROMPT =
  'In this directory: create a file named note.txt containing the text "heap-soak", '
  + 'then list the directory contents, then append a second line "done" to note.txt, '
  + 'then run `wc -l note.txt`, then reply with exactly one line summarizing what you did.';
const FOLLOW_UP_PROMPT = 'In one short sentence, confirm the file still exists.';

export interface ChildResult {
  success: boolean;
  timedOut: boolean;
  sessionId?: string;
  reason?: string;
}

async function runChild(
  options: DriverOptions,
  lane: LaneDefinition,
  modelId: string,
): Promise<ChildResult> {
  const childId = randomUUID().slice(0, 8);
  const cwd = path.join(options.childWorkspaceRoot, `${lane.name}-${childId}`);
  mkdirSync(cwd, { recursive: true });
  const elapsed = () => Date.now() - options.runStartMs;
  let sessionId: string | undefined;
  try {
    const created = await options.client.createSession({
      runtime: 'pi',
      cwd,
      model: modelId,
      source: `${HEAP_SOAK_SOURCE_TAG_PREFIX}${options.runId}`,
    });
    sessionId = created.sessionId;
    options.logEvent({ ts: new Date().toISOString(), elapsedMs: elapsed(), lane: lane.name, kind: 'child_created', sessionId, detail: modelId });

    // Register a durable watch too, matching production orchestration usage —
    // best-effort; the tool-call check below is what actually decides success.
    try {
      await options.client.registerWatch(sessionId, {
        conditions: [{ type: 'tool' }],
        pin: false,
        label: `heap-soak-${options.runId}-${lane.name}`,
      });
    } catch { /* watch registration is not load-bearing for this harness */ }

    const events = await options.client.promptStream(sessionId, { message: TOOL_PROMPT, verbosity: 'full' });
    const sawToolCall = events.some((e) => e.type === 'tool_execution_start');
    if (!sawToolCall) {
      options.logEvent({ ts: new Date().toISOString(), elapsedMs: elapsed(), lane: lane.name, kind: 'child_failed', sessionId, detail: 'no tool_execution_start event observed' });
      return { success: false, timedOut: false, sessionId, reason: 'no-tool-call' };
    }
    options.logEvent({ ts: new Date().toISOString(), elapsedMs: elapsed(), lane: lane.name, kind: 'child_tool_call_seen', sessionId });

    await options.client.promptStream(sessionId, { message: FOLLOW_UP_PROMPT, verbosity: 'answers' });
    options.logEvent({ ts: new Date().toISOString(), elapsedMs: elapsed(), lane: lane.name, kind: 'child_prompted', sessionId });

    return { success: true, timedOut: false, sessionId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.logEvent({ ts: new Date().toISOString(), elapsedMs: elapsed(), lane: lane.name, kind: 'child_failed', sessionId, detail: reason.slice(0, 200) });
    return { success: false, timedOut: false, sessionId, reason };
  } finally {
    if (sessionId) {
      try {
        await options.client.deleteSession(sessionId);
        options.logEvent({ ts: new Date().toISOString(), elapsedMs: elapsed(), lane: lane.name, kind: 'child_deleted', sessionId });
      } catch { /* best-effort delete; the orphan sweep catches anything left behind */ }
    }
  }
}

/** Runs one child with a hard per-turn deadline. On timeout, the child's own cleanup still runs in the background. */
export async function runChildWithDeadline(
  options: DriverOptions,
  lane: LaneDefinition,
  modelId: string,
  deadlineMs: number,
): Promise<ChildResult> {
  let timedOut = false;
  const timeout = new Promise<ChildResult>((resolve) => {
    setTimeout(() => { timedOut = true; resolve({ success: false, timedOut: true, reason: 'deadline-exceeded' }); }, deadlineMs);
  });
  const result = await Promise.race([runChild(options, lane, modelId), timeout]);
  if (timedOut) {
    options.logEvent({ ts: new Date().toISOString(), elapsedMs: Date.now() - options.runStartMs, lane: lane.name, kind: 'child_timeout' });
  }
  return result;
}

export interface WaveResult {
  completedByLane: Partial<Record<LaneName, number>>;
  attemptedByLane: Partial<Record<LaneName, number>>;
  toppedUp: number;
  anomaly: boolean;
}

/**
 * Runs one time-boxed wave: dispatches children across available lanes
 * (weighted, breaker- and concurrency-cap-aware) until `waveMs` elapses, then
 * tops up the shortfall on the backbone lane so the wave's target is met.
 */
export async function runWave(
  options: DriverOptions,
  state: DriverState,
  waveMs: number,
): Promise<WaveResult> {
  const lanes = options.lanes;
  const backbone = pickBackbone(lanes);
  const inFlight = new Map<LaneName, Set<Promise<ChildResult>>>();
  const completedByLane: Partial<Record<LaneName, number>> = {};
  const attemptedByLane: Partial<Record<LaneName, number>> = {};

  const inFlightCount = (name: LaneName) => inFlight.get(name)?.size ?? 0;

  const dispatch = (lane: LaneDefinition) => {
    const modelId = lane.modelIds[0];
    attemptedByLane[lane.name] = (attemptedByLane[lane.name] ?? 0) + 1;
    const promise = runChildWithDeadline(options, lane, modelId, options.waveTargetConfig.childTurnDeadlineMs);
    const set = inFlight.get(lane.name) ?? new Set();
    set.add(promise);
    inFlight.set(lane.name, set);
    promise.then((result) => {
      set.delete(promise);
      const breaker = state.breakers.get(lane.name) ?? createBreakerState(lane.name);
      state.breakers.set(lane.name, result.success ? recordSuccess(breaker) : recordFailure(breaker, Date.now()));
      if (result.success) completedByLane[lane.name] = (completedByLane[lane.name] ?? 0) + 1;
    }).catch(() => { set.delete(promise); });
  };

  const waveEnd = Date.now() + waveMs;
  while (Date.now() < waveEnd) {
    const lane = pickLane(lanes, state.breakers, Date.now(), options.rng);
    if (lane && inFlightCount(lane.name) < lane.maxConcurrent) {
      dispatch(lane);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Time-boxed: do not await stragglers here. They resolve/settle in the
  // background via their own .then() handler above and their own deadline.

  const shortfall = computeTopUpCount({ completedByLane }, options.waveTargetConfig, backbone.name);
  let toppedUp = 0;
  for (let i = 0; i < shortfall; i++) {
    const result = await runChildWithDeadline(options, backbone, backbone.modelIds[0], options.waveTargetConfig.childTurnDeadlineMs);
    const breaker = state.breakers.get(backbone.name) ?? createBreakerState(backbone.name);
    state.breakers.set(backbone.name, result.success ? recordSuccess(breaker) : recordFailure(breaker, Date.now()));
    if (result.success) {
      completedByLane[backbone.name] = (completedByLane[backbone.name] ?? 0) + 1;
      toppedUp += 1;
      options.logEvent({ ts: new Date().toISOString(), elapsedMs: Date.now() - options.runStartMs, lane: backbone.name, kind: 'top_up', sessionId: result.sessionId });
    }
  }

  const anomaly = isBackboneDownAnomaly({ completedByLane }, options.waveTargetConfig, backbone.name);
  return { completedByLane, attemptedByLane, toppedUp, anomaly };
}
