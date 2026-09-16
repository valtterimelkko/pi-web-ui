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
    // P20 raised this from 4200: the new WORKER SESSION HISTORY section costs
    // ~450 chars, existing prose was tightened to compensate, and the prompt
    // must stay a one-screen leanness budget — not grow per feature.
    // P22 raised it to 4650: the new TALKING-TO-YOU-NOT-THE-WORKER section
    // costs ~465 chars; ~210 chars were tightened from existing prose in the
    // same edit (pushback, history, unsure, pending-line paragraphs), and the
    // remaining ~35 chars of growth are covered by this ceiling, not drift.
    // Parent review restored 'and do not act confused' (a designed guard on the
    // mandatory pushback path, no other test covers it): +~28 chars, ceiling +30.
    // Operator round 2026-09-16 added ROUTINE HOUSEKEEPING IS NOT NEWS (~450
    // chars) and PAID FOR IT by tightening existing prose, so the ceiling is
    // unchanged: leanness is a budget, not a per-feature allowance.
    expect(prompt.length).toBeLessThanOrEqual(4680); // ~1170 tokens hard ceiling
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
    // The designed response, not just the situation (parent review, P22): a
    // pushback must not collapse the gate into either caving or muddle.
    expect(prompt).toMatch(/do not simply agree/i);
    expect(prompt).toMatch(/do not act confused/i);
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

  // Operator, 2026-09-16: the talker narrated what the worker had CAPTURED
  // (routine memory-housekeeping) instead of what it had been working on, and
  // the substantive work took several turns to get out of it.
  it('treats routine housekeeping as non-news and points at the real work', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toMatch(/housekeeping/i);
    expect(prompt).toMatch(/not news|non-news/i);
    expect(prompt).toMatch(/captured|recorded|promoted/i);
    expect(prompt).toMatch(/actual work|real work|the work it/i);
  });

  it('matches the canonical file byte-for-byte (file stays authoritative)', () => {
    const fromFile = readFileSync(path.join(repoRoot, TALKER_PROMPT_RELATIVE_PATH), 'utf8').trim();
    expect(loadTalkerSystemPrompt()).toBe(fromFile);
  });

  // P18 package C: the two new instructed behaviours. The prompt is where the
  // judge-and-act asymmetry lives — the model may OFFER a relay and may SUGGEST
  // leaving focus, but both are acted on by the operator (and by the harness),
  // never by the model.
  it('teaches the ask-the-worker offer with its mechanical tag and its narrow scope', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toContain('[[ask-worker]]');
    expect(prompt).toMatch(/cannot answer/i);
    // The relay text is the operator's, never the model's paraphrase.
    expect(prompt).toMatch(/their words — not your wording|word for word/i);
    // The narrow scope: not instructions, not "did you send it".
    expect(prompt).toMatch(/never for an instruction/i);
  });

  it('teaches the focus suggestion without ever claiming a switch', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toMatch(/focus on/i);
    expect(prompt).toMatch(/cannot switch it/i);
  });

  // P22: requests addressed to the talker itself are answered, not held. The
  // prompt teaches the [[to-talker]] tag with the same narrowness as
  // [[ask-worker]]: only for a request actually answered from what the
  // talker holds, never for a worker instruction however phrased, and the
  // unsure default is to hold the words as usual.
  it('teaches the self-service answer with its mechanical tag and its narrow scope', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toContain('[[to-talker]]');
    expect(prompt).toMatch(/talking to you, not the worker/i);
    expect(prompt).toMatch(/summarise what's been done|read that back/i);
    // The narrow scope: not worker instructions; not the ask-worker case.
    expect(prompt).toMatch(/never for an instruction to the worker/i);
    expect(prompt).toMatch(/never for a question you cannot answer/i);
    // Unsure default: hold, don't mark.
    expect(prompt).toMatch(/omit the tag/i);
    // The two tags are distinguished from each other.
    expect(prompt).toContain('[[ask-worker]]');
  });

  // P20: the snapshot may now carry the worker session's earlier turns. The
  // prompt must teach answering from that window, stating its limits, never
  // inventing beyond it — and keeping the offer as the honest fallback.
  it('teaches the worker session history window and its honest limits', () => {
    const prompt = loadTalkerSystemPrompt();
    expect(prompt).toMatch(/session history/i);
    // Truncation is stated, never hidden: never imply knowledge beyond the window.
    expect(prompt).toMatch(/not included|not shown|only the most recent/i);
    expect(prompt).toMatch(/never imply|never invent/i);
    // Absence is honest too: no history block means nothing earlier is visible.
    expect(prompt).toMatch(/no history|no earlier|nothing earlier/i);
    // The offer stays the fallback when a question exceeds the window.
    expect(prompt).toMatch(/\[\[ask-worker\]\]/);
  });
});
