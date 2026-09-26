import type { CircuitBreakerState, LaneDefinition, LaneName } from './types.js';
import { isLaneAvailable } from './circuit-breaker.js';

/**
 * Model lanes for the load driver. Lane C (Command Code FREE models via a Pi
 * "commandcode" provider) is disabled: Pi's models.json has no `commandcode`
 * provider/API type today (confirmed by inspecting the live
 * ~/.pi/agent/models.json providers map, which has openai-codex, glm-coding,
 * kimi-subscription, zai, nvidia, github-copilot, clinepass, opencode-go,
 * openrouter — no commandcode key, and the Command Code runtime is a
 * standalone CLI binary launched by server/src/command-code/*, not an HTTP
 * endpoint Pi could proxy to via models.json alone). Making Pi speak to
 * Command Code's models would require server code changes, which are out of
 * scope for this harness; per the task's own instruction ("If lane C cannot
 * work cleanly, disable it and report why") lane C stays disabled and its
 * weight is redistributed to A and B, keeping their 0.6:0.25 ratio (≈0.706:0.294).
 */
export const LANE_DEFINITIONS: LaneDefinition[] = [
  {
    name: 'A',
    label: 'zai/glm-5.3-flash (low thinking) — BACKBONE',
    weight: 0.6,
    runtime: 'pi',
    modelIds: ['zai/glm-5.3-flash'],
    thinkingLevel: 'low',
    enabled: true,
    isBackbone: true,
    maxConcurrent: 8,
  },
  {
    name: 'B',
    label: 'OpenRouter free models (best-effort; congested — never load-bearing)',
    weight: 0.25,
    runtime: 'pi',
    modelIds: [
      'openrouter/poolside/laguna-s-2.1:free',
      'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      'openrouter/qwen/qwen3.8-27b:free',
    ],
    enabled: true,
    isBackbone: false,
    maxConcurrent: 2,
  },
  {
    name: 'C',
    label: 'Command Code FREE models via Pi commandcode provider (best-effort; congested — never load-bearing)',
    weight: 0.15,
    runtime: 'pi',
    modelIds: ['commandcode/poolside/laguna-s-2.1-free', 'commandcode/stealth/space-bunny-alpha', 'commandcode/inclusionai/ling-3.0-flash-sante:free'],
    enabled: false,
    isBackbone: false,
    maxConcurrent: 2,
    disabledReason:
      'Pi has no `commandcode` model provider (checked live ~/.pi/agent/models.json providers: '
      + 'openai-codex, glm-coding, kimi-subscription, zai, nvidia, github-copilot, clinepass, opencode-go, openrouter — '
      + 'no commandcode entry); Command Code is a separate standalone-CLI runtime family in this repo '
      + '(server/src/command-code/*), not an HTTP provider Pi can address via models.json without server code changes.',
  },
];

export const FORCE_BAD_LANE_ENV_KEY = 'HEAP_SOAK_FORCE_BAD_LANE';
const INVALID_MODEL_ID = 'invalid-provider/does-not-exist-model';

/**
 * Gate 1(b) test seam: force one or more non-backbone lanes to fail every
 * attempt (invalid model id) so their circuit breaker demonstrably opens
 * while the backbone lane keeps the wave on target. Reads a comma-separated
 * lane-name list from `env[FORCE_BAD_LANE_ENV_KEY]`; refuses to target the
 * backbone lane (that would defeat the harness's own safety net, not just
 * test it) and is a no-op when unset — never active outside an explicit
 * Gate 1 exercise.
 */
export function applyForcedBadLanes(lanes: readonly LaneDefinition[], env: NodeJS.ProcessEnv = process.env): LaneDefinition[] {
  const forced = new Set((env[FORCE_BAD_LANE_ENV_KEY] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (forced.size === 0) return [...lanes];
  return lanes.map((lane) => {
    if (!forced.has(lane.name)) return lane;
    if (lane.isBackbone) {
      throw new Error(`${FORCE_BAD_LANE_ENV_KEY} may not target the backbone lane (${lane.name}) — that would remove the harness's own safety net.`);
    }
    return { ...lane, modelIds: [INVALID_MODEL_ID] };
  });
}

export function backboneLane(lanes: readonly LaneDefinition[] = LANE_DEFINITIONS): LaneDefinition {
  const backbone = lanes.find((l) => l.isBackbone);
  if (!backbone) throw new Error('No backbone lane defined — the harness requires exactly one load-bearing lane.');
  return backbone;
}

export function enabledLanes(lanes: readonly LaneDefinition[]): LaneDefinition[] {
  return lanes.filter((l) => l.enabled);
}

/**
 * Weighted pick among lanes whose breaker is currently available, redistributing
 * the disabled/open lanes' weight proportionally across the rest. Deterministic
 * given `rng` (a 0..1 generator) so this is fully unit-testable.
 */
export function pickLane(
  lanes: readonly LaneDefinition[],
  breakers: ReadonlyMap<LaneName, CircuitBreakerState>,
  nowMs: number,
  rng: () => number = Math.random,
): LaneDefinition | undefined {
  const candidates = lanes.filter((lane) => {
    if (!lane.enabled) return false;
    const breaker = breakers.get(lane.name);
    return !breaker || isLaneAvailable(breaker, nowMs);
  });
  if (candidates.length === 0) return undefined;
  const totalWeight = candidates.reduce((sum, l) => sum + l.weight, 0);
  if (totalWeight <= 0) return candidates[0];
  let roll = rng() * totalWeight;
  for (const lane of candidates) {
    roll -= lane.weight;
    if (roll <= 0) return lane;
  }
  return candidates[candidates.length - 1];
}
