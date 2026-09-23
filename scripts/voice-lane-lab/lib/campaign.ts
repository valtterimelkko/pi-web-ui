/**
 * Campaign runner core (child J; plan §6.2, §8, §9).
 *
 * Pure orchestration data: matrix enumeration, the full scheduled-cell index,
 * resume-safe selection, and the paired alternating execution order. No
 * browser, no server, no provider calls — the heavy runner lives in
 * `journey-run.ts`; this module decides WHAT runs, WHAT has run, and WHAT the
 * campaign's honest exit code is.
 *
 * §8 matrix, per arm: 12 P-tier core cells, 4 holdout cells (validator-frozen
 * surface forms), 1 continuity soak, 8 E-tier extend cells (budget-gated),
 * 2 noise spot-checks (C05+C09 at one fixed-seed moderate-noise profile).
 * The index lists EVERY scheduled cell — including never-started, skipped,
 * invalid and unsupported — because "we only kept the good ones" is not
 * evidence.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeCampaignIndex, readCampaignIndex, type CampaignIndex, type CampaignCell, type CellStatus } from './records.js';
import { P_TIER_DEV_SET, HOLDOUT_IDS, type LoadedCorpus } from './corpus.js';
import { ARM_LABELS, type ArmLabel } from './journey-plan.js';

/** The campaign's arm labels (the §7 arms). */
export const ARMS: readonly ArmLabel[] = ARM_LABELS;

export type Stratum = 'core' | 'holdout' | 'soak' | 'extend' | 'noise';

export const SOAK_EPISODE_ID = 'SOAK-10MIN';

export type CellGate = 'validator-frozen' | 'soak-runner' | 'noise-profile' | null;

export interface MatrixCell {
  cellId: string;
  episodeId: string;
  arm: ArmLabel;
  stratum: Stratum;
  /** Audio/profile variant for the cell (clean by default). */
  profile: 'clean' | 'noise-fixed-seed';
  gate: CellGate;
}

export function matrixCellId(cell: Pick<MatrixCell, 'episodeId' | 'arm' | 'stratum' | 'profile'>): string {
  return `${cell.episodeId}--${cell.arm}--${cell.stratum}--${cell.profile}`;
}

function episodeTier(corpus: LoadedCorpus, episodeId: string): string | null {
  return corpus.episodes.find((episode) => episode.id === episodeId)?.tier ?? null;
}

/** The full §8 matrix for the given arms. */
export function campaignMatrix(options: { corpus: LoadedCorpus; arms: ArmLabel[] }): MatrixCell[] {
  const cells: MatrixCell[] = [];
  const push = (episodeId: string, arm: ArmLabel, stratum: Stratum, profile: 'clean' | 'noise-fixed-seed', gate: CellGate): void => {
    cells.push({ episodeId, arm, stratum, profile, gate, cellId: `${episodeId}--${arm}--${stratum}--${profile}` });
  };
  for (const arm of options.arms) {
    for (const episode of options.corpus.episodes) {
      if (episode.tier === 'P' && P_TIER_DEV_SET.includes(episode.id)) push(episode.id, arm, 'core', 'clean', null);
      else if (episode.tier === 'H' && HOLDOUT_IDS.includes(episode.id)) push(episode.id, arm, 'holdout', 'clean', 'validator-frozen');
      else if (episode.tier === 'E' && episodeTier(options.corpus, episode.id) === 'E') push(episode.id, arm, 'extend', 'clean', null);
    }
    push(SOAK_EPISODE_ID, arm, 'soak', 'clean', 'soak-runner');
    for (const episodeId of ['C05', 'C09']) push(episodeId, arm, 'noise', 'noise-fixed-seed', 'noise-profile');
  }
  return cells;
}

export interface CampaignIndexFile extends CampaignIndex {
  seed: number;
  arms: ArmLabel[];
  requiredCellCount: number;
  executionOrderCellIds: string[];
  /** Per-cell verification verdicts filled by the runner (never self-scored). */
  cells: Array<CampaignCell & { cellId: string; stratum: Stratum; profile: 'clean' | 'noise-fixed-seed'; gate: CellGate; verdict?: 'pass' | 'fail' | 'indeterminate' | 'not-run' }>;
}

const CELLS_SCHEMA_VERSION = 1;

export function newCampaignIndex(options: {
  campaignId: string;
  corpus: LoadedCorpus;
  arms: ArmLabel[];
  seed: number;
}): CampaignIndexFile {
  const now = new Date().toISOString();
  const matrix = campaignMatrix(options);
  const cells: CampaignIndexFile['cells'] = matrix.map((cell) => ({
    ...cell,
    status: 'pending' as CellStatus,
    attemptDirs: [],
    ...(cell.gate === 'validator-frozen'
      ? { note: 'holdout: surface forms frozen by the separate validator before this cell may run' }
      : cell.gate === 'soak-runner'
        ? { note: 'continuity soak: 10 minutes, ≥8 turns, one mid-session reconnect (plan §8)' }
        : cell.gate === 'noise-profile'
          ? { note: 'noise spot-check: one fixed-seed moderate-noise profile (plan §8; robustness signal only)' }
          : {}),
  }));
  const required = cells.filter((cell) => cell.stratum === 'core' || cell.stratum === 'holdout' || cell.stratum === 'soak');
  return {
    schemaVersion: CELLS_SCHEMA_VERSION,
    campaignId: options.campaignId,
    createdAtIso: now,
    updatedIso: now,
    seed: options.seed,
    arms: options.arms,
    requiredCellCount: required.length,
    executionOrderCellIds: executionOrder(required, options.seed).map((cell) => cell.cellId),
    cells,
  };
}

/**
 * Paired execution order: blocks follow corpus episode order; within a block
 * the two arms alternate, the first block's order decided by the seed. The
 * same seed always produces the same order (plan §6.2).
 */
/** A minimal structural view of a scheduled cell (arm is a plain label here). */
export type OrderableCell = Omit<MatrixCell, 'arm'> & { arm: string };

export function executionOrder(cells: OrderableCell[], seed: number): OrderableCell[] {
  const episodeOrder: string[] = [];
  for (const cell of cells) {
    if (!episodeOrder.includes(cell.episodeId)) episodeOrder.push(cell.episodeId);
  }
  const out: OrderableCell[] = [];
  episodeOrder.forEach((episodeId, blockIndex) => {
    const block = cells.filter((cell) => cell.episodeId === episodeId);
    const standardFirst = (blockIndex + seed) % 2 === 0;
    const ordered = standardFirst
      ? [...block].sort((a, b) => a.arm.localeCompare(b.arm))
      : [...block].sort((a, b) => b.arm.localeCompare(a.arm));
    out.push(...ordered);
  });
  return out;
}

/** Load the campaign's index, or create it when absent. */
export function loadOrCreateIndex(
  root: string,
  options: { campaignId: string; corpus: LoadedCorpus; arms: ArmLabel[]; seed: number; strictPlan?: boolean }
): CampaignIndexFile {
  const indexPath = path.join(root, 'campaigns', options.campaignId, 'campaign-index.json');
  if (!existsSync(indexPath)) return newCampaignIndex(options);
  const existing = readCampaignIndex(root, options.campaignId) as CampaignIndexFile;
  const fresh = newCampaignIndex(options);
  const existingIds = new Set(existing.cells.map((cell) => cell.cellId));
  const freshIds = new Set(fresh.cells.map((cell) => cell.cellId));
  const samePlan =
    existingIds.size === freshIds.size && [...freshIds].every((id) => existingIds.has(id));
  if (options.strictPlan && !samePlan) {
    throw new Error(
      `campaign index plan drift: the scheduled cell set changed since the index was created ` +
        `(${existingIds.size} stored vs ${freshIds.size} scheduled) — a resumed campaign must drive the plan it was created with`
    );
  }
  return existing;
}

export function saveIndex(root: string, index: CampaignIndexFile): string {
  return writeCampaignIndex(index as CampaignIndex, root);
}

export interface SelectionOptions {
  includeExtend?: boolean;
  includeNoise?: boolean;
  budgetExhausted?: boolean;
}

/**
 * The next cell the runner may execute, honouring resume-safety: completed
 * cells are no-ops; a failed REQUIRED cell retries with a NEW attempt (old
 * evidence is never overwritten); budget exhaustion stops everything.
 */
export function nextExecutableCell(
  index: CampaignIndexFile,
  options: SelectionOptions = {}
): (CampaignIndexFile['cells'][number]) | null {
  if (options.budgetExhausted) return null;
  const scheduled = new Set(index.executionOrderCellIds);
  const executable = (cell: CampaignIndexFile['cells'][number]): boolean => {
    if (!scheduled.has(cell.cellId)) return false;
    if (cell.stratum === 'holdout' || cell.stratum === 'soak' || cell.stratum === 'noise') return false;
    if (cell.stratum === 'extend' && !options.includeExtend) return false;
    return true;
  };
  const order = index.executionOrderCellIds
    .map((cellId) => index.cells.find((cell) => cell.cellId === cellId))
    .filter((cell): cell is CampaignIndexFile['cells'][number] => cell !== undefined && executable(cell));
  for (const cell of order) {
    if (cell.status === 'pending' || cell.status === 'started') return cell;
    if (cell.status === 'failed') return cell; // retry with a fresh attempt; old evidence kept
  }
  return null;
}

/**
 * The campaign's honest exit code from the index alone (plan §9):
 *   0 — every required cell has a terminal adjudication and none failed;
 *   1 — at least one required cell demonstrated failure;
 *   2 — required coverage incomplete (pending/started/skipped/invalid cells).
 */
export function campaignExitCode(index: CampaignIndexFile): 0 | 1 | 2 {
  const required = index.cells.filter(
    (cell) => cell.stratum === 'core' || cell.stratum === 'holdout' || cell.stratum === 'soak'
  );
  if (required.some((cell) => cell.verdict === 'fail')) return 1;
  const incomplete = required.some(
    (cell) =>
      cell.status === 'pending' ||
      cell.status === 'started' ||
      cell.status === 'invalid' ||
      cell.status === 'skipped' ||
      (cell.status === 'completed' && cell.verdict === undefined) ||
      (cell.status === 'failed' && cell.verdict !== 'fail' && cell.verdict !== 'indeterminate')
  );
  if (incomplete) return 2;
  return 0;
}
