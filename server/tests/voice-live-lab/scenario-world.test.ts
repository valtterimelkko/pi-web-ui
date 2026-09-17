/**
 * L2 scenario + world fixture tests.
 *
 * The seven tier-1 scenarios and their scripted worlds live in the
 * agent-benchmarks repository (§10 decision e). These tests pin them: every
 * file must parse, validate against its schema, and obey the authoring
 * invariants that keep the scorer honest — golden hidden-truth strings never
 * appear in a spoken utterance, relays carry confirming permissions, and the
 * benchmark 3 port keeps its turn↔beat correspondence.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SCENARIO_SCHEMA,
  loadScenarioFile,
  validateScenario,
  type VoiceScenario,
} from '../../../scripts/voice-live-lab/lib/scenario.js';
import { WORLD_SCHEMA, goldenStringsFor, loadWorldFile, validateWorld, type WorkerWorld } from '../../../scripts/voice-live-lab/lib/worlds.js';

const BENCH_ROOT = '/root/agent-benchmarks/benchmarks/04-voice-live-lab';
const benchRootExists = existsSync(BENCH_ROOT);

/** Paths of the shipped tier-1 scenarios, sorted by id. */
function tier1ScenarioPaths(): string[] {
  const dir = path.join(BENCH_ROOT, 'scenarios', 'tier1');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

function worldPaths(): string[] {
  const dir = path.join(BENCH_ROOT, 'worlds');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();
}

/** Every word sequence a world hides, checked against spoken golden text. */
function spokenCorpus(scenario: VoiceScenario): string {
  const pieces: string[] = [];
  for (const beat of scenario.beats) {
    if (beat.utterance) pieces.push(beat.utterance);
    for (const branch of beat.branches ?? []) pieces.push(branch.utterance);
  }
  return pieces.join('\n').toLowerCase();
}

describe.skipIf(!benchRootExists)('shipped tier-1 scenarios', () => {
  const EXPECTED_IDS = [
    't1-s1-orchestration-voice',
    't1-s2-clarification',
    't1-s3-plain-worker',
    't1-s4-permission-gate',
    't1-s5-sparse-state',
    't1-s6-worker-permission',
    't1-s7-reading-levels',
  ];

  it('ships exactly the seven planned scenarios', () => {
    const ids = tier1ScenarioPaths().map((file) => JSON.parse(readFileSync(file, 'utf8')).id);
    expect(ids).toEqual(EXPECTED_IDS);
  });

  for (const file of tier1ScenarioPaths()) {
    const scenario = loadScenarioFile(file);
    const name = path.basename(file);

    it(`${name}: validates against ${SCENARIO_SCHEMA}`, () => {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const outcome = validateScenario(raw);
      expect(outcome.problems).toEqual([]);
      expect(raw).toMatchObject({ schema: SCENARIO_SCHEMA, tier: 1, language: 'en-GB', endpointing: 'E' });
    });

    it(`${name}: beats carry triggers, and relays carry a confirming permission`, () => {
      for (const beat of scenario.beats) {
        if (beat.expect.relay === true) {
          expect(beat.permissions.some((p) => p.startsWith('confirm:'))).toBe(true);
        }
        if (beat.expect.conversationalOnly === true) {
          expect(beat.expect.relay).toBe(false);
        }
      }
    });

    it(`${name}: no hidden-truth string appears in any spoken utterance`, () => {
      if (!scenario.world) return;
      const world: WorkerWorld = loadWorldFile(path.join(BENCH_ROOT, scenario.world));
      const corpus = spokenCorpus(scenario);
      for (const secret of goldenStringsFor(world)) {
        expect(corpus.includes(secret.toLowerCase())).toBe(false);
      }
    });

    it(`${name}: utterances are speakable prose (no markdown, bounded length)`, () => {
      for (const beat of scenario.beats) {
        for (const text of [beat.utterance, ...(beat.branches ?? []).map((b) => b.utterance)]) {
          if (!text) continue;
          expect(text.length).toBeLessThan(400);
          expect(text).not.toMatch(/```|^- |\|#|\*\*/);
        }
      }
    });
  }

  it('benchmark 3 port: s1 keeps its eight-turn correspondence', () => {
    const scenario = loadScenarioFile(path.join(BENCH_ROOT, 'scenarios/tier1/t1-s1-orchestration-voice.json'));
    expect(scenario.beats).toHaveLength(8);
    expect(scenario.beats.map((b) => b.id)).toEqual([
      'b1-status',
      'b2-hold-phase-3',
      'b3-confirm-hold',
      'b4-thinking-aloud',
      'b5-server-file-question',
      'b6-queue-quality-question',
      'b7-gate-note-instruction',
      'b8-confirm-note',
    ]);
  });

  it('every confirmation release names the words that must reach the worker', () => {
    for (const file of tier1ScenarioPaths()) {
      const scenario = loadScenarioFile(file);
      for (const beat of scenario.beats) {
        if (beat.expect.relay === true) {
          expect(beat.expect.releasedContains?.length ?? 0).toBeGreaterThan(0);
          expect(beat.expect.ackIsTrusted).toBe(true);
        }
      }
    }
  });
});

describe.skipIf(!benchRootExists)('shipped worlds', () => {
  it('every scenario resolves to a valid shipped world', () => {
    for (const file of tier1ScenarioPaths()) {
      const scenario = loadScenarioFile(file);
      expect(scenario.world).toBeTruthy();
      const world = loadWorldFile(path.join(BENCH_ROOT, scenario.world as string));
      expect(world.schema).toBe(WORLD_SCHEMA);
    }
  });

  for (const file of worldPaths()) {
    const world = loadWorldFile(file);
    const name = path.basename(file);

    it(`${name}: validates against ${WORLD_SCHEMA}`, () => {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const outcome = validateWorld(raw);
      expect(outcome.problems).toEqual([]);
    });

    it(`${name}: hidden truth is distinctive and timeline ids are unique`, () => {
      const secrets = goldenStringsFor(world);
      expect(secrets.length).toBeGreaterThan(0);
      for (const secret of secrets) expect(secret.length).toBeGreaterThanOrEqual(8);
      const ids = world.timeline.filter((e) => 'id' in e && e.id).map((e) => (e as { id: string }).id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  it('the permission-flow world carries both permission requests finding D needs', () => {
    const world = loadWorldFile(path.join(BENCH_ROOT, 'worlds/worker-permission-flow.json'));
    const requests = world.timeline.filter((entry) => entry.kind === 'permission-request');
    expect(requests.map((r) => (r as { id: string }).id).sort()).toEqual(['permission-request-1', 'permission-request-2']);
  });

  it('scenario world-event triggers reference existing world events', () => {
    const worldEventIds = new Set<string>();
    for (const file of worldPaths()) {
      const world = loadWorldFile(file);
      for (const entry of world.timeline) {
        if ('id' in entry && entry.id) worldEventIds.add(`${world.id}:${entry.id}`);
      }
    }
    for (const file of tier1ScenarioPaths()) {
      const scenario = loadScenarioFile(file);
      const world = scenario.world ? loadWorldFile(path.join(BENCH_ROOT, scenario.world)) : null;
      for (const beat of scenario.beats) {
        if (beat.trigger.after === 'world-event') {
          expect(worldEventIds.has(`${world?.id}:${beat.trigger.event}`)).toBe(true);
        }
      }
    }
  });
});

describe('validator rejects damaged documents', () => {
  it('scenario: relay expectation without a confirming permission is an authoring error', () => {
    const outcome = validateScenario({
      schema: SCENARIO_SCHEMA,
      id: 't1-x-broken',
      tier: 1,
      language: 'en-GB',
      voice: { engine: 'supertonic-3', voice: 'M1' },
      endpointing: 'E',
      budgets: { maxRunMs: 1, maxOperatorTurns: 1, maxCandidateSpeechMs: 1, maxSpendUsd: 1 },
      beats: [
        { id: 'b1', mode: 'frozen', utterance: 'yes', trigger: { at: 'run-start' }, permissions: [], expect: { relay: true } },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.some((p) => p.includes('confirm: permission'))).toBe(true);
  });

  it('scenario: unknown permission verb, missing default branch and bad id are named', () => {
    const outcome = validateScenario({
      schema: 'wrong',
      id: 'not-an-id',
      tier: 1,
      language: 'en-GB',
      voice: { engine: 'supertonic-3', voice: 'M1' },
      endpointing: 'E',
      budgets: { maxRunMs: 1, maxOperatorTurns: 1, maxCandidateSpeechMs: 1, maxSpendUsd: 1 },
      beats: [
        { id: 'b1', mode: 'frozen', utterance: 'go', trigger: { at: 'run-start' }, permissions: ['fly:to-the-moon'], expect: {} },
        { id: 'b1', mode: 'branching', trigger: { after: 'candidate-silence' }, permissions: [], expect: {}, branches: [{ utterance: 'x' }] },
      ],
    });
    expect(outcome.ok).toBe(false);
    const joined = outcome.problems.join('\n');
    expect(joined).toContain('schema');
    expect(joined).toContain('id');
    expect(joined).toContain('fly:to-the-moon');
    expect(joined).toContain('default branch');
  });

  it('world: short hidden-truth strings are refused (leak checks need distinctive strings)', () => {
    const outcome = validateWorld({
      schema: WORLD_SCHEMA,
      id: 'w',
      runtime: 'pi',
      initial: { activity: 'x' },
      timeline: [],
      hiddenTruth: { a: 'yes' },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toContain('distinctive');
  });
});
