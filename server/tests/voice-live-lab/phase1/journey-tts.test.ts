/**
 * The labelled synthetic-TTS journey seam (child J3).
 *
 * The automated journey's Chromium has no speech synthesis, so the client
 * honestly reports the presentation incomplete and the attempt stalls — an
 * eyes-free harness cannot hear a real TTS. The sanctioned analogue of the
 * input-side `synthetic-stream-source` fixture is an explicit, default-OFF
 * `--tts synthetic` mode: a labelled `synthetic-tts-source` page shim that
 * replaces speechSynthesis with a deterministic implementation and logs every
 * text it is asked to speak. These tests pin the seam:
 *
 *   - plan: `--tts synthetic` is explicit data on the plan and capture mode;
 *     default plans carry no shim at all; unknown values are refused;
 *   - shim: deterministic utterances (non-empty getVoices, onstart then a
 *     length-proportional onend, cancel fires nothing further), every spoken
 *     text logged to a window-scoped array;
 *   - verifier: spoken bytes must equal the live proposal's retained bytes
 *     (exact comparison after the product's own normalisation); shim use must
 *     be declared in the manifest (no silent use); the read-back must be
 *     attributable to the shim; a shim record must never claim a
 *     rendered-audio (E2R/E3) pass; a declared seam with missing evidence is
 *     indeterminate, never a pass.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, afterEach } from 'vitest';
import { loadCorpus, episodeById } from '../../../../scripts/voice-lane-lab/lib/corpus.js';
import { journeyPlan } from '../../../../scripts/voice-lane-lab/lib/journey-plan.js';import { SYNTHETIC_TTS_LABEL, TTS_SHIM_SCRIPT } from '../../../../scripts/voice-lane-lab/lib/built-app.js';
import { verifyRecord, exitCodeFor, type VerifyOutcome } from '../../../../scripts/voice-lane-lab/lib/verifier.js';

const corpus = loadCorpus();
const C01_D = corpus.episodes.find((episode) => episode.id === 'C01')!.perStepDeadlinesMs;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** The corpus wording a fixture id stands for (the plan fails closed on text drift). */
function wordingForFixture(id: string): string {
  const turn = /^([A-Z]\d+)-t(\d+)$/.exec(id);
  if (turn) {
    const episode = episodeById(corpus, turn[1]);
    const text = episode.inputTurns[Number(turn[2]) - 1]?.text;
    if (text) return text;
  }
  const repair = /^([A-Z]\d+)-repair-1$/.exec(id);
  if (repair) {
    const episode = episodeById(corpus, repair[1]);
    const branch = episode.repairBranches.find((candidate) => candidate.action === 'one-clarification');
    if (branch?.say) return branch.say;
  }
  return `fixture words for ${id}`;
}


// ── Plan-level seam data ─────────────────────────────────────────────────────

const fakeVoiceManifest = (corpusDir: string, ids: string[]): string => {
  const dir = path.join(corpusDir, 'voices');
  mkdirSync(dir, { recursive: true });
  const manifest = {
    profileId: 'voice-a',
    speechLabel: 'synthetic speech based on real wording',
    fixtures: ids.map((id) => ({
      id,
      text: wordingForFixture(id),
      pcm16kSha256: 'b'.repeat(64),
      pcm16kPath: `/root/voice-lane-lab/fixtures/voice-a/${id}.pcm16k`,
      masterWavPath: `/root/voice-lane-lab/fixtures/voice-a/${id}.master.wav`,
      durationMs: 2_000,
      asr: { transcript: 'fixture words', wer: 0.02, missingWords: [], ok: true },
    })),
  };
  writeFileSync(path.join(dir, 'voice-a.manifest.json'), JSON.stringify(manifest, null, 2));
  return corpusDir;
};

function withFakeVoices(run: (corpusDir: string) => void): void {
  const corpusDir = path.join(tmpdir(), `voice-lab-jtts-${Math.random().toString(36).slice(2)}`);
  mkdirSync(corpusDir, { recursive: true });
  fakeVoiceManifest(corpusDir, ['C01-t1', 'C01-t2', 'C01-repair-1']);
  run(corpusDir);
}

describe('the journey plan carries the explicit --tts mode', () => {
  it('a default plan carries no shim: no tts field, capture mode unchanged', () => {
    withFakeVoices((corpusDir) => {
      const plan = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      expect(plan.captureMode).toBe('fake-file+synthetic-stream-source');
      expect(plan.tts).toBeUndefined();
      expect(plan.ttsLabel).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain('synthetic-tts-source');
    });
  });

  it('an explicit --tts real plan is byte-identical to the default (no shim)', () => {
    withFakeVoices((corpusDir) => {
      const deft = journeyPlan('C01', { corpus, corpusDir, arm: 'standard' });
      const real = journeyPlan('C01', { corpus, corpusDir, arm: 'standard', tts: 'real' });
      expect(JSON.stringify(real)).toBe(JSON.stringify(deft));
    });
  });

  it('an explicit --tts synthetic plan declares the labelled shim on plan and capture mode', () => {
    withFakeVoices((corpusDir) => {
      const plan = journeyPlan('C01', { corpus, corpusDir, arm: 'standard', tts: 'synthetic' });
      expect(plan.tts).toBe('synthetic');
      expect(plan.ttsLabel).toBe('synthetic-tts-source');
      expect(plan.captureMode).toBe('fake-file+synthetic-stream-source+synthetic-tts-source');
      expect(JSON.stringify(plan)).toContain('synthetic-tts-source');
    });
  });

  it('the runner refuses --tts values other than synthetic|real', () => {
    withFakeVoices((corpusDir) => {
      expect(() => journeyPlan('C01', { corpus, corpusDir, arm: 'standard', tts: 'bogus' })).toThrow(/--tts/);
      expect(() => journeyPlan('C01', { corpus, corpusDir, arm: 'standard', tts: 'off' })).toThrow(/--tts/);
    });
  });
});

// ── The page shim's deterministic behaviour (driven in a Node sandbox) ──────

interface FakeTimer { id: number; fn: () => void; atMs: number }

/** A minimal window + fake-clock sandbox that executes the injected script. */
function shimSandbox(options: { getterOnlySpeechSynthesis?: boolean } = {}): {
  win: Record<string, unknown>;
  advance: (ms: number) => void;
  now: () => number;
  hasPendingTimers: () => boolean;
} {
  let nowMs = 0;
  let nextId = 1;
  const timers: FakeTimer[] = [];
  const setTimeoutFn = (fn: () => void, delayMs?: number): number => {
    const timer: FakeTimer = { id: nextId++, fn, atMs: nowMs + (delayMs ?? 0) };
    timers.push(timer);
    return timer.id;
  };
  const clearTimeoutFn = (id: number): void => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  // Real Chromium exposes speechSynthesis as a getter-only accessor on the
  // Window PROTOTYPE: a plain `window.speechSynthesis = x` assignment in the
  // page silently no-ops. The sandbox reproduces that shape on demand so the
  // shim's installation strategy is actually exercised.
  let win: Record<string, unknown> = {};
  if (options.getterOnlySpeechSynthesis) {
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, 'speechSynthesis', {
      get: () => ({ speak: () => {}, cancel: () => {} }),
      configurable: true,
    });
    win = Object.create(proto) as Record<string, unknown>;
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function('window', 'performance', 'setTimeout', 'clearTimeout', TTS_SHIM_SCRIPT)(
    win,
    { now: () => nowMs },
    setTimeoutFn,
    clearTimeoutFn
  );
  const advance = (ms: number): void => {
    nowMs += ms;
    for (const timer of [...timers].sort((a, b) => a.atMs - b.atMs)) {
      if (timer.atMs <= nowMs) {
        clearTimeoutFn(timer.id);
        timer.fn();
      }
    }
  };
  return { win, advance, now: () => nowMs, hasPendingTimers: () => timers.length > 0 };
}

/** The client's own usage pattern (createBrowserReadBackSpeaker) in the sandbox. */
function clientStyleSpeaker(win: Record<string, unknown>): {
  speak(text: string): { onEnd(): void; onError(reason: string): void; events: string[] };
  cancel(): void;
} {
  const host = win as unknown as {
    speechSynthesis: { speak: (u: unknown) => void; cancel: () => void };
    SpeechSynthesisUtterance: new (text: string) => {
      text: string;
      onstart: (() => void) | null;
      onend: (() => void) | null;
      onerror: ((event: { error?: string }) => void) | null;
    };
  };
  const speakFn = host.speechSynthesis.speak.bind(host.speechSynthesis);
  const cancelFn = host.speechSynthesis.cancel.bind(host.speechSynthesis);
  return {
    speak(text: string) {
      const events: string[] = [];
      const utterance = new host.SpeechSynthesisUtterance(text);
      utterance.text = text;
      utterance.onend = () => events.push('end');
      utterance.onerror = () => events.push('error');
      utterance.onstart = () => events.push('start');
      cancelFn();
      speakFn(utterance);
      return {
        onEnd: () => events.push('end'),
        onError: () => events.push('error'),
        events,
      };
    },
    cancel: () => cancelFn(),
  };
}

describe('the synthetic-tts-source page shim', () => {
  it('installs with the sanctioned label and an installation marker on speechSynthesis', () => {
    const { win } = shimSandbox();
    const shim = win.__voiceTtsShim as { label?: string } | undefined;
    const synth = win.speechSynthesis as { __voiceTtsShim?: boolean } | undefined;
    expect(shim?.label).toBe('synthetic-tts-source');
    expect(SYNTHETIC_TTS_LABEL).toBe('synthetic-tts-source');
    expect(synth?.__voiceTtsShim).toBe(true);
  });

  it('replaces speechSynthesis even when the host exposes it as a getter-only prototype accessor (real Chromium shape)', () => {
    // This is the defect the first live confirmation run caught: plain
    // assignment to a getter-only Window accessor silently no-ops in the
    // page, leaving the shim object present but synthesis unreplaced.
    const { win } = shimSandbox({ getterOnlySpeechSynthesis: true });
    const own = Object.getOwnPropertyDescriptor(win, 'speechSynthesis');
    expect(own?.value?.__voiceTtsShim).toBe(true);
    expect((win.speechSynthesis as { __voiceTtsShim?: boolean }).__voiceTtsShim).toBe(true);
    const utterance = Object.getOwnPropertyDescriptor(win, 'SpeechSynthesisUtterance');
    expect(typeof utterance?.value).toBe('function');
  });

  it('is idempotent: re-running the injected script resets nothing', () => {
    const sandbox = shimSandbox();
    const speaker = clientStyleSpeaker(sandbox.win);
    speaker.speak('first words');
    // A second injection attempt (the guard must refuse it).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function('window', 'performance', 'setTimeout', 'clearTimeout', TTS_SHIM_SCRIPT)(
      sandbox.win,
      { now: sandbox.now },
      () => 0,
      () => undefined
    );
    const shim = sandbox.win.__voiceTtsShim as { spoken: Array<{ text: string }> };
    expect(shim.spoken.map((row) => row.text)).toEqual(['first words']);
  });

  it('getVoices is non-empty', () => {
    const { win } = shimSandbox();
    const synth = win.speechSynthesis as { getVoices: () => unknown[] };
    expect(synth.getVoices().length).toBeGreaterThan(0);
  });

  it('speak logs the exact text, fires onstart then a length-proportional onend', () => {
    const sandbox = shimSandbox();
    const speaker = clientStyleSpeaker(sandbox.win);
    const speech = speaker.speak('I want to find out about Podpoint.');
    // Nothing fired synchronously.
    expect(speech.events).toEqual([]);
    sandbox.advance(0); // onstart rides a 0-delay task
    expect(speech.events).toEqual(['start']);
    // 34 chars × 6 ms + 150 ms base = 354 ms; not yet at 353.
    sandbox.advance(353);
    expect(speech.events).toEqual(['start']);
    sandbox.advance(1);
    expect(speech.events).toEqual(['start', 'end']);
    const shim = sandbox.win.__voiceTtsShim as { spoken: Array<{ seq: number; text: string; chars: number }> };
    expect(shim.spoken).toHaveLength(1);
    expect(shim.spoken[0].text).toBe('I want to find out about Podpoint.');
    expect(shim.spoken[0].chars).toBe(34);
  });

  it('timing is configurable (a modest default, override for faster runs)', () => {
    const sandbox = shimSandbox();
    const speaker = clientStyleSpeaker(sandbox.win);
    const configure = sandbox.win.__voiceTtsShimConfigure as (patch: { baseMs: number; perCharMs: number }) => unknown;
    expect(configure({ baseMs: 10, perCharMs: 0 })).toEqual({ baseMs: 10, perCharMs: 0 });
    const speech = speaker.speak('a much longer utterance than the default timing test needs');
    sandbox.advance(10);
    expect(speech.events).toEqual(['start', 'end']);
  });

  it('cancel fires nothing further: no onend, no onerror after a cancelled utterance', () => {
    const sandbox = shimSandbox();
    const speaker = clientStyleSpeaker(sandbox.win);
    const speech = speaker.speak('words that will never finish in this sandbox');
    speaker.cancel();
    sandbox.advance(10_000);
    expect(speech.events).toEqual([]);
    // Cancelling an idle host must never throw either.
    expect(() => speaker.cancel()).not.toThrow();
  });

  it('records every text it was asked to speak in order (the runner reads this back)', () => {
    const sandbox = shimSandbox();
    const speaker = clientStyleSpeaker(sandbox.win);
    speaker.speak('first read-back bytes');
    sandbox.advance(10_000);
    speaker.speak('second read-back bytes');
    const shim = sandbox.win.__voiceTtsShim as { spoken: Array<{ seq: number; text: string }> };
    expect(shim.spoken.map((row) => row.text)).toEqual(['first read-back bytes', 'second read-back bytes']);
    expect(shim.spoken.map((row) => row.seq)).toEqual([0, 1]);
  });
});

// ── Verifier teeth over the seam ─────────────────────────────────────────────

const TIDIED = 'I want to find out about Podpoint.';

interface StepRow { seq: number; atMs: number; observation?: Record<string, unknown>; action: Record<string, unknown> }

class JourneyRecordBuilder {
  readonly dir: string;
  readonly episodeId: string;
  private steps: StepRow[] = [];
  private extraFiles = new Map<string, string>();
  private manifest: Record<string, unknown>;

  constructor(episodeId = 'C01') {
    this.episodeId = episodeId;
    this.dir = path.join(tmpdir(), `voice-lab-jtts-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(path.join(this.dir, 'capture'), { recursive: true });
    mkdirSync(path.join(this.dir, 'director'), { recursive: true });
    mkdirSync(path.join(this.dir, 'fixtures'), { recursive: true });
    mkdirSync(path.join(this.dir, 'provider'), { recursive: true });
    this.manifest = {
      schemaVersion: 1,
      lab: 'voice-lane-lab',
      attemptId: 'attempt-01',
      runId: 'run-test',
      episodeId,
      kind: 'primary-mic-journey',
      evidenceLevel: 'E2',
      captureMode: 'fake-file+synthetic-stream-source+synthetic-tts-source',
      corpusHash: 'corpus-hash-placeholder',
      status: 'pass',
      startedAtIso: new Date().toISOString(),
      capture: { startedAtMs: 1_000, stoppedAtMs: 6_000 },
      laneStop: { finalState: 'stopped-start-control-back' },
      cleanup: { browserClosed: true, previewStopped: true, serverStopped: true, socketsRemoved: true },
      armSelection: { requested: 'standard', env: { VOICE_LIVE_PROFILE: 'standard' } },
      turnModes: [
        { turnId: 't1', inputMode: 'fake-file', fixtureId: 'C01-t1' },
        { turnId: 't2', inputMode: 'synthetic-stream-source', fixtureId: 'C01-t2' },
      ],
      tts: {
        mode: 'synthetic',
        label: 'synthetic-tts-source',
        shimVerified: true,
        spokenCount: 1,
        spokenLog: 'capture/tts-spoken.json',
        readBackAttribution: 'synthetic-tts-source',
        renderedAudioClaimed: false,
      },
    };
  }

  ttsBlock(patch: Record<string, unknown> | null): this {
    if (patch === null) {
      const { tts: _drop, ...rest } = this.manifest;
      void _drop;
      this.manifest = rest;
    } else {
      this.manifest = { ...this.manifest, tts: { mode: 'synthetic', label: 'synthetic-tts-source', shimVerified: true, spokenCount: 1, spokenLog: 'capture/tts-spoken.json', readBackAttribution: 'synthetic-tts-source', renderedAudioClaimed: false, ...patch } };
    }
    return this;
  }

  /** A conversation-only journey: speak t1, await the response, complete on it. */
  conversationalFlow(responseText: string): this {
    const episode = corpus.episodes.find((row) => row.id === this.episodeId);
    if (!episode) throw new Error(`unknown episode ${this.episodeId}`);
    this.manifest = {
      ...this.manifest,
      turnModes: [{ turnId: 't1', inputMode: 'fake-file', fixtureId: `${this.episodeId}-t1` }],
    };
    this.steps.push({ seq: this.steps.length + 1, atMs: 1_000, action: { type: 'speak', turnId: 't1', text: episode.inputTurns[0].text } });
    this.steps.push({ seq: this.steps.length + 1, atMs: 1_500, action: { type: 'await', reason: 'waiting for response', deadlineMs: episode.perStepDeadlinesMs.candidateMs } });
    this.steps.push({ seq: this.steps.length + 1, atMs: 4_000, action: { type: 'terminal', status: 'complete', reason: 'episode flow completed' }, observation: { kind: 'response', text: responseText, atMs: 4_000 } });
    return this;
  }

  canonicalFlow(): this {
    const speaking = (turnId: string, text: string, atMs: number) => this.steps.push({ seq: this.steps.length + 1, atMs, action: { type: 'speak', turnId, text } });
    const awaiting = (atMs: number, reason: string) =>
      this.steps.push({ seq: this.steps.length + 1, atMs, action: { type: 'await', reason, deadlineMs: reason.includes('presentation') ? C01_D.presentationMs : reason.includes('release') || reason.includes('delivery') ? C01_D.deliveryMs : reason.includes('worker store') ? C01_D.workerStoreMs : C01_D.candidateMs } });
    speaking('t1', 'Relay to worker I want to find out about Podpoint.', 1_000);
    awaiting(1_500, 'waiting for candidate');
    this.steps.push({ seq: this.steps.length + 1, atMs: 2_200, action: { type: 'await', reason: 'waiting for presentation', deadlineMs: C01_D.presentationMs }, observation: { kind: 'candidate', payloadText: TIDIED, identity: 'cand-1', atMs: 2_200 } });
    this.steps.push({ seq: this.steps.length + 1, atMs: 2_800, action: { type: 'speak', turnId: 't2', text: 'Yes, send that.' }, observation: { kind: 'presentation', identity: 'cand-1', complete: true, atMs: 2_800 } });
    awaiting(3_200, 'waiting for release');
    this.steps.push({ seq: this.steps.length + 1, atMs: 3_500, action: { type: 'await', reason: 'waiting for delivery', deadlineMs: C01_D.deliveryMs }, observation: { kind: 'release', identity: 'cand-1', atMs: 3_500 } });
    this.steps.push({ seq: this.steps.length + 1, atMs: 3_700, action: { type: 'await', reason: 'waiting for worker store', deadlineMs: C01_D.workerStoreMs }, observation: { kind: 'delivery', identity: 'cand-1', atMs: 3_700 } });
    this.steps.push({ seq: this.steps.length + 1, atMs: 4_000, action: { type: 'terminal', status: 'complete', reason: 'episode flow completed' }, observation: { kind: 'worker-store', identity: 'cand-1', ok: true, atMs: 4_000 } });
    return this;
  }

  proposalWireFrames(): this {
    this.extraFiles.set(
      'capture/wire-frames.json',
      `${JSON.stringify([
        {
          seq: 0,
          atMs: 2_200,
          direction: 'inbound',
          type: 'proposal_created',
          frame: {
            type: 'proposal_created',
            proposal: {
              proposalId: 'cand-1',
              original: 'Relay to worker I want to find out about Podpoint.',
              tidied: TIDIED,
              presentedVariant: 'tidied',
              version: 1,
            },
          },
        },
      ])}\n`
    );
    return this;
  }

  spokenLog(spoken: Array<Record<string, unknown>>, label = 'synthetic-tts-source', shimVerified = true): this {
    this.extraFiles.set('capture/tts-spoken.json', `${JSON.stringify({ label, shimVerified, readBackAttribution: 'synthetic-tts-source', spoken })}\n`);
    return this;
  }

  defaultSpoken(): this {
    return this.spokenLog([{ seq: 0, atMs: 2_850, text: TIDIED, chars: TIDIED.length }]);
  }

  audioAndFixture(): this {
    const ingressChunks: Array<Record<string, unknown>> = [];
    const egressChunks: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 30; index += 1) {
      const ingress = new Int16Array(480).map((_, i) => ((index * 480 + i) % 1000) as number);
      const ingressPcm = Buffer.from(ingress.buffer);
      writeFileSync(path.join(this.dir, 'capture', `ingress-${index}.pcm`), ingressPcm);
      ingressChunks.push({
        seq: index,
        atMs: 1_100 + index * 10,
        sampleRate: 48_000,
        sampleCount: 480,
        declaredDurationMs: 10,
        sha256: sha256(ingressPcm),
        pcmFile: `ingress-${index}.pcm`,
        source: 'fake-file',
      });
      const egress = new Int16Array(160).map((_, i) => ((index * 160 + i) % 1000) as number);
      const egressPcm = Buffer.from(egress.buffer);
      writeFileSync(path.join(this.dir, 'capture', `egress-${index}.pcm`), egressPcm);
      egressChunks.push({
        seq: index,
        atMs: 1_120 + index * 10,
        sampleRate: 16_000,
        sampleCount: 160,
        declaredDurationMs: 10,
        sha256: sha256(egressPcm),
        pcmFile: `egress-${index}.pcm`,
      });
    }
    this.extraFiles.set('capture/ingress-chunks.json', `${JSON.stringify(ingressChunks)}\n`);
    this.extraFiles.set('capture/egress-chunks.json', `${JSON.stringify(egressChunks)}\n`);
    this.extraFiles.set(
      'fixtures/used.json',
      `${JSON.stringify([
        {
          fixtureId: 'C01-t1-voice-a',
          episodeId: 'C01',
          turnId: 't1',
          inputMode: 'fake-file',
          speechLabel: 'synthetic speech based on real wording',
          pcmSha256: sha256(Buffer.from('fixture-bytes')),
          manifestPath: 'corpus/voices/voice-a.manifest.json',
          asr: { transcript: 'ok', wer: 0, missingWords: [], ok: true },
        },
      ])}\n`
    );
    return this;
  }

  write(): string {
    writeFileSync(path.join(this.dir, 'director', 'steps.jsonl'), this.steps.map((step) => JSON.stringify(step)).join('\n') + '\n');
    for (const [relative, content] of this.extraFiles) {
      const full = path.join(this.dir, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const artifacts: Array<{ relativePath: string; sha256: string; bytes: number }> = [];
    const walk = (dir: string): void => {
      for (const entry of nodeFs.readdirSync(dir).sort()) {
        const full = path.join(dir, entry);
        if (nodeFs.statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        const bytes = nodeFs.readFileSync(full);
        artifacts.push({ relativePath: path.relative(this.dir, full), sha256: sha256(bytes), bytes: bytes.byteLength });
      }
    };
    walk(this.dir);
    const frozen = { ...this.manifest, artifacts };
    writeFileSync(path.join(this.dir, 'manifest.json'), `${JSON.stringify(frozen, null, 2)}\n`);
    writeFileSync(path.join(this.dir, 'manifest.sha256'), `${sha256(nodeFs.readFileSync(path.join(this.dir, 'manifest.json')))}\n`);
    writeFileSync(path.join(this.dir, 'FINALISED'), `${new Date().toISOString()}\n`);
    return this.dir;
  }
}

function verify(builder: JourneyRecordBuilder): VerifyOutcome {
  return verifyRecord(builder.write(), { corpus });
}

const codesOf = (outcome: VerifyOutcome): string[] => outcome.problems.map((problem) => problem.code);

describe('verifier: the synthetic-tts seam', () => {
  it('accepts the exact-bytes case: the shim spoke the proposal tidied bytes', () => {
    const outcome = verify(new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().defaultSpoken().audioAndFixture());
    expect(codesOf(outcome).filter((code) => code.startsWith('tts-'))).toEqual([]);
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('rejects a shim-spoken text that differs from the proposal bytes (tts-shim-text-mismatch)', () => {
    const outcome = verify(
      new JourneyRecordBuilder()
        .canonicalFlow()
        .proposalWireFrames()
        .spokenLog([{ seq: 0, atMs: 2_850, text: 'Something entirely different was spoken aloud.', chars: 45 }])
        .audioAndFixture()
    );
    expect(outcome.verdict).toBe('fail');
    expect(codesOf(outcome)).toContain('tts-shim-text-mismatch');
    expect(exitCodeFor(outcome)).toBe(1);
  });

  it('a near-miss (extra words appended) is still a mismatch, not a substring pass', () => {
    const outcome = verify(
      new JourneyRecordBuilder()
        .canonicalFlow()
        .proposalWireFrames()
        .spokenLog([{ seq: 0, atMs: 2_850, text: 'I want to find out about Podpoint immediately.', chars: 46 }])
        .audioAndFixture()
    );
    expect(outcome.verdict).toBe('fail');
    expect(codesOf(outcome)).toContain('tts-shim-text-mismatch');
  });

  it('shim evidence without a manifest declaration is silent use (tts-shim-undeclared)', () => {
    const builder = new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().defaultSpoken().audioAndFixture();
    builder.manifest.captureMode = 'fake-file+synthetic-stream-source';
    builder.ttsBlock(null);
    const outcome = verify(builder);
    expect(outcome.verdict).toBe('fail');
    expect(codesOf(outcome)).toContain('tts-shim-undeclared');
  });

  it('a declared seam whose spoken log is missing is indeterminate, never a pass (tts-shim-evidence-missing)', () => {
    const builder = new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().audioAndFixture();
    const outcome = verify(builder);
    expect(outcome.verdict).toBe('indeterminate');
    expect(codesOf(outcome)).toContain('tts-shim-evidence-missing');
    expect(exitCodeFor(outcome)).toBe(2);
  });

  it('a shim record claiming a rendered-audio evidence level is a demonstrated failure (tts-shim-rendered-audio-claim)', () => {
    const builder = new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().defaultSpoken().audioAndFixture();
    builder.manifest.evidenceLevel = 'E2R';
    const outcome = verify(builder);
    expect(outcome.verdict).toBe('fail');
    expect(codesOf(outcome)).toContain('tts-shim-rendered-audio-claim');
  });

  it('a completed read-back with zero shim speech is not attributable to the shim (tts-shim-readback-unattributed)', () => {
    const outcome = verify(
      new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().spokenLog([]).audioAndFixture()
    );
    expect(outcome.verdict).toBe('fail');
    expect(codesOf(outcome)).toContain('tts-shim-readback-unattributed');
  });

  it('a malformed spoken log is damaged evidence (indeterminate, never a pass)', () => {
    const builder = new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().audioAndFixture();
    writeFileSync(path.join(builder.dir, 'capture', 'tts-spoken.json'), '{not json');
    const outcome = verify(builder);
    expect(outcome.verdict).toBe('indeterminate');
    expect(codesOf(outcome)).toContain('tts-shim-log-malformed');
  });

  it('a default journey record carries no seam assertions at all', () => {
    const builder = new JourneyRecordBuilder().canonicalFlow().proposalWireFrames().audioAndFixture();
    builder.manifest.captureMode = 'fake-file+synthetic-stream-source';
    builder.ttsBlock(null);
    const outcome = verify(builder);
    expect(codesOf(outcome).filter((code) => code.startsWith('tts-'))).toEqual([]);
    expect(outcome.verdict).toBe('pass');
  });
});

describe('verifier: zero shim speech in a proposalless episode is complete, not incomplete (C16/C21)', () => {
  it('a declared seam that spoke nothing, in a record with no proposal and no completed presentation, is complete and passes', () => {
    // The C16/C21 live shape: a conversation-only journey with the seam
    // declared; the shim had nothing to read back because no proposal was ever
    // created and no presentation ever completed. That is the EXPECTED record.
    const outcome = verify(
      new JourneyRecordBuilder('C16')
        .conversationalFlow(
          "The worker session is new and has no messages yet, so I can't confirm if the test suite has finished running. The plan is still to run the suite."
        )
        .spokenLog([])
        .audioAndFixture()
    );
    expect(codesOf(outcome).filter((code) => code.startsWith('tts-'))).toEqual([]);
    expect(outcome.verdict).toBe('pass');
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('zero speech with a claimed completed read-back is still unattributed (unchanged guard)', () => {
    const outcome = verify(
      new JourneyRecordBuilder('C01').canonicalFlow().proposalWireFrames().spokenLog([]).audioAndFixture()
    );
    expect(outcome.verdict).toBe('fail');
    expect(codesOf(outcome)).toContain('tts-shim-readback-unattributed');
    expect(exitCodeFor(outcome)).toBe(1);
  });

  it('zero speech with a proposal on the wire but no completed read-back keeps the seam unproven (indeterminate)', () => {
    // A conversational record cannot honestly carry a proposal; this damaged
    // shape must stay incomplete/indeterminate — never upgraded to a pass.
    const builder = new JourneyRecordBuilder('C16')
      .conversationalFlow(
        "The worker session is new and has no messages yet, so I can't confirm if the test suite has finished running. The plan is still to run the suite."
      )
      .spokenLog([])
      .audioAndFixture();
    builder.proposalWireFrames();
    const outcome = verify(builder);
    expect(outcome.verdict).toBe('indeterminate');
    expect(exitCodeFor(outcome)).toBe(2);
  });
});

afterEach(() => {
  for (const entry of nodeFs.readdirSync(tmpdir())) {
    if (entry.startsWith('voice-lab-jtts-')) rmSync(path.join(tmpdir(), entry), { recursive: true, force: true });
  }
});
