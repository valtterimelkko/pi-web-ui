#!/usr/bin/env npx tsx
/**
 * Single-snapshot retainer summary for B1.1's synthetic churn.
 *
 * Reuses the heap-soak read-only retainer module
 * (`server/src/live-validation/heap-soak/snapshot-retainers.ts`, owned by lane
 * b0-1) — this script only imports it. For each requested constructor it
 * reports the instance count, how many are reachable from the GC root, how many
 * are held through a watcher path, and the dominant shortest retainer chains
 * (which double as the watcher map sizes, e.g. instances reached through
 * `object:SessionWatcher --property:debounceTimers--> object:Map`).
 *
 * Usage:
 *   node --max-old-space-size=12288 --import tsx summarize.ts \
 *     --before before.heapsnapshot --after after.heapsnapshot \
 *     --targets Timeout,Stats,Date,FSWatcher --out-json summary.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  analyzeConstructorRetainers,
  buildSnapshotGraph,
  nodeName,
  nodeTypeName,
  type ConstructorRetainerAnalysis,
  type ParsedHeapSnapshot,
  type SnapshotGraph,
} from '../../server/src/live-validation/heap-soak/snapshot-retainers.js';

export const SESSION_WATCHER_CHAIN_TOKENS = [
  'SessionWatcher',
  'debounceTimers',
  'readStateByPath',
  'sessionIdsByPath',
  'pendingInfoByPath',
  '_pendingWrites',
  '_watched',
  '_closers',
  'awaitWriteFinish',
  'chokidar',
] as const;

/** Generic `fs.FSWatcher` handles (node internals); the Pi SDK creates these too. */
export const FS_WATCHER_CHAIN_TOKENS = ['FSWatcher', 'FSEvent'] as const;

export const WATCHER_CHAIN_TOKENS = [
  ...SESSION_WATCHER_CHAIN_TOKENS,
  ...FS_WATCHER_CHAIN_TOKENS,
] as const;

export interface ConstructorSummary {
  constructor: string;
  instances: number;
  reachableInstances: number;
  /** Reachable instances whose dominant retainer chain passes through watcher state. */
  watcherHeldInstances: number;
  /**
   * Subset held specifically through `SessionWatcher`/chokidar session state
   * (debounceTimers, readStateByPath, _pendingWrites, _watched, _closers …),
   * as opposed to a generic `fs.FSWatcher` handle the Pi SDK can also create.
   */
  sessionWatcherHeldInstances: number;
  topChains: Array<{ chain: string; instances: number; watcherHeld: boolean; sessionWatcherHeld: boolean }>;
}

export interface SnapshotSummary {
  file: string;
  /** Live session-file path strings still reachable (churn marker match). */
  retainedChurnPathStrings: number;
  constructors: ConstructorSummary[];
}

export function isWatcherChain(chain: string): boolean {
  return WATCHER_CHAIN_TOKENS.some((token) => chain.includes(token));
}

export function isSessionWatcherChain(chain: string): boolean {
  return SESSION_WATCHER_CHAIN_TOKENS.some((token) => chain.includes(token));
}

function summarizeConstructor(graph: SnapshotGraph, analysis: ConstructorRetainerAnalysis): ConstructorSummary {
  const topChains = analysis.chains.map((group) => ({
    chain: group.chain,
    instances: group.instances,
    watcherHeld: isWatcherChain(group.chain),
    sessionWatcherHeld: isSessionWatcherChain(group.chain),
  }));
  const watcherHeldInstances = topChains.reduce((sum, group) => sum + (group.watcherHeld ? group.instances : 0), 0);
  const sessionWatcherHeldInstances = topChains.reduce((sum, group) => sum + (group.sessionWatcherHeld ? group.instances : 0), 0);
  return {
    constructor: analysis.constructor,
    instances: analysis.instances,
    reachableInstances: analysis.reachableInstances,
    watcherHeldInstances,
    sessionWatcherHeldInstances,
    topChains,
  };
}

export function summarizeGraph(
  graph: SnapshotGraph,
  targets: readonly string[],
  file: string,
  churnPathMarker = 'churn-ws-',
): SnapshotSummary {
  const constructors = targets.map((target) => summarizeConstructor(graph, analyzeConstructorRetainers(graph, target, { maxChains: 6 })));
  let retainedChurnPathStrings = 0;
  for (let i = 0; i < graph.nodeCount; i += 1) {
    if (nodeTypeName(graph, i) !== 'string' || graph.dist[i] < 0) continue;
    if (nodeName(graph, i).includes(churnPathMarker)) retainedChurnPathStrings += 1;
  }
  return { file, retainedChurnPathStrings, constructors };
}

function summarizeSnapshotFile(filePath: string, targets: readonly string[], churnPathMarker: string): SnapshotSummary {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ParsedHeapSnapshot;
  const graph = buildSnapshotGraph(parsed);
  return summarizeGraph(graph, targets, filePath, churnPathMarker);
}

export function renderSummaryMarkdown(
  before: SnapshotSummary,
  after: SnapshotSummary,
  label: string,
  cases: Array<{ case: string; files: number }>,
): string {
  const lines: string[] = [];
  lines.push(`# B1.1 watcher-churn retainer summary — ${label}`);
  lines.push('');
  lines.push(`- Files churned: ${cases.reduce((sum, c) => sum + c.files, 0)} across ${cases.length} cases (${cases.map((c) => `${c.case}=${c.files}`).join(', ')}).`);
  lines.push(`- Retained churn path strings: before ${before.retainedChurnPathStrings} → after ${after.retainedChurnPathStrings} (Δ ${after.retainedChurnPathStrings - before.retainedChurnPathStrings}).`);
  lines.push('');
  lines.push('| constructor | instances before | instances after | Δ | session-watcher-held Δ | any-watcher-held Δ |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  const byName = new Map(before.constructors.map((c) => [c.constructor, c]));
  for (const afterCtor of after.constructors) {
    const beforeCtor = byName.get(afterCtor.constructor);
    lines.push(
      `| ${afterCtor.constructor} | ${beforeCtor?.instances ?? 'n/a'} | ${afterCtor.instances} | ` +
      `${beforeCtor ? afterCtor.instances - beforeCtor.instances : 'n/a'} | ` +
      `${beforeCtor ? afterCtor.sessionWatcherHeldInstances - beforeCtor.sessionWatcherHeldInstances : 'n/a'} | ` +
      `${beforeCtor ? afterCtor.watcherHeldInstances - beforeCtor.watcherHeldInstances : 'n/a'} |`,
    );
  }
  lines.push('');
  lines.push('## Dominant retainer chains (after snapshot)');
  for (const ctor of after.constructors) {
    lines.push('');
    lines.push(`### ${ctor.constructor} — ${ctor.instances} instances (${ctor.reachableInstances} reachable)`);
    for (const chain of ctor.topChains) {
      lines.push(`- ${chain.instances} instance(s)${chain.sessionWatcherHeld ? ' [session-watcher-held]' : chain.watcherHeld ? ' [fs-watcher-held]' : ''} via:`);
      lines.push('  ```');
      for (const step of chain.chain.split('\n')) lines.push(`  ${step}`);
      lines.push('  ```');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1]?.startsWith('--') ? '' : argv[++i] ?? '';
    out[key] = value;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const beforePath = args.before;
  const afterPath = args.after;
  if (!beforePath || !afterPath) {
    console.error('usage: summarize.ts --before <file> --after <file> [--targets Timeout,Stats,Date,FSWatcher] [--out-json f] [--out-md f] [--label text] [--churn-marker text]');
    process.exit(64);
    return;
  }
  const targets = (args.targets ?? 'Timeout,Stats,Date,FSWatcher').split(',').map((s) => s.trim()).filter(Boolean);
  const marker = args['churn-marker'] ?? 'churn-ws-';
  const label = args.label ?? 'run';
  const cases = args['cases-json'] ? (JSON.parse(args['cases-json']) as Array<{ case: string; files: number }>) : [];

  const before = summarizeSnapshotFile(beforePath, targets, marker);
  const after = summarizeSnapshotFile(afterPath, targets, marker);
  const summary = { label, targets, before, after };
  if (args['out-json']) writeFileSync(args['out-json'], JSON.stringify(summary, null, 2));
  const markdown = renderSummaryMarkdown(before, after, label, cases);
  if (args['out-md']) writeFileSync(args['out-md'], markdown);
  process.stdout.write(markdown);
}

const invokedDirectly = process.argv[1] && (process.argv[1].endsWith('summarize.ts') || process.argv[1].endsWith('summarize.js'));
if (invokedDirectly) main();
