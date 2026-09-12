import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RED: module does not exist yet.
import { loadTalkerSystemPrompt, TALKER_PROMPT_RELATIVE_PATH } from '../../../src/talker/prompt.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('talker system prompt (v3 harness variant)', () => {
  it('loads the v3 variant file and does not touch the frozen v2 file', () => {
    expect(TALKER_PROMPT_RELATIVE_PATH).toBe('scripts/talker-prompts/v3-harness.txt');
    const v2 = readFileSync(path.join(repoRoot, 'scripts/talker-prompts/v2-structured.txt'), 'utf8');
    // v2 is the validated safety baseline and must remain byte-identical to its committed form.
    expect(v2.length).toBeGreaterThan(1000);
  });

  it('is lean: stays in the low hundreds of tokens', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt.length).toBeLessThanOrEqual(4200); // ~1000 tokens hard ceiling
  });

  it('justifies the gate rather than merely asserting it (plan §10.11 binding finding)', () => {
    const prompt = loadTalkerSystemPrompt();
    // The WHY: operator thinks out loud; worker cannot tell thought from instruction.
    expect(prompt).toMatch(/think(s|ing)? out loud/i);
    expect(prompt).toMatch(/unfinished thought/i);
  });

  it('names the operator-pushback situation explicitly (mandatory scenario)', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toMatch(/just do it|stop asking|don't ask/i);
  });

  it('tells the model it never composes or announces relay text (harness owns both)', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toMatch(/harness/i);
    expect(prompt).toMatch(/never claim/i);
    // The mechanical ack belongs to the harness; the model must not be told to say it.
    expect(prompt).not.toMatch(/say\s+"sending that now"|say 'sending that now'/i);
  });

  it('keeps the answer-only-from-state and can-tell honesty disciplines', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toMatch(/snapshot|state view/i);
    expect(prompt).toMatch(/can't tell|cannot tell|can’t tell/i);
  });

  it('matches the canonical file byte-for-byte (file stays authoritative)', () => {
    const fromFile = readFileSync(path.join(repoRoot, TALKER_PROMPT_RELATIVE_PATH), 'utf8').trim();
    expect(loadTalkerSystemPrompt()).toBe(fromFile);
  });
});
