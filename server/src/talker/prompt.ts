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

let cached: string | null = null;

function repoRoot(): string {
  // This module lives at <repo>/server/src/talker/prompt.ts at development
  // time and <repo>/server/dist/talker/prompt.js when compiled — both are
  // exactly three levels below the repository root.
  return new URL('../../../', import.meta.url).pathname;
}

export function loadTalkerSystemPrompt(): string {
  if (cached) return cached;
  const filePath = `${repoRoot()}${TALKER_PROMPT_RELATIVE_PATH}`;
  try {
    cached = readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    logger.error('Failed to load talker system prompt', { filePath, error });
    throw new Error(`Cannot load talker system prompt from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cached;
}

/** Test seam: drop the cache so a test can re-load after editing the file. */
export function resetTalkerPromptCache(): void {
  cached = null;
}
