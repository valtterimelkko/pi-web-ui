#!/usr/bin/env node
/**
 * Guarded local patch for @earendil-works/pi-ai 0.87.x — streamed tool-call
 * arguments (2026-09-12 event-loop stall, Defect B / the trigger).
 *
 * RE-EVALUATED 2026-09-22 for 0.87.1 (frontier-models update): the 0.87.1
 * dist/api/openai-completions.js still contains the identical per-delta
 * parseStreamingJson block and no upstream throttle, so the patch carries
 * forward unchanged (stream anchor x1, defect block byte-identical).
 *
 * WHY THIS EXISTS
 * pi-ai's openai-completions adapter re-parsed the accumulated tool-call
 * argument buffer on EVERY streamed delta:
 *   block.partialArgs = (block.partialArgs ?? "") + delta;    // O(n) copy
 *   block.arguments   = parseStreamingJson(block.partialArgs); // O(n) parse
 * parseStreamingJson on an incomplete JSON string runs two throwing
 * JSON.parse attempts, a full repairJson char walk and partialParse — linear
 * per call, quadratic over the stream, synchronous on the event loop.
 * Measured on this host: ~0.4 ms/call at 5 KB rising to ~14 ms/call at
 * 460 KB; one runaway 131k-token glm-5.3-flash generation integrated to
 * ~124 s of pure main-thread CPU and stalled the production server for
 * ~11 minutes (see /tmp/r1-investigation/R1-REPORT.md and
 * server/tests/unit/pi-ai/toolstream-parse-regression.test.ts).
 *
 * WHAT THE PATCH DOES (behaviour-compatible for well-formed streams)
 * 1. Parses accumulated arguments on a ~250 ms throttle instead of per delta.
 *    The authoritative final parse in finishBlock is unchanged, so the
 *    completed message is byte-for-byte identical; only the *progressive*
 *    refresh of block.arguments lags by at most one throttle window.
 * 2. Aborts the request with a clear error once accumulated arguments exceed
 *    64 KB (MAX_STREAMING_TOOL_ARGS_CHARS) instead of streaming on to the
 *    provider token ceiling. Real tool arguments are a few KB at most; the
 *    incident's final arguments were 549 bytes.
 *
 * MAINTAINABILITY COST (deliberate, documented)
 * This edits a file inside node_modules. It is applied idempotently to every
 * physical pi-ai copy under the repo's node_modules (there are TWO: the root
 * copy used by server code, and the nested copy inside
 * @earendil-works/pi-coding-agent used by in-process hosted pi sessions —
 * nearest node_modules wins, and the nested copy is the one that stalled).
 * It is re-applied automatically on `npm ci` / `npm install` via the root
 * package.json "postinstall" hook. The script FAILS LOUDLY (exit 1) when the
 * pi-ai version or file content is not exactly what it knows how to patch,
 * and server/tests/unit/pi-ai/toolstream-parse-regression.test.ts fails
 * independently if the patch is missing. When pi-ai is upgraded, this script
 * must be re-evaluated: if upstream ships an equivalent fix, delete this
 * script, the postinstall hook and the guard test; otherwise update the
 * anchors below for the new version.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '0.87.1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATCH_MARKER = 'PARTIAL_ARGS_PARSE_INTERVAL_MS';

/** Inserted once, before the adapter's `stream` export. */
const CONSTANTS_ANCHOR = 'export const stream = (model, context, options) => {';
const CONSTANTS_BLOCK = `// pi-web-ui local patch (scripts/patch-pi-ai-toolstream.mjs): streaming
// tool-call arguments are parsed on a ~250ms throttle instead of every delta,
// and accumulation is capped. Per-delta parsing of a growing buffer is O(n)
// per delta (quadratic overall, synchronous) and stalls the event loop on
// long streams (2026-09-12 incident).
const PARTIAL_ARGS_PARSE_INTERVAL_MS = 250;
const MAX_STREAMING_TOOL_ARGS_CHARS = 64 * 1024;
const lastStreamingArgsParseAt = new WeakMap();
`;

/** The original defect block (exact content in pi-ai 0.87.0). */
const ORIGINAL_BLOCK = `                            if (toolCall.function?.arguments) {
                                delta = toolCall.function.arguments;
                                block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                                block.arguments = parseStreamingJson(block.partialArgs);
                            }`;

const PATCHED_BLOCK = `                            if (toolCall.function?.arguments) {
                                delta = toolCall.function.arguments;
                                const nextPartialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
                                if (nextPartialArgs.length > MAX_STREAMING_TOOL_ARGS_CHARS) {
                                    throw new Error(\`Tool call "\${block.name || "unknown"}" streamed more than \${MAX_STREAMING_TOOL_ARGS_CHARS} characters of arguments without completing; aborting the request to avoid unbounded accumulation (stalled-stream guard).\`);
                                }
                                block.partialArgs = nextPartialArgs;
                                const nowMs = Date.now();
                                if (nowMs - (lastStreamingArgsParseAt.get(block) ?? 0) >= PARTIAL_ARGS_PARSE_INTERVAL_MS) {
                                    lastStreamingArgsParseAt.set(block, nowMs);
                                    block.arguments = parseStreamingJson(nextPartialArgs);
                                }
                            }`;

/** Find every physical @earendil-works/pi-ai install under node_modules (bounded depth). */
function findPiAiCopies(dir, depth, results) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin' || entry.name.startsWith('.')) continue;
    if (entry.name === '@earendil-works') {
      const candidate = join(dir, entry.name, 'pi-ai');
      try {
        const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
        if (pkg.name === '@earendil-works/pi-ai' && !statSync(candidate).isSymbolicLink()) {
          results.push(candidate);
        }
      } catch { /* not a pi-ai package dir */ }
    }
    // Walk into every package dir: nested copies hide under e.g.
    // node_modules/@earendil-works/pi-coding-agent/node_modules/... (the copy
    // the in-process hosted pi sessions actually resolve).
    findPiAiCopies(join(dir, entry.name), depth + 1, results);
  }
}

const failures = [];
const patched = [];
const already = [];

const copies = [];
findPiAiCopies(join(repoRoot, 'node_modules'), 0, copies);

if (copies.length === 0) {
  failures.push('no @earendil-works/pi-ai install found under node_modules — nothing to patch (install first)');
}

for (const copy of copies) {
  const pkg = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
  const target = join(copy, 'dist', 'api', 'openai-completions.js');
  let source;
  try {
    source = readFileSync(target, 'utf8');
  } catch (error) {
    failures.push(`${copy}: cannot read ${target} (${error.message})`);
    continue;
  }

  if (pkg.version !== EXPECTED_VERSION) {
    failures.push(
      `${copy}: pi-ai version is ${pkg.version}, expected ${EXPECTED_VERSION}. ` +
      'The dependency was updated — re-evaluate this patch (if upstream now throttles streamed ' +
      'tool-args parsing itself, delete scripts/patch-pi-ai-toolstream.mjs, the postinstall hook ' +
      'and the guard test; otherwise update the script for the new version).',
    );
    continue;
  }

  if (source.includes(PATCH_MARKER)) {
    already.push(copy);
    continue;
  }

  const anchorCount = source.split(CONSTANTS_ANCHOR).length - 1;
  const originalCount = source.split(ORIGINAL_BLOCK).length - 1;
  if (anchorCount !== 1 || originalCount !== 1) {
    failures.push(
      `${copy}: dist/api/openai-completions.js does not match the expected 0.87.x content ` +
      `(stream anchor x${anchorCount}, defect block x${originalCount}). ` +
      'Refusing to patch unknown content — re-evaluate scripts/patch-pi-ai-toolstream.mjs.',
    );
    continue;
  }

  const patchedSource = source
    .replace(CONSTANTS_ANCHOR, `${CONSTANTS_BLOCK}\n${CONSTANTS_ANCHOR}`)
    .replace(ORIGINAL_BLOCK, PATCHED_BLOCK);
  writeFileSync(target, patchedSource);
  patched.push(copy);
}

for (const copy of already) console.log(`[patch-pi-ai] already patched: ${copy}`);
for (const copy of patched) console.log(`[patch-pi-ai] patched:        ${copy}`);
for (const failure of failures) console.error(`[patch-pi-ai] FAIL: ${failure}`);

if (failures.length > 0) {
  console.error('[patch-pi-ai] refusing to continue with unpatched/unknown pi-ai content.');
  process.exit(1);
}
console.log('[patch-pi-ai] all pi-ai copies carry the toolstream throttle/cap patch.');
