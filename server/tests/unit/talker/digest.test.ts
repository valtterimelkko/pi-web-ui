import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// RED: modules do not exist yet.
import {
  DIGEST_PROMPT_RELATIVE_PATH,
  TALKER_DIGEST_HEADLINES_MAX_CHARS,
  TALKER_DIGEST_MAX_TEXT_CHARS,
  TALKER_DIGEST_SUMMARY_MAX_CHARS,
  buildDigestMessages,
  digestTurn,
  normaliseDigest,
} from '../../../src/talker/digest.js';
import type { ChatMessage, TalkerModelClient } from '../../../src/talker/types.js';

/**
 * P17 package A — the digest the reading levels speak instead of the raw answer.
 *
 * The digest is the TALKER in the reading path: the surface used to hand the
 * worker's words straight to TTS, and now it can hand them to the talker first
 * and speak the talker's condensation. The prompt is the whole quality contract,
 * so it is canonical file content (byte-pinned here) rather than a string buried
 * in code.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const WORKER_TEXT = [
  'I refactored the auth branch and the suite is green.',
  'The migration is staged but the second half is unwritten.',
  'The deploy needs your approval before it runs.',
].join(' ');

function makeModel(reply: string): TalkerModelClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async completeTurn(messages) {
      calls.push(messages);
      return { text: reply, ttftMs: 5, totalMs: 20 };
    },
  };
}

describe('talker digest prompt (canonical file)', () => {
  it('is loaded from the talker prompt family, byte for byte', () => {
    expect(DIGEST_PROMPT_RELATIVE_PATH).toBe('scripts/talker-prompts/digest.txt');
    const fromFile = readFileSync(path.join(repoRoot, DIGEST_PROMPT_RELATIVE_PATH), 'utf8').trim();
    const system = buildDigestMessages({ kind: 'summary', text: WORKER_TEXT })[0];
    expect(system.role).toBe('system');
    expect(system.content).toBe(fromFile);
  });

  it('states the two extractions, including the exact Headlines shape', () => {
    const prompt = readFileSync(path.join(repoRoot, DIGEST_PROMPT_RELATIVE_PATH), 'utf8');
    // Headlines is a DIFFERENT extraction, not a shorter summary: one line,
    // status plus asks.
    expect(prompt).toMatch(/Done:/);
    expect(prompt).toMatch(/Needs you:/);
    expect(prompt).toMatch(/one sentence/i);
    // Summary: plain spoken prose for the ear.
    expect(prompt).toMatch(/plain spoken prose/i);
    // And the honesty rule that keeps a digest from inventing work.
    expect(prompt).toMatch(/never invent/i);
  });
});

describe('digest message construction', () => {
  it('puts the worker’s output in a delimited user message, never in the system prompt', () => {
    const messages = buildDigestMessages({ kind: 'summary', text: WORKER_TEXT });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain(WORKER_TEXT);
    expect(messages[1].content).toMatch(/WORKER OUTPUT TO DIGEST/);
    expect(messages[0].content).not.toContain(WORKER_TEXT);
  });

  it('names the level so the model produces the extraction that was asked for', () => {
    const summary = buildDigestMessages({ kind: 'summary', text: WORKER_TEXT })[1].content;
    const headlines = buildDigestMessages({ kind: 'headlines', text: WORKER_TEXT })[1].content;
    expect(summary).not.toBe(headlines);
    expect(summary).toMatch(/summary/i);
    expect(headlines).toMatch(/headlines/i);
  });

  it('tells the model what the operator has already heard, so a mid-speech flip never repeats it', () => {
    const messages = buildDigestMessages({
      kind: 'summary',
      text: 'Charlie the remaining work.',
      spokenPrefix: 'Alpha the part they heard. Bravo the rest of it.',
    });
    expect(messages[1].content).toMatch(/ALREADY HEARD/);
    expect(messages[1].content).toContain('Alpha the part they heard.');
    expect(messages[1].content).toMatch(/do not repeat/i);
  });

  it('omits the already-heard section entirely when there is none', () => {
    const messages = buildDigestMessages({ kind: 'summary', text: WORKER_TEXT });
    expect(messages[1].content).not.toMatch(/ALREADY HEARD/);
  });
});

describe('digest normalisation', () => {
  it('keeps Headlines to ONE line, whatever the model returned', () => {
    const digest = normaliseDigest('headlines', 'Done: the build is green.\nNeeds you: nothing.\n');
    expect(digest).toBe('Done: the build is green. Needs you: nothing.');
    expect(digest).not.toContain('\n');
  });

  it('caps a runaway Headlines line instead of letting it become a paragraph', () => {
    const digest = normaliseDigest('headlines', 'Done: ' + 'x'.repeat(2000));
    expect(digest).not.toBeNull();
    expect((digest as string).length).toBeLessThanOrEqual(TALKER_DIGEST_HEADLINES_MAX_CHARS);
  });

  it('caps a runaway Summary too', () => {
    const digest = normaliseDigest('summary', 'y'.repeat(5000));
    expect((digest as string).length).toBeLessThanOrEqual(TALKER_DIGEST_SUMMARY_MAX_CHARS);
  });

  it('strips wrapping quotes the model may add around its own answer', () => {
    expect(normaliseDigest('summary', '"the build is green"')).toBe('the build is green');
    expect(normaliseDigest('headlines', '“Done: the build. Needs you: nothing.”')).toBe(
      'Done: the build. Needs you: nothing.'
    );
  });

  it('returns null when the model replied with nothing but quotes', () => {
    expect(normaliseDigest('summary', '""')).toBeNull();
    expect(normaliseDigest('headlines', '“”')).toBeNull();
  });

  it('returns null rather than speaking whitespace as if it were the turn', () => {
    expect(normaliseDigest('summary', '   \n  ')).toBeNull();
    expect(normaliseDigest('headlines', '')).toBeNull();
  });
});

describe('digestTurn', () => {
  it('asks the model once and returns the normalised digest', async () => {
    const model = makeModel('Done: the build is green.\nNeeds you: the deploy approval.');
    const outcome = await digestTurn(model, { kind: 'headlines', text: WORKER_TEXT });
    expect(model.calls).toHaveLength(1);
    expect(outcome.digest).toBe('Done: the build is green. Needs you: the deploy approval.');
    expect(outcome.totalMs).toBe(20);
  });

  it('fails honestly on an empty model reply instead of returning silence as the answer', async () => {
    const model = makeModel('   ');
    await expect(digestTurn(model, { kind: 'summary', text: WORKER_TEXT })).rejects.toThrow(
      /empty digest/i
    );
  });

  it('refuses a text longer than the digest budget rather than silently digesting a fragment', async () => {
    const model = makeModel('a digest');
    const huge = 'x'.repeat(TALKER_DIGEST_MAX_TEXT_CHARS + 1);
    await expect(digestTurn(model, { kind: 'summary', text: huge })).rejects.toThrow(/too long/i);
    expect(model.calls).toHaveLength(0);
  });

  it('treats a quotes-only reply as an empty digest and fails honestly', async () => {
    const model = makeModel('""');
    await expect(digestTurn(model, { kind: 'summary', text: WORKER_TEXT })).rejects.toThrow(
      /empty digest/i
    );
  });

  it('fails on empty input rather than asking the model to digest nothing', async () => {
    const model = makeModel('a digest');
    await expect(digestTurn(model, { kind: 'summary', text: '   ' })).rejects.toThrow(/no text/i);
    expect(model.calls).toHaveLength(0);
  });

  it('never calls a second model or invents a digest when the model fails', async () => {
    const model: TalkerModelClient = {
      completeTurn: vi.fn().mockRejectedValue(new Error('provider down')),
    };
    await expect(digestTurn(model, { kind: 'summary', text: WORKER_TEXT })).rejects.toThrow(
      /provider down/
    );
    expect(model.completeTurn).toHaveBeenCalledTimes(1);
  });
});
