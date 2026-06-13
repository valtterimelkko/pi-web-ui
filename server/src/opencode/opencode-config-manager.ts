/**
 * OpenCode config-file bridge for thinking budget control.
 *
 * GLM-5.x (including GLM-5.2 and other Z.AI models) support a `thinking_budget` API parameter
 * via OpenCode's `provider[id].models[id].options.thinkingBudget` config key.
 * This module reads/writes ~/.config/opencode/opencode.json to apply the
 * requested thinking level before the OpenCode server is recycled.
 *
 * Budget levels are derived from common industry ranges:
 *   off      →  remove option (model decides, typically very low)
 *   minimal  →  1 024 tokens  (constrained, quick reasoning)
 *   low      →  4 096 tokens  (OpenAI o3-low / Claude light thinking range)
 *   medium   → 10 240 tokens  (near Anthropic's 10k default recommendation)
 *   high     → 25 600 tokens  (OpenAI o3-high / Claude 16–32k range)
 *   xhigh    → 51 200 tokens  (deep reasoning, ~half of the GLM-5.x output limit)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_BUDGET_MAP: Record<Exclude<ThinkingLevel, 'off'>, number> = {
  minimal: 1_024,
  low: 4_096,
  medium: 10_240,
  high: 25_600,
  xhigh: 51_200,
};

const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');

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
 * Apply a thinking level for the given model in opencode.json.
 *
 * - For 'off': removes the thinkingBudget option for this model.
 * - For all other levels: writes thinkingBudget integer to
 *   provider[providerId].models[modelId].options.thinkingBudget.
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

  const cfg = await readOpenCodeConfig();

  if (!cfg.provider) cfg.provider = {};
  if (!cfg.provider[providerId]) cfg.provider[providerId] = {};
  if (!cfg.provider[providerId].models) cfg.provider[providerId].models = {};

  const models = cfg.provider[providerId].models!;
  if (!models[modelId]) models[modelId] = {};
  if (!models[modelId].options) models[modelId].options = {};

  const options = models[modelId].options!;

  if (level === 'off') {
    delete options['thinkingBudget'];
    // Clean up empty objects so the config stays tidy
    if (Object.keys(options).length === 0) {
      delete models[modelId].options;
    }
    if (Object.keys(models[modelId]).length === 0) {
      delete models[modelId];
    }
    if (Object.keys(models).length === 0) {
      delete cfg.provider[providerId].models;
    }
    if (Object.keys(cfg.provider[providerId]).length === 0) {
      delete cfg.provider[providerId];
    }
    if (Object.keys(cfg.provider).length === 0) {
      delete cfg.provider;
    }
  } else {
    options['thinkingBudget'] = THINKING_BUDGET_MAP[level];
  }

  await writeOpenCodeConfig(cfg);
}
