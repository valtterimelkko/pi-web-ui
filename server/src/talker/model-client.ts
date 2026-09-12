/**
 * The talker's side completion: one direct, streaming model call in the
 * validated spot-check shape (scripts/talker-spot-check.mjs) — no agent
 * session, no tools, no AGENTS.md, no memory packet.
 *
 * Configuration (plan D7): model openrouter/google/gemma-4-26b-a4b-it,
 * thinking OFF, OpenRouter paid route. First-token budget: ≤2 s target,
 * >4 s failure (measured and reported by scripts/talker-harness.ts).
 */

import type { ChatMessage, ModelTurnResult, TalkerModelClient } from './types.js';

export const TALKER_DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';
export const TALKER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface TalkerModelConfig {
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
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
  };
}

interface SseChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: Record<string, unknown>;
}

export class OpenRouterTalkerClient implements TalkerModelClient {
  private readonly cfg: TalkerModelConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: TalkerModelConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
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
          // The selected configuration is thinking OFF (plan §10.4).
          reasoning: { enabled: false },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`talker model call failed: HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      let ttftMs: number | null = null;
      let text = '';
      let buffer = '';

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
          if (content) {
            if (ttftMs === null) ttftMs = performance.now() - started;
            text += content;
          }
        }
      }

      return { text: text.trim(), ttftMs, totalMs: performance.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }
}
