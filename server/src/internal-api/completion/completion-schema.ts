/**
 * C3a (contract 1.58.0): the child completion block — canonical schema.
 *
 * A child emits one fenced code block at the end of its task. The fence info
 * string names the schema so a parser can find the block without ambiguity:
 *
 *   ```completion
 *   {"schema":"pi-completion/v1","status":"done", ...}
 *   ```
 *
 * The wire types live in `../types.js` (the machine-readable contract); this
 * module owns the schema name, the bounds and the zod validation that
 * produces them. Exported so the C1 contract snapshot can carry the schema.
 */
import { z } from 'zod';

import type { CompletionBlock } from '../types.js';

/** Schema name required inside every block. */
export const COMPLETION_SCHEMA_NAME = 'pi-completion/v1';

/** Fence info string that opens a completion block. */
export const COMPLETION_FENCE_INFO = 'completion';

/**
 * Maximum characters of block content (between the fences). A larger block is
 * a typed `OVERSIZED_BLOCK` parse error, never a truncated parse.
 */
export const COMPLETION_BLOCK_MAX_CHARS = 16_384;

/**
 * Tail window the parser scans (and the run/turn trackers keep) so a block at
 * the very end of a long answer is always inside it. At least 4× the block
 * cap: trailing prose after the fence can never push a compliant block out of
 * the window.
 */
export const COMPLETION_PARSE_WINDOW_CHARS = 65_536;

/** Per-field bounds so a validated block is bounded by construction. */
const MAX_SUMMARY_CHARS = 2_000;
const MAX_COMMANDS = 50;
const MAX_TEST_CASES = 100;
const MAX_COMMITS = 50;
const MAX_FILES = 200;
const MAX_ISSUES = 50;
const MAX_COMMAND_CHARS = 2_000;
const MAX_NOTE_CHARS = 2_000;
const MAX_NAME_CHARS = 500;
const MAX_PATH_CHARS = 1_024;
const MAX_REASON_CHARS = 4_000;
/** git short SHA (7) through SHA-256 (64), hex only. */
const SAFE_SHA = /^[0-9a-f]{7,64}$/i;

const commandSchema = z.object({
  command: z.string().min(1).max(MAX_COMMAND_CHARS),
  exitCode: z.number().int().min(0).max(255),
  note: z.string().max(MAX_NOTE_CHARS).optional(),
}).strict();

const testSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_CHARS),
  result: z.enum(['pass', 'fail', 'skip']),
  note: z.string().max(MAX_NOTE_CHARS).optional(),
}).strict();

const commitSchema = z.object({
  sha: z.string().regex(SAFE_SHA),
  repo: z.string().min(1).max(MAX_PATH_CHARS),
  subject: z.string().max(MAX_NOTE_CHARS).optional(),
}).strict();

export const completionBlockSchema = z.object({
  schema: z.literal(COMPLETION_SCHEMA_NAME),
  status: z.enum(['done', 'blocked', 'partial']),
  summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
  commands: z.array(commandSchema).max(MAX_COMMANDS).optional(),
  tests: z.array(testSchema).max(MAX_TEST_CASES).optional(),
  commits: z.array(commitSchema).max(MAX_COMMITS).optional(),
  filesChanged: z.array(z.string().min(1).max(MAX_PATH_CHARS)).max(MAX_FILES).optional(),
  openIssues: z.array(z.string().min(1).max(MAX_NOTE_CHARS)).max(MAX_ISSUES).optional(),
  blockedReason: z.string().min(1).max(MAX_REASON_CHARS).optional(),
}).strict()
  .refine(
    (value) => value.status !== 'blocked' || (value.blockedReason !== undefined && value.blockedReason.length > 0),
    { path: ['blockedReason'], message: 'blockedReason is required when status is "blocked"' },
  );

/** First failing issue, as a dotted field path (e.g. `commands.0.exitCode`). */
export function firstIssuePath(error: z.ZodError): string | undefined {
  const issue = error.issues[0];
  if (!issue) return undefined;
  // Strict-object unknown keys report on the object itself; name the first
  // unknown key so the field path is still actionable.
  if (issue.code === 'unrecognized_keys') {
    const keys = (issue as { keys?: unknown[] }).keys;
    return keys && keys.length > 0 ? String(keys[0]) : undefined;
  }
  if (issue.path.length === 0) return undefined;
  return issue.path.map((segment) => String(segment)).join('.');
}

/**
 * Validate one parsed JSON value against the completion schema. Returns the
 * typed block or the first issue's field path — never throws.
 */
export function validateCompletionBlock(value: unknown): { ok: true; block: CompletionBlock } | { ok: false; fieldPath?: string; message: string } {
  const result = completionBlockSchema.safeParse(value);
  if (result.success) return { ok: true, block: result.data };
  const issue = result.error.issues[0];
  return {
    ok: false,
    fieldPath: firstIssuePath(result.error),
    message: issue ? `${issue.message}` : 'completion block failed schema validation',
  };
}
