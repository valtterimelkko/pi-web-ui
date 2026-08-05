import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  Phase7PiShadowClassification,
  Phase7PiShadowEvidence,
  Phase7PiShadowProfile,
  Phase7PiShadowReasonCode,
} from './types.js';

/** Frozen policy identity for the Phase 7 Pi/Internal API shadow gate. */
export const PHASE7_PI_SHADOW_POLICY_VERSION = 'phase7-pi-shadow/v1' as const;

/**
 * Deliberately conservative, payload-free thresholds. Duration is a separate
 * long-horizon signal; it must never be presented as proof of resource
 * pressure. No caller can override these values or select a profile.
 */
export const PHASE7_PI_SHADOW_THRESHOLDS = Object.freeze({
  promptBytes: 4_096,
  toolEventCount: 8,
  longTurnMs: 60_000,
});

const MAX_TOOL_EVENT_COUNT = 10_000;
const TOOL_SIGNAL = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck)|\b(?:pytest|vitest|jest|cargo\s+test|go\s+test|make|cmake|tsc|esbuild)\b/i;
const FORK_OR_MEMORY_SIGNAL = /\b(?:fork(?:[- ]bomb)?|child[_ -]?process|worker[_ -]?threads?|memory(?:[- ]pressure|[- ]bound)?|out[- ]of[- ]memory|oom|heap|pids?|process(?:[- ]fan[- ]out)?|stress(?:[- ]ng)?)\b/i;

export interface Phase7PiShadowInput {
  sessionId: string;
  message: string;
}

export interface Phase7PiShadowState {
  classification: Phase7PiShadowClassification;
  acceptedAtMs: number;
  toolEventCount: number;
}

/**
 * Classify an accepted Pi Internal API prompt without changing dispatch. The
 * prompt body is used only transiently to derive bounded reason codes and its
 * UTF-8 byte length; it is never included in the returned evidence.
 */
export function classifyPhase7PiShadow(input: Phase7PiShadowInput): Phase7PiShadowClassification {
  const promptBytes = Buffer.byteLength(input.message, 'utf8');
  const hasForkOrMemorySignal = FORK_OR_MEMORY_SIGNAL.test(input.message);
  const hasToolSignal = TOOL_SIGNAL.test(input.message);
  const reasonCodes: Phase7PiShadowReasonCode[] = [];

  if (hasForkOrMemorySignal) reasonCodes.push('message_fork_or_memory_signal');
  if (hasToolSignal) reasonCodes.push('message_tool_signal');
  if (promptBytes >= PHASE7_PI_SHADOW_THRESHOLDS.promptBytes) reasonCodes.push('prompt_size_threshold');
  if (reasonCodes.length === 0) reasonCodes.push('default_standard');

  const profile: Phase7PiShadowProfile = hasForkOrMemorySignal || hasToolSignal || promptBytes >= PHASE7_PI_SHADOW_THRESHOLDS.promptBytes
    ? 'heavy'
    : 'standard';

  return {
    policyVersion: PHASE7_PI_SHADOW_POLICY_VERSION,
    mode: 'shadow',
    profile,
    reasonCodes,
    affinity: {
      kind: 'session',
      sessionId: input.sessionId,
      ownership: 'server-owned',
    },
    resourceIdentity: {
      kind: 'shared-service',
      boundary: 'pi-control-process',
      ownership: 'server-owned',
      sessionScoped: false,
    },
    evidence: {
      promptBytes,
      toolEventCount: 0,
    },
  };
}

export function createPhase7PiShadowState(
  classification: Phase7PiShadowClassification,
  acceptedAtMs: number,
): Phase7PiShadowState {
  return {
    classification: structuredClone(classification),
    acceptedAtMs,
    toolEventCount: classification.evidence.toolEventCount,
  };
}

/** Record only a bounded count of attributable tool-start events. */
export function observePhase7PiShadowEvent(
  state: Phase7PiShadowState,
  event: Pick<NormalizedEvent, 'type' | 'sessionId'>,
  _observedAtMs: number,
): void {
  if (event.type !== 'tool_execution_start' || (
    event.sessionId !== undefined
    && event.sessionId !== state.classification.affinity.sessionId
  )) return;
  state.toolEventCount = Math.min(MAX_TOOL_EVENT_COUNT, state.toolEventCount + 1);
}

/**
 * Produce the final shadow projection at the terminal boundary. The existing
 * runtime path is untouched: this is evidence only, and the shared-service
 * resource identity remains explicit rather than being upgraded to a worker.
 */
export function finalizePhase7PiShadow(
  state: Phase7PiShadowState,
  terminalAtMs: number,
): Phase7PiShadowClassification {
  const durationMs = Math.max(0, terminalAtMs - state.acceptedAtMs);
  const initialReasons = state.classification.reasonCodes.filter((reason) => reason !== 'default_standard');
  const reasonCodes: Phase7PiShadowReasonCode[] = [...initialReasons];
  if (state.toolEventCount >= PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount && !reasonCodes.includes('tool_event_threshold')) {
    reasonCodes.push('tool_event_threshold');
  }
  if (durationMs >= PHASE7_PI_SHADOW_THRESHOLDS.longTurnMs && !reasonCodes.includes('turn_duration_threshold')) {
    reasonCodes.push('turn_duration_threshold');
  }
  if (reasonCodes.length === 0) reasonCodes.push('default_standard');

  const hasHeavySignal = state.classification.profile === 'heavy'
    || state.toolEventCount >= PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount;
  const profile: Phase7PiShadowProfile = hasHeavySignal
    ? 'heavy'
    : durationMs >= PHASE7_PI_SHADOW_THRESHOLDS.longTurnMs
      ? 'long-horizon'
      : 'standard';

  const evidence: Phase7PiShadowEvidence = {
    ...state.classification.evidence,
    toolEventCount: state.toolEventCount,
    ...(durationMs > 0 ? { durationMs } : {}),
  };

  return {
    ...structuredClone(state.classification),
    profile,
    reasonCodes,
    evidence,
  };
}
