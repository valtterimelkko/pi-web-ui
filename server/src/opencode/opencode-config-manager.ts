/**
 * OpenCode config-file bridge for thinking control.
 *
 * GLM-5.x (including GLM-5.2 and other Z.AI models) support a `thinking` API
 * parameter via OpenCode's `provider[id].models[id].options.thinking` config
 * key. The Z.AI API accepts:
 *   { "type": "enabled" }  — model automatically reasons (default)
 *   { "type": "disabled" } — skip chain-of-thought entirely
 *
 * The API does NOT support a numeric thinking budget; reasoning depth is
 * decided by the model based on task complexity. We therefore map:
 *   off  → thinking disabled
 *   any other level (minimal/low/medium/high/xhigh) → thinking enabled
 *
 * The non-off levels are preserved in the registry so the UI can show the
 * user's selection, but the API-level control is binary.
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
 * Writes `provider[providerId].models[modelId].options.thinking` with
 * `{type:"enabled"}` or `{type:"disabled"}`.
 *
 * For 'off' the thinking option is removed so the config stays tidy (the
 * model defaults to thinking enabled, so removing the key is equivalent to
 * re-enabling default behaviour after it was previously disabled).
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

  // 'off' historically meant "remove the override". Since the Z.AI default
  // is thinking-enabled, removing the key restores the default behaviour.
  if (level === 'off') {
    delete options['thinking'];
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
    options['thinking'] = thinkingLevelToOption(level);
  }

  await writeOpenCodeConfig(cfg);
}
