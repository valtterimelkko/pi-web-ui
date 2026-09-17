/**
 * L2 baseline dry-run end-to-end.
 *
 * Every shipped tier-1 scenario is driven through the full hermetic path —
 * scenario beats → speech driver → baseline cascade (real TalkerSession +
 * policy core + recording delivery) → reference player → immutable attempt
 * record → offline verifier — and the mechanical spine of each attempt is
 * asserted: one cascade turn per spoken beat, one recorded delivery per
 * expect.relay beat, verifiable records, dry-run labelling that can never be
 * mistaken for a provider measurement.
 *
 * What this deliberately does NOT assert: that a scripted model is a good
 * talker. The dry run proves the EQUIPMENT; conversation quality is what the
 * scored runs measure.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, parseEventLog } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import { runDryAttempt } from '../../../scripts/voice-live-lab/lib/baseline-dryrun.js';
import { main as cliMain } from '../../../scripts/voice-live-lab/cli.js';

const BENCH_SCENARIOS = '/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1';
const benchExists = existsSync(BENCH_SCENARIOS);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-dryrun-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function eventsOf(attemptDir: string) {
  const parsed = parseEventLog(readFileSync(path.join(attemptDir, 'application', 'events.jsonl'), 'utf8'));
  expect(parsed.problems).toEqual([]);
  return parsed.events;
}

describe.skipIf(!benchExists)('hermetic dry run of every shipped tier-1 scenario', () => {
  const scenarios = [
    { file: 't1-s1-orchestration-voice.json', releases: 2 },
    { file: 't1-s2-clarification.json', releases: 2 },
    { file: 't1-s3-plain-worker.json', releases: 1 },
    { file: 't1-s4-permission-gate.json', releases: 2 },
    { file: 't1-s5-sparse-state.json', releases: 1 },
    { file: 't1-s6-worker-permission.json', releases: 2 },
    { file: 't1-s7-reading-levels.json', releases: 0 },
  ];

  for (const { file, releases } of scenarios) {
    it(`${file}: verifies clean with ${releases} gated release(s)`, async () => {
      const scenarioPath = path.join(BENCH_SCENARIOS, file);
      const outcome = await runDryAttempt(scenarioPath, {
        runsRoot: root,
        runId: `dryrun-${file}`,
        attemptId: 'attempt-01',
        frameIntervalMs: 1,
        quiet: true,
      });

      // The record is finalised and the offline verifier accepts it.
      expect(outcome.verifyProblems).toEqual([]);
      expect(outcome.verifyOk).toBe(true);

      // One cascade turn per spoken beat (frozen + primary-branch beats).
      const spokenBeats = outcome.scenario.beats.filter((beat) => {
        const utterance = beat.mode === 'frozen' ? beat.utterance : beat.branches?.[0]?.utterance;
        return Boolean(utterance);
      });
      expect(outcome.turns).toBe(spokenBeats.length);

      // One recorded delivery per relay expectation, with the released words.
      const events = eventsOf(outcome.attempt.attemptDir);
      const releaseEvents = events.filter((e) => e.kind === EVENT.HARNESS_RELEASE);
      expect(releaseEvents).toHaveLength(releases);
      const relayBeats = outcome.scenario.beats.filter((b) => b.expect.relay === true);
      expect(relayBeats).toHaveLength(releases);
      for (const beat of relayBeats) {
        for (const word of beat.expect.releasedContains ?? []) {
          expect(
            releaseEvents.some((e) => String(e.payload.text).toLowerCase().includes(word.toLowerCase()))
          ).toBe(true);
        }
      }

      // Turn-complete payloads carry the latency facts the scorer needs.
      const turnCompletions = events.filter((e) => e.kind === EVENT.TURN_COMPLETE);
      expect(turnCompletions).toHaveLength(spokenBeats.length);
      for (const turn of turnCompletions) {
        expect(turn.payload.failedLeg).toBeNull();
        expect(Number(turn.payload.ttfaMs)).toBeGreaterThan(0);
        expect(String(turn.payload.transcript).length).toBeGreaterThan(0);
      }

      // The manifest labels the attempt as a dry run (never a measurement).
      const manifest = JSON.parse(readFileSync(path.join(outcome.attempt.attemptDir, 'manifest.json'), 'utf8'));
      expect(manifest.usage).toMatchObject({ mode: 'dry-run', provider: 'baseline-cascade' });
      expect(manifest.usage.realProviderCalls).toBe(0);
    });
  }

  it('gate regression through the full path: a bare yes with nothing held is a mechanical dead end', async () => {
    // s7 ends with "Ok, stop reading." — confirm-shaped, but with the level
    // flips suppressed [[to-talker]] there is nothing held: no release, and
    // the fixed nothing-pending ack is what reaches TTS.
    const outcome = await runDryAttempt(path.join(BENCH_SCENARIOS, 't1-s7-reading-levels.json'), {
      runsRoot: root,
      runId: 'dryrun-s7-deadend',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      quiet: true,
    });
    const events = eventsOf(outcome.attempt.attemptDir);
    const mech = events.filter((e) => e.kind === EVENT.HARNESS_MECHANICAL);
    expect(mech.some((e) => String(e.payload.reply).includes('Nothing is held right now'))).toBe(true);
  });

  it('golden hidden truth never reaches the trace', async () => {
    const outcome = await runDryAttempt(path.join(BENCH_SCENARIOS, 't1-s1-orchestration-voice.json'), {
      runsRoot: root,
      runId: 'dryrun-golden',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      quiet: true,
    });
    expect(outcome.world).not.toBeNull();
    const logText = readFileSync(path.join(outcome.attempt.attemptDir, 'application', 'events.jsonl'), 'utf8');
    for (const secret of Object.values(outcome.world?.hiddenTruth ?? {})) {
      expect(logText.includes(secret)).toBe(false);
    }
  });
});

describe.skipIf(!benchExists)('cli baseline-dryrun wiring', () => {
  it('runs attempts, prints per-attempt verify status and exits 0', async () => {
    const lines: string[] = [];
    const code = await cliMain(
      [
        'baseline-dryrun',
        '--scenario', path.join(BENCH_SCENARIOS, 't1-s3-plain-worker.json'),
        '--runs-root', root,
        '--attempts', '2',
        '--frame-interval-ms', '1',
        '--json',
      ],
      { writeOut: (line) => lines.push(line), writeErr: (line) => lines.push(`ERR: ${line}`) }
    );
    expect(code).toBe(0);
    const jsonLine = lines.find((l) => l.startsWith('{'));
    expect(jsonLine).toBeTruthy();
    const parsed = JSON.parse(jsonLine as string) as { runId: string; attempts: Array<{ verifyOk: boolean }> };
    expect(parsed.attempts).toHaveLength(2);
    expect(parsed.attempts.every((a) => a.verifyOk)).toBe(true);
    // Two attempts are two directories; nothing was overwritten.
    expect(lines.filter((l) => l.includes('attempt-01') || l.includes('attempt-02')).length).toBeGreaterThanOrEqual(2);
  });
});
