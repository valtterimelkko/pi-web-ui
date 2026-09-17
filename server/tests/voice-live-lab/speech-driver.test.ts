/**
 * L0 speech-driver + fake-provider tests.
 *
 * Two things are proved here:
 *   1. the driver's framing and endpointing contracts (640-byte / 20 ms frames,
 *      E-lane explicit markers, N-lane lead-in and trail silence, padding of a
 *      partial final frame);
 *   2. the driver and scripted fake provider together produce a trace the
 *      offline verifier accepts — and the same trace with a frame removed is
 *      rejected, tying the equipment to the gate end-to-end.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, EventLog, createMonotonicClock } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  DEFAULT_FRAME_BYTES,
  DEFAULT_FRAME_INTERVAL_MS,
  SpeechDriver,
  type PcmInputFormat,
} from '../../../scripts/voice-live-lab/lib/speech-driver.js';
import { FakeLiveProvider } from '../../../scripts/voice-live-lab/lib/providers/fake-live.js';
import {
  RECORD_SCHEMA_VERSION,
  LAB_VERSION,
  createAttempt,
  eventLogPath,
  finaliseAttempt,
  verifyAttempt,
} from '../../../scripts/voice-live-lab/lib/record.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-driver-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Deterministic no-op sleep that records the requested delays. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number): Promise<void> => {
      delays.push(ms);
    },
  };
}

describe('speech driver framing', () => {
  it('uses 640-byte / 20 ms frames and paces one tick per frame', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const pushed: Array<{ bytes: number; sequence: number }> = [];
    const { sleep, delays } = fakeSleep();
    const driver = new SpeechDriver({
      log,
      lane: 'E',
      sink: { pushAudio: (frame, _format, sequence) => pushed.push({ bytes: frame.byteLength, sequence }) },
      sleep,
    });

    const report = await driver.stream('u0', Buffer.alloc(1920));

    expect(DEFAULT_FRAME_BYTES).toBe(640);
    expect(DEFAULT_FRAME_INTERVAL_MS).toBe(20);
    expect(report.frames).toBe(3);
    expect(report.audioFrames).toBe(3);
    expect(report.silenceFrames).toBe(0);
    expect(report.bytes).toBe(1920);
    expect(pushed.map((entry) => entry.bytes)).toEqual([640, 640, 640]);
    expect(pushed.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
    expect(delays).toEqual([20, 20, 20]);
  });

  it('pads a partial final frame to exactly one frame and records the padding', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const frames: number[] = [];
    const driver = new SpeechDriver({
      log,
      lane: 'E',
      sink: { pushAudio: (frame) => frames.push(frame.byteLength) },
      sleep: async () => {},
    });

    const report = await driver.stream('u0', Buffer.alloc(700));
    expect(report.frames).toBe(2);
    expect(frames).toEqual([640, 640]);
    expect(report.bytes).toBe(1280);
    expect(report.sourceBytes).toBe(700);
    expect(report.paddedBytes).toBe(580);
  });

  it('sends explicit activity markers around the stream in the E lane', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const order: string[] = [];
    const driver = new SpeechDriver({
      log,
      lane: 'E',
      sink: {
        pushAudio: () => order.push('frame'),
        activityStart: () => order.push('activityStart'),
        activityEnd: () => order.push('activityEnd'),
      },
      sleep: async () => {},
    });

    const report = await driver.stream('u0', Buffer.alloc(1280));
    expect(order).toEqual(['activityStart', 'frame', 'frame', 'activityEnd']);
    expect(report.startedWithActivityMarker).toBe(true);
    expect(report.endedWithActivityMarker).toBe(true);
    const activityEvents = log.events().filter((event) => event.kind === EVENT.INPUT_ACTIVITY);
    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0].payload.lane).toBe('E');
  });

  it('emits lead-in and trail silence with no markers in the N lane', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const order: string[] = [];
    const driver = new SpeechDriver({
      log,
      lane: 'N',
      leadInMs: 40,
      trailSilenceMs: 60,
      frameIntervalMs: 20,
      sink: {
        pushAudio: () => order.push('frame'),
        activityStart: () => order.push('activityStart'),
        activityEnd: () => order.push('activityEnd'),
      },
      sleep: async () => {},
    });

    const report = await driver.stream('u0', Buffer.alloc(1280));
    expect(order).toEqual(['frame', 'frame', 'frame', 'frame', 'frame', 'frame', 'frame']);
    expect(report.silenceFrames).toBe(5); // 2 lead-in + 3 trail
    expect(report.audioFrames).toBe(2);
    expect(report.frames).toBe(7);
    expect(report.startedWithActivityMarker).toBe(false);

    const frames = log.events().filter((event) => event.kind === EVENT.INPUT_FRAME);
    const silenceFlags = frames.map((event) => event.payload.silence);
    expect(silenceFlags).toEqual([true, true, false, false, true, true, true]);
    // Media offsets are the intended stream positions, not the wall clock.
    expect(frames.map((event) => event.mediaOffsetMs)).toEqual([0, 20, 40, 60, 80, 100, 120]);
  });

  it('rejects an odd or non-positive frame size', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const sink = { pushAudio: () => {} };
    expect(() => new SpeechDriver({ log, sink, lane: 'E', frameBytes: 641 })).toThrow(/even/);
    expect(() => new SpeechDriver({ log, sink, lane: 'E', frameBytes: 0 })).toThrow(/even|positive/);
  });
});

describe('fake provider', () => {
  it('replays scripted serverContent and usage in order', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const { sleep } = fakeSleep();
    const provider = new FakeLiveProvider({
      log,
      sleep,
      script: [
        {
          atMs: 0,
          serverContent: {
            modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(8).toString('base64') } }] },
            outputTranscription: { text: 'working on it' },
          },
        },
        { atMs: 100, serverContent: { turnComplete: true } },
        { atMs: 120, usageMetadata: { promptTokenCount: 12, responseTokenCount: 5, totalTokenCount: 17 } },
      ],
    });

    await provider.run();
    const events = log.events();
    expect(events.filter((event) => event.kind === EVENT.PROVIDER_CONTENT)).toHaveLength(2);
    expect(events.filter((event) => event.kind === EVENT.PROVIDER_USAGE)).toHaveLength(1);

    const first = events[0];
    expect(first.payload.parts).toEqual([{ mimeType: 'audio/pcm;rate=24000', audioBytes: 8 }]);
    expect(first.payload.turnComplete).toBe(false);
    expect(events[1].payload.turnComplete).toBe(true);
    expect(events[2].payload.totalTokenCount).toBe(17);
  });

  it('records pushed frames and refuses audio after close', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const provider = new FakeLiveProvider({ log, script: [] });
    const format: PcmInputFormat = { encoding: 'pcm16', sampleRate: 16000, channels: 1 };
    provider.pushAudio(Buffer.alloc(640), format, 0);
    provider.pushAudio(Buffer.alloc(640), format, 1);
    expect(provider.receivedFrames).toBe(2);
    expect(provider.receivedBytes).toBe(1280);
    provider.close();
    expect(() => provider.pushAudio(Buffer.alloc(640), format, 2)).toThrow(/closed/);
  });
});

describe('driver → fake provider → record verifier', () => {
  async function buildTrace(attemptDir: string, dropFrame: boolean): Promise<void> {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock, filePath: eventLogPath(attemptDir) });
    const provider = new FakeLiveProvider({
      log,
      sleep: async () => {},
      script: [
        { atMs: 0, serverContent: { outputTranscription: { text: 'acknowledged' } } },
        { atMs: 10, serverContent: { turnComplete: true } },
        { atMs: 12, usageMetadata: { totalTokenCount: 21 } },
      ],
    });
    const driver = new SpeechDriver({ log, sink: provider, lane: 'E', sleep: async () => {} });
    const report = await driver.stream('u0', Buffer.alloc(1280));
    await provider.run();
    provider.close();
    const events = log.events();
    if (dropFrame) {
      const frames = events.filter((event) => event.kind === EVENT.INPUT_FRAME);
      // Drop the middle frame and renumber, simulating a faulty driver.
      const kept = events.filter((event) => event !== frames[1]);
      writeFileSync(
        eventLogPath(attemptDir),
        `${kept.map((event, index) => JSON.stringify({ ...event, seq: index + 1 })).join('\n')}\n`
      );
    }
    finaliseAttempt(attemptDir, {
      schemaVersion: RECORD_SCHEMA_VERSION,
      labVersion: LAB_VERSION,
      runId: 'run-l0',
      condition: 't1/fake/E-native-duck/world',
      attemptId: 'attempt-01',
      createdAt: new Date().toISOString(),
      input: { sourceId: 'u0', declaredFrames: report.frames, declaredBytes: report.bytes, frameBytes: 640 },
      requiredEventKinds: [EVENT.INPUT_FRAME, EVENT.PROVIDER_USAGE],
    });
  }

  it('passes a clean control produced by the driver and fake provider', async () => {
    const attemptDir = createAttempt(root, 'run-l0', 'clean', 'attempt-01').attemptDir;
    await buildTrace(attemptDir, false);
    const outcome = verifyAttempt(attemptDir);
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
    const frames = readFileSync(eventLogPath(attemptDir), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => JSON.parse(line).kind === EVENT.INPUT_FRAME);
    expect(frames).toHaveLength(2);
  });

  it('fails the same trace when one frame is dropped', async () => {
    const attemptDir = createAttempt(root, 'run-l0', 'damaged', 'attempt-01').attemptDir;
    await buildTrace(attemptDir, true);
    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join('\n')).toMatch(/dropped frames/);
  });
});
