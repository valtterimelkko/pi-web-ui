/**
 * OpenCode config-file bridge for thinking control.
 *
 * Z.AI / GLM models expose reasoning depth through OpenCode's
 * `provider[id].models[id].options` config, which `@ai-sdk/openai-compatible`
 * forwards verbatim into the chat-completion request body. Two controls matter
 * (verified live against the coding-plan endpoint, https://api.z.ai/api/coding/paas/v4):
 *
 *   options.thinking          { "type": "enabled" | "disabled" }
 *                             Binary on/off (GLM-4.5+). Reasoning is OFF unless
 *                             explicitly enabled, so 'off' must write "disabled".
 *
 *   options.reasoning_effort  "minimal" | "low" | "medium" | "high" | "max" | …
 *                             Graduated reasoning depth, takes effect while
 *                             thinking is enabled. Honoured at full granularity
 *                             by GLM-5.2; older GLM models accept it and collapse
 *                             it internally (none/minimal→off, low/medium→high,
 *                             xhigh→max), so it is safe to write uniformly for
 *                             every zai-coding-plan model.
 *
 * We therefore map the six UI levels onto both controls:
 *   off     → thinking disabled, no reasoning_effort
 *   minimal → thinking enabled, reasoning_effort "minimal"
 *   low     → thinking enabled, reasoning_effort "low"
 *   medium  → thinking enabled, reasoning_effort "medium"
 *   high    → thinking enabled, reasoning_effort "high"
 *   xhigh   → thinking enabled, reasoning_effort "max"  (UI ceiling → API ceiling)
 *
 * This control is Z.AI/GLM-specific, so it is only written for the
 * `zai-coding-plan` provider; see resolveReasoningStrategy for the generalized,
 * capability-aware handling of other gateways.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * How a model's reasoning depth is expressed in opencode.json:
 *
 *   'zai'           Z.AI / GLM: `thinking` on/off object + `reasoning_effort`
 *                   (full enum, incl. 'minimal'/'max'). zai-coding-plan only.
 *   'openai-effort' Generic OpenAI-compatible reasoning models (gateway models
 *                   that report the `reasoning` capability): `reasoning_effort`
 *                   only, clamped to the broadly-supported low/medium/high set.
 *                   No `thinking` object — that key is Z.AI-specific.
 *   'none'          Model has no usable reasoning control — write nothing.
 */
export type ReasoningStrategy = 'zai' | 'openai-effort' | 'none';

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

interface ThinkingOption {
  type: 'enabled' | 'disabled';
}

/**
 * UI thinking level -> Z.AI `reasoning_effort` enum value. The UI's top level
 * ('xhigh', labelled "Maximum reasoning") maps to the API's true ceiling 'max'.
 */
const REASONING_EFFORT_BY_LEVEL: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'max',
};

/**
 * UI thinking level -> reasoning_effort for generic OpenAI-compatible reasoning
 * models. Clamped to the broadly-supported low/medium/high set: many gateway
 * models reject Z.AI's 'minimal'/'max' extensions, so the extremes fold inward.
 */
const OPENAI_EFFORT_BY_LEVEL: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
};

interface OpenCodeJsonConfig {
  $schema?: string;
  provider?: Record<string, {
    models?: Record<string, {
      options?: Record<string, unknown>;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Parse "providerId/modelId" or just "modelId" from a model string.
 * Returns the best available split for writing into opencode.json.
 */
export function parseModelId(modelString: string): { providerId: string | null; modelId: string } {
  const parts = modelString.split('/');
  if (parts.length >= 2) {
    return { providerId: parts[0], modelId: parts.slice(1).join('/') };
  }
  return { providerId: null, modelId: modelString };
}

/**
 * Read the opencode.json config, returning an empty object if missing.
 */
export async function readOpenCodeConfig(): Promise<OpenCodeJsonConfig> {
  if (!existsSync(OPENCODE_CONFIG_PATH)) {
    return {};
  }
  try {
    const raw = await readFile(OPENCODE_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as OpenCodeJsonConfig;
  } catch {
    return {};
  }
}

/**
 * Write the opencode.json config (pretty-printed).
 */
export async function writeOpenCodeConfig(cfg: OpenCodeJsonConfig): Promise<void> {
  await writeFile(OPENCODE_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

/**
 * Map a ThinkingLevel to the Z.AI thinking option object.
 *
 * 'off' disables reasoning; every other level enables it.
 */
function thinkingLevelToOption(level: ThinkingLevel): ThinkingOption {
  return { type: level === 'off' ? 'disabled' : 'enabled' };
}

/**
 * Apply a thinking level for the given model in opencode.json, using the
 * reasoning strategy appropriate to the model's provider/capabilities.
 *
 * Writes under `provider[providerId].models[modelId].options`:
 *   - strategy 'zai':           `thinking` on/off + `reasoning_effort` (full enum)
 *   - strategy 'openai-effort': `reasoning_effort` only (low/medium/high)
 *   - strategy 'none':          nothing
 *
 * The Z.AI API defaults to thinking-off, so for 'zai' an 'off' level must write
 * `{type:"disabled"}`; in every strategy a stale `reasoning_effort` is cleared
 * on 'off' so it cannot keep the model reasoning once the user turns it off.
 *
 * If providerId cannot be determined, the function is a no-op. The default
 * strategy is 'zai' for backwards compatibility with callers that only drive
 * the Z.AI path.
 */
export async function applyThinkingBudget(
  modelString: string,
  level: ThinkingLevel,
  strategy: ReasoningStrategy = 'zai',
): Promise<void> {
  const { providerId, modelId } = parseModelId(modelString);
  if (!providerId || strategy === 'none') {
    return;
  }

  // The `thinking` object is a Z.AI / GLM-specific key. The 'zai' strategy is
  // therefore restricted to zai-coding-plan; other providers must arrive with an
  // explicit non-zai strategy chosen from their reasoning capability.
  if (strategy === 'zai' && providerId !== 'zai-coding-plan') {
    return;
  }

  const cfg = await readOpenCodeConfig();

  if (!cfg.provider) cfg.provider = {};
  if (!cfg.provider[providerId]) cfg.provider[providerId] = {};
  if (!cfg.provider[providerId].models) cfg.provider[providerId].models = {};

  const models = cfg.provider[providerId].models!;
  if (!models[modelId]) models[modelId] = {};
  if (!models[modelId].options) models[modelId].options = {};

  const options = models[modelId].options!;

  if (strategy === 'zai') {
    // Z.AI defaults to thinking-off, so 'off' must explicitly disable it.
    options['thinking'] = thinkingLevelToOption(level);
    if (level === 'off') {
      delete options['reasoning_effort'];
    } else {
      options['reasoning_effort'] = REASONING_EFFORT_BY_LEVEL[level];
    }
  } else {
    // openai-effort: reasoning_effort only; no thinking object. These models
    // can't be hard-disabled via thinking, so 'off' just drops the override.
    if (level === 'off') {
      delete options['reasoning_effort'];
    } else {
      options['reasoning_effort'] = OPENAI_EFFORT_BY_LEVEL[level];
    }
  }

  await writeOpenCodeConfig(cfg);
}

/**
 * Pick the reasoning strategy for a model.
 *
 * - zai-coding-plan -> 'zai' (thinking + full reasoning_effort enum)
 * - any other provider whose catalogue entry reports the `reasoning`
 *   capability -> 'openai-effort' (reasoning_effort only)
 * - everything else -> 'none' (no usable reasoning control)
 */
export function resolveReasoningStrategy(
  providerId: string | null,
  supportsReasoning: boolean,
): ReasoningStrategy {
  if (providerId === 'zai-coding-plan') return 'zai';
  if (supportsReasoning) return 'openai-effort';
  return 'none';
}
