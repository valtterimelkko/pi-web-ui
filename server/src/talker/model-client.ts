/**
 * The talker's side completion: one direct, streaming model call in the
 * validated spot-check shape (scripts/talker-spot-check.mjs) — no agent
 * session, no tools, no AGENTS.md, no memory packet.
 *
 * Configuration (plan D7): model openrouter/google/gemma-4-26b-a4b-it,
 * thinking OFF, OpenRouter paid route. First-token budget: ≤2 s target,
 * >4 s failure (measured and reported by scripts/talker-harness.ts).
 *
 * H5 — reliable Gemma delivery: the model is served by 11 OpenRouter
 * inference providers and several of them return degenerate output
 * (thought-channel markers in the content field, HTTP 200 with empty
 * content, or runaway repetition). Three measures, measured together at
 * 15/15 viable with a ~1-in-15 retry tax:
 *   1. provider preference — ask OpenRouter to prefer the measured-good
 *      providers, fallbacks still allowed (no single-provider dependency);
 *   2. a provider-agnostic degenerate-output check (isDegenerateReply);
 *   3. one bounded retry when the reply is degenerate. If the retry is
 *      also degenerate, throw an honest failure (spoken by the talker's
 *      existing MODEL_FAILURE_REPLY path) — never retry further, never
 *      fabricate a reply, no fallback model.
 */

import type { ChatMessage, ModelTurnResult, TalkerModelClient } from './types.js';

export const TALKER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';
export const TALKER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Measured-good OpenRouter inference providers for the talker model
 * (scripts/gemma-provider-quality-probe.ts, 2026-09): identical request,
 * 16-turn assistant history, reasoning off. DeepInfra/Darkbloom/Novita led
 * on viability and latency; preference alone measured 14/15 viable and the
 * preference+retry combination 15/15. Re-run the probe when the provider set
 * changes and update this list (or override per environment with
 * TALKER_PROVIDER_ORDER).
 */
export const TALKER_PREFERRED_PROVIDERS = ['deepinfra', 'darkbloom', 'novita'];

export interface TalkerModelConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /**
   * How to express the reasoning preference to the provider.
   *
   * - `undefined` (default): disable reasoning — the selected production model
   *   (thinking OFF, plan §10.4).
   * - an effort level: request that effort instead, for endpoints that REJECT a
   *   disabled-reasoning request with HTTP 400 (H3 retest found two such
   *   candidates).
   * - `'omit'`: send no `reasoning` field at all.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'omit';
  /**
   * OpenRouter inference-provider routing preference (H5). Sent as
   * `provider: { order: [...], allow_fallbacks: true }` — prefer the
   * measured-good providers, but never pin a single provider. Empty or
   * undefined omits the field entirely (plain OpenRouter routing).
   */
  providerOrder?: string[];
}

export function resolveTalkerModelConfig(env: NodeJS.ProcessEnv = process.env): TalkerModelConfig {
  const apiKey = env.TALKER_API_KEY || env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    throw new Error('Talker model key is not configured: set TALKER_API_KEY or OPENROUTER_API_KEY');
  }
  return {
    model: env.TALKER_MODEL || TALKER_DEFAULT_MODEL,
    apiKey,
    baseUrl: (env.TALKER_BASE_URL || TALKER_DEFAULT_BASE_URL).replace(/\/$/, ''),
    temperature: 0.3,
    maxTokens: 400,
    timeoutMs: Number(env.TALKER_TIMEOUT_MS || 30000),
    providerOrder: env.TALKER_PROVIDER_ORDER
      ? env.TALKER_PROVIDER_ORDER.split(',').map(s => s.trim()).filter(Boolean)
      : [...TALKER_PREFERRED_PROVIDERS],
  };
}

/**
 * Provider-agnostic degenerate-reply check (H5). Catches all three measured
 * failure modes regardless of which inference provider produced the reply:
 *   - empty content (HTTP 200, valid completion, no text);
 *   - thought-channel leak — raw `<|channel>` / `<channel|>` markers in the
 *     content field (the reply is entirely channel noise, so this is for
 *     retrying, NOT for salvaging by stripping);
 *   - runaway repetition — very low unique-word ratio, or a reply dominated
 *     by a single word (the observed "thought" loop).
 * Thresholds only engage at ≥8 words so natural short speech never trips them.
 */
export function isDegenerateReply(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true; // empty
  if (/<\|channel>|<channel\|>/.test(t)) return true; // thought-channel leak
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size / words.length < 0.3) return true; // runaway repetition
  if (words.length >= 8 && words.filter(w => w === 'thought').length / words.length > 0.4) return true;
  return false;
}

interface SseChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: Record<string, unknown>;
  /** OpenRouter names the inference provider that served this completion. */
  provider?: string;
}

/** Concrete result of the talker client, extending ModelTurnResult with H5 evidence. */
export interface TalkerClientTurnResult extends ModelTurnResult {
  /** 0 = good on the first attempt; 1 = one degenerate reply was retried. */
  retries: number;
  /** Inference provider that served the reply we kept, when OpenRouter reported it. */
  provider: string | null;
}

export class OpenRouterTalkerClient implements TalkerModelClient {
  private readonly cfg: TalkerModelConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TalkerModelConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async completeTurn(messages: ChatMessage[]): Promise<TalkerClientTurnResult> {
    // H5: at most two attempts (one retry). Worst case is bounded at 2×
    // timeoutMs; a persistently degenerate provider produces an honest
    // thrown failure, which the talker speaks via MODEL_FAILURE_REPLY.
    const first = await this.callOnce(messages);
    if (!isDegenerateReply(first.text)) return { ...first, retries: 0 };
    const second = await this.callOnce(messages);
    if (!isDegenerateReply(second.text)) return { ...second, retries: 1 };
    throw new Error(
      `talker model returned degenerate output after 2 attempts `
      + `(empty / thought-channel leak / runaway repetition; providers: `
      + `${first.provider ?? 'unknown'} then ${second.provider ?? 'unknown'}); `
      + `last sample: ${JSON.stringify(second.text.slice(0, 120))}`,
    );
  }

  private async callOnce(messages: ChatMessage[]): Promise<Omit<TalkerClientTurnResult, 'retries'>> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://pi-web-ui.local',
          'X-Title': 'pi-web-ui talker harness',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          stream: true,
          temperature: this.cfg.temperature,
          max_tokens: this.cfg.maxTokens,
          // Reasoning is configurable because it is NOT universally disableable:
          // some OpenRouter endpoints reject a disabled-reasoning request with
          // HTTP 400 "Reasoning is mandatory for this endpoint and cannot be
          // disabled". The selected production model wants thinking OFF
          // (plan §10.4), which stays the default; a candidate that mandates
          // reasoning sets an effort level (or 'omit') instead. (H3 retest.)
          ...(this.cfg.reasoningEffort === 'omit'
            ? {}
            : this.cfg.reasoningEffort
              ? { reasoning: { effort: this.cfg.reasoningEffort } }
              : { reasoning: { enabled: false } }),
          // H5: prefer the measured-good inference providers; fallbacks stay
          // allowed so no single provider is a dependency.
          ...(this.cfg.providerOrder && this.cfg.providerOrder.length > 0
            ? { provider: { order: this.cfg.providerOrder, allow_fallbacks: true } }
            : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`talker model call failed: HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      let ttftMs: number | null = null;
      let text = '';
      let buffer = '';
      let provider: string | null = response.headers?.get?.('x-provider') ?? null;

      const reader = response.body?.getReader();
      if (!reader) throw new Error('talker model call failed: empty response body');
      const decoder = new TextDecoder();

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let parsed: SseChunk;
          try {
            parsed = JSON.parse(payload) as SseChunk;
          } catch {
            continue;
          }
          const content = parsed.choices?.[0]?.delta?.content;
          if (parsed.provider) provider = parsed.provider;
          if (content) {
            if (ttftMs === null) ttftMs = performance.now() - started;
            text += content;
          }
        }
      }

      return { text: text.trim(), ttftMs, totalMs: performance.now() - started, provider };
    } finally {
      clearTimeout(timer);
    }
  }
}
