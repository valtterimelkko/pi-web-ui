/**
 * Campaign attempt records for the lane lab (native-primary plan §9).
 *
 * Layout under a private run root (never inside the repository):
 *
 *   <root>/campaigns/<campaignId>/campaign-index.json
 *   <root>/campaigns/<campaignId>/runs/<episodeId>-<arm>/<attempt-NN>/
 *     manifest.json manifest.sha256 FINALISED
 *     capture/ director/ fixtures/ provider/ input/ evaluation/
 *
 * An attempt directory is created once and finalised once; a retry is a new
 * numbered attempt. The campaign index is the ONE mutable coordination
 * artifact, and it must list every scheduled cell — completed, skipped,
 * invalid or never started — because "we only kept the good ones" is not
 * evidence.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createHash } from 'node:crypto';

export const RECORD_SCHEMA_VERSION = 1;

const FORBIDDEN_ROOTS = ['/root/pi-web-ui', '/etc', '/usr', '/var', '/boot', '/root/.pi-web-ui'];

export function assertSafeRunRoot(root: string): string {
  const resolved = path.resolve(root);
  if (!path.isAbsolute(resolved)) throw new Error(`Run root must be absolute: ${root}`);
  if (resolved === '/') throw new Error('Refusing to use / as the run root');
  for (const forbidden of FORBIDDEN_ROOTS) {
    if (resolved === forbidden || resolved.startsWith(`${forbidden}/`)) {
      throw new Error(
        `Refusing to use ${resolved}: it is inside protected path ${forbidden}. ` +
          'Run records belong outside the repository.'
      );
    }
  }
  return resolved;
}

export function sha256Bytes(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(filePath: string): string {
  return sha256Bytes(readFileSync(filePath));
}

export const ATTEMPT_SUBDIRS = ['capture', 'director', 'fixtures', 'provider', 'input', 'evaluation'] as const;

export interface AttemptLayout {
  root: string;
  campaignId: string;
  runId: string;
  cellId: string;
  attemptId: string;
  attemptDir: string;
}

export function campaignRoot(root: string, campaignId: string): string {
  return path.join(assertSafeRunRoot(root), 'campaigns', campaignId);
}

export function attemptDirFor(root: string, campaignId: string, cellId: string, attemptId: string): string {
  return path.join(campaignRoot(root, campaignId), 'runs', cellId, attemptId);
}

export function createAttempt(
  root: string,
  campaignId: string,
  cellId: string,
  attemptId?: string
): AttemptLayout {
  const safeRoot = assertSafeRunRoot(root);
  const id = attemptId ?? nextAttemptId(root, campaignId, cellId);
  const dir = attemptDirFor(safeRoot, campaignId, cellId, id);
  if (existsSync(dir)) {
    throw new Error(`Attempt directory already exists (refusing to overwrite evidence): ${dir}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of ATTEMPT_SUBDIRS) mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  return { root: safeRoot, campaignId, runId: campaignId, cellId, attemptId: id, attemptDir: dir };
}

/** Next free attempt id for a cell, e.g. attempt-03. */
export function nextAttemptId(root: string, campaignId: string, cellId: string): string {
  const dir = path.join(campaignRoot(root, campaignId), 'runs', cellId);
  if (!existsSync(dir)) return 'attempt-01';
  const used = readdirSync(dir)
    .map((name) => /^attempt-(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number.parseInt(match[1], 10));
  return `attempt-${String((used.length === 0 ? 0 : Math.max(...used)) + 1).padStart(2, '0')}`;
}

export interface AttemptManifest {
  schemaVersion?: number;
  lab?: string;
  attemptId?: string;
  runId?: string;
  episodeId?: string;
  arm?: string;
  evidenceLevel?: string;
  captureMode?: string;
  corpusHash?: string;
  startedAtIso?: string;
  status?: string;
  artifacts?: Array<{ relativePath: string; sha256: string; bytes: number }>;
  [key: string]: unknown;
}

const MANIFEST_BASELINE_NAMES = new Set(['manifest.json', 'manifest.sha256', 'FINALISED']);

/** Hash every file in the attempt directory except the manifest trio itself. */
export function collectArtifacts(attemptDir: string): Array<{ relativePath: string; sha256: string; bytes: number }> {
  const out: Array<{ relativePath: string; sha256: string; bytes: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (dir === attemptDir && MANIFEST_BASELINE_NAMES.has(entry)) continue;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const bytes = readFileSync(full);
      out.push({
        relativePath: path.relative(attemptDir, full),
        sha256: sha256Bytes(bytes),
        bytes: bytes.byteLength,
      });
    }
  };
  walk(attemptDir);
  return out;
}

/** Freeze the attempt: write the manifest once, then its hash and FINALISED. */
export function finaliseAttempt(attemptDir: string, manifest: AttemptManifest): string {
  const manifestPath = path.join(attemptDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    throw new Error(`Refusing to overwrite an immutable manifest: ${manifestPath}`);
  }
  const frozen: AttemptManifest = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    lab: 'voice-lane-lab',
    ...manifest,
    artifacts: manifest.artifacts ?? collectArtifacts(attemptDir),
  };
  writeFileSync(manifestPath, `${JSON.stringify(frozen, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(path.join(attemptDir, 'manifest.sha256'), `${sha256File(manifestPath)}\n`, { mode: 0o600 });
  writeFileSync(path.join(attemptDir, 'FINALISED'), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return manifestPath;
}

// ── Campaign index ──────────────────────────────────────────────────────────

export const CELL_STATUSES = [
  'pending',
  'started',
  'completed',
  'failed',
  'skipped',
  'invalid',
  'unsupported',
] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

export interface CampaignCell {
  episodeId: string;
  arm: string;
  status: CellStatus;
  attemptDirs: string[];
  reason?: string;
  note?: string;
}

export interface CampaignIndex {
  schemaVersion: number;
  campaignId: string;
  createdAtIso: string;
  updatedIso: string;
  cells: CampaignCell[];
}

export function campaignIndexFor(options: {
  campaignId: string;
  corpus: { episodes: Array<{ id: string; tier: string; holdout: boolean }> };
  arms: string[];
}): CampaignIndex {
  const now = new Date().toISOString();
  const cells: CampaignCell[] = [];
  for (const episode of options.corpus.episodes) {
    for (const arm of options.arms) {
      cells.push({
        episodeId: episode.id,
        arm,
        status: 'pending',
        attemptDirs: [],
        ...(episode.holdout
          ? { note: 'holdout: surface forms frozen by the separate validator before this cell may run' }
          : {}),
      });
    }
  }
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    campaignId: options.campaignId,
    createdAtIso: now,
    updatedIso: now,
    cells,
  };
}

export function recordCell(
  index: CampaignIndex,
  update: { episodeId: string; arm: string; status: CellStatus; attemptDirs?: string[]; reason?: string }
): void {
  if (!(CELL_STATUSES as readonly string[]).includes(update.status)) {
    throw new Error(`unknown cell status "${String(update.status)}" — allowed: ${CELL_STATUSES.join(', ')}`);
  }
  const cell = index.cells.find(
    (candidate) => candidate.episodeId === update.episodeId && candidate.arm === update.arm
  );
  if (!cell) throw new Error(`cell ${update.episodeId}-${update.arm} is not scheduled in this campaign`);
  cell.status = update.status;
  if (update.attemptDirs) cell.attemptDirs = [...cell.attemptDirs, ...update.attemptDirs];
  if (update.reason) cell.reason = update.reason;
  index.updatedIso = new Date().toISOString();
}

export function campaignIndexPath(root: string, campaignId: string): string {
  return path.join(campaignRoot(root, campaignId), 'campaign-index.json');
}

export function writeCampaignIndex(index: CampaignIndex, root: string): string {
  const target = campaignIndexPath(root, index.campaignId);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export function readCampaignIndex(root: string, campaignId: string): CampaignIndex {
  return JSON.parse(readFileSync(campaignIndexPath(root, campaignId), 'utf8')) as CampaignIndex;
}
