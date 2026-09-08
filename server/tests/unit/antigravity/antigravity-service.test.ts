import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Unit tests for the helpers that survive the stream-json integration
 * (plan Phase 10): context-window mapping and the live model catalogue.
 * Turn execution is covered by antigravity-service-stream.test.ts.
 */

const ctrl = vi.hoisted(() => ({ behavior: 'success', stdout: '', stderr: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
      (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
      (child as unknown as { kill: () => void }).kill = vi.fn();
      setTimeout(() => {
        if (ctrl.behavior === 'success') {
          (child as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(ctrl.stdout));
          child.emit('close', 0);
        } else {
          child.emit('close', 1);
        }
      }, 0);
      return child;
    }),
  };
});

import {
  getModelContextWindow,
  ANTIGRAVITY_MODEL_CONTEXT_WINDOWS,
  AntigravityService,
} from '../../../src/antigravity/antigravity-service.js';

describe('getModelContextWindow', () => {
  it('returns 1 M tokens for Gemini 3.5 Flash variants', () => {
    expect(getModelContextWindow('Gemini 3.5 Flash (Medium)')).toBe(1_048_576);
  });

  it('returns 2 M tokens for Gemini 3.1 Pro variants', () => {
    expect(getModelContextWindow('Gemini 3.1 Pro (High)')).toBe(2_097_152);
  });

  it('returns 200 K tokens for Claude Sonnet variants', () => {
    expect(getModelContextWindow('Claude Sonnet 4.6 (Thinking)')).toBe(200_000);
  });

  it('returns 200 K tokens for Claude Opus variants', () => {
    expect(getModelContextWindow('Claude Opus 4.6 (Thinking)')).toBe(200_000);
  });

  it('returns 128 K tokens for GPT-OSS models', () => {
    expect(getModelContextWindow('GPT-OSS 120B (Medium)')).toBe(128_000);
  });

  it('falls back to 1 M tokens for unrecognised model names', () => {
    expect(getModelContextWindow('Unknown Model')).toBe(1_048_576);
  });

  it('normalises a provider-prefixed id before matching (RC3)', () => {
    expect(getModelContextWindow('antigravity/Claude Opus 4.6 (Thinking)')).toBe(200_000);
  });

  it('matches slug forms (stream-json selector contract)', () => {
    expect(getModelContextWindow('gemini-3.6-flash-low')).toBe(1_048_576);
    expect(getModelContextWindow('gemini-3.1-pro-high')).toBe(2_097_152);
    expect(getModelContextWindow('claude-sonnet-4-6')).toBe(200_000);
    expect(getModelContextWindow('gpt-oss-120b-medium')).toBe(128_000);
  });

  it('exposes the mapping table (documentation surface)', () => {
    expect(ANTIGRAVITY_MODEL_CONTEXT_WINDOWS.length).toBeGreaterThan(0);
  });
});

describe('AntigravityService — getAvailableModels', () => {
  function freshService(): AntigravityService {
    return new AntigravityService({ registryPath: join(tmpdir(), `ag-models-${Date.now()}-${Math.random().toString(36).slice(2)}.json`) });
  }

  it('exposes slugs as ids (1.1.27 selector contract) with labels as names and sibling-derived thinkingLevels', async () => {
    const modelSvc = freshService();
    ctrl.behavior = 'success';
    ctrl.stdout = [
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
      'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      '',
    ].join('\n');

    const models = await modelSvc.getAvailableModels();

    // Live-validated 2026-09-08 (agy 1.1.27): both slug and label are
    // accepted by --model and the slug is what init.model echoes back —
    // so the canonical selector is the slug (plan Phase 2 / T2.2).
    expect(models.map((m) => m.id)).toEqual([
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium',
      'gemini-3.7-flash-low',
      'claude-sonnet-4-6',
    ]);
    expect(models.every((m) => !m.id.includes('\t'))).toBe(true);
    expect(models.map((m) => m.name)).toEqual([
      'Gemini 3.7 Flash (High)',
      'Gemini 3.7 Flash (Medium)',
      'Gemini 3.7 Flash (Low)',
      'Claude Sonnet 4.6 (Thinking)',
    ]);
    expect(models.every((m) => m.provider === 'antigravity')).toBe(true);
    expect(models.find((m) => m.id === 'gemini-3.7-flash-low')?.thinkingLevels).toEqual(['low', 'medium', 'high']);
    expect(models.find((m) => m.id === 'claude-sonnet-4-6')?.thinkingLevels).toEqual([]);
  });

  it('passes label-only lines through unchanged (older agy output compatibility)', async () => {
    const modelSvc = freshService();
    ctrl.behavior = 'success';
    ctrl.stdout = ['Gemini 3.5 Flash (Medium)', 'Gemini 3.1 Pro (High)', ''].join('\n');

    const models = await modelSvc.getAvailableModels();

    expect(models.map((m) => m.id)).toEqual(['Gemini 3.5 Flash (Medium)', 'Gemini 3.1 Pro (High)']);
    expect(models.every((m) => m.thinkingLevels.length === 0)).toBe(true);
  });
});
