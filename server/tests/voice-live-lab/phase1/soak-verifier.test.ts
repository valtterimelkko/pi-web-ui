/**
 * The offline verifier's SOAK branch (W4): a soak record is a journey record
 * plus the soak adjudication — duration ≥ 10 minutes, ≥ 8 operator turns,
 * EXACTLY ONE mid-session voice-transport reconnect, and an honest
 * pending-work disposition: a proposal created before the reconnect and still
 * unreleased at it must be released, delivered and stored AFTER it (survival).
 * A product-side retirement (proposal_resolved replaced/cancelled) is graded
 * truthfully as a demonstrated retirement — never faked into survival.
 *
 * The bars are FIXED by the programme (600 s / 8 turns / 1 reconnect); a
 * record's own soak block may only declare STRICTER bars.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCorpus, type Episode } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import { EpisodeDirector, type DirectorObservation } from '../../../../scripts/voice-lane-lab/lib/director.js';
import { verifyRecord, exitCodeFor } from '../../../../scripts/voice-lane-lab/lib/verifier.js';
import { collectArtifacts } from '../../../../scripts/voice-lane-lab/lib/records.js';
import { SOAK_EPISODE_ID, loadSoakPlan, soakEpisodeFromPlan, withSoakEpisode as join } from '../../../../scripts/voice-lane-lab/lib/soak-plan.js';

const corpus = loadCorpus();
const REPO = new URL('../../../../scripts/voice-lane-lab/corpus', import.meta.url).pathname;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const dirs: string[] = [];
afterEach(() => {
  // records are evidence-shaped but disposable test fixtures
  dirs.splice(0);
});

interface ScriptEntry {
  advanceMs?: number;
  observation?: DirectorObservation;
}

const CLEANUP = { browserClosed: true, previewStopped: true, serverStopped: true, socketsRemoved: true };

/** Drive a soak episode over a script, then freeze the record exactly as the runner writes it. */
function buildSoakRecord(options: {
  episode: Episode;
  script: ScriptEntry[];
  wireFrames: Array<{ seq: number; atMs: number; direction: 'inbound' | 'outbound'; type: string; frame: Record<string, unknown> }>;
  soakEvents: Array<Record<string, unknown>>;
  soakBlock?: Record<string, unknown>;
  startedAtMs?: number;
}): string {
  let clock = 1_000;
  const director = new EpisodeDirector(options.episode, { now: () => clock });
  const steps: Array<{ seq: number; atMs: number; action: Record<string, unknown>; observation?: Record<string, unknown> }> = [];
  for (const entry of options.script) {
    clock += entry.advanceMs ?? 1_000;
    const action = director.step(entry.observation) as unknown as Record<string, unknown>;
    const row: (typeof steps)[number] = { seq: steps.length + 1, atMs: clock, action };
    if (entry.observation) row.observation = entry.observation as unknown as Record<string, unknown>;
    steps.push(row);
    if (action.type === 'terminal') break;
  }
  const dir = path.join(tmpdir(), `voice-lab-soak-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  for (const sub of ['capture', 'director', 'fixtures', 'provider', 'input', 'evaluation']) {
    mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeFileSync(path.join(dir, 'director', 'steps.jsonl'), `${steps.map((row) => JSON.stringify(row)).join('\n')}\n`);
  // ingress: one plausible 3 s chunk; egress: 1.5 s back at 16 kHz
  const pcm = Buffer.alloc(9_600);
  writeFileSync(path.join(dir, 'capture', 'ingress-0.pcm'), pcm);
  const egress = Buffer.alloc(2_400);
  writeFileSync(path.join(dir, 'capture', 'egress-0.pcm'), egress);
  writeFileSync(
    path.join(dir, 'capture', 'ingress-chunks.json'),
    JSON.stringify([
      { seq: 0, atMs: (options.startedAtMs ?? 1_000) + 500, sampleRate: 16_000, sampleCount: 48_000, declaredDurationMs: 3_000, sha256: sha256(pcm), pcmFile: 'ingress-0.pcm', source: 'fake-file' },
    ])
  );
  writeFileSync(
    path.join(dir, 'capture', 'egress-chunks.json'),
    JSON.stringify([
      { seq: 0, atMs: (options.startedAtMs ?? 1_000) + 800, sampleRate: 16_000, sampleCount: 24_000, declaredDurationMs: 1_500, sha256: sha256(egress), pcmFile: 'egress-0.pcm' },
    ])
  );
  writeFileSync(path.join(dir, 'capture', 'wire-frames.json'), `${JSON.stringify(options.wireFrames, null, 2)}\n`);
  writeFileSync(path.join(dir, 'capture', 'console-errors.json'), JSON.stringify({ pageErrors: [], console: [], websockets: ['WS open: ws://x', 'WS closed: ws://x', 'WS open: ws://x'] }));
  writeFileSync(
    path.join(dir, 'fixtures', 'used.json'),
    JSON.stringify([
      { fixtureId: 'C01-t1', episodeId: SOAK_EPISODE_ID, turnId: 's01', inputMode: 'fake-file', voiceProfileId: 'voice-a', speechLabel: 'synthetic speech based on real wording', pcmSha256: 'a'.repeat(64), manifestPath: 'corpus/voices/voice-a.manifest.json', asr: { ok: true, wer: 0.02, missingWords: [] } },
    ])
  );
  writeFileSync(path.join(dir, 'provider', 'soak-events.jsonl'), `${options.soakEvents.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const last = steps[steps.length - 1]!;
  const manifest = {
    schemaVersion: 1,
    lab: 'voice-lane-lab',
    attemptId: 'attempt-01',
    episodeId: SOAK_EPISODE_ID,
    arm: 'standard',
    kind: 'primary-mic-journey',
    evidenceLevel: 'E2',
    captureMode: 'fake-file+synthetic-stream-source',
    corpusHash: 'corpus-hash-placeholder',
    status: 'pass',
    startedAtIso: new Date().toISOString(),
    capture: { startedAtMs: options.startedAtMs ?? 1_000, stoppedAtMs: last.atMs + 500, getUserMediaCalls: 1, sourceLabel: 'fake-file', ingressChunks: 1, egressChunks: 1 },
    laneStop: { finalState: 'stopped-start-control-back' },
    cleanup: CLEANUP,
    terminal: last.action,
    turnModes: [{ turnId: 's01', inputMode: 'fake-file', fixtureId: 'C01-t1' }],
    armSelection: { requested: 'standard', env: { VOICE_LIVE_PROFILE: 'standard' } },
    soak: options.soakBlock ?? { minDurationMs: 600_000, minOperatorTurns: 8, reconnects: 1 },
    artifacts: collectArtifacts(dir),
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dir, 'manifest.sha256'), `${sha256(readFileSync(path.join(dir, 'manifest.json')))}\n`);
  writeFileSync(path.join(dir, 'FINALISED'), new Date().toISOString());
  return dir;
}

/** The committed soak episode, joined into a corpus for the verifier. */
function joinedCorpus(episode: Episode) {
  return join(corpus, episode);
}

const committedEpisode = (): Episode => soakEpisodeFromPlan(loadSoakPlan(REPO), corpus);

/**
 * A full compliant script IN PROGRAM ORDER with waits placed AFTER the action
 * that causes them (the runner sleeps once it SEES a pace action): 8 operator
 * turns, 4×150 s pace waits, one reconnect, p1 pending across it and
 * released/delivered/stored after it (cycle 1's resolution frames are recorded
 * while the FSM is mid-program, exactly as in a real run).
 */
function compliantScript(): ScriptEntry[] {
  const pace = 150_000;
  return [
    { advanceMs: 2_000 }, // speak s01: relay 1
    { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p1', atMs: 0 }, advanceMs: 8_000 }, // stored in the speak window; speak s02
    { observation: { kind: 'presentation', identity: 'p1', complete: true, atMs: 0 }, advanceMs: 4_000 }, // stored; pace s03 action
    { advanceMs: pace }, // the pace wait; reconnect s04 action
    { advanceMs: 2_000 }, // the reconnect wait; speak s05: confirm p1
    { observation: { kind: 'release', identity: 'p1', atMs: 0 }, advanceMs: pace }, // recorded; pace s06 action
    { observation: { kind: 'delivery', identity: 'p1', atMs: 0 }, advanceMs: 3_000 }, // recorded; speak s07: relay 2
    { observation: { kind: 'worker-store', identity: 'p1', ok: true, atMs: 0 }, advanceMs: 2_000 }, // recorded; speak s08: conversation
    { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p2', atMs: 0 }, advanceMs: pace }, // stored; pace s09 action
    { advanceMs: 4_000 }, // the pace wait; await-candidate consumes p2
    { observation: { kind: 'presentation', identity: 'p2', complete: true, atMs: 0 }, advanceMs: 2_000 }, // consumed; speak s10: confirm p2
    { advanceMs: 2_000 }, // speak s11: conversation
    { observation: { kind: 'response', text: 'Still holding.', atMs: 0 }, advanceMs: pace }, // pace s12 action
    { advanceMs: 2_000 }, // the pace wait; speak s13: conversation closer
    { observation: { kind: 'response', text: 'Session remains live.', atMs: 0 }, advanceMs: 3_000 },
    { observation: { kind: 'release', identity: 'p2', atMs: 0 }, advanceMs: 5_000 },
    { observation: { kind: 'delivery', identity: 'p2', atMs: 0 }, advanceMs: 3_000 },
    { observation: { kind: 'worker-store', identity: 'p2', ok: true, atMs: 0 }, advanceMs: 2_000 }, // terminal complete
  ];
}

function compliantWireFrames(): Array<{ seq: number; atMs: number; direction: 'inbound' | 'outbound'; type: string; frame: Record<string, unknown> }> {
  let seq = 0;
  const frame = (type: string, atMs: number, payload: Record<string, unknown>) => ({
    seq: seq++,
    atMs,
    direction: 'inbound' as const,
    type,
    frame: { type, version: 1, laneId: 'lane-1', attachmentGeneration: 0, ...payload },
  });
  return [
    frame('voice_state', 2_000, { state: 'live' }),
    frame('proposal_created', 10_000, { proposal: { proposalId: 'p1', original: 'I want to find out about Podpoint.', tidied: 'I want to find out about Podpoint.' } }),
    frame('proposal_presentation', 14_000, { proposalId: 'p1', completed: true }),
    frame('transcript_delta', 20_000, { speaker: 'talker', final: true, text: 'The deploy takes nearly ten minutes today.' }),
    // the transport blip + reconnect: the lane comes back live
    frame('voice_state', 170_000, { state: 'live' }),
    frame('proposal_resolved', 176_000, { proposalId: 'p1', outcome: 'released' }),
    frame('receipt_event', 179_000, { receipt: { proposalId: 'p1', outcome: 'delivered' } }),
    frame('proposal_created', 315_000, { proposal: { proposalId: 'p2', original: 'I want to find out about Podpoint.', tidied: 'I want to find out about Podpoint.' } }),
    frame('proposal_presentation', 319_000, { proposalId: 'p2', completed: true }),
    frame('proposal_resolved', 490_000, { proposalId: 'p2', outcome: 'released' }),
    frame('receipt_event', 493_000, { receipt: { proposalId: 'p2', outcome: 'delivered' } }),
  ];
}

const oneReconnectEvent = (atMs: number) => [{ kind: 'transport-reconnect', atMs, detail: 'client sockets dropped; session socket reopened; lane re-bound' }];

describe('the verifier soak branch (compliant record)', () => {
  it('a compliant soak record passes: survival proven across the reconnect', () => {
    const dir = buildSoakRecord({
      episode: committedEpisode(),
      script: compliantScript(),
      wireFrames: compliantWireFrames(),
      soakEvents: oneReconnectEvent(175_000),
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(committedEpisode()) });
    const lines = outcome.lines.join('\n');
    expect(outcome.problems.filter((problem) => problem.code.startsWith('soak-'))).toEqual([]);
    expect(lines).toContain('soak duration');
    expect(lines).toContain('operator turns');
    expect(lines).toContain('reconnect');
    expect(lines).toContain('pending-work survival');
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('a record shorter than ten minutes fails on the fixed duration bar', () => {
    const script = compliantScript().map((entry) => ({ ...entry, advanceMs: Math.min(entry.advanceMs ?? 1_000, 5_000) }));
    const dir = buildSoakRecord({
      episode: committedEpisode(),
      script,
      wireFrames: compliantWireFrames(),
      soakEvents: oneReconnectEvent(60_000),
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(committedEpisode()) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-duration')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });

  it('a lying soak block cannot loosen the fixed bars', () => {
    const script = compliantScript().map((entry) => ({ ...entry, advanceMs: Math.min(entry.advanceMs ?? 1_000, 5_000) }));
    const dir = buildSoakRecord({
      episode: committedEpisode(),
      script,
      wireFrames: compliantWireFrames(),
      soakEvents: oneReconnectEvent(60_000),
      soakBlock: { minDurationMs: 1_000, minOperatorTurns: 1, reconnects: 1 },
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(committedEpisode()) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-duration')).toBe(true);
  });

  it('fewer than eight operator turns fails', () => {
    // a deliberately small honest soak episode: 2 operator turns + reconnect
    const committed = committedEpisode();
    const small: Episode = {
      ...committed,
      inputTurns: [
        committed.inputTurns[0]!, // relay
        { id: 'sx', kind: 'soak-pace', text: '', requiredWords: [], paceMs: 5_000 },
        { id: 'sr', kind: 'soak-reconnect', text: '', requiredWords: [] },
        committed.inputTurns[3]!, // confirm
      ],
    };
    const dir = buildSoakRecord({
      episode: small,
      script: [
        { advanceMs: 2_000 }, // relay speak
        { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p1', atMs: 0 }, advanceMs: 5_000 },
        { observation: { kind: 'presentation', identity: 'p1', complete: true, atMs: 0 }, advanceMs: 3_000 },
        { advanceMs: 5_000 }, // pace
        { advanceMs: 2_000 }, // reconnect
        { advanceMs: 2_000 }, // confirm speak
        { observation: { kind: 'release', identity: 'p1', atMs: 0 }, advanceMs: 3_000 },
        { observation: { kind: 'delivery', identity: 'p1', atMs: 0 }, advanceMs: 2_000 },
        { observation: { kind: 'worker-store', identity: 'p1', ok: true, atMs: 0 }, advanceMs: 2_000 },
      ],
      wireFrames: compliantWireFrames(),
      soakEvents: oneReconnectEvent(12_000),
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(small) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-turn-count')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });
});

describe('the verifier soak branch (reconnect accounting)', () => {
  it('a record with NO reconnect action fails', () => {
    // an honest program that simply never reconnects
    const committed = committedEpisode();
    const episode: Episode = {
      ...committed,
      inputTurns: [
        committed.inputTurns[0]!, // relay speak
        { id: 'sx', kind: 'soak-pace', text: '', requiredWords: [], paceMs: 150_000 },
        committed.inputTurns.find((turn) => turn.kind === 'adaptive-confirm')!, // confirm
      ],
    };
    const dir = buildSoakRecord({
      episode,
      script: [
        { advanceMs: 2_000 },
        { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p1', atMs: 0 }, advanceMs: 5_000 },
        { observation: { kind: 'presentation', identity: 'p1', complete: true, atMs: 0 }, advanceMs: 3_000 },
        { advanceMs: 150_000 }, // pace
        { advanceMs: 2_000 }, // confirm speak
        { observation: { kind: 'release', identity: 'p1', atMs: 0 }, advanceMs: 3_000 },
        { observation: { kind: 'delivery', identity: 'p1', atMs: 0 }, advanceMs: 2_000 },
        { observation: { kind: 'worker-store', identity: 'p1', ok: true, atMs: 0 }, advanceMs: 2_000 },
      ],
      wireFrames: compliantWireFrames(),
      soakEvents: [],
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(episode) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-reconnect-count')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });

  it('a record whose reconnect action lacks corroborating soak evidence fails', () => {
    const dir = buildSoakRecord({
      episode: committedEpisode(),
      script: compliantScript(),
      wireFrames: compliantWireFrames(),
      soakEvents: [], // the runner recorded no reconnect event
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(committedEpisode()) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-reconnect-evidence')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });
});

describe('the verifier soak branch (pending-work disposition)', () => {
  it('the product retiring the pending proposal is graded as a demonstrated retirement (fail, never faked)', () => {
    const wire = compliantWireFrames().map((row) =>
      row.frame.proposalId === 'p1' && row.type === 'proposal_resolved'
        ? { ...row, frame: { ...row.frame, outcome: 'replaced' } }
        : row
    );
    // the director never sees the release for p1: the repair budget exhausts into interaction failure
    const script: ScriptEntry[] = compliantScript()
      .slice(0, 8) // up to just after the reconnect + confirm speak
      .concat([{ advanceMs: 40_000 }, { advanceMs: 40_000 }, { advanceMs: 40_000 }, { advanceMs: 40_000 }]); // pace, candidate deadline, clarification, terminal
    const dir = buildSoakRecord({
      episode: committedEpisode(),
      script,
      wireFrames: wire,
      soakEvents: oneReconnectEvent(175_000),
    });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(committedEpisode()) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-pending-work-retired')).toBe(true);
    expect(outcome.verdict).toBe('fail');
    expect(exitCodeFor(outcome)).toBe(1);
  });
  it('no pending proposal at the reconnect fails the survival requirement', () => {
    // reconnect FIRST, before any candidate ever existed
    const committed = committedEpisode();
    const episode: Episode = {
      ...committed,
      inputTurns: [
        committed.inputTurns[0]!, // relay speak
        { id: 'sr', kind: 'soak-reconnect', text: '', requiredWords: [] },
        committed.inputTurns.find((turn) => turn.kind === 'adaptive-confirm')!, // confirm
      ],
    };
    const script: ScriptEntry[] = [
      { advanceMs: 2_000 }, // relay speak
      { advanceMs: 2_000 }, // reconnect (no candidate yet)
      { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'p1', atMs: 0 }, advanceMs: 5_000 },
      { observation: { kind: 'presentation', identity: 'p1', complete: true, atMs: 0 }, advanceMs: 3_000 },
      { advanceMs: 2_000 }, // confirm speak
      { observation: { kind: 'release', identity: 'p1', atMs: 0 }, advanceMs: 3_000 },
      { observation: { kind: 'delivery', identity: 'p1', atMs: 0 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'p1', ok: true, atMs: 0 }, advanceMs: 2_000 },
    ];
    const dir = buildSoakRecord({ episode, script, wireFrames: compliantWireFrames(), soakEvents: oneReconnectEvent(6_000) });
    const outcome = verifyRecord(dir, { corpus: joinedCorpus(episode) });
    expect(outcome.problems.some((problem) => problem.code === 'soak-pending-work-missing')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });
});

// the strict corpus never carries SOAK-10MIN; the verifier corpus must
describe('verifier corpus plumbing', () => {
  it('verifyRecord cannot grade a soak record without the joined episode (fails closed)', () => {
    const dir = buildSoakRecord({
      episode: committedEpisode(),
      script: compliantScript(),
      wireFrames: compliantWireFrames(),
      soakEvents: oneReconnectEvent(175_000),
    });
    const outcome = verifyRecord(dir, { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.problems.some((problem) => problem.code === 'manifest-incomplete')).toBe(true);
  });
});
