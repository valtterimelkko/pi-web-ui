/**
 * Snapshot comparison selection (B0 defect 2).
 *
 * A1's 12 h declared snapshot was 0 bytes (its server had been dead for
 * hours), and the comparison picked it as "last" and crashed on the empty
 * file. This module selects, from a run's `snapshots/` directory listing, the
 * start snapshot and an ordered list of "after" candidates — the latest valid
 * declared snapshot first (the 12 h one when the 24 h is absent), then the
 * heap-threshold snapshots newest-first. The caller tries each candidate until
 * one parses, so a corrupt/empty snapshot can no longer hide the comparison.
 *
 * Pure: it works from a directory listing (name + size), so the "skip the
 * empty file" behaviour is unit-tested without a real heap snapshot.
 */

export type SnapshotKind = 'declared' | 'threshold';

export interface SnapshotFileInfo {
  name: string;
  path: string;
  offsetMs: number;
  sizeBytes: number;
  kind: SnapshotKind;
}

export interface SnapshotSelection {
  start?: SnapshotFileInfo;
  /** Valid "after" candidates, most-preferred first. */
  afterCandidates: SnapshotFileInfo[];
  skipped: { name: string; path: string; reason: string }[];
}

/** Parse the harness's two snapshot filename conventions; undefined for anything else. */
export function parseSnapshotFilename(name: string): { offsetMs: number; kind: SnapshotKind } | undefined {
  const declared = name.match(/^snapshot-(\d+)ms\.heapsnapshot$/);
  if (declared) return { offsetMs: Number(declared[1]), kind: 'declared' };
  const threshold = name.match(/^snapshot-heap-\d+MB-(\d+)ms\.heapsnapshot$/);
  if (threshold) return { offsetMs: Number(threshold[1]), kind: 'threshold' };
  return undefined;
}

/**
 * Choose the start snapshot and the ordered after-candidates from a listing.
 * `minBytes` (default 1) filters out empty files; the worker's real parse is
 * the final validity check for files that pass this cheap size screen.
 */
export function selectSnapshotCandidates(files: readonly SnapshotFileInfo[], minBytes = 1): SnapshotSelection {
  const skipped: SnapshotSelection['skipped'] = [];
  const valid: SnapshotFileInfo[] = [];
  for (const file of files) {
    if (file.sizeBytes < minBytes) {
      skipped.push({ name: file.name, path: file.path, reason: file.sizeBytes === 0 ? 'empty (0 bytes)' : `smaller than ${minBytes} bytes` });
    } else {
      valid.push(file);
    }
  }

  valid.sort((a, b) => a.offsetMs - b.offsetMs || (a.kind === 'declared' ? -1 : 1) - (b.kind === 'declared' ? -1 : 1));
  const start = valid[0];

  const rest = valid.slice(1);
  const declared = rest.filter((f) => f.kind === 'declared').sort((a, b) => b.offsetMs - a.offsetMs);
  const thresholds = rest.filter((f) => f.kind === 'threshold').sort((a, b) => b.offsetMs - a.offsetMs);

  return { start, afterCandidates: [...declared, ...thresholds], skipped };
}
