/**
 * Capture-proof records (Phase 1): the built-app mode's record kind.
 *
 * A capture-proof proves the capture path (start/stop, ingress digests,
 * resampler egress, cleanup) — it does NOT claim a completed episode, so the
 * verifier grades it by capture rules: capture-started/stopped observations
 * bracketing the audio, and CLEANUP THAT FAILS CLOSED (an unverified teardown
 * is never a pass).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import { verifyRecord, exitCodeFor } from '../../../../scripts/voice-lane-lab/lib/verifier.js';
import * as nodeFs from 'node:fs';

const corpus = loadCorpus();
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

interface CaptureProofOptions {
  cleanup?: Record<string, boolean>;
  withStop?: boolean;
  tamperStop?: boolean;
  laneStopOverride?: Record<string, unknown>;
}

function buildCaptureProofRecord(options: CaptureProofOptions = {}): string {
  const dir = path.join(tmpdir(), `voice-lab-cp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, 'capture'), { recursive: true });
  mkdirSync(path.join(dir, 'director'), { recursive: true });
  mkdirSync(path.join(dir, 'fixtures'), { recursive: true });

  const pcm = Buffer.from(new Int16Array(480).fill(100).buffer);
  const ingressChunks: Array<Record<string, unknown>> = [];
  const egressChunks: Array<Record<string, unknown>> = [];
  writeFileSync(path.join(dir, 'capture', 'ingress-0.pcm'), pcm);
  const ePcm = Buffer.from(new Int16Array(160).fill(100).buffer);
  writeFileSync(path.join(dir, 'capture', 'egress-0.pcm'), ePcm);
  for (let index = 0; index < 30; index += 1) {
    ingressChunks.push({
      seq: index,
      atMs: 1_100 + index * 10,
      sampleRate: 48_000,
      sampleCount: 480,
      declaredDurationMs: 10,
      sha256: sha256(pcm),
      pcmFile: 'ingress-0.pcm',
      source: 'default',
    });
    egressChunks.push({
      seq: index,
      atMs: 1_120 + index * 10,
      sampleRate: 16_000,
      sampleCount: 160,
      declaredDurationMs: 10,
      sha256: sha256(ePcm),
      pcmFile: 'egress-0.pcm',
    });
  }
  writeFileSync(path.join(dir, 'capture', 'ingress-chunks.json'), JSON.stringify(ingressChunks));
  writeFileSync(path.join(dir, 'capture', 'egress-chunks.json'), JSON.stringify(egressChunks));

  const steps = [
    { seq: 1, atMs: 1_000, action: { type: 'speak', turnId: 't1', text: 'Relay to worker I want to find out about Podpoint.' }, observation: { kind: 'capture-started', mode: 'fake-file' } },
    { seq: 2, atMs: 1_400, action: { type: 'await', reason: 'waiting for lane live', deadlineMs: 60_000 }, observation: { kind: 'lane-live' } },
    { seq: 3, atMs: 5_000, action: { type: 'await', reason: 'waiting for utterance to traverse', deadlineMs: 45_000 }, observation: { kind: 'ingress-complete', chunks: 30 } },
  ];
  if (!options.tamperStop) {
    steps.push({
      seq: 4,
      atMs: options.withStop === false ? 5_500 : 6_000,
      action: { type: 'terminal', status: 'capture-complete', reason: 'capture proof finished' },
      observation: { kind: 'capture-stopped' },
    });
  }
  writeFileSync(path.join(dir, 'director', 'steps.jsonl'), steps.map((step) => JSON.stringify(step)).join('\n') + '\n');
  writeFileSync(
    path.join(dir, 'fixtures', 'used.json'),
    JSON.stringify([
      {
        fixtureId: 'C01-t1',
        episodeId: 'C01',
        turnId: 't1',
        voiceProfileId: 'voice-a',
        speechLabel: 'synthetic speech based on real wording',
        pcmSha256: sha256(Buffer.from('fixture-bytes')),
        manifestPath: 'corpus/voices/voice-a.manifest.json',
        asr: { transcript: 'relay to worker i want to find out about pod point', wer: 0.05, missingWords: [], ok: true },
      },
    ])
  );

  const files: Array<[string, Buffer]> = [];
  const walk = (root: string): void => {
    const fs = nodeFs;
    for (const entry of fs.readdirSync(root).sort()) {
      const full = path.join(root, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else files.push([path.relative(dir, full), fs.readFileSync(full)]);
    }
  };
  walk(dir);
  const manifest = {
    schemaVersion: 1,
    lab: 'voice-lane-lab',
    attemptId: 'attempt-01',
    runId: 'capture-proofs',
    kind: 'capture-proof',
    episodeId: 'C01',
    arm: 'standard',
    evidenceLevel: 'E2',
    captureMode: 'fake-file',
    corpusHash: 'x',
    capture: { startedAtMs: 1_100, stoppedAtMs: 6_000, getUserMediaCalls: 1, sourceLabel: 'default', ingressChunks: 30, egressChunks: 30 },
    laneStop: { finalState: 'stopped-start-control-back' },
    cleanup: options.cleanup ?? { browserClosed: true, previewStopped: true, serverStopped: true, socketsRemoved: true },
    ...(options.laneStopOverride ? { laneStop: options.laneStopOverride } : {}),
    artifacts: files.map(([relativePath, bytes]) => ({ relativePath, sha256: sha256(bytes), bytes: bytes.byteLength })),
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(path.join(dir, 'manifest.sha256'), sha256(nodeFs.readFileSync(path.join(dir, 'manifest.json'))) + '\n');
  writeFileSync(path.join(dir, 'FINALISED'), 'x\n');
  return dir;
}

afterEach(() => {
  const fs = nodeFs;
  for (const entry of fs.readdirSync(tmpdir())) {
    if (entry.startsWith('voice-lab-cp-')) fs.rmSync(path.join(tmpdir(), entry), { recursive: true, force: true });
  }
});

describe('clean capture-proof records pass', () => {
  it('verifies with verdict pass and exit 0', () => {
    const outcome = verifyRecord(buildCaptureProofRecord(), { corpus });
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
    expect(outcome.lines.some((line) => line.includes('capture window verified'))).toBe(true);
  });
});

describe('capture-proof damage is caught', () => {
  it('a record with no capture-stopped observation fails (no-stop)', () => {
    const outcome = verifyRecord(buildCaptureProofRecord({ tamperStop: true }), { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('no-capture-stop');
    expect(outcome.verdict).toBe('fail');
  });

  it('unverified cleanup is NEVER a pass — it fails closed (cleanup-unverified)', () => {
    const outcome = verifyRecord(
      buildCaptureProofRecord({ cleanup: { browserClosed: true, previewStopped: true, serverStopped: false, socketsRemoved: true } }),
      { corpus }
    );
    expect(outcome.problems.map((problem) => problem.code)).toContain('cleanup-unverified');
    expect(outcome.verdict).toBe('indeterminate');
    expect(exitCodeFor(outcome)).toBe(2);
  });

  it('a lane left live after the stop control is a demonstrated defect (lane-stop-unverified)', () => {
    const outcome = verifyRecord(
      buildCaptureProofRecord({ cleanup: { browserClosed: true, previewStopped: true, serverStopped: true, socketsRemoved: true }, laneStopOverride: { finalState: 'live' } }),
      { corpus }
    );
    expect(outcome.problems.map((problem) => problem.code)).toContain('lane-stop-unverified');
    expect(outcome.verdict).toBe('fail');
  });

  it('capture stopping before the audio ends is a causality violation (no-capture-stop bracket)', () => {
    const dir = buildCaptureProofRecord();
    // declared stop (6000) before the last chunk (1390+... last at 1390? 1100+29*10=1390 —
    // instead move the stop observation before the first chunk via the manifest window:
    const fs = nodeFs;
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.capture.stoppedAtMs = 900;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'manifest.sha256'), sha256(fs.readFileSync(manifestPath)) + '\n');
    const outcome = verifyRecord(dir, { corpus });
    expect(outcome.problems.map((problem) => problem.code)).toContain('ingress-causality');
  });
});
