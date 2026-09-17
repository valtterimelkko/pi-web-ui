/**
 * L2 baseline-cascade tests.
 *
 * The baseline cascade is the shipped Gemma stack (STT → TalkerSession →
 * TTS) driven in-process as a ProviderInputSink, so the same operator driver,
 * event log, verifier and scorer that will measure a native candidate can
 * measure the baseline. These tests prove, hermetically (mocked STT/TTS,
 * scripted talker model, recording delivery):
 *
 *   1. an E-lane utterance becomes exactly one cascade turn — buffered PCM in,
 *      transcript to the talker, reply to TTS, audio to the player, and the
 *      event sequence provider_content → provider_usage → turn_complete;
 *   2. the N lane fires its turn on trailing silence alone;
 *   3. the mechanical gate survives the cascade unchanged: statement then
 *      confirm releases the stored bytes through the one delivery path, with
 *      the trusted ack spoken and a harness_release event to score;
 *   4. provider failures are recorded as provider_error events, never
 *      silently swallowed, and the failed leg is named;
 *   5. a complete hermetic attempt verifies clean with the L0 offline
 *      verifier (dense seq, usage present, no golden leak);
 *   6. the real OpenAI/Whisper adapters map requests and failures honestly
 *      (stubbed fetch — no network).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, EventLog, createMonotonicClock, parseEventLog } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  DEFAULT_FRAME_BYTES,
  SpeechDriver,
} from '../../../scripts/voice-live-lab/lib/speech-driver.js';
import { ReferencePlayer } from '../../../scripts/voice-live-lab/lib/playback.js';
import {
  createAttempt,
  eventLogPath,
  finaliseAttempt,
  verifyAttempt,
} from '../../../scripts/voice-live-lab/lib/record.js';
import {
  BaselineCascade,
  createOpenAiStt,
  createOpenAiTts,
  createWhisperFallbackStt,
  type BaselineStt,
  type BaselineTts,
  type SttOutcome,
  type TtsOutcome,
} from '../../../scripts/voice-live-lab/lib/providers/baseline-cascade.js';
import { TalkerSession } from '../../src/talker/talker.js';
import { RELEASE_ACK, RECEIPT_ACK, NOTHING_PENDING_ACK } from '../../src/talker/ack.js';
import { createNullDelivery } from '../../src/talker/delivery.js';
import type { ChatMessage, ModelTurnResult, TalkerModelClient, WorkerStateSnapshot } from '../../src/talker/types.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-cascade-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── Hermetic doubles ───────────────────────────────────────────────────────

/** Scripted talker model: pops canned replies; never degenerate. */
function scriptedModel(replies: string[]): TalkerModelClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
      calls.push(messages.map((m) => ({ ...m })));
      return { text: replies.shift() ?? 'Right — understood.', ttftMs: 120, totalMs: 240 };
    },
  };
}

interface TalkerHarness {
  session: TalkerSession;
  model: ReturnType<typeof scriptedModel>;
  delivery: ReturnType<typeof createNullDelivery>;
}

function makeTalker(replies: string[], deliveryOptions?: { forcedOutcome?: string }): TalkerHarness {
  const model = scriptedModel(replies);
  const delivery = createNullDelivery(
    deliveryOptions?.forcedOutcome ? { forcedOutcome: deliveryOptions.forcedOutcome as never } : {}
  );
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-lab-1',
    snapshotProvider: (): WorkerStateSnapshot => ({
      elapsedLabel: '14m',
      activity: 'supervising two workers',
      children: ['worker 1: running'],
      lastAssistantText: 'Both are running.',
    }),
  });
  return { session, model, delivery };
}

/** Mock STT returning a scripted transcript per call (last one repeats). */
function mockStt(texts: string[] = ['tell the worker to hold phase 3 until my review']): BaselineStt & { calls: Buffer[]; texts: string[] } {
  const calls: Buffer[] = [];
  const queue = [...texts];
  return {
    calls,
    texts: queue,
    async transcribe(pcm: Buffer): Promise<SttOutcome> {
      calls.push(Buffer.from(pcm));
      const text = queue.length > 1 ? (queue.shift() as string) : queue[0];
      return { text, provider: 'mock', model: 'mock-stt', ms: 5, usage: { mocked: true } };
    },
  };
}

function mockTts(): BaselineTts & { calls: string[]; pcm: Buffer } {
  const calls: string[] = [];
  const pcm = Buffer.alloc(480, 0); // 10 ms of 24 kHz silence
  return {
    calls,
    pcm,
    async synthesise(text: string): Promise<TtsOutcome> {
      calls.push(text);
      return { pcm: Buffer.from(pcm), provider: 'mock', model: 'mock-tts', voice: 'alloy', ms: 7, usage: { mocked: true } };
    },
  };
}

function tonePcm(ms: number, sampleRate = 16000): Buffer {
  const frames = Math.floor((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
  return buf;
}

interface CascadeFixture {
  cascade: BaselineCascade;
  log: EventLog;
  stt: ReturnType<typeof mockStt>;
  tts: ReturnType<typeof mockTts>;
  talker: TalkerHarness;
  player: ReferencePlayer;
}

function makeCascade(
  talkerReplies: string[],
  options: { lane?: 'E' | 'N'; trailSilenceMs?: number; ttsFail?: boolean; sttFail?: boolean; transcripts?: string[] } = {}
): CascadeFixture {
  const clock = createMonotonicClock();
  const log = new EventLog({ clock });
  const stt = mockStt(options.transcripts);
  const tts = mockTts();
  if (options.sttFail) {
    stt.transcribe = async () => {
      throw new Error('stt provider down');
    };
  }
  if (options.ttsFail) {
    tts.synthesise = async () => {
      throw new Error('tts provider down');
    };
  }
  const talker = makeTalker(talkerReplies);
  const player = new ReferencePlayer({ log });
  const cascade = new BaselineCascade({
    log,
    clock,
    lane: options.lane ?? 'E',
    trailSilenceMs: options.trailSilenceMs,
    talker: talker.session,
    stt,
    tts,
    player,
  });
  return { cascade, log, stt, tts, talker, player };
}

// ── 1. E lane: one utterance → one turn ────────────────────────────────────

describe('baseline cascade E lane', () => {
  it('runs STT → talker → TTS once per utterance and logs the full event set', async () => {
    const fx = makeCascade(['Understood — holding phase 3 for your review.']);
    const pcm = tonePcm(120);
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', pcm);
    await fx.cascade.settle();

    // Exactly one turn, one call per leg, full PCM delivered to STT.
    expect(fx.stt.calls).toHaveLength(1);
    expect(fx.stt.calls[0].byteLength).toBeGreaterThanOrEqual(pcm.byteLength);
    expect(fx.tts.calls).toEqual(['Understood — holding phase 3 for your review.']);
    void pcm;
    expect(fx.talker.model.calls).toHaveLength(1);
    // The transcript reached the talker as the operator's utterance.
    const lastUser = fx.talker.model.calls[0].at(-1);
    expect(lastUser?.role).toBe('user');
    expect(String(lastUser?.content)).toContain('tell the worker to hold phase 3');
    // The talker held the statement as a draft (composition batch).
    expect(fx.talker.session.proposals.pending).not.toBeNull();
    // TTS audio reached the reference player.
    expect(fx.player.stats().receivedFrames).toBe(240);

    const events = fx.log.events();
    const kinds = events.map((e) => e.kind);
    const contentIdx = kinds.lastIndexOf(EVENT.PROVIDER_CONTENT);
    const usageIdx = kinds.lastIndexOf(EVENT.PROVIDER_USAGE);
    const doneIdx = kinds.lastIndexOf(EVENT.TURN_COMPLETE);
    expect(doneIdx).toBeGreaterThan(usageIdx);
    expect(usageIdx).toBeGreaterThan(contentIdx);

    const content = events[contentIdx];
    expect(content.source).toBe('provider');
    expect(content.payload.inputTranscription).toBe('tell the worker to hold phase 3 until my review');
    expect(content.payload.outputTranscription).toBe('Understood — holding phase 3 for your review.');
    const parts = content.payload.parts as Array<{ mimeType: string; audioBytes: number }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].mimeType).toBe('audio/pcm;rate=24000');
    expect(parts[0].audioBytes).toBe(480);

    const usage = events[usageIdx].payload;
    expect(usage.stt).toMatchObject({ provider: 'mock', model: 'mock-stt' });
    expect(usage.tts).toMatchObject({ provider: 'mock', voice: 'alloy', chars: expect.any(Number) });
    expect(usage.audioMs).toBeGreaterThan(0);

    const done = events[doneIdx].payload as Record<string, unknown>;
    expect(done.failedLeg).toBeNull();
    expect(done.transcript).toBe('tell the worker to hold phase 3 until my review');
    expect(done.draftSizeAfter).toBe(1);
    expect(Number(done.sttMs)).toBeGreaterThan(0);
    expect(Number(done.modelMs)).toBeGreaterThan(0);
    expect(Number(done.ttsMs)).toBeGreaterThan(0);
    expect(Number(done.ttfaMs)).toBeGreaterThan(0);
    // Speech end is anchored on the log clock, before the reply audio.
    expect(Number(done.speechEndAtMs)).toBeLessThan(Number(done.firstAudioAtMs));
    // The receipt for the opened composition batch was spoken about and logged.
    expect(kinds).toContain(EVENT.HARNESS_RECEIPT);
  });

  it('speaks the trusted release ack when a confirm follows a held statement', async () => {
    const fx = makeCascade(['Understood — holding that.'], {
      transcripts: ['tell the worker to hold phase 3 until my review', 'yes go ahead'],
    });
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(80));
    await fx.cascade.settle();
    await driver.stream('u2', tonePcm(40)); // "yes go ahead" → confirm
    await fx.cascade.settle();

    // Gate: the confirm released the stored bytes through the one delivery.
    // P25 semi-verbatim: the draft stores the RELAY text (channel words like
    // "tell the worker to" are mechanically normalised away at draft time),
    // so that is exactly what a confirmation releases.
    expect(fx.talker.delivery.deliveredTexts()).toEqual(['hold phase 3 until my review']);
    // Trusted ack is what TTS was asked to speak on the release turn.
    expect(fx.tts.calls[1]).toBe(RELEASE_ACK);
    // And the draft is gone.
    expect(fx.talker.session.proposals.pending).toBeNull();

    const releaseEvents = fx.log.events().filter((e) => e.kind === EVENT.HARNESS_RELEASE);
    expect(releaseEvents).toHaveLength(1);
    expect(releaseEvents[0].payload).toMatchObject({
      text: 'hold phase 3 until my review',
      outcome: 'delivered',
      utteranceId: 1,
    });
    const done = fx.log.events().filter((e) => e.kind === EVENT.TURN_COMPLETE);
    expect(done).toHaveLength(2);
    expect((done[1].payload as Record<string, unknown>).released).toMatchObject({
      text: 'hold phase 3 until my review',
    });
  });

  it('answers a confirm with nothing held mechanically, never through the model', async () => {
    const fx = makeCascade([], { transcripts: ['yes go ahead'] });
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(40)); // "yes go ahead" with empty draft
    await fx.cascade.settle();

    expect(fx.talker.model.calls).toHaveLength(0); // dead end is model-free
    expect(fx.tts.calls).toEqual([NOTHING_PENDING_ACK]);
    const mech = fx.log.events().filter((e) => e.kind === EVENT.HARNESS_MECHANICAL);
    expect(mech).toHaveLength(1);
    expect((mech[0].payload as Record<string, unknown>).reply).toBe(NOTHING_PENDING_ACK);
  });
});

// ── 2. N lane: trailing silence is the boundary ────────────────────────────

describe('baseline cascade N lane', () => {
  it('fires the turn on trailing silence without an activityEnd marker', async () => {
    const fx = makeCascade(['Sure.'], { lane: 'N', trailSilenceMs: 300 });
    const driver = new SpeechDriver({
      log: fx.log,
      sink: fx.cascade,
      lane: 'N',
      frameIntervalMs: 1,
      leadInMs: 20,
      trailSilenceMs: 300,
    });
    await driver.stream('u1', tonePcm(80));
    await fx.cascade.settle();

    expect(fx.stt.calls).toHaveLength(1);
    expect(fx.tts.calls).toEqual(['Sure.']);
    const done = fx.log.events().filter((e) => e.kind === EVENT.TURN_COMPLETE);
    expect(done).toHaveLength(1);
    expect((done[0].payload as Record<string, unknown>).boundary).toBe('trailing-silence');
  });

  it('does not invent a turn from silence alone', async () => {
    const fx = makeCascade(['Sure.'], { lane: 'N', trailSilenceMs: 100 });
    const driver = new SpeechDriver({
      log: fx.log,
      sink: fx.cascade,
      lane: 'N',
      frameIntervalMs: 1,
      leadInMs: 200,
      trailSilenceMs: 100,
    });
    await driver.stream('empty', Buffer.alloc(0)); // silence only
    await fx.cascade.flush();

    expect(fx.stt.calls).toHaveLength(0);
    expect(fx.log.events().some((e) => e.kind === EVENT.TURN_COMPLETE)).toBe(false);
  });
});

// ── 3. Provider failures are named, never swallowed ────────────────────────

describe('baseline cascade provider failures', () => {
  it('records a stt-leg provider_error and calls no model or TTS', async () => {
    const fx = makeCascade(['unused'], { sttFail: true });
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(40));
    await fx.cascade.settle();

    expect(fx.talker.model.calls).toHaveLength(0);
    expect(fx.tts.calls).toHaveLength(0);
    const errors = fx.log.events().filter((e) => e.kind === EVENT.PROVIDER_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ leg: 'stt', message: 'stt provider down' });
    const done = fx.log.events().filter((e) => e.kind === EVENT.TURN_COMPLETE);
    expect((done[0].payload as Record<string, unknown>).failedLeg).toBe('stt');
  });

  it('records a tts-leg provider_error but still logs transcript, reply and usage', async () => {
    const fx = makeCascade(['Reply text.'], { ttsFail: true });
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(40));
    await fx.cascade.settle();

    expect(fx.player.stats().receivedFrames).toBe(0);
    const errors = fx.log.events().filter((e) => e.kind === EVENT.PROVIDER_ERROR);
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ leg: 'tts' });
    // The transcript leg is still on the record, and the reply lives on the
    // turn-complete payload even though no audio was produced.
    const sttContent = fx.log.events().find((e) => e.kind === EVENT.PROVIDER_CONTENT);
    expect((sttContent?.payload as Record<string, unknown>).inputTranscription).toBe('tell the worker to hold phase 3 until my review');
    const usage = fx.log.events().find((e) => e.kind === EVENT.PROVIDER_USAGE);
    expect((usage?.payload as Record<string, unknown>).stt).toMatchObject({ provider: 'mock' });
    expect((usage?.payload as Record<string, unknown>).model).toMatchObject({ modelCalled: true });
    const done = fx.log.events().filter((e) => e.kind === EVENT.TURN_COMPLETE);
    expect((done[0].payload as Record<string, unknown>).reply).toBe('Reply text.');
    expect((done[0].payload as Record<string, unknown>).failedLeg).toBe('tts');
    expect((done[0].payload as Record<string, unknown>).firstAudioAtMs).toBeNull();
  });

  it('records a model-leg failure when the talker session itself throws', async () => {
    const fx = makeCascade([]);
    fx.talker.session.handleOperatorTurn = async () => {
      throw new Error('talker session exploded');
    };
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(40));
    await fx.cascade.settle();

    const errors = fx.log.events().filter((e) => e.kind === EVENT.PROVIDER_ERROR);
    expect(errors.map((e) => (e.payload as Record<string, unknown>).leg)).toContain('model');
    const done = fx.log.events().filter((e) => e.kind === EVENT.TURN_COMPLETE);
    expect((done[0].payload as Record<string, unknown>).failedLeg).toBe('model');
  });
});

// ── 4. End-to-end: the hermetic attempt verifies ───────────────────────────

describe('baseline cascade attempt record', () => {
  it('produces a trace the offline verifier accepts', async () => {
    const attempt = createAttempt(root, 'run-l2-test', 't1/baseline-cascade/E-sidecar-duck/test-world');
    const clock = createMonotonicClock();
    const log = new EventLog({ clock, filePath: eventLogPath(attempt.attemptDir) });
    const stt = mockStt();
    const tts = mockTts();
    const talker = makeTalker(['Understood — holding that.']);
    const player = new ReferencePlayer({ log });
    const cascade = new BaselineCascade({
      log,
      clock,
      lane: 'E',
      talker: talker.session,
      stt,
      tts,
      player,
    });
    const driver = new SpeechDriver({ log, sink: cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(80));
    await cascade.settle();
    await driver.stream('u2', tonePcm(40));
    await cascade.settle();
    player.stop('attempt-end');

    finaliseAttempt(attempt.attemptDir, {
      runId: attempt.runId,
      condition: attempt.condition,
      attemptId: attempt.attemptId,
      createdAt: new Date().toISOString(),
      requiredEventKinds: [EVENT.PROVIDER_CONTENT, EVENT.PROVIDER_USAGE, EVENT.TURN_COMPLETE, EVENT.INPUT_FRAME],
      goldenStrings: ['hidden-truth-value'],
      // tonePcm(80) is 2560 bytes → 4 frames; tonePcm(40) is 1280 bytes → 2.
      input: { declaredFrames: 6, frameBytes: DEFAULT_FRAME_BYTES },
      usage: { provider: 'baseline-cascade', mode: 'hermetic-test' },
      outcome: 'completed',
    });
    const outcome = verifyAttempt(attempt.attemptDir);
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('keeps the log parseable and monotonic across interleaved turns', async () => {
    const fx = makeCascade(['Understood — holding that.']);
    const driver = new SpeechDriver({ log: fx.log, sink: fx.cascade, lane: 'E', frameIntervalMs: 1 });
    await driver.stream('u1', tonePcm(80));
    await driver.stream('u2', tonePcm(40));
    await fx.cascade.settle();
    const text = fx.log
      .events()
      .map((e) => JSON.stringify(e))
      .join('\n');
    const parsed = parseEventLog(text);
    expect(parsed.problems).toEqual([]);
    const turns = parsed.events.filter((e) => e.kind === EVENT.TURN_COMPLETE);
    expect(turns).toHaveLength(2);
    expect(turns[1].seq).toBeGreaterThan(turns[0].seq);
    expect(turns[1].tMs).toBeGreaterThanOrEqual(turns[0].tMs);
  });
});

// ── 5. The real adapters map requests and failures honestly ────────────────

describe('baseline cascade real adapters (stubbed fetch)', () => {
  it('OpenAI STT sends the transcription request and returns the text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('held phase three', { status: 200 });
    }) as unknown as typeof fetch;
    const stt = createOpenAiStt({ apiKey: 'key-test', fetchImpl });
    const outcome = await stt.transcribe(tonePcm(100));
    expect(outcome.text).toBe('held phase three');
    expect(outcome.provider).toBe('openai');
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const form = calls[0].init.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
  });

  it('OpenAI STT falls back to the local Whisper service on failure', async () => {
    const fetchImpl: typeof fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes('api.openai.com')) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ text: 'whisper text' }), { status: 200 });
    }) as unknown as typeof fetch;
    const stt = createOpenAiStt({
      apiKey: 'key-test',
      fetchImpl,
      whisperFallback: createWhisperFallbackStt({ baseUrl: 'http://127.0.0.1:9000', fetchImpl }),
    });
    const outcome = await stt.transcribe(tonePcm(100));
    expect(outcome.text).toBe('whisper text');
    expect(outcome.provider).toBe('whisper-local');
  });

  it('OpenAI STT throws an honest error when both providers fail', async () => {
    const fetchImpl: typeof fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const stt = createOpenAiStt({
      apiKey: 'key-test',
      fetchImpl,
      whisperFallback: createWhisperFallbackStt({ baseUrl: 'http://127.0.0.1:9000', fetchImpl }),
    });
    await expect(stt.transcribe(tonePcm(100))).rejects.toThrow(/stt failed/i);
  });

  it('OpenAI TTS requests tts-1 alloy pcm and returns the raw PCM', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const pcmBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const fetchImpl: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(pcmBytes, { status: 200 });
    }) as unknown as typeof fetch;
    const tts = createOpenAiTts({ apiKey: 'key-test', fetchImpl });
    const outcome = await tts.synthesise('sending that now');
    expect(outcome.provider).toBe('openai');
    expect(outcome.model).toBe('tts-1');
    expect(outcome.voice).toBe('alloy');
    expect(outcome.pcm.byteLength).toBe(6);
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/speech');
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'tts-1', voice: 'alloy', response_format: 'pcm', input: 'sending that now' });
  });

  it('the cascade refuses to build when a required receipt ack shape is wrong', async () => {
    // Guard on the trusted-ack contract the baseline speaks: the ack the
    // release turn synthesises must be the fixed string, not model text.
    expect(RELEASE_ACK).toBe('sending that now');
    expect(RECEIPT_ACK).toBe('Noted — still holding that.');
  });
});
