/**
 * C3a (contract 1.58.0): strict, bounded, pure completion-block parser.
 *
 * Finds the LAST protocol block in a piece of assistant text, parses it,
 * validates it against the pi-completion/v1 schema, and returns either the
 * parsed block (with the delimiter that matched) or a typed error. It never
 * throws on model output.
 *
 * Delimiter rules (chosen so a model can write the block reliably and a
 * parser can find it without ambiguity):
 *
 * - An OPENING fence is a line with at most three leading spaces, then a run
 *   of at least three backticks, then optional whitespace and an info string
 *   that is exactly `completion` (the protocol delimiter), exactly `json`
 *   (tolerated fallback), or empty (tolerated fallback). Backticks inside a
 *   line (a quoted template, inline code) never open a block.
 * - The CLOSING fence is the next line containing only backticks (optionally
 *   surrounded by whitespace) — a run at least as long as the opening run.
 *   A four-backtick outer fence therefore closes an inner three-backtick
 *   block, and a block quoted inside another document still parses.
 * - A new opening while a candidate is open abandons the previous attempt
 *   (a model retry): the complete later block wins.
 * - Correction 01 (parent decision), one narrow tolerance: a fence with info
 *   string `json` (or none) is accepted as a block ONLY when its parsed
 *   object carries exactly `"schema": "pi-completion/v1"` — the schema tag is
 *   the marker. Any other `json` fence stays "no block". A malformed
 *   `json`-tagged fence produces the typed error, but only when no complete
 *   `completion` block exists anywhere (a trailing code example after a
 *   delivered block must not turn into a false completionError). The parsed
 *   result records which delimiter matched: `completion` | `json-tagged`.
 * - The scan window is bounded: only the last COMPLETION_PARSE_WINDOW_CHARS
 *   characters are considered, and any block whose content exceeds
 *   COMPLETION_BLOCK_MAX_CHARS is a typed `OVERSIZED_BLOCK` error rather
 *   than an unbounded parse.
 */
import {
  COMPLETION_BLOCK_MAX_CHARS,
  COMPLETION_PARSE_WINDOW_CHARS,
  COMPLETION_SCHEMA_NAME,
  validateCompletionBlock,
} from './completion-schema.js';
import type { CompletionBlock, CompletionDelimiter, CompletionParseError, CompletionParseResult } from '../types.js';

type FenceClass = 'completion' | 'json' | 'none';

interface RawBlock {
  fenceClass: FenceClass;
  content: string;
  complete: boolean;
}

const OPENING_FENCE = /^[ ]{0,3}(`{3,})[ \t]*([a-z0-9_-]*)[ \t]*$/;
const CLOSING_FENCE = (minLength: number) => new RegExp(`^[ ]{0,3}\`{${minLength},}[ \t]*$`);

function fenceClassOf(info: string): FenceClass | undefined {
  if (info === 'completion') return 'completion';
  if (info === 'json') return 'json';
  if (info === '') return 'none';
  return undefined;
}

/** Extract every fenced candidate (complete or not) from a bounded window. */
function scanBlocks(text: string): RawBlock[] {
  const lines = text.split('\n');
  const blocks: RawBlock[] = [];
  let openFenceClass: FenceClass | undefined;
  let openFenceLength = 0;
  let current: string[] | undefined;

  for (const line of lines) {
    if (current === undefined) {
      const opening = OPENING_FENCE.exec(line);
      const fenceClass = opening ? fenceClassOf(opening[2]) : undefined;
      if (opening && fenceClass) {
        openFenceClass = fenceClass;
        openFenceLength = opening[1].length;
        current = [];
      }
      continue;
    }
    // A closing fence takes precedence over a reopen: a backticks-only line
    // of at least the opening length always closes (an untagged reopen is
    // indistinguishable from a close, and meaningless anyway — the schema
    // tag is the marker).
    if (CLOSING_FENCE(openFenceLength).test(line)) {
      blocks.push({ fenceClass: openFenceClass ?? 'completion', content: current.join('\n'), complete: true });
      current = undefined;
      openFenceClass = undefined;
      openFenceLength = 0;
      continue;
    }
    // A new protocol opening while a candidate is open means the previous
    // attempt was abandoned (a model retry): record it as unclosed and start
    // fresh, so a complete later block wins over an earlier unclosed opening.
    const reopening = OPENING_FENCE.exec(line);
    if (reopening && fenceClassOf(reopening[2])) {
      blocks.push({ fenceClass: openFenceClass ?? 'completion', content: current.join('\n'), complete: false });
      openFenceClass = fenceClassOf(reopening[2]);
      openFenceLength = reopening[1].length;
      current = [];
      continue;
    }
    current.push(line);
    if (current.join('\n').length > COMPLETION_BLOCK_MAX_CHARS) {
      // Bound the accumulation: an oversized candidate is recorded as such
      // and the scan continues after it, so no input can grow memory without
      // bound. Treat it as closed at the cap; the typed error below wins.
      blocks.push({ fenceClass: openFenceClass ?? 'completion', content: current.join('\n'), complete: true });
      current = undefined;
      openFenceClass = undefined;
      openFenceLength = 0;
    }
  }
  if (current !== undefined) {
    blocks.push({ fenceClass: openFenceClass ?? 'completion', content: current.join('\n'), complete: false });
  }
  return blocks;
}

function tryJson(content: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function carriesSchemaTag(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === COMPLETION_SCHEMA_NAME;
}

/**
 * Parse the LAST completion block in `text`. Pure: no I/O, no throwing —
 * every failure mode is a typed `CompletionParseError`. The result records
 * which delimiter matched (`completion` or the correction-01 `json-tagged`
 * tolerance).
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

  // Selection (correction-01 semantics):
  // - every complete `completion` candidate sets the outcome (last one wins,
  //   success or typed error — it is the protocol delimiter);
  // - a complete `json`/untagged candidate sets the outcome only when it is a
  //   protocol attempt that VALIDATES (exact schema tag) — last-wins applies;
  // - json/untagged ERROR candidates (malformed, or tagged-but-invalid) are
  //   remembered separately and surface only when no `completion` outcome
  //   exists anywhere, so a trailing code example after a delivered block
  //   cannot fake a failure.
  let outcome: CompletionParseResult | undefined;
  let jsonErrorCandidate: RawBlock | undefined;
  let hasCompleteCompletionFence = false;
  let hasUnclosedCompletionFence = false;

  const completionOutcome = (candidate: RawBlock): CompletionParseResult => {
    if (candidate.content.length > COMPLETION_BLOCK_MAX_CHARS) {
      return {
        ok: false,
        error: {
          code: 'OVERSIZED_BLOCK',
          message: `Completion block exceeds the ${COMPLETION_BLOCK_MAX_CHARS}-character cap`,
        },
      };
    }
    const parsedJson = tryJson(candidate.content);
    if (!parsedJson.ok) {
      return {
        ok: false,
        error: { code: 'MALFORMED_JSON', message: `Completion block is not valid JSON: ${parsedJson.reason}` },
      };
    }
    if (typeof parsedJson.value !== 'object' || parsedJson.value === null || Array.isArray(parsedJson.value)) {
      return {
        ok: false,
        error: { code: 'MALFORMED_JSON', message: 'Completion block JSON must be an object' },
      };
    }
    const validated = validateCompletionBlock(parsedJson.value);
    if (validated.ok) return { ok: true, block: validated.block, delimiter: 'completion' };
    const error: CompletionParseError = { code: 'SCHEMA_VIOLATION', message: validated.message };
    if (validated.fieldPath !== undefined) error.fieldPath = validated.fieldPath;
    return { ok: false, error };
  };

  for (const candidate of blocks) {
    if (!candidate.complete) {
      if (candidate.fenceClass === 'completion') hasUnclosedCompletionFence = true;
      continue;
    }
    if (candidate.fenceClass === 'completion') {
      hasCompleteCompletionFence = true;
      outcome = completionOutcome(candidate);
      continue;
    }
    // json / none class: only the schema tag makes it a protocol attempt.
    if (candidate.content.length > COMPLETION_BLOCK_MAX_CHARS) continue;
    const parsedJson = tryJson(candidate.content);
    if (!parsedJson.ok) {
      if (candidate.fenceClass === 'json') jsonErrorCandidate = candidate;
      continue; // untagged malformed fences are not attempts
    }
    if (!carriesSchemaTag(parsedJson.value)) continue; // stays "no block"
    const validated = validateCompletionBlock(parsedJson.value);
    if (validated.ok) {
      outcome = { ok: true, block: validated.block, delimiter: 'json-tagged' };
    } else {
      jsonErrorCandidate = candidate;
    }
  }

  if (outcome?.ok) return outcome;
  if (outcome && !outcome.ok) return outcome;

  // Error fallback: a malformed or schema-invalid tagged fence is the typed
  // error — but only when no `completion` outcome exists anywhere, so a
  // trailing code example after a delivered block cannot fake a failure.
  if (!hasCompleteCompletionFence && jsonErrorCandidate) {
    const parsedJson = tryJson(jsonErrorCandidate.content);
    if (!parsedJson.ok) {
      return {
        ok: false,
        error: { code: 'MALFORMED_JSON', message: `Completion block is not valid JSON: ${parsedJson.reason}` },
      };
    }
    const validated = validateCompletionBlock(parsedJson.value);
    if (!validated.ok) {
      const error: CompletionParseError = { code: 'SCHEMA_VIOLATION', message: validated.message };
      if (validated.fieldPath !== undefined) error.fieldPath = validated.fieldPath;
      return { ok: false, error };
    }
  }

  if (hasUnclosedCompletionFence) {
    return {
      ok: false,
      error: { code: 'UNCLOSED_FENCE', message: 'The last ```completion block was never closed' },
    };
  }

  return { ok: false, error: { code: 'NO_BLOCK', message: 'No ```completion block found' } };
}
