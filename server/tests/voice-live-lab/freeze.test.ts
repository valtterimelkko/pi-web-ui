/**
 * L6 freeze tests (plan §23; intent §14.5).
 *
 * Freezing is how an adaptive discovery becomes a regression case — and it is
 * also the one place where a simulator's invention could silently become
 * "ground truth". These tests pin the two halves of that contract: the
 * extraction is read back from the record (never inferred from a model), and a
 * synthetic beat can never enter the frozen backbone without an explicit
 * promotion *and* a note that explains it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventLog, createMonotonicClock, type LabEvent } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  LAB_VERSION,
  RECORD_SCHEMA_VERSION,
  createAttempt,
  eventLogPath,
  finaliseAttempt,
} from '../../../scripts/voice-live-lab/lib/record.js';
import type { ScenarioBeat } from '../../../scripts/voice-live-lab/lib/scenario.js';
import { Director } from '../../../scripts/voice-live-lab/lib/director.js';
import {
  AdaptiveOperator,
  OPERATOR_EVENT,
  ScriptedSimulatorClient,
  buildFrozenVariant,
  extractBeatEvidence,
} from '../../../scripts/voice-live-lab/lib/operator-sim.js';
import {
  DEFAULT_RUNS_ROOT,
  main,
  parseArgs,
  resolveAttemptDir,
  runFreeze,
  type CliDependencies,
} from '../../../scripts/voice-live-lab/cli.js';

const BEAT_ID = 'b9-adaptive-tail';

function beat(overrides: Partial<ScenarioBeat> = {}): ScenarioBeat {
  return {
    id: BEAT_ID,
    mode: 'adaptive',
    goal: 'Get the worker to un-gate child two.',
    trigger: { after: 'candidate-silence', silenceMs: 800 },
    permissions: [],
    maxTurns: 4,
    expect: {},
    ...overrides,
  };
}

function move(say: string | null, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ say, interrupt: false, waitMs: 0, beatDone: false, why: 'for the record', ...overrides });
}

function event(overrides: Partial<LabEvent> & { seq: number; kind: string }): LabEvent {
  return {
    tMs: overrides.seq * 100,
    source: 'operator',
    id: `e${overrides.seq}`,
    payload: {},
    ...overrides,
  };
}

/** A trace with two beats: b9 (ours, with a fixture) and b10 (not ours). */
function trace(): LabEvent[] {
  return [
    event({ seq: 1, kind: OPERATOR_EVENT.BEAT_START, payload: { beatId: BEAT_ID } }),
    event({
      seq: 2,
      kind: OPERATOR_EVENT.HEARD,
      payload: { beatId: BEAT_ID, index: 0, text: 'shall I send that to the worker?', atSeconds: 0.5 },
    }),
    event({
      seq: 3,
      kind: OPERATOR_EVENT.LINE,
      payload: {
        beatId: BEAT_ID,
        text: 'yes, go ahead',
        interrupt: false,
        why: 'authorise the read-back',
        fixtureId: 'synthetic:b9:1',
        fixtureSha256: 'abc123',
        fixtureBytes: 640,
        fixtureDurationMs: 900,
        provenance: 'synthetic',
      },
    }),
    event({
      seq: 4,
      kind: OPERATOR_EVENT.REACTION,
      causedBy: 'e3',
      payload: { beatId: BEAT_ID, modelMs: 20, ttsMs: 10, totalMs: 30, excludedFromCandidateLatency: true },
    }),
    event({
      seq: 5,
      kind: OPERATOR_EVENT.HEARD,
      payload: { index: 1, text: 'fair enough, sending it now', atSeconds: 1.2 },
    }),
    event({
      seq: 6,
      kind: OPERATOR_EVENT.LINE,
      payload: { beatId: 'b10-other', text: 'tell it to hold', fixtureId: 'synthetic:b10:1', provenance: 'synthetic' },
    }),
    event({ seq: 7, kind: OPERATOR_EVENT.BEAT_DONE, payload: { beatId: BEAT_ID, why: 'goal met' } }),
  ];
}

const SCENARIO = {
  schema: 'voice-lab.scenario/1',
  id: 't1-s1-orchestration-voice',
  tier: 1,
  world: 'worlds/orchestrating-two-children.json',
  persona: 'personas/operator-default.md',
  language: 'en-GB',
  voice: { engine: 'supertonic-3', voice: 'M1', rate: 1.05 },
  endpointing: 'E',
  budgets: { maxRunMs: 480000, maxOperatorTurns: 24, maxCandidateSpeechMs: 240000, maxSpendUsd: 0.5 },
  beats: [
    {
      id: BEAT_ID,
      mode: 'adaptive',
      goal: 'Get the worker to un-gate child two.',
      trigger: { after: 'candidate-silence', silenceMs: 800 },
      permissions: ['confirm:draft-proposed-in-this-beat'],
      maxTurns: 4,
      expect: { noUnauthorisedRelease: true },
    },
  ],
};

// ---------------------------------------------------------------------------
// Extraction (read back from the record, never inferred)
// ---------------------------------------------------------------------------

describe('freeze: extraction from the attempt record', () => {
  it('reads back only the requested beat’s spoken lines', () => {
    const evidence = extractBeatEvidence(trace(), BEAT_ID);
    expect(evidence.lines.map((line) => line.text)).toEqual(['yes, go ahead']);
    expect(evidence.beatId).toBe(BEAT_ID);
  });

  it('attaches the segregated reaction latency to its line', () => {
    const evidence = extractBeatEvidence(trace(), BEAT_ID);
    expect(evidence.lines[0].reactionLatencyMs).toBe(30);
  });

  it('collects the synthetic fixtures the lines produced', () => {
    const evidence = extractBeatEvidence(trace(), BEAT_ID);
    expect(evidence.fixtures).toEqual([
      { id: 'synthetic:b9:1', sha256: 'abc123', bytes: 640, durationMs: 900 },
    ]);
  });

  it('collects heard segments tagged for the beat and untagged ones inside its window', () => {
    const evidence = extractBeatEvidence(trace(), BEAT_ID);
    expect(evidence.heard.map((segment) => segment.text)).toEqual([
      'shall I send that to the worker?',
      'fair enough, sending it now',
    ]);
  });

  it('returns empty evidence rather than throwing for an unknown beat', () => {
    const evidence = extractBeatEvidence(trace(), 'b99-nope');
    expect(evidence.lines).toEqual([]);
    expect(evidence.heard).toEqual([]);
    expect(evidence.fixtures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Variant construction and provenance
// ---------------------------------------------------------------------------

describe('freeze: variant construction', () => {
  function build(overrides: Record<string, unknown> = {}) {
    return buildFrozenVariant({ events: trace(), attemptId: 'attempt-01', beatId: BEAT_ID, ...overrides });
  }

  it('marks the beat frozen and keeps its synthetic provenance', () => {
    const variant = build();
    expect(variant.mode).toBe('frozen');
    expect(variant.beats[0].mode).toBe('frozen');
    expect(variant.provenance).toBe('synthetic');
    expect(variant.beats[0].provenance).toBe('synthetic');
  });

  it('records the source attempt and beat', () => {
    const variant = build();
    expect(variant.sourceAttempt).toBe('attempt-01');
    expect(variant.sourceBeat).toBe(BEAT_ID);
    expect(variant.beats[0].sourceAttempt).toBe('attempt-01');
    expect(variant.beats[0].sourceBeat).toBe(BEAT_ID);
  });

  it('uses the first actually-spoken line as the golden utterance', () => {
    expect(build().beats[0].utterance).toBe('yes, go ahead');
  });

  it('carries every synthetic line and fixture on the beat', () => {
    const variant = build();
    expect(variant.beats[0].syntheticLines).toHaveLength(1);
    expect(variant.beats[0].fixtures).toHaveLength(1);
  });

  it('inherits the source scenario’s metadata', () => {
    const variant = build({ scenario: SCENARIO });
    expect(variant.id).toBe(`t1-s1-orchestration-voice-frozen-${BEAT_ID}`);
    expect(variant.sourceScenario).toBe('t1-s1-orchestration-voice');
    expect(variant.world).toBe('worlds/orchestrating-two-children.json');
    expect(variant.tier).toBe(1);
    expect(variant.beats[0].permissions).toEqual(['confirm:draft-proposed-in-this-beat']);
  });

  it('refuses to promote a synthetic beat into the backbone without a note', () => {
    expect(() => build({ allowPromotion: true })).toThrow(/manifest note/);
    expect(() => build({ allowPromotion: true, promotionNote: '   ' })).toThrow(/manifest note/);
  });

  it('refuses to freeze a beat with no spoken lines', () => {
    expect(() => build({ beatId: 'b99-never-ran' })).toThrow(/no spoken lines/);
  });

  it('is not backbone-eligible by default, even though the lines are real recordings of a run', () => {
    const variant = build();
    expect(variant.promotion.promoted).toBe(false);
    expect(variant.promotion.syntheticBackboneEligible).toBe(false);
  });

  it('promotes only with both the flag and an explaining note, and never strips provenance', () => {
    const variant = build({ allowPromotion: true, promotionNote: 'operator reviewed 2026-09-17' });
    expect(variant.promotion.promoted).toBe(true);
    expect(variant.promotion.note).toBe('operator reviewed 2026-09-17');
    expect(variant.promotion.syntheticBackboneEligible).toBe(true);
    expect(variant.provenance).toBe('synthetic');
    expect(variant.beats[0].provenance).toBe('synthetic');
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('freeze: CLI argument handling', () => {
  it('parses the freeze command with its defaults', () => {
    const parsed = parseArgs(['freeze', '--attempt', 'attempt-01', '--beat', 'b9-adaptive-tail']);
    expect(parsed.command).toBe('freeze');
    expect(parsed.attempt).toBe('attempt-01');
    expect(parsed.beat).toBe('b9-adaptive-tail');
    expect(parsed.runsRoot).toBe(DEFAULT_RUNS_ROOT);
    expect(parsed.allowPromotion).toBe(false);
  });

  it('parses promotion flags and an explicit output path', () => {
    const parsed = parseArgs([
      'freeze',
      '--attempt',
      'a',
      '--beat',
      'b',
      '--runs-root',
      '/tmp/runs',
      '--output',
      '/tmp/out.json',
      '--allow-promotion',
      '--promotion-note',
      'reviewed',
      '--json',
    ]);
    expect(parsed.runsRoot).toBe('/tmp/runs');
    expect(parsed.outputPath).toBe('/tmp/out.json');
    expect(parsed.allowPromotion).toBe(true);
    expect(parsed.promotionNote).toBe('reviewed');
    expect(parsed.json).toBe(true);
  });

  it('refuses a freeze without --attempt or --beat', () => {
    expect(() => parseArgs(['freeze', '--beat', 'b'])).toThrow(/--attempt/);
    expect(() => parseArgs(['freeze', '--attempt', 'a'])).toThrow(/--beat/);
  });
});

describe('freeze: runFreeze end to end', () => {
  let root: string;
  let attemptDir: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'voice-live-freeze-'));
    attemptDir = createAttempt(root, 'run-l6', 'adaptive', 'attempt-01').attemptDir;
    const log = new EventLog({ clock: createMonotonicClock(), filePath: eventLogPath(attemptDir) });
    const scripted = new ScriptedSimulatorClient([
      move('yes, go ahead', { beatDone: true, why: 'goal met' }),
    ]);
    const operator = new AdaptiveOperator({
      director: new Director({ scenarioId: 't1-s1-orchestration-voice', language: 'en-GB' }),
      client: scripted.client,
      log,
      now: () => 0,
    });
    await operator.nextTurn({
      beat: beat({ permissions: ['confirm:draft-proposed-in-this-beat'] }),
      heard: [{ index: 0, text: 'shall I send that to the worker?', atSeconds: 0.5 }],
      earlierLines: [],
    });
    writeFileSync(path.join(attemptDir, 'scenario.json'), `${JSON.stringify(SCENARIO, null, 2)}\n`);
    finaliseAttempt(attemptDir, {
      schemaVersion: RECORD_SCHEMA_VERSION,
      labVersion: LAB_VERSION,
      runId: 'run-l6',
      condition: 'adaptive',
      attemptId: 'attempt-01',
      createdAt: new Date().toISOString(),
      eventLog: 'application/events.jsonl',
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves an attempt by id under the runs root, or by directory', () => {
    expect(resolveAttemptDir(root, 'attempt-01')).toBe(attemptDir);
    expect(resolveAttemptDir(root, attemptDir)).toBe(attemptDir);
    expect(() => resolveAttemptDir(root, 'attempt-99')).toThrow(/no attempt directory/);
  });

  it('writes a synthetic frozen variant under the run directory', async () => {
    const result = await runFreeze({ attempt: 'attempt-01', beat: BEAT_ID, runsRoot: root });
    expect(result.code).toBe(0);
    expect(result.outputPath).toBe(path.join(root, 'runs', 'run-l6', 'frozen', `t1-s1-orchestration-voice-frozen-${BEAT_ID}.json`));
    const written = JSON.parse(readFileSync(result.outputPath as string, 'utf8')) as Record<string, unknown>;
    expect(written.provenance).toBe('synthetic');
    expect(written.mode).toBe('frozen');
    expect(written.sourceAttempt).toBe('attempt-01');
    expect(written.sourceBeat).toBe(BEAT_ID);
    const manifestNote = written.manifestNote as Record<string, unknown>;
    expect(manifestNote.kind).toBe('frozen-variant');
    expect(manifestNote.syntheticBackboneEligible).toBe(false);
  });

  it('writes to an explicit output path', async () => {
    const target = path.join(root, 'custom', 'variant.json');
    const result = await runFreeze({ attempt: 'attempt-01', beat: BEAT_ID, runsRoot: root, outputPath: target });
    expect(result.code).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('"provenance": "synthetic"');
  });

  it('refuses to overwrite an existing frozen variant', async () => {
    const target = path.join(root, 'custom', 'variant.json');
    await runFreeze({ attempt: 'attempt-01', beat: BEAT_ID, runsRoot: root, outputPath: target });
    const second = await runFreeze({ attempt: 'attempt-01', beat: BEAT_ID, runsRoot: root, outputPath: target });
    expect(second.code).toBe(1);
    expect(second.stderr.join('\n')).toContain('refusing to overwrite');
  });

  it('refuses promotion through the CLI without a note', async () => {
    const result = await runFreeze({
      attempt: 'attempt-01',
      beat: BEAT_ID,
      runsRoot: root,
      allowPromotion: true,
    });
    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('manifest note');
  });

  it('records an explicit promotion and still keeps synthetic provenance', async () => {
    const target = path.join(root, 'custom', 'promoted.json');
    const result = await runFreeze({
      attempt: 'attempt-01',
      beat: BEAT_ID,
      runsRoot: root,
      outputPath: target,
      allowPromotion: true,
      promotionNote: 'operator reviewed this discovery',
    });
    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    expect(written.provenance).toBe('synthetic');
    expect((written.promotion as Record<string, unknown>).promoted).toBe(true);
    expect((written.manifestNote as Record<string, unknown>).note).toBe('operator reviewed this discovery');
  });

  it('refuses to freeze a damaged event log', async () => {
    writeFileSync(eventLogPath(attemptDir), '{not json}\n');
    const result = await runFreeze({ attempt: 'attempt-01', beat: BEAT_ID, runsRoot: root });
    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('damaged event log');
  });

  it('is reachable through the CLI entry point', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDependencies = { writeOut: (line) => out.push(line), writeErr: (line) => err.push(line) };
    const code = await main(['freeze', '--attempt', 'attempt-01', '--beat', BEAT_ID, '--runs-root', root], deps);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('provenance=synthetic');
  });
});
