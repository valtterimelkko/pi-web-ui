import { describe, expect, it } from 'vitest';
import {
  parseSnapshotFilename,
  selectSnapshotCandidates,
  type SnapshotFileInfo,
} from '../../../src/live-validation/heap-soak/snapshot-selection.js';

function info(name: string, sizeBytes: number): SnapshotFileInfo {
  const parsed = parseSnapshotFilename(name);
  if (!parsed) throw new Error(`unparseable test name ${name}`);
  return { name, path: `/run/snapshots/${name}`, sizeBytes, ...parsed };
}

describe('parseSnapshotFilename', () => {
  it('parses a declared snapshot name', () => {
    expect(parseSnapshotFilename('snapshot-43200000ms.heapsnapshot')).toEqual({ offsetMs: 43_200_000, kind: 'declared' });
  });
  it('parses a heap-threshold snapshot name', () => {
    expect(parseSnapshotFilename('snapshot-heap-2048MB-2078666ms.heapsnapshot')).toEqual({ offsetMs: 2_078_666, kind: 'threshold' });
  });
  it('returns undefined for anything else', () => {
    expect(parseSnapshotFilename('preflight.heapsnapshot')).toBeUndefined();
  });
});

describe('selectSnapshotCandidates (B0 defect 2)', () => {
  it('skips the empty 12 h snapshot and falls back to the latest valid threshold snapshot', () => {
    const selection = selectSnapshotCandidates([
      info('snapshot-0ms.heapsnapshot', 100_522_134),
      info('snapshot-43200000ms.heapsnapshot', 0),
      info('snapshot-heap-1024MB-1217543ms.heapsnapshot', 297_184_139),
      info('snapshot-heap-2048MB-2078666ms.heapsnapshot', 477_401_911),
    ]);
    expect(selection.start?.name).toBe('snapshot-0ms.heapsnapshot');
    expect(selection.afterCandidates.map((c) => c.name)).toEqual([
      'snapshot-heap-2048MB-2078666ms.heapsnapshot',
      'snapshot-heap-1024MB-1217543ms.heapsnapshot',
    ]);
    expect(selection.skipped.map((s) => s.name)).toEqual(['snapshot-43200000ms.heapsnapshot']);
    expect(selection.skipped[0].reason).toMatch(/empty/i);
  });

  it('prefers a valid declared snapshot over threshold snapshots', () => {
    const selection = selectSnapshotCandidates([
      info('snapshot-0ms.heapsnapshot', 100),
      info('snapshot-heap-1024MB-1000ms.heapsnapshot', 300),
      info('snapshot-43200000ms.heapsnapshot', 500),
    ]);
    expect(selection.afterCandidates[0].name).toBe('snapshot-43200000ms.heapsnapshot');
  });

  it('returns no candidates when only one valid snapshot exists', () => {
    const selection = selectSnapshotCandidates([info('snapshot-0ms.heapsnapshot', 100)]);
    expect(selection.start?.name).toBe('snapshot-0ms.heapsnapshot');
    expect(selection.afterCandidates).toEqual([]);
  });
});
