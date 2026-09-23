/**
 * Immutable attempt records and the campaign index (Phase 1 item 2).
 *
 * Every attempt writes a fresh directory; nothing is ever overwritten; the
 * campaign index accounts for EVERY scheduled cell — including skipped,
 * invalid and never-started ones (plan §9).
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  attemptDirFor,
  createAttempt,
  finaliseAttempt,
  nextAttemptId,
  campaignIndexFor,
  readCampaignIndex,
  recordCell,
  writeCampaignIndex,
  type CampaignCell,
} from '../../../../scripts/voice-lane-lab/lib/records.js';
import { loadCorpus } from '../../../../scripts/voice-lane-lab/lib/corpus.js';

const root = path.join('/tmp', `voice-lab-records-${process.pid}`);
const corpus = loadCorpus();

afterEach(() => {
  // per-test isolation via unique run ids; the root is cleaned at the end
});

describe('attempt records are write-once', () => {
  it('creates a fresh attempt directory with the standard subdirs', () => {
    const layout = createAttempt(root, 'run-a', 'C01-standard');
    expect(existsSync(layout.attemptDir)).toBe(true);
    for (const sub of ['capture', 'director', 'fixtures', 'provider', 'input', 'evaluation']) {
      expect(existsSync(path.join(layout.attemptDir, sub)), sub).toBe(true);
    }
    expect(layout.attemptId).toBe('attempt-01');
  });

  it('refuses to reuse an attempt directory', () => {
    createAttempt(root, 'run-b', 'C01-standard');
    expect(() => createAttempt(root, 'run-b', 'C01-standard', 'attempt-01')).toThrow(/exists/);
  });

  it('a retry is a NEW attempt id, never a rewrite', () => {
    createAttempt(root, 'run-c', 'C01-standard');
    expect(nextAttemptId(root, 'run-c', 'C01-standard')).toBe('attempt-02');
  });

  it('finalise writes manifest + hash + FINALISED exactly once', () => {
    const layout = createAttempt(root, 'run-d', 'C01-standard');
    writeFileSync(path.join(layout.attemptDir, 'director', 'steps.jsonl'), '{"seq":1}\n');
    const manifestPath = finaliseAttempt(layout.attemptDir, {
      episodeId: 'C01',
      evidenceLevel: 'E2',
      captureMode: 'fake-file',
    });
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(path.join(layout.attemptDir, 'manifest.sha256'))).toBe(true);
    expect(existsSync(path.join(layout.attemptDir, 'FINALISED'))).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.artifacts.length).toBeGreaterThan(0);
    expect(() => finaliseAttempt(layout.attemptDir, { episodeId: 'C01' })).toThrow(/immutable/);
  });

  it('refuses run roots inside the canonical checkout', () => {
    expect(() => createAttempt('/root/pi-web-ui/records', 'run-x', 'C01')).toThrow(/protected/);
  });
});

describe('the campaign index accounts for every scheduled cell', () => {
  it('builds pending cells for all 24 episodes × both arms', () => {
    const index = campaignIndexFor({
      campaignId: 'native-primary-20260922',
      corpus,
      arms: ['standard', 'et-high'],
    });
    expect(index.cells).toHaveLength(48);
    expect(index.cells.every((cell: CampaignCell) => cell.status === 'pending')).toBe(true);
    expect(new Set(index.cells.map((cell: CampaignCell) => `${cell.episodeId}-${cell.arm}`)).size).toBe(48);
    // Holdout cells are annotated as validator-gated, not silently schedulable.
    const c10 = index.cells.find((cell: CampaignCell) => cell.episodeId === 'C10');
    expect(c10.note).toContain('validator');
  });

  it('records skipped and invalid cells alongside completed ones', () => {
    const index = campaignIndexFor({ campaignId: 'camp-x', corpus, arms: ['standard'] });
    recordCell(index, { episodeId: 'C01', arm: 'standard', status: 'completed', attemptDirs: ['/runs/a'] });
    recordCell(index, { episodeId: 'C02', arm: 'standard', status: 'skipped', reason: 'budget exhausted' });
    recordCell(index, { episodeId: 'C05', arm: 'standard', status: 'invalid', reason: 'missing ingress evidence' });
    expect(index.cells.find((cell: CampaignCell) => cell.episodeId === 'C01').status).toBe('completed');
    expect(index.cells.find((cell: CampaignCell) => cell.episodeId === 'C02').status).toBe('skipped');
    expect(index.cells.find((cell: CampaignCell) => cell.episodeId === 'C05').status).toBe('invalid');
    writeCampaignIndex(index, root);
    const loaded = readCampaignIndex(root, 'camp-x');
    expect(loaded.cells).toHaveLength(24);
    const completed = loaded.cells.filter((cell: CampaignCell) => cell.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(loaded.cells.every((cell: CampaignCell) => cell.status !== undefined && cell.episodeId)).toBe(true);
  });

  it('recordCell refuses unknown statuses (no free-form history)', () => {
    const index = campaignIndexFor({ campaignId: 'camp-y', corpus, arms: ['standard'] });
    expect(() =>
      recordCell(index, { episodeId: 'C01', arm: 'standard', status: 'passed-fine-i-guess' as never })
    ).toThrow(/status/);
  });
});

void existsSync;
void mkdirSync;
