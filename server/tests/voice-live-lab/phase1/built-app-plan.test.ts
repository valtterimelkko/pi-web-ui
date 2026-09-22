/**
 * Built-app capture-proof planning (Phase 1 item 1 + gate command 3).
 *
 * The dry-run path must be deterministic, need no browser/server/network, and
 * fail closed when the frozen voice manifests are missing. The injected
 * ingress instrument must be visibly labelled (lab-only) and must carry the
 * plan's synthetic-stream-source helper for adaptive steps.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import {
  INGRESS_INSTRUMENT_SCRIPT,
  INSTRUMENT_ID,
  planCaptureProof,
  planHash,
} from '../../../../scripts/voice-lane-lab/lib/built-app.js';

const corpus = loadCorpus();

const fakeVoiceManifest = (corpusDir: string): string => {
  const dir = path.join(corpusDir, 'voices');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    profileId: 'voice-a',
    speechLabel: 'synthetic speech based on real wording',
    fixtures: [
      {
        id: 'C01-t1',
        text: 'Relay to worker I want to find out about Podpoint.',
        pcm16kSha256: 'a'.repeat(64),
        pcm16kPath: '/root/voice-lane-lab/fixtures/voice-a/C01-t1.pcm16k',
        masterWavPath: '/root/voice-lane-lab/fixtures/voice-a/C01-t1.master.wav',
        durationMs: 2_800,
        asr: { transcript: 'relay to worker i want to find out about pod point', wer: 0.04, missingWords: [], ok: true },
      },
    ],
  };
  const file = path.join(dir, 'voice-a.manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2));
  return corpusDir;
};

function withFakeVoices(run: (corpusDir: string) => void): void {
  const corpusDir = path.join(tmpdir(), `voice-lab-plan-${Math.random().toString(36).slice(2)}`);
  mkdirSync(corpusDir, { recursive: true });
  fakeVoiceManifest(corpusDir);
  run(corpusDir);
}

describe('the capture-proof plan', () => {
  it('is deterministic: the same inputs give the same plan and hash', () => {
    withFakeVoices((corpusDir) => {
      const planA = planCaptureProof('C01', { corpus, corpusDir });
      const planB = planCaptureProof('C01', { corpus, corpusDir });
      expect(JSON.stringify(planA)).toBe(JSON.stringify(planB));
      expect(planHash(planA)).toBe(planHash(planB));
      expect(planHash(planA)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('launches Chromium with the file-backed fake microphone carrying the real utterance WAV', () => {
    withFakeVoices((corpusDir) => {
      const plan = planCaptureProof('C01', { corpus, corpusDir });
      const fileArg = plan.browserArgs.find((arg) => arg.startsWith('--use-file-for-fake-audio-capture='));
      expect(fileArg, 'file-backed fake capture flag present').toBeTruthy();
      expect(fileArg).toContain('C01-t1.master.wav');
      expect(fileArg).toContain('%noloop');
      expect(plan.browserArgs).toContain('--use-fake-ui-for-media-stream');
      expect(plan.browserArgs).toContain('--use-fake-device-for-media-stream');
      expect(plan.captureMode).toBe('fake-file');
      expect(plan.utterance.text).toBe('Relay to worker I want to find out about Podpoint.');
      expect(plan.utterance.speechLabel).toBe('synthetic speech based on real wording');
    });
  });

  it('fails closed when the frozen voice manifest is missing', () => {
    const corpusDir = path.join(tmpdir(), `voice-lab-plan-empty-${Math.random().toString(36).slice(2)}`);
    mkdirSync(corpusDir, { recursive: true });
    expect(() => planCaptureProof('C01', { corpus, corpusDir })).toThrow(/voices.*first|frozen voice manifest/);
  });

  it('refuses holdout episodes outright', () => {
    withFakeVoices((corpusDir) => {
      const holdout = path.join(corpusDir, 'voices', 'voice-a.manifest.json');
      // Even with a manifest present, a holdout episode cannot be planned.
      expect(() => planCaptureProof('C10', { corpus, corpusDir })).toThrow(/holdout/);
      void holdout;
    });
  });
});

describe('the ingress instrument', () => {
  it('is labelled lab-only and identifies itself', () => {
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain(INSTRUMENT_ID);
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('lab-only boundary observation');
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('__voiceLaneLab');
  });

  it('observes both boundaries: pre-worklet ingress and post-resampler egress', () => {
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('createMediaStreamSource');
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('onaudioprocess');
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain("voice_audio_chunk");
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('parsed.data');
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('sampleRate: 16000');
  });

  it('carries the labelled synthetic-stream-source helper for adaptive steps', () => {
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain("'synthetic-stream-source'");
    expect(INGRESS_INSTRUMENT_SCRIPT).toContain('__voiceLaneLabSpeak');
  });
});
