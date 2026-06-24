/**
 * Pi SDK OpenRouter model refresh.
 *
 * Pure, testable building blocks for surfacing the full OpenRouter gateway
 * catalogue in the Pi runtime path of Pi Web UI, on a refreshable cadence —
 * the Pi-SDK analogue of the OpenCode model automation (see
 * docs/OPENCODE-MODEL-AUTOMATION.md and docs/PI-OPENROUTER-MODEL-AUTOMATION.md).
 *
 * Design notes:
 * - Pi Web UI never reads or stores the OpenRouter API key. OpenRouter is a
 *   built-in Pi SDK provider; auth is auto-detected from the OPENROUTER_API_KEY
 *   env var (see @earendil-works/pi-ai env-api-keys.js). The provider config we
 *   register uses an env-reference ("$OPENROUTER_API_KEY") so no literal secret
 *   ever lives in the cache file or the repo — the key is resolved lazily by the
 *   SDK at request time.
 * - The fetched catalogue (model ids + public metadata only) is cached under
 *   ~/.pi-web-ui/pi-openrouter-models.json and registered into the running
 *   ModelRegistry via registerProvider(). The snapshot/diff helpers are shared
 *   with the OpenCode automation (they are provider-agnostic).
 * - The cache and snapshot contain model ids and public pricing/capability data
 *   only — never credentials.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

// Provider-agnostic snapshot/diff helpers, shared with the OpenCode automation.
// Imported for local use and re-exported so this module is the Pi-path entry point.
import {
  buildModelSnapshot,
  diffModelSnapshots,
  readSnapshot,
  writeSnapshot,
} from '../opencode/opencode-model-refresh.js';
import type {
  ModelSnapshot,
  SnapshotDiff,
  RefreshModelEntry,
} from '../opencode/opencode-model-refresh.js';

export { buildModelSnapshot, diffModelSnapshots, readSnapshot, writeSnapshot };
export type { ModelSnapshot, SnapshotDiff, RefreshModelEntry };

export const OPENROUTER_PROVIDER = 'openrouter';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';
/** Env-reference form understood by the Pi SDK config-value resolver. */
export const OPENROUTER_API_KEY_REF = '$OPENROUTER_API_KEY';

/** A model entry from OpenRouter's public GET /api/v1/models endpoint. */
export interface OpenRouterModelEntry {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: {
    modality?: string | null;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  };
  supported_parameters?: string[];
  reasoning?: { mandatory?: boolean; default_enabled?: boolean } | null;
}

/** Response shape of OpenRouter GET /api/v1/models ({ data: [...] }). */
export interface OpenRouterModelsResponse {
  data?: OpenRouterModelEntry[];
}

/** A single model definition in the Pi SDK provider-config shape. */
export interface PiModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Provider block ready for ModelRegistry.registerProvider('openrouter', ...). */
export interface OpenRouterProviderConfig {
  baseUrl: string;
  api: 'openai-completions';
  apiKey: string;
  models: PiModelDef[];
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS_CAP = 64_000;

function parseConfigNumber(value: string | undefined): number {
  const n = parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse an OpenRouter `modality` string like "text+image->text" into its input
 * and output modality lists. Tolerant of null/missing values.
 */
export function parseModality(
  modality: string | null | undefined,
): { input: string[]; output: string[] } {
  if (!modality || typeof modality !== 'string') {
    return { input: [], output: [] };
  }
  const [inPart, outPart] = modality.split('->');
  const split = (s: string | undefined): string[] =>
    s ? s.split('+').map((x) => x.trim().toLowerCase()).filter(Boolean) : [];
  return { input: split(inPart), output: split(outPart) };
}

/**
 * Keep text-output chat models; exclude image-generation, audio/TTS, embedding,
 * and transcription endpoints that cannot drive an agentic coding session.
 * Audio-output models (e.g. music generation) are excluded even when they also
 * emit text — a coding agent never wants audio output.
 */
export function isOpenRouterChatModel(m: OpenRouterModelEntry): boolean {
  const arch = m.architecture ?? {};
  const parsed = parseModality(arch.modality);
  const output = arch.output_modalities?.map((s) => s.toLowerCase()) ?? parsed.output;
  const modality = (arch.modality ?? '').toLowerCase();

  if (!output.includes('text')) return false;
  if (output.includes('audio')) return false;
  if (/embedding|transcri|whisper/.test(modality)) return false;
  return true;
}

/** Map OpenRouter modality data to the Pi SDK ("text" | "image")[] input list. */
export function deriveInputModalities(m: OpenRouterModelEntry): ('text' | 'image')[] {
  const arch = m.architecture ?? {};
  const parsed = parseModality(arch.modality);
  const input = arch.input_modalities?.map((s) => s.toLowerCase()) ?? parsed.input;
  const out: ('text' | 'image')[] = ['text'];
  if (input.includes('image')) out.push('image');
  return out;
}

/** A model counts as reasoning-capable if it advertises the reasoning parameter
 *  or reports default-enabled/mandatory reasoning. */
export function isReasoningModel(m: OpenRouterModelEntry): boolean {
  const params = (m.supported_parameters ?? []).map((s) => s.toLowerCase());
  if (params.includes('reasoning') || params.includes('include_reasoning')) return true;
  if (m.reasoning?.mandatory === true || m.reasoning?.default_enabled === true) return true;
  return false;
}

function toCost(pricing: OpenRouterModelEntry['pricing']): PiModelDef['cost'] {
  return {
    input: parseConfigNumber(pricing?.prompt),
    output: parseConfigNumber(pricing?.completion),
    cacheRead: parseConfigNumber(pricing?.input_cache_read),
    cacheWrite: 0,
  };
}

/**
 * Transform a single OpenRouter model entry into a Pi SDK model def.
 * Returns null when the entry is not a usable chat model (filtered out).
 */
export function transformOpenRouterModel(m: OpenRouterModelEntry): PiModelDef | null {
  if (!m?.id) return null;
  if (!isOpenRouterChatModel(m)) return null;

  const contextWindow =
    m.top_provider?.context_length ?? m.context_length ?? DEFAULT_CONTEXT_WINDOW;
  const rawMax = m.top_provider?.max_completion_tokens;
  const maxTokens =
    typeof rawMax === 'number' && rawMax > 0
      ? rawMax
      : Math.min(contextWindow, FALLBACK_MAX_TOKENS_CAP);

  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: isReasoningModel(m),
    input: deriveInputModalities(m),
    contextWindow,
    maxTokens,
    cost: toCost(m.pricing),
  };
}

/**
 * Transform the full OpenRouter /api/v1/models response into a Pi SDK provider
 * config. Models are filtered to chat models, de-duplicated by id, and sorted
 * for stable diffs.
 */
export function transformOpenRouterCatalogue(
  resp: OpenRouterModelsResponse | OpenRouterModelEntry[],
  opts: { baseUrl?: string; apiKeyRef?: string } = {},
): OpenRouterProviderConfig {
  const entries: OpenRouterModelEntry[] = Array.isArray(resp)
    ? resp
    : Array.isArray(resp?.data)
      ? resp.data
      : [];

  const models: PiModelDef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const def = transformOpenRouterModel(entry);
    if (def && !seen.has(def.id)) {
      seen.add(def.id);
      models.push(def);
    }
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  return {
    baseUrl: opts.baseUrl ?? OPENROUTER_BASE_URL,
    api: 'openai-completions',
    apiKey: opts.apiKeyRef ?? OPENROUTER_API_KEY_REF,
    models,
  };
}

/** Flatten a provider config into the { provider, id } entries a snapshot needs. */
export function openRouterModelIds(config: OpenRouterProviderConfig): RefreshModelEntry[] {
  return config.models.map((m) => ({ provider: OPENROUTER_PROVIDER, id: m.id }));
}

/** Read a cached provider config, returning null if missing or unparseable. */
export async function readOpenRouterCache(
  cachePath: string,
): Promise<OpenRouterProviderConfig | null> {
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OpenRouterProviderConfig>;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.models)) {
      return parsed as OpenRouterProviderConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a provider config (creating the parent directory). Best-effort. */
export async function writeOpenRouterCache(
  cachePath: string,
  config: OpenRouterProviderConfig,
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Fetch the OpenRouter model catalogue. The endpoint is public (no key needed
 * to list models). Injectable fetch for testing. Throws on non-2xx or timeout.
 */
export async function fetchOpenRouterCatalogue(
  url: string = OPENROUTER_MODELS_URL,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenRouterModelsResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A global fetch implementation is required to fetch OpenRouter models');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`OpenRouter models request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as OpenRouterModelsResponse;
  } finally {
    clearTimeout(timer);
  }
}
