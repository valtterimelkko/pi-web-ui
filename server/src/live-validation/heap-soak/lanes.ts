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
    // First measured live against an artificial cgroup pids limit (512) this
    // harness itself had set, well below the server's real admission budget
    // (`[InternalAPI] admission: ... reservedPids/turn=96`, `apiTurnLimit=14`)
    // and production's own TasksMax (8192) — 8 concurrent turns produced real
    // `ADMISSION_CAPACITY_EXHAUSTED (pid_pressure)` rejections purely from
    // that self-imposed cgroup ceiling, not from anything production would
    // actually refuse. Parent amendment 2026-09-26: TasksMax raised to 8192
    // (matching production) and this cap raised to 6, closer to production's
    // real ~14-API-turn admission ceiling while B stays capped at 1.
    maxConcurrent: 6,
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
    maxConcurrent: 1,
  },
  {
    name: 'C',
    label: 'Command Code FREE models via Pi commandcode provider (declined — see disabledReason)',
    weight: 0.15,
    runtime: 'pi',
    modelIds: ['commandcode/poolside/laguna-s-2.1-free'],
    enabled: false,
    isBackbone: false,
    maxConcurrent: 1,
    disabledReason:
      'A live `commandcode` Pi provider DOES exist — it is registered at runtime by the '
      + '~/.pi/agent/extensions/commandcode-provider Pi extension (confirmed live: the disposable server\'s '
      + '"Available providers (with auth)" log line lists `commandcode`, meaning a Command Code API key was '
      + 'resolvable on this host). But it is deliberately left disabled for this harness because: '
      + '(1) of the 3 free model ids named for lane C, only `poolside/laguna-s-2.1-free` actually resolves in the '
      + 'live-generated catalogue (~/.pi/agent/extensions/commandcode-provider/models.ts) — '
      + '`stealth/space-bunny-alpha` and `ling-3.0-flash-sante:free` are absent from it entirely, so the lane '
      + 'cannot be built as specified (with fallbacks) regardless; '
      + '(2) that catalogue reports `cost: {input:0,output:0}` uniformly for EVERY one of its 47 models, including '
      + 'unambiguously paid ones (e.g. Kimi-K3, GLM-5.3, Qwen3.8-Max, DeepSeek-v4-Pro) — so there is no '
      + 'machine-checkable signal this harness could use to guarantee a 24h unattended run only ever dispatches '
      + 'the one free id, never a paid one; '
      + '(3) the account has ~7% monthly credit left, so an accidental paid call (a future catalogue regeneration '
      + 'reordering ids, a routing/fallback quirk) is a real financial risk for a lane that is best-effort and '
      + 'non-load-bearing by design. Disabling is the conservative call the task explicitly allows '
      + '("if lane C cannot work cleanly, disable it and report why").',
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
