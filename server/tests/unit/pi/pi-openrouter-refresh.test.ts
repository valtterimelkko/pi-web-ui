import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  parseModality,
  isOpenRouterChatModel,
  deriveInputModalities,
  isReasoningModel,
  transformOpenRouterModel,
  transformOpenRouterCatalogue,
  openRouterModelIds,
  readOpenRouterCache,
  writeOpenRouterCache,
  fetchOpenRouterCatalogue,
  buildModelSnapshot,
  diffModelSnapshots,
  OPENROUTER_BASE_URL,
  OPENROUTER_API_KEY_REF,
  type OpenRouterModelEntry,
} from '../../../src/pi/pi-openrouter-refresh.js';

describe('parseModality', () => {
  it('splits a "in->out" modality string', () => {
    expect(parseModality('text+image->text')).toEqual({
      input: ['text', 'image'],
      output: ['text'],
    });
    expect(parseModality('text->text')).toEqual({ input: ['text'], output: ['text'] });
  });

  it('returns empty lists for missing values', () => {
    expect(parseModality(null)).toEqual({ input: [], output: [] });
    expect(parseModality(undefined)).toEqual({ input: [], output: [] });
  });
});

describe('isOpenRouterChatModel', () => {
  const chat = (over: Partial<OpenRouterModelEntry> = {}): OpenRouterModelEntry => ({
    id: 'x/y',
    architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
    ...over,
  });

  it('keeps text-output chat models', () => {
    expect(isOpenRouterChatModel(chat())).toBe(true);
    expect(isOpenRouterChatModel(chat({ architecture: { modality: 'text+image->text' } }))).toBe(true);
  });

  it('excludes image-generation / audio / embedding output models', () => {
    expect(isOpenRouterChatModel(chat({ architecture: { modality: 'text->image' } }))).toBe(false);
    expect(isOpenRouterChatModel(chat({ architecture: { modality: 'text->audio' } }))).toBe(false);
    expect(isOpenRouterChatModel(chat({ architecture: { modality: 'text->embedding' } }))).toBe(false);
  });

  it('excludes audio-output models even when they also emit text (e.g. music gen)', () => {
    expect(
      isOpenRouterChatModel(chat({ architecture: { modality: 'text+image->text+audio', output_modalities: ['text', 'audio'] } })),
    ).toBe(false);
  });
});

describe('deriveInputModalities', () => {
  it('includes image when the model accepts image input', () => {
    expect(
      deriveInputModalities({ id: 'a', architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] } }),
    ).toEqual(['text', 'image']);
  });

  it('is text-only otherwise', () => {
    expect(deriveInputModalities({ id: 'a', architecture: { modality: 'text->text' } })).toEqual(['text']);
  });
});

describe('isReasoningModel', () => {
  it('is true when reasoning is a supported parameter', () => {
    expect(isReasoningModel({ id: 'a', supported_parameters: ['tools', 'reasoning'] })).toBe(true);
    expect(isReasoningModel({ id: 'a', supported_parameters: ['include_reasoning'] })).toBe(true);
  });

  it('is true when reasoning defaults on / is mandatory', () => {
    expect(isReasoningModel({ id: 'a', reasoning: { default_enabled: true } })).toBe(true);
    expect(isReasoningModel({ id: 'a', reasoning: { mandatory: true } })).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isReasoningModel({ id: 'a', supported_parameters: ['tools'] })).toBe(false);
    expect(isReasoningModel({ id: 'a' })).toBe(false);
  });
});

describe('transformOpenRouterModel', () => {
  const fugu: OpenRouterModelEntry = {
    id: 'sakana/fugu-ultra',
    name: 'Sakana: Fugu Ultra',
    context_length: 1_000_000,
    architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0.000005', completion: '0.00003', input_cache_read: '0.0000005' },
    top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
    supported_parameters: ['include_reasoning', 'reasoning', 'tools'],
    reasoning: { mandatory: true, default_enabled: true },
  };

  it('maps fields, cost (per-token), modalities and reasoning', () => {
    expect(transformOpenRouterModel(fugu)).toEqual({
      id: 'sakana/fugu-ultra',
      name: 'Sakana: Fugu Ultra',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 0.000005, output: 0.00003, cacheRead: 0.0000005, cacheWrite: 0 },
    });
  });

  it('falls back contextWindow / maxTokens when provider fields are missing', () => {
    const def = transformOpenRouterModel({
      id: 'a/b',
      name: 'AB',
      architecture: { modality: 'text->text', output_modalities: ['text'] },
    });
    expect(def?.contextWindow).toBe(200_000);
    expect(def?.maxTokens).toBe(64_000);
  });

  it('returns null for non-chat models', () => {
    expect(
      transformOpenRouterModel({ id: 'img/gen', architecture: { modality: 'text->image' } }),
    ).toBeNull();
  });

  it('uses the id as the name when name is absent', () => {
    const def = transformOpenRouterModel({
      id: 'a/b',
      architecture: { modality: 'text->text', output_modalities: ['text'] },
    });
    expect(def?.name).toBe('a/b');
  });
});

describe('transformOpenRouterCatalogue', () => {
  it('filters to chat models, dedups, sorts, and builds the provider config', () => {
    const config = transformOpenRouterCatalogue({
      data: [
        { id: 'zeta/z', architecture: { modality: 'text->text', output_modalities: ['text'] } },
        { id: 'alpha/a', architecture: { modality: 'text->text', output_modalities: ['text'] } },
        { id: 'alpha/a', architecture: { modality: 'text->text', output_modalities: ['text'] } },
        { id: 'img/gen', architecture: { modality: 'text->image' } },
      ],
    });
    expect(config.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(config.api).toBe('openai-completions');
    expect(config.apiKey).toBe(OPENROUTER_API_KEY_REF);
    expect(config.models.map((m) => m.id)).toEqual(['alpha/a', 'zeta/z']);
  });

  it('accepts a bare array of entries', () => {
    const config = transformOpenRouterCatalogue([
      { id: 'a/b', architecture: { modality: 'text->text', output_modalities: ['text'] } },
    ]);
    expect(config.models).toHaveLength(1);
  });
});

describe('cache read/write', () => {
  let tmp: string;
  let cachePath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'or-cache-'));
    cachePath = path.join(tmp, 'nested', 'openrouter-cache.json');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('round-trips a provider config and creates parent dirs', async () => {
    const config = transformOpenRouterCatalogue({
      data: [{ id: 'a/b', architecture: { modality: 'text->text', output_modalities: ['text'] } }],
    });
    await writeOpenRouterCache(cachePath, config);
    const read = await readOpenRouterCache(cachePath);
    expect(read?.models.map((m) => m.id)).toEqual(['a/b']);
  });

  it('returns null for a missing or malformed cache', async () => {
    expect(await readOpenRouterCache(cachePath)).toBeNull();
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, 'not json', 'utf-8');
    expect(await readOpenRouterCache(cachePath)).toBeNull();
  });
});

describe('snapshot/diff reuse for OpenRouter', () => {
  it('builds a single-provider snapshot and diffs ids', () => {
    const config = transformOpenRouterCatalogue({
      data: [
        { id: 'a/1', architecture: { modality: 'text->text', output_modalities: ['text'] } },
        { id: 'a/2', architecture: { modality: 'text->text', output_modalities: ['text'] } },
      ],
    });
    const snap = buildModelSnapshot(openRouterModelIds(config), new Date('2026-01-01T00:00:00.000Z'));
    expect(snap.providers.openrouter).toEqual(['a/1', 'a/2']);

    const next = buildModelSnapshot(
      openRouterModelIds(
        transformOpenRouterCatalogue({
          data: [
            { id: 'a/2', architecture: { modality: 'text->text', output_modalities: ['text'] } },
            { id: 'a/3', architecture: { modality: 'text->text', output_modalities: ['text'] } },
          ],
        }),
      ),
    );
    const diff = diffModelSnapshots(snap, next);
    expect(diff.addedModels).toEqual(['openrouter/a/3']);
    expect(diff.removedModels).toEqual(['openrouter/a/1']);
  });
});

describe('fetchOpenRouterCatalogue', () => {
  it('returns parsed JSON on a 2xx response', async () => {
    const fetchImpl = (async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'a/b', architecture: { modality: 'text->text', output_modalities: ['text'] } }] }),
    }) as unknown as typeof fetch);
    const resp = await fetchOpenRouterCatalogue('https://x', { fetchImpl });
    expect(resp.data?.[0]?.id).toBe('a/b');
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, statusText: 'Unavailable' }) as unknown as typeof fetch);
    await expect(fetchOpenRouterCatalogue('https://x', { fetchImpl })).rejects.toThrow(/503/);
  });
});
