/**
 * Frontier models shipped in @earendil-works/pi-ai 0.87.1 (pi CLI 0.87.1,
 * 2026-09-22): Claude Opus 5.5, GPT-6 Sol, GPT-6 Luna.
 *
 * pi-web-ui exposes whatever the installed pi-ai built-in catalogue contains:
 * PiService lists models from the ModelRuntime (generated from this
 * catalogue), the Internal API /api/v1/models surface advertises them, and
 * the web UI model pickers render that list. These tests pin the
 * owner-requested frontier models on the providers this host is
 * authenticated for, so a dependency downgrade or upstream catalogue
 * regression fails loudly instead of silently dropping models from every
 * surface at once.
 *
 * Note the upstream id spelling difference: anthropic publishes
 * `claude-opus-5-5` (dashed) while github-copilot inherits it as
 * `claude-opus-5.5` (dotted). Both are pinned here deliberately.
 */
import { describe, expect, it } from 'vitest';
import { getModel, getModels } from '@earendil-works/pi-ai/compat';

describe('installed pi-ai catalogue ships the 0.87.1 frontier models', () => {
  it('anthropic carries Claude Opus 5.5', () => {
    expect(getModel('anthropic', 'claude-opus-5-5')).toBeDefined();
  });

  it('github-copilot carries the full trio (Copilot inherits all three)', () => {
    expect(getModel('github-copilot', 'claude-opus-5.5')).toBeDefined();
    expect(getModel('github-copilot', 'gpt-6-sol')).toBeDefined();
    expect(getModel('github-copilot', 'gpt-6-luna')).toBeDefined();
  });

  it('openai and openai-codex carry GPT-6 Sol and GPT-6 Luna', () => {
    for (const provider of ['openai', 'openai-codex'] as const) {
      expect(getModel(provider, 'gpt-6-sol'), `${provider}/gpt-6-sol`).toBeDefined();
      expect(getModel(provider, 'gpt-6-luna'), `${provider}/gpt-6-luna`).toBeDefined();
    }
  });

  it('lists the models under their real published ids (no alias drift)', () => {
    const copilotIds = getModels('github-copilot').map((m) => m.id);
    expect(copilotIds).toContain('gpt-6-sol');
    expect(copilotIds).toContain('gpt-6-luna');
    expect(copilotIds).toContain('claude-opus-5.5');
    expect(getModels('anthropic').map((m) => m.id)).toContain('claude-opus-5-5');
  });
});
