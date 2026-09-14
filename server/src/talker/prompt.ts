/**
 * The talker's system prompt.
 *
 * Canonical source: scripts/talker-prompts/v3-harness.txt (the v3 harness
 * variant derived from the safety-validated v2-structured.txt; the frozen v2
 * file is never modified). The file is the authority — this loader reads it at
 * runtime and a unit test pins byte-equality, so prompt drift fails CI rather
 * than silently diverging.
 *
 * The prompt justifies the confirmation gate rather than merely asserting it
 * (plan §10.11 binding finding): a prompt that only asserted the rule
 * abandoned the gate under operator pushback in 2 of 3 runs; the justified
 * variant held it 5 of 5.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Talker');

export const TALKER_PROMPT_RELATIVE_PATH = 'scripts/talker-prompts/v3-harness.txt';

/**
 * The digest prompt (P17 reading levels) — a separate canonical file for the
 * separate job: turning the worker's output into speech the operator hears,
 * with no gate, no draft and no relay anywhere near it.
 */
export const DIGEST_PROMPT_RELATIVE_PATH = 'scripts/talker-prompts/digest.txt';

const promptCache = new Map<string, string>();

function repoRoot(): string {
  // This module lives at <repo>/server/src/talker/prompt.ts at development
  // time and <repo>/server/dist/talker/prompt.js when compiled — both are
  // exactly three levels below the repository root.
  return new URL('../../../', import.meta.url).pathname;
}

export function loadTalkerSystemPrompt(): string {
  return loadPromptText(TALKER_PROMPT_RELATIVE_PATH);
}

/** The digest system prompt (P17). Same loader, same byte-pinned file rule. */
export function loadDigestSystemPrompt(): string {
  return loadPromptText(DIGEST_PROMPT_RELATIVE_PATH);
}

/**
 * Load one canonical prompt file, trimmed, cached per path. The file is the
 * authority — a unit test pins byte-equality, so prompt drift fails CI rather
 * than silently diverging.
 */
export function loadPromptText(relativePath: string): string {
  const cached = promptCache.get(relativePath);
  if (cached !== undefined) return cached;
  const filePath = `${repoRoot()}${relativePath}`;
  try {
    const text = readFileSync(filePath, 'utf8').trim();
    promptCache.set(relativePath, text);
    return text;
  } catch (error) {
    logger.error('Failed to load talker prompt', { filePath, error });
    throw new Error(
      `Cannot load talker prompt from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Test seam: drop the cache so a test can re-load after editing the file. */
export function resetTalkerPromptCache(): void {
  promptCache.clear();
}
