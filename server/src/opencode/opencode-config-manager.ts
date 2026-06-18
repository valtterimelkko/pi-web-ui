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
 * Apply a thinking level for the given model in opencode.json.
 *
 * Writes, under `provider[providerId].models[modelId].options`:
 *   - `thinking`         `{type:"enabled"}` for any non-off level, `{type:"disabled"}` for off
 *   - `reasoning_effort` the mapped enum value for non-off levels; removed on off
 *
 * The Z.AI API defaults to thinking-off, so 'off' must EXPLICITLY write
 * `{type:"disabled"}`, and any stale `reasoning_effort` must be cleared so it
 * cannot keep the model reasoning once the user turns thinking off.
 *
 * If providerId cannot be determined, the function is a no-op.
 */
export async function applyThinkingBudget(
  modelString: string,
  level: ThinkingLevel,
): Promise<void> {
  const { providerId, modelId } = parseModelId(modelString);
  if (!providerId) {
    return;
  }

  // The `thinking` / `reasoning_effort` controls are Z.AI / GLM-specific config
  // keys. Writing them for other gateway providers (Kilo, OpenCode Zen, etc.)
  // would inject options their APIs don't understand, so we only apply them for
  // zai-coding-plan. Other providers are handled by the capability-aware path.
  if (providerId !== 'zai-coding-plan') {
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

  // Z.AI defaults to thinking-off, so 'off' must explicitly disable it.
  options['thinking'] = thinkingLevelToOption(level);

  // reasoning_effort only takes effect while thinking is enabled. On 'off',
  // delete it so a previously-selected depth can't keep the model reasoning.
  if (level === 'off') {
    delete options['reasoning_effort'];
  } else {
    options['reasoning_effort'] = REASONING_EFFORT_BY_LEVEL[level];
  }

  await writeOpenCodeConfig(cfg);
}
