/**
 * Negative-control guard tests (Phase 1 item 7): the E0 bypass hooks must be
 * unreachable on measured paths, visibly labelled when they do run, and cause
 * an E2 attempt record that contains them to fail offline verification.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  NEGATIVE_CONTROL_NAMES,
  BypassRefusedError,
  assertBypassAllowed,
  injectTranscript,
  injectModelText,
  fabricateCandidate,
} from '../../../../scripts/voice-lane-lab/lib/negative-controls.js';
import { verifyRecord } from '../../../../scripts/voice-lane-lab/lib/verifier.js';
import * as nodeFs from 'node:fs';

const corpus = loadCorpus();
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

describe('bypass hooks refuse measured paths', () => {
  const measuredLevels = ['E2', 'E2R'] as const;
  for (const level of measuredLevels) {
    it(`refuses transcript injection at ${level}`, () => {
      expect(() => injectTranscript({ evidenceLevel: level }, 'hello', 1)).toThrow(BypassRefusedError);
    });
    it(`refuses direct model text at ${level}`, () => {
      expect(() => injectModelText({ evidenceLevel: level }, 'hello', 1)).toThrow(BypassRefusedError);
    });
    it(`refuses fabricated candidates at ${level}`, () => {
      expect(() => fabricateCandidate({ evidenceLevel: level }, 'payload', 'id', 1)).toThrow(BypassRefusedError);
    });
  }

  it('exposes the guard for runner code to call directly', () => {
    expect(() => assertBypassAllowed({ evidenceLevel: 'E2' }, 'transcript-injection')).toThrow(BypassRefusedError);
    expect(() => assertBypassAllowed({ evidenceLevel: 'E0' }, 'transcript-injection')).not.toThrow();
  });
});

describe('allowed E0 hooks label everything they produce', () => {
  it('stamps the transcript injection with its control name and E0', () => {
    const observation = injectTranscript({ evidenceLevel: 'E0' }, 'I am a forged transcript', 5_000);
    expect(observation.negativeControl).toBe('transcript-injection');
    expect(observation.evidenceLevel).toBe('E0');
    expect(observation.kind).toBe('response');
  });

  it('stamps direct model text and fabricated candidates likewise', () => {
    const text = injectModelText({ evidenceLevel: 'E1' }, 'model text', 6_000);
    expect(text.negativeControl).toBe('direct-model-text');
    const candidate = fabricateCandidate({ evidenceLevel: 'E0' }, 'payload', 'identity-0', 7_000);
    expect(candidate.negativeControl).toBe('fabricated-candidate');
    expect(candidate.evidenceLevel).toBe('E0');
  });

  it('declares exactly the three labelled controls', () => {
    expect([...NEGATIVE_CONTROL_NAMES].sort()).toEqual(['direct-model-text', 'fabricated-candidate', 'transcript-injection']);
  });
});

describe('the verifier rejects E2 records that contain a negative-control marker', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) {
      try {
        nodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  function minimalRecordWithMarker(): string {
    const dir = path.join(tmpdir(), `voice-lab-nc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dirs.push(dir);
    mkdirSync(path.join(dir, 'capture'), { recursive: true });
    mkdirSync(path.join(dir, 'director'), { recursive: true });
    mkdirSync(path.join(dir, 'fixtures'), { recursive: true });

    const pcm0 = Buffer.from(new Int16Array(480).fill(100).buffer);
    const ingressChunks: Array<Record<string, unknown>> = [];
    const egressChunks: Array<Record<string, unknown>> = [];
    writeFileSync(path.join(dir, 'capture', 'ingress-0.pcm'), pcm0);
    const ePcm0 = Buffer.from(new Int16Array(160).fill(100).buffer);
    writeFileSync(path.join(dir, 'capture', 'egress-0.pcm'), ePcm0);
    for (let index = 0; index < 30; index += 1) {
      ingressChunks.push({
        seq: index,
        atMs: 1_100 + index * 10,
        sampleRate: 48_000,
        sampleCount: 480,
        declaredDurationMs: 10,
        sha256: sha256(pcm0),
        pcmFile: 'ingress-0.pcm',
      });
      egressChunks.push({
        seq: index,
        atMs: 1_120 + index * 10,
        sampleRate: 16_000,
        sampleCount: 160,
        declaredDurationMs: 10,
        sha256: sha256(ePcm0),
        pcmFile: 'egress-0.pcm',
      });
    }
    writeFileSync(path.join(dir, 'capture', 'ingress-chunks.json'), JSON.stringify(ingressChunks));
    writeFileSync(path.join(dir, 'capture', 'egress-chunks.json'), JSON.stringify(egressChunks));
    // The hook's stamped output lands in the steps log, exactly as a careless
    // runner would record it — the marker makes the contamination visible.
    const observation = injectTranscript({ evidenceLevel: 'E0' }, 'forged', 2_000);
    const steps = [{ seq: 1, atMs: 2_000, action: { type: 'terminal', status: 'complete', reason: 'x' }, observation }];
    writeFileSync(path.join(dir, 'director', 'steps.jsonl'), steps.map((step) => JSON.stringify(step)).join('\n') + '\n');
    writeFileSync(path.join(dir, 'fixtures', 'used.json'), '[]');

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
      attemptId: 'a1',
      runId: 'r1',
      episodeId: 'C09',
      evidenceLevel: 'E2',
      captureMode: 'fake-file',
      corpusHash: 'x',
      capture: { startedAtMs: 1_000, stoppedAtMs: 6_000 },
      artifacts: files.map(([relativePath, bytes]) => ({ relativePath, sha256: sha256(bytes), bytes: bytes.byteLength })),
    };
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(path.join(dir, 'manifest.sha256'), sha256(nodeFs.readFileSync(path.join(dir, 'manifest.json'))) + '\n');
    writeFileSync(path.join(dir, 'FINALISED'), 'x\n');
    return dir;
  }

  it('an E2 record with a marker is indeterminate, never pass', () => {
    const outcome = verifyRecord(minimalRecordWithMarker(), { corpus });
    expect(outcome.verdict).toBe('indeterminate');
    expect(outcome.problems.map((problem) => problem.code)).toContain('negative-control-in-e2');
    expect(outcome.problems.find((problem) => problem.code === 'negative-control-in-e2')?.detail).toContain('transcript-injection');
  });
});
