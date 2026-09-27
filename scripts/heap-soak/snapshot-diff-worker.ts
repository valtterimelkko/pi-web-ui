#!/usr/bin/env npx tsx
/**
 * Snapshot diff worker: runs in its OWN process (spawned with a large
 * `--max-old-space-size`, see snapshot-diff.ts) so that parsing two
 * potentially-huge `.heapsnapshot` JSON files never pressures the caller's
 * own heap. Reads two file paths from argv, prints a single JSON line to
 * stdout:
 *
 *   { before, after, growth, retainers, cutSpecs, cutBaseline, cutApplied }
 *
 * Each snapshot is parsed ONCE and the parsed object reused for both the
 * constructor aggregate and the retainer-graph analysis (which needs the raw
 * nodes/edges/strings). Retainer targets are the top-growing object
 * constructors plus `AgentSession` when present.
 */
import { readFileSync } from 'node:fs';
import { aggregateParsedByConstructor, diffAggregates } from '../../server/src/live-validation/heap-soak/snapshot-parse.js';
import {
  analyzeConstructorRetainers,
  buildSnapshotGraph,
  deriveCutSpecs,
  nodeName,
  nodeTypeName,
  runCutTest,
  type ConstructorRetainerAnalysis,
  type ParsedHeapSnapshot,
} from '../../server/src/live-validation/heap-soak/snapshot-retainers.js';

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error('usage: snapshot-diff-worker.ts <before.heapsnapshot> <after.heapsnapshot>');
  process.exit(64);
}

const MAX_RETAINER_TARGETS = 6;

const beforeParsed = JSON.parse(readFileSync(beforePath, 'utf8')) as ParsedHeapSnapshot;
const afterParsed = JSON.parse(readFileSync(afterPath, 'utf8')) as ParsedHeapSnapshot;
const before = aggregateParsedByConstructor(beforeParsed);
const after = aggregateParsedByConstructor(afterParsed);
const growth = diffAggregates(before, after);

const graph = buildSnapshotGraph(afterParsed);

// Object constructor names present in the after snapshot (one pass), so
// "top growers" can be restricted to real object constructors rather than
// primitive node types like `string`/`array`.
const objectNames = new Set<string>();
for (let i = 0; i < graph.nodeCount; i++) {
  if (nodeTypeName(graph, i) === 'object') objectNames.add(nodeName(graph, i));
}

const targets: string[] = [];
if (objectNames.has('AgentSession')) targets.push('AgentSession');
for (const grow of growth) {
  if (grow.deltaBytes <= 0 || targets.length >= MAX_RETAINER_TARGETS) continue;
  if (!objectNames.has(grow.label) || targets.includes(grow.label)) continue;
  targets.push(grow.label);
}

const retainers: ConstructorRetainerAnalysis[] = targets.map((target) => analyzeConstructorRetainers(graph, target, { maxChains: 3 }));

const cutSpecs: string[] = [];
// Union cut specs from every retainer target (nearest-target property hops), so
// the cut test covers both A1 retainers: `PiService.sessions` (from the
// AgentSession chain) and `process._events` (from the closure/context chain).
for (const analysis of retainers) {
  for (const spec of deriveCutSpecs(analysis, 2)) if (!cutSpecs.includes(spec)) cutSpecs.push(spec);
}
// A1's second retainer is the `subagent` extension's process-level exit
// listener; include it explicitly so the cut test measures both named
// retainers. runCutTest reports appliedCuts, so this is a no-op when absent.
if (!cutSpecs.includes('process._events')) cutSpecs.push('process._events');
cutSpecs.splice(12);

const cutBaseline = runCutTest(graph, [], 'AgentSession', { maxPaths: 3 });
const cutApplied = runCutTest(graph, cutSpecs, 'AgentSession', { maxPaths: 3 });

process.stdout.write(JSON.stringify({ before, after, growth, retainers, cutSpecs, cutBaseline, cutApplied }));
