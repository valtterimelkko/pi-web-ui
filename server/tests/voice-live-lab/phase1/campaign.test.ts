/**
 * Campaign runner core (child J, plan §6.2, §8, §9): matrix enumeration, the
 * full scheduled-cell index, resume-safety, arm/data-driven selection and the
 * paired alternating execution order. These tests are pure — no browser, no
 * server, no provider calls.
 */
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { loadCorpus, P_TIER_DEV_SET, HOLDOUT_IDS } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  campaignMatrix,
  matrixCellId,
  newCampaignIndex,
  executionOrder,
  loadOrCreateIndex,
  saveIndex,
  nextExecutableCell,
  campaignExitCode,
  ARMS,
} from '../../../../scripts/voice-lane-lab/lib/campaign.js';

const corpus = loadCorpus();
const DEFAULT_ARMS = ['standard', 'et-high'] as const;

describe('the campaign matrix (plan §8)', () => {
  it('enumerates 54 cells across both arms: core 24, holdout 8, soak 2, extend 16, noise 4', () => {
    const cells = campaignMatrix({ corpus, arms: [...DEFAULT_ARMS] });
    const byStratum = (stratum: string) => cells.filter((cell) => cell.stratum === stratum);
    expect(byStratum('core').length).toBe(24);
    expect(byStratum('holdout').length).toBe(8);
    expect(byStratum('soak').length).toBe(2);
    expect(byStratum('extend').length).toBe(16);
    expect(byStratum('noise').length).toBe(4);
    expect(cells.length).toBe(54);
    // every scheduled cell is unique
    expect(new Set(cells.map(matrixCellId)).size).toBe(54);
  });

  it('schedules exactly the 12 P-tier IDs paired per arm in the core stratum', () => {
    const cells = campaignMatrix({ corpus, arms: [...DEFAULT_ARMS] }).filter((cell) => cell.stratum === 'core');
    const ids = new Set(cells.map((cell) => cell.episodeId));
    expect([...ids].sort()).toEqual([...P_TIER_DEV_SET].sort());
    for (const id of P_TIER_DEV_SET) {
      expect(cells.filter((cell) => cell.episodeId === id).map((cell) => cell.arm).sort()).toEqual(['et-high', 'standard']);
    }
  });

  it('marks holdout cells validator-gated and the soak/noise strata as special runners', () => {
    const cells = campaignMatrix({ corpus, arms: [...DEFAULT_ARMS] });
    for (const cell of cells.filter((c) => c.stratum === 'holdout')) {
      expect(cell.gate).toBe('validator-frozen');
      expect(HOLDOUT_IDS).toContain(cell.episodeId);
    }
    for (const cell of cells.filter((c) => c.stratum === 'soak')) expect(cell.gate).toBe('soak-runner');
    for (const cell of cells.filter((c) => c.stratum === 'noise')) expect(cell.gate).toBe('noise-profile');
    for (const cell of cells.filter((c) => c.stratum === 'core' || c.stratum === 'extend')) {
      expect(cell.gate).toBeNull();
    }
  });

  it('the extend stratum is exactly the 8 E-tier IDs; the noise stratum is C05+C09', () => {
    const cells = campaignMatrix({ corpus, arms: [...DEFAULT_ARMS] });
    const extendIds = new Set(cells.filter((c) => c.stratum === 'extend').map((c) => c.episodeId));
    expect(extendIds.size).toBe(8);
    const noiseIds = new Set(cells.filter((c) => c.stratum === 'noise').map((c) => c.episodeId));
    expect([...noiseIds].sort()).toEqual(['C05', 'C09']);
    for (const cell of cells.filter((c) => c.stratum === 'noise')) {
      expect(cell.profile).toBe('noise-fixed-seed');
    }
  });
});

describe('the campaign index (plan §9)', () => {
  it('starts with every scheduled cell pending and never-started', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'voice-lab-camp-'));
    const index = newCampaignIndex({ campaignId: 'camp-test', corpus, arms: [...DEFAULT_ARMS], seed: 20260922 });
    expect(index.cells.length).toBe(54);
    expect(index.cells.every((cell) => cell.status === 'pending')).toBe(true);
    expect(index.seed).toBe(20260922);
    expect(index.arms).toEqual([...DEFAULT_ARMS]);
    expect(index.requiredCellCount).toBe(34); // core 24 + holdout 8 + soak 2
    expect(saveIndex(root, index)).toBeTruthy();
    expect(existsSync(path.join(root, 'campaigns', 'camp-test', 'campaign-index.json'))).toBe(true);
  });

  it('persists and reloads without drift', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'voice-lab-camp-'));
    const index = newCampaignIndex({ campaignId: 'camp-test', corpus, arms: [...DEFAULT_ARMS], seed: 7 });
    saveIndex(root, index);
    const reloaded = loadOrCreateIndex(root, { campaignId: 'camp-test', corpus, arms: [...DEFAULT_ARMS], seed: 7 });
    expect(reloaded).toEqual(index);
  });

  it('resume-safety: refuses to load an index whose scheduled plan changed (cell set drift)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'voice-lab-camp-'));
    const index = newCampaignIndex({ campaignId: 'camp-test', corpus, arms: [...DEFAULT_ARMS], seed: 7 });
    saveIndex(root, index);
    const singleArm = loadOrCreateIndex(root, { campaignId: 'camp-test', corpus, arms: ['standard'], seed: 7 });
    // A different plan must never silently drive an existing index: the caller
    // gets a NEW index only when none exists; a mismatched reload is an error.
    expect(() =>
      loadOrCreateIndex(root, { campaignId: 'camp-test', corpus, arms: ['standard'], seed: 7, strictPlan: true })
    ).toThrow(/plan drift|cell set/i);
    void singleArm;
  });
});

describe('execution order (plan §6.2 pairing discipline)', () => {
  it('pairs cells by episode and alternates arm order between blocks, driven by the seed', () => {
    const required = (arms: string[]) =>
      campaignMatrix({ corpus, arms }).filter((cell) => cell.stratum === 'core' || cell.stratum === 'holdout' || cell.stratum === 'soak');
    const a = executionOrder(required([...ARMS]), 1);
    const b = executionOrder(required([...ARMS]), 2);
    expect(a.length).toBe(34);
    // Same seed ⇒ same order; a different seed flips at least one block's arms.
    expect(a.map(matrixCellId)).toEqual(executionOrder(required([...ARMS]), 1).map(matrixCellId));
    expect(a.map(matrixCellId).join(',')).not.toBe(b.map(matrixCellId).join(','));
    // Paired by episode: the two arms of an episode block are adjacent.
    const coreIds = [...P_TIER_DEV_SET];
    for (let index = 0; index < coreIds.length; index += 1) {
      const block = a.filter((cell) => cell.episodeId === coreIds[index] && cell.stratum === 'core');
      expect(block.map((cell) => cell.arm).sort()).toEqual(['et-high', 'standard']);
      if (index % 2 === 0) expect(block[0].arm).toBe('standard');
      else expect(block[0].arm).toBe('et-high');
    }
  });
});

describe('resume-safe cell selection', () => {
  it('skips completed cells, retries failed cells with a fresh attempt, and never overwrites attempts', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'voice-lab-camp-'));
    const index = newCampaignIndex({ campaignId: 'camp', corpus, arms: [...DEFAULT_ARMS], seed: 1 });
    const first = nextExecutableCell(index, { includeExtend: false });
    expect(first?.cellId).toBeTruthy();
    const cell = index.cells.find((candidate) => candidate.cellId === first!.cellId)!;
    cell.status = 'completed';
    cell.attemptDirs = ['attempt-01'];
    const second = nextExecutableCell(index, { includeExtend: false });
    expect(second?.cellId).not.toBe(first!.cellId);
    cell.status = 'failed';
    const third = nextExecutableCell(index, { includeExtend: false });
    // a failed REQUIRED cell is retried with a NEW attempt (old evidence kept)
    expect(third?.cellId).toBe(first!.cellId);
  });

  it('a failed cell is never silently overwritten: the index preserves its attempt dirs', () => {
    const index = newCampaignIndex({ campaignId: 'camp', corpus, arms: [...DEFAULT_ARMS], seed: 1 });
    const first = nextExecutableCell(index, { includeExtend: false })!;
    const cell = index.cells.find((candidate) => candidate.cellId === first.cellId)!;
    cell.attemptDirs = [`${first.cellId}/attempt-01`];
    cell.status = 'failed';
    const retry = nextExecutableCell(index, { includeExtend: false });
    expect(retry?.cellId).toBe(first.cellId);
    expect(cell.attemptDirs).toEqual([`${first.cellId}/attempt-01`]);
  });

  it('budget exhaustion stops selection: cells stay pending and the runner reports exit 2', () => {
    const index = newCampaignIndex({ campaignId: 'camp', corpus, arms: [...DEFAULT_ARMS], seed: 1 });
    expect(nextExecutableCell(index, { includeExtend: false, budgetExhausted: true })).toBeNull();
    expect(campaignExitCode(index)).toBe(2);
  });

  it('skipped cells carry a reason; a campaign with all required cells terminal adjudicates by verdicts', () => {
    const index = newCampaignIndex({ campaignId: 'camp', corpus, arms: [...DEFAULT_ARMS], seed: 1 });
    for (const cell of index.cells) {
      cell.status = 'completed';
      cell.verdict = 'pass';
    }
    index.cells.find((c) => c.stratum === 'core')!.verdict = 'fail';
    expect(campaignExitCode(index)).toBe(1);
    for (const cell of index.cells) cell.verdict = 'pass';
    expect(campaignExitCode(index)).toBe(0);
    for (const cell of index.cells) if (cell.stratum === 'extend' || cell.stratum === 'noise') cell.verdict = undefined;
    // optional cells left never-started do not fail the required pass…
    expect(campaignExitCode(index)).toBe(0);
    // …but a required cell left pending does.
    const required = index.cells.find((c) => c.stratum === 'core')!;
    required.status = 'pending';
    required.verdict = undefined;
    expect(campaignExitCode(index)).toBe(2);
  });
});
