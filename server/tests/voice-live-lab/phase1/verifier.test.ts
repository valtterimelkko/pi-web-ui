/**
 * The offline verifier's teeth (native-primary plan Phase 1 / gate G1).
 *
 * The verifier recomputes a verdict from RAW attempt records — no re-run, no
 * browser, no trust in a self-reported status. These tests pin the contract:
 *
 *   - a clean control record passes;
 *   - every damaged record class is caught FOR THE RIGHT REASON (distinct
 *     problem codes, asserted individually);
 *   - malformed, empty, missing or tampered evidence is NEVER a pass: it is
 *     indeterminate (exit 2 class) — the verifier fails closed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { loadCorpus, episodeById } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  verifyRecord,
  exitCodeFor,
  recomputeSlotVerdict,
} from '../../../../scripts/voice-lane-lab/lib/verifier.js';

const corpus = loadCorpus();
const C01_D = episodeById(corpus, 'C01').perStepDeadlinesMs;

// ── Record builder (the format the built-app runner writes) ────────────────

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

interface StepRow {
  seq: number;
  atMs: number;
  observation?: Record<string, unknown>;
  action: Record<string, unknown>;
}

class RecordBuilder {
  readonly dir: string;
  private steps: StepRow[] = [];
  private ingressChunks: Array<Record<string, unknown>> = [];
  private ingressPcm: Buffer[] = [];
  private egressChunks: Array<Record<string, unknown>> = [];
  private egressPcm: Buffer[] = [];
  private fixturesUsed: Array<Record<string, unknown>> = [];
  private extraFiles = new Map<string, string>();
  private manifest: Record<string, unknown>;
  private finalise = true;

  constructor(episodeId = 'C01') {
    this.dir = path.join(tmpdir(), `voice-lab-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(this.dir, 'capture'), { recursive: true });
    mkdirSync(path.join(this.dir, 'director'), { recursive: true });
    mkdirSync(path.join(this.dir, 'fixtures'), { recursive: true });
    mkdirSync(path.join(this.dir, 'provider'), { recursive: true });
    const episode = episodeById(corpus, episodeId);
    this.manifest = {
      schemaVersion: 1,
      lab: 'voice-lane-lab',
      attemptId: 'attempt-01',
      runId: 'run-test',
      episodeId,
      evidenceLevel: 'E2',
      captureMode: 'fake-file',
      corpusHash: 'corpus-hash-placeholder',
      status: 'pass',
      startedAtIso: new Date().toISOString(),
      capture: { startedAtMs: 1_000, stoppedAtMs: 6_000 },
      expectedFinalWorkerArtefact: episode.expectedFinalWorkerArtefact,
    };
  }

  step(atMs: number, action: Record<string, unknown>, observation?: Record<string, unknown>): this {
    this.steps.push({ seq: this.steps.length + 1, atMs, action, ...(observation ? { observation } : {}) });
    return this;
  }

  addIngressChunk(opts: { atMs: number; sampleRate?: number; samples?: Int16Array; corrupt?: boolean }): this {
    const samples = opts.samples ?? new Int16Array(480); // 10 ms @ 48 kHz
    const pcm = Buffer.from(samples.buffer);
    const index = this.ingressPcm.length;
    this.ingressPcm.push(pcm);
    this.ingressChunks.push({
      seq: index,
      atMs: opts.atMs,
      sampleRate: opts.sampleRate ?? 48_000,
      sampleCount: samples.length,
      declaredDurationMs: (samples.length / (opts.sampleRate ?? 48_000)) * 1_000,
      sha256: opts.corrupt ? '0'.repeat(64) : sha256(pcm),
      pcmFile: `ingress-${index}.pcm`,
      source: 'fake-file',
    });
    return this;
  }

  addEgressChunk(opts: { atMs: number; samples?: Int16Array; corrupt?: boolean }): this {
    const samples = opts.samples ?? new Int16Array(160); // 10 ms @ 16 kHz
    const pcm = Buffer.from(samples.buffer);
    const index = this.egressPcm.length;
    this.egressPcm.push(pcm);
    this.egressChunks.push({
      seq: index,
      atMs: opts.atMs,
      sampleRate: 16_000,
      sampleCount: samples.length,
      declaredDurationMs: (samples.length / 16_000) * 1_000,
      sha256: opts.corrupt ? '1'.repeat(64) : sha256(pcm),
      pcmFile: `egress-${index}.pcm`,
    });
    return this;
  }

  useFixture(entry: Record<string, unknown>): this {
    this.fixturesUsed.push({ asr: { transcript: 'ok', wer: 0, missingWords: [], ok: true }, ...entry });
    return this;
  }

  addFile(relativePath: string, content: string): this {
    this.extraFiles.set(relativePath, content);
    return this;
  }

  patchManifest(patch: Record<string, unknown>): this {
    this.manifest = { ...this.manifest, ...patch };
    return this;
  }

  /** Corrupt the LAST ingress chunk's declared duration (instrument damage). */
  badLastIngressDuration(ms: number): this {
    const chunks = this.ingressChunks as Array<Record<string, unknown>>;
    if (chunks.length > 0) chunks[chunks.length - 1].declaredDurationMs = ms;
    return this;
  }

  doNotFinalise(): this {
    this.finalise = false;
    return this;
  }

  write(): string {
    for (const [index, pcm] of this.ingressPcm.entries()) writeFileSync(path.join(this.dir, 'capture', `ingress-${index}.pcm`), pcm);
    for (const [index, pcm] of this.egressPcm.entries()) writeFileSync(path.join(this.dir, 'capture', `egress-${index}.pcm`), pcm);
    writeFileSync(path.join(this.dir, 'capture', 'ingress-chunks.json'), `${JSON.stringify(this.ingressChunks, null, 2)}\n`);
    writeFileSync(path.join(this.dir, 'capture', 'egress-chunks.json'), `${JSON.stringify(this.egressChunks, null, 2)}\n`);
    writeFileSync(path.join(this.dir, 'director', 'steps.jsonl'), this.steps.map((step) => JSON.stringify(step)).join('\n') + '\n');
    writeFileSync(path.join(this.dir, 'fixtures', 'used.json'), `${JSON.stringify(this.fixturesUsed, null, 2)}\n`);
    for (const [relative, content] of this.extraFiles) {
      const full = path.join(this.dir, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    if (this.finalise) {
      const artifacts: Array<{ relativePath: string; sha256: string; bytes: number }> = [];
      const walk = (dir: string): void => {
        for (const entry of nodeFs.readdirSync(dir).sort()) {
          const full = path.join(dir, entry);
          if (nodeFs.statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          const bytes = nodeFs.readFileSync(full);
          artifacts.push({
            relativePath: path.relative(this.dir, full),
            sha256: sha256(bytes),
            bytes: bytes.byteLength,
          });
        }
      };
      walk(this.dir);
      const frozen = { ...this.manifest, artifacts };
      writeFileSync(path.join(this.dir, 'manifest.json'), `${JSON.stringify(frozen, null, 2)}\n`);
      writeFileSync(path.join(this.dir, 'manifest.sha256'), `${sha256(nodeFs.readFileSync(path.join(this.dir, 'manifest.json')))}\n`);
      writeFileSync(path.join(this.dir, 'FINALISED'), `${new Date().toISOString()}\n`);
    }
    return this.dir;
  }
}

afterEach(() => {
  // bounded cleanup of the test dirs created this run
  for (const entry of nodeFs.readdirSync(tmpdir())) {
    if (entry.startsWith('voice-lab-verify-')) rmSync(path.join(tmpdir(), entry), { recursive: true, force: true });
  }
});

// ── A canonical clean C01 flow ──────────────────────────────────────────────

function cleanRecord(): RecordBuilder {
  const builder = new RecordBuilder('C01');
  const speaking = (turnId: string, text: string, atMs: number) =>
    builder.step(atMs, { type: 'speak', turnId, text });
  const awaiting = (atMs: number, reason: string) => builder.step(atMs, { type: 'await', reason, deadlineMs: reason.includes('presentation') ? C01_D.presentationMs : reason.includes('release') || reason.includes('delivery') ? C01_D.deliveryMs : reason.includes('worker store') ? C01_D.workerStoreMs : C01_D.candidateMs });
  speaking('t1', 'Relay to worker I want to find out about Podpoint.', 1_000);
  awaiting(1_500, 'waiting for candidate');
  builder.step(2_200, { type: 'await', reason: 'waiting for presentation', deadlineMs: C01_D.presentationMs }, {
    kind: 'candidate',
    payloadText: 'I want to find out about Podpoint.',
    identity: 'cand-1',
    atMs: 2_200,
  });
  builder.step(2_800, { type: 'speak', turnId: 't2', text: 'Yes, send that.' }, {
    kind: 'presentation',
    identity: 'cand-1',
    complete: true,
    atMs: 2_800,
  });
  builder.step(3_200, { type: 'await', reason: 'waiting for release', deadlineMs: C01_D.deliveryMs });
  builder.step(3_500, { type: 'await', reason: 'waiting for delivery', deadlineMs: C01_D.deliveryMs }, {
    kind: 'release',
    identity: 'cand-1',
    atMs: 3_500,
  });
  builder.step(3_700, { type: 'await', reason: 'waiting for worker store', deadlineMs: C01_D.workerStoreMs }, {
    kind: 'delivery',
    identity: 'cand-1',
    atMs: 3_700,
  });
  builder.step(4_000, { type: 'terminal', status: 'complete', reason: 'episode flow completed' }, {
    kind: 'worker-store',
    identity: 'cand-1',
    ok: true,
    atMs: 4_000,
  });
  // 300 ms of ingress audio @ 48 kHz in 10 ms chunks, mirrored at 16 kHz egress.
  for (let index = 0; index < 30; index += 1) {
    const samples = new Int16Array(480).map((_, i) => ((index * 480 + i) % 1000) as number);
    builder.addIngressChunk({ atMs: 1_100 + index * 10, samples });
    builder.addEgressChunk({ atMs: 1_120 + index * 10, samples: new Int16Array(160).map((_, i) => ((index * 160 + i) % 1000) as number) });
  }
  builder.useFixture({
    fixtureId: 'C01-t1-voice-a',
    episodeId: 'C01',
    turnId: 't1',
    voiceProfile: 'voice-a',
    speechLabel: 'synthetic speech based on real wording',
    pcmSha256: sha256(Buffer.from('fixture-bytes')),
    manifestPath: '/root/voice-lane-lab/fixtures/voice-a/manifest.json',
  });
  return builder;
}

describe('clean control', () => {
  it('passes with verdict pass and exit class 0', () => {
    const outcome = verifyRecord(cleanRecord().write(), { corpus });
    expect(outcome.verdict).toBe('pass');
    expect(outcome.problems).toEqual([]);
    expect(exitCodeFor(outcome)).toBe(0);
  });
});

describe('damaged evidence is caught for the right reason', () => {
  it('truncated ingress PCM fails its digest check (ingest-digest-mismatch)', () => {
    const builder = cleanRecord();
    builder.addIngressChunk({ atMs: 5_000, samples: new Int16Array(480).fill(7), corrupt: true });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.map((problem) => problem.code)).toContain('ingress-digest-mismatch');
  });

  it('an egress chunk whose bytes do not match its digest fails (egress-digest-mismatch)', () => {
    const builder = cleanRecord();
    builder.addEgressChunk({ atMs: 5_500, corrupt: true });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.map((problem) => problem.code)).toContain('egress-digest-mismatch');
  });

  it('non-monotonic ingress timestamps violate causality (ingress-causality)', () => {
    const builder = cleanRecord();
    builder.addIngressChunk({ atMs: 900, samples: new Int16Array(480).fill(3) }); // before the previous chunk
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('ingress-causality');
    expect(outcome.verdict).toBe('fail');
  });

  it('declared duration inconsistent with the sample count (ingress-duration)', () => {
    const builder = cleanRecord();
    // 480 samples @ 48 kHz is 10 ms; the corrupted declaration says 999 ms.
    builder.addIngressChunk({ atMs: 5_000 });
    builder.badLastIngressDuration(999);
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('ingress-duration');
    expect(outcome.verdict).toBe('fail');
  });

  it('an approved flow whose worker store never persisted is a demonstrated failure (worker-store-failed)', () => {
    const builder = new RecordBuilder('C01');
    builder
      .step(1_000, { type: 'speak', turnId: 't1', text: 'Relay to worker I want to find out about Podpoint.' })
      .step(1_500, { type: 'await', reason: 'waiting for candidate', deadlineMs: C01_D.candidateMs })
      .step(
        2_200,
        { type: 'await', reason: 'waiting for presentation', deadlineMs: C01_D.presentationMs },
        { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'cand-1', atMs: 2_200 }
      )
      .step(
        2_800,
        { type: 'speak', turnId: 't2', text: 'Yes, send that.' },
        { kind: 'presentation', identity: 'cand-1', complete: true, atMs: 2_800 }
      )
      .step(3_200, { type: 'await', reason: 'waiting for release', deadlineMs: C01_D.deliveryMs })
      .step(
        3_500,
        { type: 'await', reason: 'waiting for delivery', deadlineMs: C01_D.deliveryMs },
        { kind: 'release', identity: 'cand-1', atMs: 3_500 }
      )
      .step(
        3_700,
        { type: 'await', reason: 'waiting for worker store', deadlineMs: C01_D.workerStoreMs },
        { kind: 'delivery', identity: 'cand-1', atMs: 3_700 }
      )
      .step(
        4_000,
        {
          type: 'terminal',
          status: 'interaction-failure',
          reason: 'worker store check failed: approved input was not persisted',
        },
        { kind: 'worker-store', identity: 'cand-1', ok: false, atMs: 4_000 }
      );
    for (let index = 0; index < 30; index += 1) {
      builder.addIngressChunk({ atMs: 1_100 + index * 10 });
      builder.addEgressChunk({ atMs: 1_120 + index * 10 });
    }
    builder.useFixture({
      fixtureId: 'C01-t1-voice-a',
      episodeId: 'C01',
      turnId: 't1',
      voiceProfile: 'voice-a',
      speechLabel: 'synthetic speech based on real wording',
      pcmSha256: sha256(Buffer.from('fixture-bytes')),
      manifestPath: '/root/voice-lane-lab/fixtures/voice-a/manifest.json',
    });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('worker-store-failed');
    expect(outcome.verdict).toBe('fail');
    expect(exitCodeFor(outcome)).toBe(1);
  });

  it('an egress stream with invented audio fails the duration-gap oracle (ingress-egress-duration-gap)', () => {
    const cut = new RecordBuilder('C01');
    cut.step(1_000, { type: 'speak', turnId: 't1', text: 'Relay to worker I want to find out about Podpoint.' });
    cut.step(1_500, { type: 'await', reason: 'waiting for candidate', deadlineMs: C01_D.candidateMs });
    cut.step(2_200, { type: 'await', reason: 'waiting for presentation', deadlineMs: C01_D.presentationMs }, { kind: 'candidate', payloadText: 'I want to find out about Podpoint.', identity: 'cand-1', atMs: 2_200 });
    cut.step(2_800, { type: 'speak', turnId: 't2', text: 'Yes, send that.' }, { kind: 'presentation', identity: 'cand-1', complete: true, atMs: 2_800 });
    cut.step(3_200, { type: 'await', reason: 'waiting for release', deadlineMs: C01_D.deliveryMs });
    cut.step(3_500, { type: 'await', reason: 'waiting for delivery', deadlineMs: C01_D.deliveryMs }, { kind: 'release', identity: 'cand-1', atMs: 3_500 });
    cut.step(3_700, { type: 'await', reason: 'waiting for worker store', deadlineMs: C01_D.workerStoreMs }, { kind: 'delivery', identity: 'cand-1', atMs: 3_700 });
    cut.step(4_000, { type: 'terminal', status: 'complete', reason: 'episode flow completed' }, { kind: 'worker-store', identity: 'cand-1', ok: true, atMs: 4_000 });
    for (let index = 0; index < 30; index += 1) {
      cut.addIngressChunk({ atMs: 1_100 + index * 10 });
    }
    for (let index = 0; index < 60; index += 1) {
      cut.addEgressChunk({ atMs: 1_120 + index * 10 });
    }
    cut.useFixture({
      fixtureId: 'C01-t1-voice-a',
      episodeId: 'C01',
      turnId: 't1',
      voiceProfileId: 'voice-a',
      speechLabel: 'synthetic speech based on real wording',
      pcmSha256: sha256(Buffer.from('fixture-bytes')),
      manifestPath: '/root/voice-lane-lab/fixtures/voice-a/manifest.json',
    });
    const outcome = verifyRecord(cut.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('ingress-egress-duration-gap');
    expect(outcome.verdict).toBe('fail');
  });

  it('tampered manifest is indeterminate, never a pass (manifest-hash-mismatch)', () => {
    const record = cleanRecord().write();
    const manifestPath = path.join(record, 'manifest.json');
    const fs = nodeFs;
    const tampered = fs.readFileSync(manifestPath, 'utf8').replace('"status": "pass"', '"status": "tampered"');
    fs.writeFileSync(manifestPath, tampered);
    const outcome = verifyRecord(record, { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.problems.map((problem) => problem.code)).toContain('manifest-hash-mismatch');
    expect(exitCodeFor(outcome)).toBe(2);
  });

  it('a modified artifact after finalisation is caught (artifact-hash-mismatch)', () => {
    const record = cleanRecord().write();
    const fs = nodeFs;
    fs.appendFileSync(path.join(record, 'provider', 'injected.txt'), 'tail appended later');
    const outcome = verifyRecord(record, { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('artifact-hash-mismatch');
    expect(outcome.verdict).toBe('indeterminate');
  });

  it('recorded actions that the deterministic director would never produce are indeterminate (director-replay-divergence)', () => {
    const builder = cleanRecord();
    // A confirm spoken with NO candidate observed: the replay cannot reproduce it.
    const forged = new RecordBuilder('C01');
    forged.step(1_000, { type: 'speak', turnId: 't1', text: 'Relay to worker I want to find out about Podpoint.' });
    forged.step(1_500, { type: 'speak', turnId: 't2', text: 'Yes, send that.' }); // blind confirm!
    forged
      .addIngressChunk({ atMs: 1_100 })
      .addEgressChunk({ atMs: 1_120 })
      .useFixture({
        fixtureId: 'C01-t1-voice-a',
        episodeId: 'C01',
        turnId: 't1',
        voiceProfile: 'voice-a',
        speechLabel: 'synthetic speech based on real wording',
        pcmSha256: sha256(Buffer.from('fixture-bytes')),
        manifestPath: '/root/voice-lane-lab/fixtures/voice-a/manifest.json',
      });
    void builder;
    const outcome = verifyRecord(forged.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('director-replay-divergence');
    expect(outcome.verdict).toBe('indeterminate');
  });

  it('a repair-branch clarification appearing on the provider side is a hint leak (golden-leak)', () => {
    const builder = cleanRecord();
    builder.addFile('provider/summary.txt', 'Relay to worker, please: I want to find out about Podpoint.');
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('golden-leak');
  });

  it('a fixture whose ASR validation failed makes the record indeterminate (fixture-intelligibility)', () => {
    const builder = cleanRecord();
    builder.useFixture({
      fixtureId: 'C01-t1-voice-a',
      episodeId: 'C01',
      turnId: 't1',
      voiceProfile: 'voice-a',
      speechLabel: 'synthetic speech based on real wording',
      pcmSha256: sha256(Buffer.from('fixture-bytes')),
      manifestPath: '/root/voice-lane-lab/fixtures/voice-a/manifest.json',
      asr: { transcript: 'relay to worker', wer: 0.6, missingWords: ['pod', 'point'], ok: false },
    });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('fixture-intelligibility');
    expect(outcome.verdict).toBe('indeterminate');
  });

  it('a negative-control marker inside an E2 record is contamination (negative-control-in-e2)', () => {
    const builder = cleanRecord().patchManifest({ evidenceLevel: 'E2' });
    builder.addFile('director/nc-marker.txt', 'negative-control: transcript-injection');
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('negative-control-in-e2');
    expect(outcome.verdict).toBe('indeterminate');
  });
});

describe('missing, empty or malformed evidence fails closed', () => {
  it('missing manifest → indeterminate', () => {
    const record = cleanRecord().doNotFinalise().write();
    const outcome = verifyRecord(record, { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(exitCodeFor(outcome)).toBe(2);
  });

  it('empty ingress evidence → indeterminate, never pass', () => {
    const builder = cleanRecord();
    // No ingress chunks were added beyond none: rebuild without audio.
    const empty = new RecordBuilder('C01');
    empty.step(1_000, { type: 'terminal', status: 'complete', reason: 'nothing happened' });
    const outcome = verifyRecord(empty.write(), { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.problems.some((problem) => problem.code.startsWith('ingress-') || problem.code === 'evidence-empty')).toBe(true);
  });

  it('malformed JSON in a required section → indeterminate', () => {
    const record = cleanRecord().write();
    const fs = nodeFs;
    fs.writeFileSync(path.join(record, 'capture', 'ingress-chunks.json'), '{not json');
    const outcome = verifyRecord(record, { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.problems.map((problem) => problem.code)).toContain('malformed-json');
  });

  it('a directory that does not exist → indeterminate', () => {
    const outcome = verifyRecord(path.join(tmpdir(), 'voice-lab-verify-does-not-exist'), { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(exitCodeFor(outcome)).toBe(2);
  });
});

// (slot damage is now covered directly in the damage block above)

// ── Journey records (child J): kind 'primary-mic-journey' ───────────────────

function conversationJourneyRecord(responseText: string, episodeId = 'C09'): RecordBuilder {
  const builder = new RecordBuilder(episodeId);
  builder.patchManifest({
    kind: 'primary-mic-journey',
    captureMode: 'fake-file+synthetic-stream-source',
    laneStop: { finalState: 'stopped-start-control-back' },
    cleanup: { browserClosed: true, previewStopped: true, serverStopped: true, socketsRemoved: true },
    armSelection: { requested: 'standard', env: { VOICE_LIVE_PROFILE: 'standard' } },
    turnModes: [{ turnId: 't1', inputMode: 'fake-file', fixtureId: `${episodeId}-t1` }],
  });
  builder.step(1_000, { type: 'speak', turnId: 't1', text: episodeById(corpus, episodeId).inputTurns[0].text });
  builder.step(1_600, { type: 'await', reason: 'waiting for response', deadlineMs: episodeById(corpus, episodeId).perStepDeadlinesMs.candidateMs });
  builder.step(4_000, { type: 'terminal', status: 'complete', reason: 'episode flow completed' }, {
    kind: 'response',
    text: responseText,
    atMs: 4_000,
  });
  for (let index = 0; index < 30; index += 1) {
    const samples = new Int16Array(480).map((_, i) => ((index * 480 + i) % 1000) as number);
    builder.addIngressChunk({ atMs: 1_100 + index * 10, samples });
    builder.addEgressChunk({ atMs: 1_120 + index * 10, samples: new Int16Array(160).map((_, i) => ((index * 160 + i) % 1000) as number) });
  }
  builder.useFixture({
    fixtureId: `${episodeId}-t1`,
    episodeId,
    turnId: 't1',
    inputMode: 'fake-file',
    speechLabel: 'synthetic speech based on real wording',
    pcmSha256: sha256(Buffer.from(`fixture-bytes-${episodeId.toLowerCase()}`)),
    manifestPath: 'corpus/voices/voice-a.manifest.json',
  });
  return builder;
}

describe('journey records: conversational-only episodes', () => {
  it('a clean conversational journey passes on response grounding, not on a release that never exists', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('The retry handler currently swallows the second error, per the worker session log.').write(),
      { corpus }
    );
    expect(outcome.problems).toEqual([]);
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('a response missing its required content is a demonstrated failure (slot-violation)', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('Something entirely unrelated happened today.').write(),
      { corpus }
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.code === 'slot-violation')).toBe(true);
  });

  it('a response claiming a forbidden action is a demonstrated failure', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('The retry handler issue has been sent to the worker already.').write(),
      { corpus }
    );
    expect(outcome.verdict).toBe('fail');
  });
});

describe('responseMustNotContain is negation-aware (C15/C16 boundary)', () => {
  it('C16: an honest negated response is not flagged for the forbidden completion claim', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord(
        "The worker session is new and has no messages yet, so I can't confirm if the test suite has finished running. The plan is still to run the suite.",
        'C16'
      ).write(),
      { corpus }
    );
    expect(outcome.problems).toEqual([]);
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('C16: an unnegated completion claim still fails', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('The test suite finished and everything is green. The plan worked.', 'C16').write(),
      { corpus }
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.code === 'slot-violation' && problem.detail.includes('finished'))).toBe(true);
  });

  it('a negation cue only rescues occurrences inside its own clause', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord("I can't confirm the plan details. The suite finished.", 'C16').write(),
      { corpus }
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.detail.includes('finished'))).toBe(true);
  });

  it('C15: a negated forbidden phrase passes while required literal content stays literal', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('Understood. It has not yet been sent to the worker. I will not send it. I am still thinking about it.', 'C15').write(),
      { corpus }
    );
    expect(outcome.problems).toEqual([]);
    expect(outcome.verdict).toBe('pass');
  });

  it('C15: an unnegated forbidden phrase still fails', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('Understood. The message was sent to the worker while I was thinking.', 'C15').write(),
      { corpus }
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.detail.includes('sent to the worker'))).toBe(true);
  });
});

describe('openResponse episodes skip the required-word check but keep the forbidden-claim check (C09/C14/C15)', () => {
  /** The corpus the conductor will ship: C09 declares open-response grading. */
  const corpusWithOpenC09 = () => ({
    ...corpus,
    episodes: corpus.episodes.map((episode) =>
      episode.id === 'C09'
        ? { ...episode, expectedSlots: { ...episode.expectedSlots, openResponse: true, responseMustContain: [] } }
        : episode
    ),
  });

  it('a correct conversational answer that omits the old required word passes (the deterministic check is skipped)', () => {
    // The conductor's real shape: C09 declares openResponse: true and an empty
    // responseMustContain. The live defect: the model's right answer omitted the
    // literal slot word and failed deterministically.
    const outcome = verifyRecord(
      conversationJourneyRecord('Something entirely unrelated happened today.').write(),
      { corpus: corpusWithOpenC09() }
    );
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
    expect(outcome.problems).toEqual([]);
  });

  it('the flag itself decides the skip: openResponse with required words declared still skips the required-word check', () => {
    // Schema-impossible from files (the schema refuses the combination), but
    // this pins WHAT the verifier keys on — the episode's flag, not the array's
    // accident of being empty.
    const flaggedCorpus = () => ({
      ...corpus,
      episodes: corpus.episodes.map((episode) =>
        episode.id === 'C09'
          ? { ...episode, expectedSlots: { ...episode.expectedSlots, openResponse: true } }
          : episode
      ),
    });
    const outcome = verifyRecord(
      conversationJourneyRecord('Something entirely unrelated happened today.').write(),
      { corpus: flaggedCorpus() }
    );
    expect(outcome.verdict).toBe('pass');
    expect(outcome.problems).toEqual([]);
  });

  it('forbidden claims still fail under openResponse — the negation-aware check stays armed', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('The retry handler issue has been sent to the worker already.').write(),
      { corpus: corpusWithOpenC09() }
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.code === 'slot-violation')).toBe(true);
    expect(exitCodeFor(outcome)).toBe(1);
  });

  it('without the flag the required words are still enforced (the boundary does not move)', () => {
    const outcome = verifyRecord(
      conversationJourneyRecord('Something entirely unrelated happened today.').write(),
      { corpus }
    );
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.detail.includes('retry handler'))).toBe(true);
  });
});

describe('journey records: cleanup and lane stop fail closed', () => {
  it('an unverified cleanup is indeterminate, never a pass', () => {
    const builder = conversationJourneyRecord('The retry handler is the cause.');
    builder.patchManifest({ cleanup: { browserClosed: true, previewStopped: true, serverStopped: false, socketsRemoved: false } });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.problems.some((problem) => problem.code === 'cleanup-unverified')).toBe(true);
  });

  it('a lane still live after the stop control is a demonstrated failure', () => {
    const builder = conversationJourneyRecord('The retry handler is the cause.');
    builder.patchManifest({ laneStop: { finalState: 'live' } });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.verdict).toBe('fail');
    expect(outcome.problems.some((problem) => problem.code === 'lane-stop-unverified')).toBe(true);
  });

  it('a journey record without turn mode data is indeterminate', () => {
    const builder = conversationJourneyRecord('The retry handler is the cause.');
    builder.patchManifest({ turnModes: undefined });
    const outcome = verifyRecord(builder.write(), { corpus });
    expect(outcome.verdict).toBe('indeterminate');
  });
});
