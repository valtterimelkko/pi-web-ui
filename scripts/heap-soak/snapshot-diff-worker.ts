#!/usr/bin/env npx tsx
/**
 * Snapshot diff worker: runs in its OWN process (spawned with a large
 * `--max-old-space-size`, see snapshot-diff.ts) so that parsing two
 * potentially-huge `.heapsnapshot` JSON files never pressures the caller's
 * own heap. Reads two file paths from argv, prints a single JSON line to
 * stdout: { before: ConstructorAggregate[], after: ConstructorAggregate[],
 * growth: ConstructorGrowth[] }.
 */
import { readFileSync } from 'node:fs';
import { aggregateByConstructor, diffAggregates } from '../../server/src/live-validation/heap-soak/snapshot-parse.js';

const [, , beforePath, afterPath] = process.argv;
if (!beforePath || !afterPath) {
  console.error('usage: snapshot-diff-worker.ts <before.heapsnapshot> <after.heapsnapshot>');
  process.exit(64);
}

const before = aggregateByConstructor(readFileSync(beforePath, 'utf8'));
const after = aggregateByConstructor(readFileSync(afterPath, 'utf8'));
const growth = diffAggregates(before, after);
process.stdout.write(JSON.stringify({ before, after, growth }));
