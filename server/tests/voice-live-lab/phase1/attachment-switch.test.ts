/**
 * W4 attachment-switch (C24 family) harness: the director's `adaptive-switch`
 * gesture and the verifier's C24 adjudication — the pending proposal is
 * retired by the product (cancel-before-retarget), NEVER released or delivered
 * to the new attachment, and the switch is acknowledged audibly.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EpisodeSchema, episodeById, loadCorpus, type Episode } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import { EpisodeDirector, type DirectorObservation } from '../../../../scripts/voice-lane-lab/lib/director.js';
import { verifyRecord } from '../../../../scripts/voice-lane-lab/lib/verifier.js';
import { collectArtifacts } from '../../../../scripts/voice-lane-lab/lib/records.js';

const corpus = loadCorpus();
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const dirs: string[] = [];
afterEach(() => dirs.splice(0));

describe('the adaptive-switch director gesture', () => {
  it('emits exactly one switch-attachment action and completes the post-switch confirm flow', () => {
    const base = episodeById(corpus, 'C01');
    const parsed = EpisodeSchema.safeParse({
      ...base,
      id: 'C24',
      holdout: false, // the merged-overlay shape: the frozen structure is drivable
      title: 'test: switch attached worker with a pending proposal',
      permittedRouteOutcomes: ['relay-proposal'],
      inputTurns: [
        { id: 't1', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
        { id: 't2', kind: 'adaptive-switch', text: '', requiredWords: [] },
        { id: 't3', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
        { id: 't4', kind: 'adaptive-confirm', text: base.inputTurns[1]!.text, requiredWords: base.inputTurns[1]!.requiredWords },
      ],
      approvalTurns: [{ turnId: 't4', precondition: 'candidate-matched+presentation-complete' }],
    });
    expect(parsed.success).toBe(true);
    const episode = parsed.data as Episode;
    let clock = 1_000;
    const director = new EpisodeDirector(episode, { now: () => clock });
    const script: Array<{ observation?: DirectorObservation; advanceMs?: number }> = [
      { advanceMs: 2_000 }, // speak t1: relay to worker A
      { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'pA', atMs: 0 }, advanceMs: 3_000 }, // pA lands in the switch window
      { advanceMs: 2_000 }, // switch action
      { advanceMs: 2_000 }, // speak t3: relay to worker B
      { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'pB', atMs: 0 }, advanceMs: 4_000 }, // pB lands in the speak window
      { observation: { kind: 'presentation', identity: 'pB', complete: true, atMs: 0 }, advanceMs: 3_000 }, // t4's phases consume pB
      { advanceMs: 2_000 }, // speak t4: confirm pB
      { observation: { kind: 'release', identity: 'pB', atMs: 0 }, advanceMs: 3_000 },
      { observation: { kind: 'response', text: 'Now attached to the second worker.', atMs: 0 }, advanceMs: 2_000 }, // audible ack
      { observation: { kind: 'delivery', identity: 'pB', atMs: 0 }, advanceMs: 2_000 },
      { observation: { kind: 'worker-store', identity: 'pB', ok: true, atMs: 0 }, advanceMs: 2_000 },
    ];
    const rows: Array<{ atMs: number; observation?: DirectorObservation; action: ReturnType<EpisodeDirector['step']> }> = [];
    for (const entry of script) {
      clock += entry.advanceMs ?? 1_000;
      const action = director.step(entry.observation);
      rows.push({ atMs: clock, observation: entry.observation, action });
      if (action.type === 'terminal') break;
    }
    const switches = rows.map((row) => row.action).filter((action) => action.type === 'switch-attachment');
    expect(switches).toHaveLength(1);
    expect(rows.some((row) => row.action.type === 'speak' && (row.action as { turnId: string }).turnId === 't3')).toBe(true);
    expect(rows[rows.length - 1]!.action).toMatchObject({ type: 'terminal', status: 'complete' });
    // the switch is a GESTURE, never speech
    expect(switches[0]).not.toHaveProperty('text');
  });
});

/** Build an attachment-switch record exactly as the runner freezes it. */
function buildSwitchRecord(options: {
  manifestSwitch?: Record<string, unknown> | null;
  wireReplaced?: boolean;
  releaseOldAfterSwitch?: boolean;
  ackAfterSwitch?: boolean;
}): string {
  const base = episodeById(corpus, 'C01');
  const episodeParsed = EpisodeSchema.safeParse({
    ...base,
    id: 'C24',
    holdout: false, // the merged-overlay shape: the frozen structure is drivable
    title: 'test: switch attached worker with a pending proposal',
    inputTurns: [
      { id: 't1', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
      { id: 't2', kind: 'adaptive-switch', text: '', requiredWords: [] },
      { id: 't3', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
      { id: 't4', kind: 'adaptive-confirm', text: base.inputTurns[1]!.text, requiredWords: base.inputTurns[1]!.requiredWords },
    ],
    approvalTurns: [{ turnId: 't4', precondition: 'candidate-matched+presentation-complete' }],
  });
  const episode = episodeParsed.data as Episode;
  let clock = 1_000;
  const director = new EpisodeDirector(episode, { now: () => clock });
  const script: Array<{ observation?: DirectorObservation; advanceMs?: number }> = [
    { advanceMs: 2_000 }, // speak t1
    { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'pA', atMs: 0 }, advanceMs: 3_000 }, // pA in the switch window
    { advanceMs: 2_000 }, // switch action
    { advanceMs: 2_000 }, // speak t3
    { observation: { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'pB', atMs: 0 }, advanceMs: 4_000 }, // pB speak window
    { observation: { kind: 'presentation', identity: 'pB', complete: true, atMs: 0 }, advanceMs: 3_000 },
    { advanceMs: 2_000 }, // speak t4
    { observation: { kind: 'release', identity: 'pB', atMs: 0 }, advanceMs: 3_000 },
    { observation: { kind: 'response', text: 'Now attached to the second worker.', atMs: 0 }, advanceMs: 2_000 }, // ack
    { observation: { kind: 'delivery', identity: 'pB', atMs: 0 }, advanceMs: 2_000 },
    ...(options.releaseOldAfterSwitch
      ? [{ observation: { kind: 'release', identity: 'pA', atMs: 0 } as unknown as DirectorObservation, advanceMs: 2_000 }]
      : []),
    { observation: { kind: 'worker-store', identity: 'pB', ok: true, atMs: 0 }, advanceMs: 2_000 },
  ];
  const steps: Array<Record<string, unknown>> = [];
  for (const entry of script) {
    clock += entry.advanceMs ?? 1_000;
    const action = director.step(entry.observation) as unknown as Record<string, unknown>;
    const row: Record<string, unknown> = { seq: steps.length + 1, atMs: clock, action };
    if (entry.observation) row.observation = entry.observation;
    steps.push(row);
    if (action.type === 'terminal') break;
  }

  if (options.ackAfterSwitch === false) {
    // strip the audible ack step: the switch went unacknowledged
    const index = steps.findIndex((step) => (step as { observation?: { kind?: string } }).observation?.kind === 'response');
    if (index >= 0) steps.splice(index, 1);
    steps.forEach((step, position) => ((step as { seq?: number }).seq = position + 1));
  }
  const dir = path.join(tmpdir(), `voice-lab-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  dirs.push(dir);
  for (const sub of ['capture', 'director', 'fixtures', 'provider', 'input', 'evaluation']) mkdirSync(path.join(dir, sub), { recursive: true });
  writeFileSync(path.join(dir, 'director', 'steps.jsonl'), `${steps.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const pcm = Buffer.alloc(9_600);
  const egress = Buffer.alloc(2_400);
  writeFileSync(path.join(dir, 'capture', 'ingress-0.pcm'), pcm);
  writeFileSync(path.join(dir, 'capture', 'egress-0.pcm'), egress);
  writeFileSync(path.join(dir, 'capture', 'ingress-chunks.json'), JSON.stringify([{ seq: 0, atMs: 1_500, sampleRate: 16_000, sampleCount: 48_000, declaredDurationMs: 3_000, sha256: sha256(pcm), pcmFile: 'ingress-0.pcm', source: 'fake-file' }]));
  writeFileSync(path.join(dir, 'capture', 'egress-chunks.json'), JSON.stringify([{ seq: 0, atMs: 1_800, sampleRate: 16_000, sampleCount: 24_000, declaredDurationMs: 1_500, sha256: sha256(egress), pcmFile: 'egress-0.pcm' }]));
  let seq = 0;
  const frame = (type: string, atMs: number, payload: Record<string, unknown>) => ({ seq: seq++, atMs, direction: 'inbound', type, frame: { type, version: 1, laneId: 'lane-1', attachmentGeneration: 0, ...payload } });
  const wire = [
    frame('proposal_created', 5_000, { proposal: { proposalId: 'pA', original: 'x', tidied: 'x' } }),
    frame('proposal_presentation', 8_000, { proposalId: 'pA', completed: true }),
    // the product retires the old proposal BEFORE the retarget (H1)
    ...(options.wireReplaced === false
      ? []
      : [frame('proposal_resolved', 10_000, { proposalId: 'pA', outcome: 'replaced' })]),
    frame('voice_state', 11_000, { state: 'live' }),
    frame('proposal_created', 14_000, { proposal: { proposalId: 'pB', original: 'x', tidied: 'x' } }),
    frame('proposal_resolved', 20_000, { proposalId: 'pB', outcome: 'released' }),
    frame('receipt_event', 21_000, { receipt: { proposalId: 'pB', outcome: 'delivered' } }),
  ];
  writeFileSync(path.join(dir, 'capture', 'wire-frames.json'), JSON.stringify(wire, null, 2));
  writeFileSync(path.join(dir, 'fixtures', 'used.json'), JSON.stringify([{ fixtureId: 'C01-t1', episodeId: 'C24', turnId: 't1', inputMode: 'fake-file', voiceProfileId: 'voice-a', speechLabel: 'synthetic speech based on real wording', pcmSha256: 'a'.repeat(64), manifestPath: 'corpus/voices/voice-a.manifest.json', asr: { ok: true, wer: 0.02, missingWords: [] } }]));
  const last = steps[steps.length - 1] as { atMs: number; action: Record<string, unknown> };
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    lab: 'voice-lane-lab',
    attemptId: 'attempt-01',
    episodeId: 'C24',
    arm: 'standard',
    kind: 'primary-mic-journey',
    evidenceLevel: 'E2',
    captureMode: 'fake-file+synthetic-stream-source',
    corpusHash: 'corpus-hash-placeholder',
    status: 'pass',
    startedAtIso: new Date().toISOString(),
    capture: { startedAtMs: 1_000, stoppedAtMs: last.atMs + 500, getUserMediaCalls: 1, sourceLabel: 'fake-file', ingressChunks: 1, egressChunks: 1 },
    laneStop: { finalState: 'stopped-start-control-back' },
    cleanup: { browserClosed: true, previewStopped: true, serverStopped: true, socketsRemoved: true },
    terminal: last.action,
    turnModes: [{ turnId: 't1', inputMode: 'fake-file', fixtureId: 'C01-t1' }],
    armSelection: { requested: 'standard', env: {} },
    ...(options.manifestSwitch === null ? {} : { attachmentSwitch: options.manifestSwitch ?? { fromWorkerSessionId: 'w1', toWorkerSessionId: 'w2' } }),
    artifacts: collectArtifacts(dir),
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dir, 'manifest.sha256'), `${sha256(readFileSync(path.join(dir, 'manifest.json')))}\n`);
  writeFileSync(path.join(dir, 'FINALISED'), new Date().toISOString());
  return dir;
}

/** The corpus as production grades it: the C24 record is graded through the overlay-merged (drivable) episode. */
function switchCorpus(): ReturnType<typeof loadCorpus> {
  const base = episodeById(corpus, 'C01');
  const episodeParsed = EpisodeSchema.safeParse({
    ...base,
    id: 'C24',
    holdout: false,
    title: 'test: switch attached worker with a pending proposal',
    inputTurns: [
      { id: 't1', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
      { id: 't2', kind: 'adaptive-switch', text: '', requiredWords: [] },
      { id: 't3', kind: 'opening', text: base.inputTurns[0]!.text, requiredWords: base.inputTurns[0]!.requiredWords },
      { id: 't4', kind: 'adaptive-confirm', text: base.inputTurns[1]!.text, requiredWords: base.inputTurns[1]!.requiredWords },
    ],
    approvalTurns: [{ turnId: 't4', precondition: 'candidate-matched+presentation-complete' }],
  });
  const episode = episodeParsed.data as Episode;
  return { ...corpus, episodes: corpus.episodes.map((candidate) => (candidate.id === 'C24' ? episode : candidate)) };
}

describe('the verifier attachment-switch adjudication', () => {
  it('a compliant switch record passes: old proposal retired, never retargeted, audibly acknowledged', () => {
    const dir = buildSwitchRecord({});
    const outcome = verifyRecord(dir, { corpus: switchCorpus() });
    const lines = outcome.lines.join('\n');
    expect(outcome.problems.filter((problem) => problem.code.startsWith('switch-'))).toEqual([]);
    expect(lines).toContain('retired by the product');
    expect(lines).toContain('never retargeted');
    expect(lines).toContain('acknowledged audibly');
    expect(outcome.verdict).toBe('pass');
  });

  it('a record without the switch declaration is not adjudicated as a switch', () => {
    const dir = buildSwitchRecord({ manifestSwitch: null });
    const outcome = verifyRecord(dir, { corpus: switchCorpus() });
    expect(outcome.problems.some((problem) => problem.code.startsWith('switch-'))).toBe(false);
  });

  it('releasing the OLD proposal after the switch fails as a retarget', () => {
    const dir = buildSwitchRecord({ releaseOldAfterSwitch: true });
    const outcome = verifyRecord(dir, { corpus: switchCorpus() });
    expect(outcome.problems.some((problem) => problem.code === 'switch-retargeted')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });

  it('a missing retirement record fails closed', () => {
    const dir = buildSwitchRecord({ wireReplaced: false });
    const outcome = verifyRecord(dir, { corpus: switchCorpus() });
    expect(outcome.problems.some((problem) => problem.code === 'switch-retirement-unrecorded')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });

  it('a silent switch (no audible acknowledgement) fails', () => {
    const dir = buildSwitchRecord({ ackAfterSwitch: false });
    const outcome = verifyRecord(dir, { corpus: switchCorpus() });
    expect(outcome.problems.some((problem) => problem.code === 'switch-unacknowledged')).toBe(true);
    expect(outcome.verdict).toBe('fail');
  });
});
