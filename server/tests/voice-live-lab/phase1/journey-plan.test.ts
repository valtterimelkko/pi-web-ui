/**
 * Journey planning for the `primary-mic` browser journey (child J, plan §4.2
 * and §11 Phase 2). The plan is pure data: episode turns → speech fixtures and
 * capture modes, deadlines, server env (arm selection as data), and browser
 * arguments. It must be deterministic, fail closed on missing fixtures or
 * holdout episodes, and make the fake-file → synthetic-stream-source mode
 * policy explicit: the FIRST utterance rides Chromium's file-backed fake
 * microphone; every later director utterance uses the labelled
 * `synthetic-stream-source` helper feeding the unchanged product pipeline.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { loadCorpus, episodeById } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  journeyPlan,
  journeyPlanHash,
  DEFAULT_ARM_ENV_KEY,
  armServerEnv,
} from '../../../../scripts/voice-lane-lab/lib/journey-plan.js';

const corpus = loadCorpus();

const fakeVoiceManifest = (corpusDir: string, ids: string[]): string => {
  const dir = path.join(corpusDir, 'voices');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    profileId: 'voice-a',
    speechLabel: 'synthetic speech based on real wording',
    fixtures: ids.map((id) => ({
      id,
      // The real episode wording: the plan now fails closed on text drift, so a
      // faithful fake manifest must carry the wording the corpus declares.
      text: wordingForFixture(id),
      pcm16kSha256: 'b'.repeat(64),
      pcm16kPath: `/root/voice-lane-lab/fixtures/voice-a/${id}.pcm16k`,
      masterWavPath: `/root/voice-lane-lab/fixtures/voice-a/${id}.master.wav`,
      durationMs: 2_000,
      asr: { transcript: 'fixture words', wer: 0.02, missingWords: [], ok: true },
    })),
  };
  writeFileSync(path.join(dir, 'voice-a.manifest.json'), JSON.stringify(manifest, null, 2));
  return corpusDir;
};

/** The corpus wording a fixture id stands for (turns and the one-clarification repair). */
function wordingForFixture(id: string): string {
  const turn = /^([A-Z]\d+)-t(\d+)$/.exec(id);
  if (turn) {
    const episode = episodeById(corpus, turn[1]);
    const text = episode.inputTurns[Number(turn[2]) - 1]?.text;
    if (text) return text;
  }
  const repair = /^([A-Z]\d+)-repair-1$/.exec(id);
  if (repair) {
    const episode = episodeById(corpus, repair[1]);
    const branch = episode.repairBranches.find((candidate) => candidate.action === 'one-clarification');
    if (branch?.say) return branch.say;
  }
  return `fixture words for ${id}`;
}

function withFakeVoices(turnIds: string[], run: (corpusDir: string) => void): void {
  const corpusDir = path.join(tmpdir(), `voice-lab-jplan-${Math.random().toString(36).slice(2)}`);
  mkdirSync(corpusDir, { recursive: true });
  fakeVoiceManifest(corpusDir, turnIds);
  run(corpusDir);
}

const C01_TURNS = ['C01-t1', 'C01-t2', 'C01-repair-1'];

describe('the primary-mic journey plan', () => {
  it('is deterministic: same inputs give the same plan and hash', () => {
    withFakeVoices(C01_TURNS, (corpusDir) => {
      const a = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      const b = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(journeyPlanHash(a)).toBe(journeyPlanHash(b));
      expect(journeyPlanHash(a)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('drives the opening turn through the file-backed fake microphone', () => {
    withFakeVoices(C01_TURNS, (corpusDir) => {
      const plan = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      const opening = plan.turns[0];
      expect(opening.turnId).toBe('t1');
      expect(opening.inputMode).toBe('fake-file');
      expect(opening.fixtureId).toBe('C01-t1');
      expect(opening.speakOnStart).toBe(true);
      const fileArg = plan.browserArgs.find((arg) => arg.startsWith('--use-file-for-fake-audio-capture='));
      expect(fileArg, 'opening WAV bound to the fake device').toBeTruthy();
      expect(fileArg).toContain('C01-t1.master.wav');
      expect(fileArg).toContain('%noloop');
    });
  });

  it('drives every later director utterance through the labelled synthetic-stream-source helper', () => {
    withFakeVoices(C01_TURNS, (corpusDir) => {
      const plan = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      const later = plan.turns.slice(1);
      expect(later.length).toBeGreaterThanOrEqual(1);
      for (const turn of later) {
        expect(turn.inputMode).toBe('synthetic-stream-source');
        expect(turn.speakOnStart).toBe(false);
        expect(turn.fixtureId).toMatch(/^C01-/);
      }
      expect(plan.turns.map((turn) => turn.turnId)).toEqual(['t1', 't2', 'repair-1']);
    });
  });

  it('carries the episode deadlines and expected artefact into the plan', () => {
    withFakeVoices(C01_TURNS, (corpusDir) => {
      const plan = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      expect(plan.deadlines).toEqual(episodeById(corpus, 'C01').perStepDeadlinesMs);
      expect(plan.attemptDeadlineMs).toBeGreaterThanOrEqual(120_000);
      expect(plan.expectedArtefact.kind).toBe('worker-input-persisted');
      expect(plan.routesRelay).toBe(true);
    });
  });

  it('records the capture mode and the evidence level as E2 with the labelled helper', () => {
    withFakeVoices(C01_TURNS, (corpusDir) => {
      const plan = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      expect(plan.captureMode).toBe('fake-file+synthetic-stream-source');
      expect(plan.evidenceLevel).toBe('E2');
      expect(plan.syntheticLabel).toBe('synthetic-stream-source');
    });
  });

  it('refuses to plan a holdout episode', () => {
    withFakeVoices(['C10-t1'], (corpusDir) => {
      expect(() => journeyPlan('C10', { corpus, corpusDir, arm: 'standard' })).toThrow(/holdout/);
    });
  });

  it('fails closed when a turn fixture is missing from the frozen manifest', () => {
    withFakeVoices(['C01-t1'], (corpusDir) => {
      expect(() => journeyPlan('C01', { corpus, corpusDir, arm: 'standard' })).toThrow(/C01-t2/);
    });
  });

  it('fails closed when a frozen fixture was made for different wording than the episode declares', () => {
    const corpusDir = path.join(tmpdir(), `voice-lab-jplan-${Math.random().toString(36).slice(2)}`);
    mkdirSync(corpusDir, { recursive: true });
    fakeVoiceManifest(corpusDir, C01_TURNS);
    const manifestPath = path.join(corpusDir, 'voices', 'voice-a.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entry = manifest.fixtures.find((fixture: { id: string }) => fixture.id === 'C01-t2');
    entry.text = 'Yes, send that exactly as written.';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => journeyPlan('C01', { corpus, corpusDir, arm: 'standard' })).toThrow(/different wording|re-freeze/);
  });

  it('refuses to plan when a fixture failed ASR validation', () => {
    const corpusDir = path.join(tmpdir(), `voice-lab-jplan-${Math.random().toString(36).slice(2)}`);
    mkdirSync(corpusDir, { recursive: true });
    const dir = path.join(corpusDir, 'voices');
    mkdirSync(dir, { recursive: true });
    const manifest = {
      profileId: 'voice-a',
      speechLabel: 'synthetic speech based on real wording',
      fixtures: C01_TURNS.map((id) => ({
        id,
        text: wordingForFixture(id),
        pcm16kSha256: 'c'.repeat(64),
        pcm16kPath: `/x/${id}.pcm16k`,
        masterWavPath: `/x/${id}.master.wav`,
        durationMs: 1_500,
        asr: { transcript: 'wrong', wer: 0.9, missingWords: ['relay'], ok: false },
      })),
    };
    writeFileSync(path.join(dir, 'voice-a.manifest.json'), JSON.stringify(manifest, null, 2));
    expect(() => journeyPlan('C01', { corpus, corpusDir, arm: 'standard' })).toThrow(/ASR/);
  });

  it('plans a conversational-only episode with response slots and no relay phases', () => {
    withFakeVoices(['C09-t1', 'C09-t2'], (corpusDir) => {
      const plan = journeyPlan('C09', { corpus, corpusDir, arm: 'standard' });
      expect(plan.routesRelay).toBe(false);
      expect(plan.turns.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('arm selection as data', () => {
  it('exposes the documented default env key VOICE_LIVE_PROFILE', () => {
    expect(DEFAULT_ARM_ENV_KEY).toBe('VOICE_LIVE_PROFILE');
  });

  it('maps an arm label to child-server env without hard-coding beyond the documented default', () => {
    expect(armServerEnv('standard', [])).toEqual({ VOICE_LIVE_PROFILE: 'standard' });
    expect(armServerEnv('et-high', [])).toEqual({ VOICE_LIVE_PROFILE: 'et-high' });
  });

  it('lets --server-env entries override or extend the default mapping', () => {
    expect(armServerEnv('standard', ['VOICE_LIVE_PROFILE=standard-v2', 'EXTRA_FLAG=1'])).toEqual({
      VOICE_LIVE_PROFILE: 'standard-v2',
      EXTRA_FLAG: '1',
    });
  });

  it('rejects malformed --server-env entries', () => {
    expect(() => armServerEnv('standard', ['BROKEN'])).toThrow(/KEY=VALUE/);
  });
});
