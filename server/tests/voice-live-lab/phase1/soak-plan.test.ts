/**
 * The W4 continuity soak plan (native-primary plan §8 soak cell).
 *
 * The soak is DATA: a small honest script re-using the corpus' frozen operator
 * wording and frozen fixtures (never new product behaviour, never new audio),
 * paced across a 10-minute session with one mid-session voice-transport
 * reconnect. These tests pin the plan file, the constructed soak episode, and
 * the journey plan that drives it.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CorpusError,
  EpisodeSchema,
  episodeById,
  loadCorpus,
  loadCorpusFromDir,
} from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  SOAK_EPISODE_ID,
  loadSoakPlan,
  soakEpisodeFromPlan,
  soakJourneyPlan,
  withSoakEpisode,
  type SoakPlan,
} from '../../../../scripts/voice-lane-lab/lib/soak-plan.js';

const corpus = loadCorpus();
const REPO_CORPUS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
  'scripts/voice-lane-lab/corpus'
);
const REAL_CORPUS_DIR = REPO_CORPUS_DIR; // the committed plan + frozen voices live in the repo corpus

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let cached: SoakPlan | null = null;
function committedPlan(): SoakPlan {
  if (!cached) cached = loadSoakPlan(REAL_CORPUS_DIR);
  return cached;
}

describe('the committed SOAK-10MIN plan', () => {
  it('exists and declares an honest 10-minute, >=8-turn, one-reconnect soak', () => {
    const plan = committedPlan();
    expect(plan.id).toBe(SOAK_EPISODE_ID);
    expect(plan.schemaVersion).toBe(1);
    expect(plan.minDurationMs).toBeGreaterThanOrEqual(600_000);
    expect(plan.minOperatorTurns).toBeGreaterThanOrEqual(8);
    expect(plan.attemptDeadlineMs).toBeGreaterThan(plan.minDurationMs);
    const turnSteps = plan.steps.filter((step) => step.kind === 'turn');
    const reconnects = plan.steps.filter((step) => step.kind === 'reconnect');
    expect(turnSteps.length).toBeGreaterThanOrEqual(8);
    expect(reconnects).toHaveLength(1);
    // the reconnect is MID-session: turns exist on both sides of it
    const reconnectIndex = plan.steps.findIndex((step) => step.kind === 'reconnect');
    expect(plan.steps.slice(0, reconnectIndex).some((step) => step.kind === 'turn')).toBe(true);
    expect(plan.steps.slice(reconnectIndex + 1).filter((step) => step.kind === 'turn').length).toBeGreaterThanOrEqual(4);
  });

  it('re-uses ONLY existing frozen corpus wording (every ref resolves, text untouched)', () => {
    const plan = committedPlan();
    for (const step of plan.steps) {
      if (step.kind !== 'turn') continue;
      const episode = episodeById(corpus, step.ref.episodeId);
      const turn = episode.inputTurns.find((candidate) => candidate.id === step.ref.turnId);
      expect(turn, `${step.ref.episodeId}/${step.ref.turnId}`).toBeDefined();
      expect(turn?.text.trim().length ?? 0).toBeGreaterThan(8);
      expect(turn?.validatorFrozen ?? false).toBe(false);
    }
  });

  it('paces the session to its declared minimum with explicit pace steps', () => {
    const plan = committedPlan();
    const paceMs = plan.steps.reduce((total, step) => (step.kind === 'pace' ? total + step.ms : total), 0);
    // the pace steps alone carry most of the soak; turn latency adds the rest
    expect(paceMs).toBeGreaterThanOrEqual(480_000);
  });
});

describe('the constructed soak episode', () => {
  it('is a valid, drivable Episode under SOAK-10MIN', () => {
    const episode = soakEpisodeFromPlan(committedPlan(), corpus);
    expect(episode.id).toBe(SOAK_EPISODE_ID);
    expect(episode.holdout).toBe(false);
    expect(EpisodeSchema.safeParse(episode).success).toBe(true);
    expect(episode.permittedRouteOutcomes).toContain('relay-proposal');
    expect(episode.approvalTurns.length).toBeGreaterThanOrEqual(2);
    // every soak pace/reconnect step is a director-visible turn
    const kinds = episode.inputTurns.map((turn) => turn.kind);
    expect(kinds.filter((kind) => kind === 'soak-reconnect')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'soak-pace').length).toBeGreaterThan(0);
  });

  it('joins the corpus for planning and verification without mutating the loaded corpus', () => {
    const episode = soakEpisodeFromPlan(committedPlan(), corpus);
    const joined = withSoakEpisode(corpus, episode);
    expect(joined.episodes.find((candidate) => candidate.id === SOAK_EPISODE_ID)).toBeDefined();
    expect(corpus.episodes.find((candidate) => candidate.id === SOAK_EPISODE_ID)).toBeUndefined();
    expect(joined.episodes.filter((candidate) => candidate.id === SOAK_EPISODE_ID)).toHaveLength(1);
  });
});

describe('the soak journey plan', () => {
  it('maps every operator turn onto an EXISTING frozen fixture and extends the attempt deadline past the soak', () => {
    const plan = committedPlan();
    const episode = soakEpisodeFromPlan(plan, corpus);
    const joined = withSoakEpisode(corpus, episode);
    const journey = soakJourneyPlan(plan, joined, { corpusDir: REAL_CORPUS_DIR, arm: 'standard', tts: 'synthetic' });
    expect(journey.episodeId).toBe(SOAK_EPISODE_ID);
    const turnSteps = plan.steps.filter((step) => step.kind === 'turn');
    // operator turns + (at most) the frozen repair fixture riding along
    expect(journey.turns.length).toBeGreaterThanOrEqual(turnSteps.length);
    expect(journey.turns.length).toBeLessThanOrEqual(turnSteps.length + 1);
    expect(journey.attemptDeadlineMs).toBeGreaterThanOrEqual(plan.minDurationMs + 300_000);
    expect(journey.tts).toBe('synthetic');
    // the first operator turn rides the file-backed fake mic; all later turns the labelled synthetic source
    expect(journey.turns[0]?.inputMode).toBe('fake-file');
    for (const turn of journey.turns.slice(1)) expect(turn.inputMode).toBe('synthetic-stream-source');
    // fixture ids are the SOURCE episodes' frozen fixtures, untouched
    const fixtureIds = new Set(journey.turns.map((turn) => turn.fixtureId));
    for (const id of fixtureIds) expect(id).toMatch(/^C\d{2}-(t\d+|repair-1)$/);
    // and the fixture wording equals the spoken text (freshness guard holds)
    for (const turn of journey.turns) expect(turn.text.trim().length).toBeGreaterThan(8);
  });

  it('is deterministic', () => {
    const plan = committedPlan();
    const episode = soakEpisodeFromPlan(plan, corpus);
    const joined = withSoakEpisode(corpus, episode);
    const a = soakJourneyPlan(plan, joined, { corpusDir: REAL_CORPUS_DIR, arm: 'standard' });
    const b = soakJourneyPlan(plan, joined, { corpusDir: REAL_CORPUS_DIR, arm: 'standard' });
    expect(a).toEqual(b);
  });
});

describe('the corpus loader guard', () => {
  it('refuses a committed episode FILE that uses soak-only turn kinds', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voice-lab-soak-guard-'));
    cleanup.push(dir);
    const episodesDir = path.join(dir, 'episodes');
    mkdirSync(episodesDir, { recursive: true });
    for (const name of readdirSync(path.join(REPO_CORPUS_DIR, 'episodes'))) {
      writeFileSync(path.join(episodesDir, name), readFileSync(path.join(REPO_CORPUS_DIR, 'episodes', name)));
    }
    writeFileSync(path.join(dir, 'index.json'), readFileSync(path.join(REPO_CORPUS_DIR, 'index.json')));
    // corrupt C01 with a soak turn kind
    const c01 = JSON.parse(readFileSync(path.join(REPO_CORPUS_DIR, 'episodes', 'C01.json'), 'utf8')) as {
      inputTurns: Array<Record<string, unknown>>;
    };
    c01.inputTurns.push({ id: 'sx', kind: 'soak-pace', text: '', requiredWords: [], paceMs: 1_000 });
    writeFileSync(path.join(episodesDir, 'C01.json'), JSON.stringify(c01));
    expect(() => loadCorpusFromDir(dir)).toThrow(CorpusError);
    expect(() => loadCorpusFromDir(dir)).toThrow(/soak/);
  });
});
