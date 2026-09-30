/**
 * C3a (contract 1.58.0): strict, bounded, pure completion-block parser.
 *
 * Finds the LAST complete ```completion fenced block in a piece of assistant
 * text, parses it, validates it against the pi-completion/v1 schema, and
 * returns either the parsed block or a typed error. It never throws on model
 * output.
 *
 * Delimiter rules (chosen so a model can write the block reliably and a
 * parser can find it without ambiguity):
 *
 * - An OPENING fence is a line with at most three leading spaces, then a run
 *   of at least three backticks, then optional whitespace and the exact info
 *   string `completion`. Backticks inside a line (a quoted template, inline
 *   code) never open a block.
 * - The CLOSING fence is the next line containing only backticks (optionally
 *   surrounded by whitespace) — a run at least as long as the opening run.
 *   A four-backtick outer fence therefore closes an inner three-backtick
 *   block, and a block quoted inside another document still parses.
 * - Among all complete blocks, the LAST one wins; earlier examples or
 *   abandoned attempts are ignored. If an opening never closes and no later
 *   complete block exists, that is a typed `UNCLOSED_FENCE` error.
 * - The scan window is bounded: only the last COMPLETION_PARSE_WINDOW_CHARS
 *   characters are considered, and any block whose content exceeds
 *   COMPLETION_BLOCK_MAX_CHARS is a typed `OVERSIZED_BLOCK` error rather
 *   than an unbounded parse.
 */
import {
  COMPLETION_BLOCK_MAX_CHARS,
  COMPLETION_PARSE_WINDOW_CHARS,
  validateCompletionBlock,
} from './completion-schema.js';
import type { CompletionBlock, CompletionParseError, CompletionParseResult } from '../types.js';

interface RawBlock {
  content: string;
  complete: boolean;
}

const OPENING_FENCE = /^[ ]{0,3}(`{3,})[ \t]*completion[ \t]*$/;
const CLOSING_FENCE = (minLength: number) => new RegExp(`^[ ]{0,3}\`{${minLength},}[ \t]*$`);

/** Extract every fenced candidate (complete or not) from a bounded window. */
function scanBlocks(text: string): RawBlock[] {
  const lines = text.split('\n');
  const blocks: RawBlock[] = [];
  let openFenceLength = 0;
  let current: string[] | undefined;

  for (const line of lines) {
    if (current === undefined) {
      const opening = OPENING_FENCE.exec(line);
      if (opening) {
        openFenceLength = opening[1].length;
        current = [];
      }
      continue;
    }
    // A new opening while a candidate is open means the previous attempt was
    // abandoned (a model retry): record it as unclosed and start fresh, so a
    // complete later block wins over an earlier unclosed opening.
    if (OPENING_FENCE.test(line)) {
      blocks.push({ content: current.join('\n'), complete: false });
      const reopening = OPENING_FENCE.exec(line);
      openFenceLength = reopening ? reopening[1].length : 3;
      current = [];
      continue;
    }
    if (CLOSING_FENCE(openFenceLength).test(line)) {
      blocks.push({ content: current.join('\n'), complete: true });
      current = undefined;
      openFenceLength = 0;
      continue;
    }
    current.push(line);
    if (current.join('\n').length > COMPLETION_BLOCK_MAX_CHARS) {
      // Bound the accumulation: an oversized candidate is recorded as such
      // and the scan continues after it, so no input can grow memory without
      // bound. Treat it as closed at the cap; the typed error below wins.
      blocks.push({ content: current.join('\n'), complete: true });
      current = undefined;
      openFenceLength = 0;
    }
  }
  if (current !== undefined) {
    blocks.push({ content: current.join('\n'), complete: false });
  }
  return blocks;
}

/**
 * Parse the LAST completion block in `text`. Pure: no I/O, no throwing —
 * every failure mode is a typed `CompletionParseError`.
 */
export function parseCompletionBlock(text: string | undefined | null): CompletionParseResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, error: { code: 'NO_BLOCK', message: 'No ```completion block found' } };
  }
  const windowStart = text.length > COMPLETION_PARSE_WINDOW_CHARS
    ? text.length - COMPLETION_PARSE_WINDOW_CHARS
    : 0;
  const window = windowStart > 0 ? text.slice(windowStart) : text;
  const blocks = scanBlocks(window);
  if (blocks.length === 0) {
    return { ok: false, error: { code: 'NO_BLOCK', message: 'No ```completion block found' } };
  }
  const last = blocks[blocks.length - 1];
  if (!last.complete) {
    return {
      ok: false,
      error: { code: 'UNCLOSED_FENCE', message: 'The last ```completion block was never closed' },
    };
  }
  if (last.content.length > COMPLETION_BLOCK_MAX_CHARS) {
    return {
      ok: false,
      error: {
        code: 'OVERSIZED_BLOCK',
        message: `Completion block exceeds the ${COMPLETION_BLOCK_MAX_CHARS}-character cap`,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last.content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: { code: 'MALFORMED_JSON', message: `Completion block is not valid JSON: ${reason}` },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: { code: 'MALFORMED_JSON', message: 'Completion block JSON must be an object' },
    };
  }
  const validated = validateCompletionBlock(parsed);
  if (!validated.ok) {
    const error: CompletionParseError = {
      code: 'SCHEMA_VIOLATION',
      message: validated.message,
    };
    if (validated.fieldPath !== undefined) error.fieldPath = validated.fieldPath;
    return { ok: false, error };
  }
  const block: CompletionBlock = validated.block;
  return { ok: true, block };
}
