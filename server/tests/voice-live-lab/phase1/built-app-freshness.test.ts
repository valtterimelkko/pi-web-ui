/**
 * Freshness guard for the served built app (fix-loop pass 2 defect, 2026-09-23).
 *
 * The journey runner used to build only when a dist file was MISSING, so it
 * served a stale client/server and graded old code. These tests pin the pure
 * staleness predicate that now forces a rebuild whenever any source or manifest
 * is newer than the OLDER of the two dists.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { builtAppIsStale, newestMtimeMs } from '../../../../scripts/voice-lane-lab/lib/built-app.js';

function makeRepo(): string {
  const root = path.join(tmpdir(), `voice-lab-freshness-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(root, 'server', 'dist'), { recursive: true });
  mkdirSync(path.join(root, 'client', 'dist'), { recursive: true });
  mkdirSync(path.join(root, 'client', 'src'), { recursive: true });
  mkdirSync(path.join(root, 'server', 'src'), { recursive: true });
  mkdirSync(path.join(root, 'shared', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'server', 'dist', 'index.js'), '// dist');
  writeFileSync(path.join(root, 'client', 'dist', 'index.html'), '<html></html>');
  writeFileSync(path.join(root, 'client', 'src', 'app.ts'), 'export {};');
  writeFileSync(path.join(root, 'server', 'src', 'index.ts'), 'export {};');
  writeFileSync(path.join(root, 'shared', 'src', 'index.ts'), 'export {};');
  writeFileSync(path.join(root, 'package.json'), '{}');
  return root;
}

function setMtimes(root: string, distSec: number, sourceSec: number): void {
  for (const rel of ['server/dist/index.js', 'client/dist/index.html']) {
    utimesSync(path.join(root, rel), distSec, distSec);
  }
  for (const rel of [
    'client/src/app.ts',
    'server/src/index.ts',
    'shared/src/index.ts',
    'package.json',
  ]) {
    utimesSync(path.join(root, rel), sourceSec, sourceSec);
  }
}

describe('builtAppIsStale — the served build may never be older than its sources', () => {
  it('is stale when a dist is missing', () => {
    const root = makeRepo();
    utimesSync(path.join(root, 'client', 'src', 'app.ts'), 2_000, 2_000);
    rmSync(path.join(root, 'server', 'dist', 'index.js'));
    expect(builtAppIsStale(root)).toBe(true);
  });

  it('is stale when a source is newer than the older dist (the pass-2 defect)', () => {
    const root = makeRepo();
    setMtimes(root, 1_000, 2_000); // dists 1000, sources 2000
    expect(builtAppIsStale(root)).toBe(true);
  });

  it('is fresh when both dists are newer than every source and manifest', () => {
    const root = makeRepo();
    setMtimes(root, 3_000, 2_000); // dists 3000, sources 2000
    expect(builtAppIsStale(root)).toBe(false);
  });

  it('newestMtimeMs ignores node_modules and dist trees', () => {
    const root = makeRepo();
    mkdirSync(path.join(root, 'client', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(root, 'client', 'node_modules', 'pkg', 'index.js'), '// dep');
    utimesSync(path.join(root, 'client', 'node_modules', 'pkg', 'index.js'), 9_000, 9_000);
    setMtimes(root, 3_000, 2_000);
    expect(newestMtimeMs(path.join(root, 'client'))).toBeLessThan(9_000_000); // 9000 s in ms
    expect(builtAppIsStale(root)).toBe(false);
  });
});
