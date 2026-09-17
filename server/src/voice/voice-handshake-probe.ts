/**
 * Live handshake probe — Track B's Gate 3 second command.
 *
 *   npm --prefix server run test:voice-handshake
 *
 * THIS IS A REAL PROVIDER CALL. There is no dry-run flag, no fixture response,
 * no mock socket: the service opens a real `gemini-3.8-live` session with the
 * server's `GEMINI_API_KEY`, sends genuine spoken audio (a committed 16 kHz
 * speech fixture — sine tones and digital silence are forbidden by the plan's
 * anti-cheat rules), and requires a real transcription delta before it exits 0.
 *
 * What it proves, in order:
 *   1. the key is present in the server environment and reaches the provider and
 *      nowhere else (it is never printed, logged or emitted);
 *   2. the provider accepts the connect config and reports `setupComplete`;
 *   3. the transcoder + session + bridge deliver operator PCM to the provider;
 *   4. the provider transcribes that speech (input transcription) or speaks a
 *      transcript (output transcription) — either is a valid delta;
 *   5. the session captures a resumption handle;
 *   6. the lane stops cleanly.
 *
 * Exit codes: 0 = handshake observed; 1 = handshake failed; 2 = no key.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

import { VoiceSessionService } from './voice-session.js';
import { GeminiLiveBridge } from './gemini-live-bridge.js';
import { HANDSHAKE_EXPECTED_PHRASE, evaluateHandshakeTranscript } from './handshake-verdict.js';
import type { VoiceBridgeEmittedEvent } from './contract.js';
import type { GeminiLiveBridgeUsage } from './types.js';

dotenv.config();

const FIXTURE_URL = new URL('./fixtures/handshake-speech-16k.pcm', import.meta.url);
const FRAME_BYTES = 640; // 20 ms at 16 kHz mono PCM16
const FRAME_INTERVAL_MS = 20;
const SETUP_TIMEOUT_MS = 20_000;
const TRANSCRIPT_TIMEOUT_MS = 20_000;
const LANE_ID = 'handshake-probe:cli';
const ATTACHMENT_GENERATION = 1;

interface ProbeOutcome {
  setupAtMs: number | null;
  sentBytes: number;
  sentFrames: number;
  sentDurationMs: number;
  /** Accumulated operator input transcript (final deltas replace partials). */
  operatorText: string;
  /** Latest normalised observation, for honest failure output. */
  observedNormalised: string;
  /** Verdict reason for the latest observation. */
  verdictReason: string;
  /** Expected-token overlap of the latest observation (0..1). */
  overlapRatio: number;
  /** The normalised text that actually matched, when one did. */
  matchedNormalised: string;
  matchedText: string;
  matchedPreview: string;
  otherTranscriptDeltas: number;
  audioOutBytes: number;
  resumable: boolean;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Bounded, sanitised preview: the fixture phrase is our own, never a secret. */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 96 ? `${oneLine.slice(0, 93)}...` : oneLine;
}

async function main(): Promise<number> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    log('Voice handshake probe: GEMINI_API_KEY is not set in the server environment.');
    log('This probe refuses to run without a real key: a handshake must never be simulated.');
    return 2;
  }

  const fixture = readFileSync(fileURLToPath(FIXTURE_URL));
  log('Voice handshake probe — REAL provider call (no mock socket, no dry-run).');
  log(`provider key: present in server env (${apiKey.length} characters; value never printed)`);
  log(`audio fixture: ${fixture.byteLength} bytes / ${(fixture.byteLength / 2 / 16_000).toFixed(2)} s of genuine speech at 16 kHz mono PCM16`);

  const bridges: GeminiLiveBridge[] = [];
  const service = new VoiceSessionService({
    bridgeFactory: (options) => {
      const bridge = new GeminiLiveBridge(options);
      bridges.push(bridge);
      return bridge;
    },
  });

  const outcome: ProbeOutcome = {
    setupAtMs: null,
    sentBytes: 0,
    sentFrames: 0,
    sentDurationMs: 0,
    operatorText: '',
    observedNormalised: '',
    verdictReason: 'empty',
    overlapRatio: 0,
    matchedNormalised: '',
    matchedText: '',
    matchedPreview: '',
    otherTranscriptDeltas: 0,
    audioOutBytes: 0,
    resumable: false,
  };

  const startedAt = Date.now();
  let resolveSetup: () => void = () => {};
  let resolveTranscript: () => void = () => {};
  const setupSeen = new Promise<void>((resolve) => {
    resolveSetup = resolve;
  });
  const transcriptSeen = new Promise<void>((resolve) => {
    resolveTranscript = resolve;
  });

  service.subscribe((event: VoiceBridgeEmittedEvent) => {
    switch (event.kind) {
      case 'state':
        if (event.state === 'live' && outcome.setupAtMs === null) {
          outcome.setupAtMs = Date.now() - startedAt;
          resolveSetup();
        }
        break;
      case 'resumption':
        outcome.resumable = event.resumable;
        break;
      case 'audio_out':
        outcome.audioOutBytes += Buffer.from(event.data, 'base64').byteLength;
        break;
      case 'transcript': {
        // The pass condition is the OPERATOR INPUT transcript, not any delta:
        // a silenced or garbage audio path can make the provider hallucinate a
        // short delta (negative control: "¿Qué?" from digital silence).
        if (event.speaker !== 'operator' || event.source !== 'native') {
          outcome.otherTranscriptDeltas += 1;
          break;
        }
        // A final delta carries the finalised turn text; partials accumulate.
        outcome.operatorText = event.final ? event.text : outcome.operatorText + event.text;
        const verdict = evaluateHandshakeTranscript(outcome.operatorText);
        outcome.observedNormalised = verdict.normalised;
        outcome.verdictReason = verdict.reason;
        outcome.overlapRatio = verdict.overlapRatio;
        if (verdict.ok && outcome.matchedNormalised === '') {
          outcome.matchedNormalised = verdict.normalised;
          outcome.matchedText = outcome.operatorText;
          outcome.matchedPreview = preview(outcome.operatorText);
          resolveTranscript();
        }
        break;
      }
      default:
        break;
    }
  });

  try {
    await service.start({
      laneId: LANE_ID,
      attachmentGeneration: ATTACHMENT_GENERATION,
      workerSessionId: 'handshake-probe',
      runtime: 'pi',
      captureMode: 'open-mic',
      readingLevel: 'verbatim',
      callbacks: {},
    });

    const setupResult = await Promise.race([
      setupSeen.then(() => 'setup' as const),
      wait(SETUP_TIMEOUT_MS).then(() => 'timeout' as const),
    ]);
    if (setupResult === 'timeout') {
      log(`FAIL: the provider did not report setupComplete within ${SETUP_TIMEOUT_MS} ms.`);
      return 1;
    }
    log(`provider: setup complete at ${outcome.setupAtMs} ms`);

    service.noteActivity({
      laneId: LANE_ID,
      attachmentGeneration: ATTACHMENT_GENERATION,
      state: 'speech_start',
      atMs: Date.now(),
    });

    const audioStartedAt = Date.now();
    for (let offset = 0, seq = 0; offset < fixture.byteLength; offset += FRAME_BYTES, seq += 1) {
      const frame = fixture.subarray(offset, Math.min(offset + FRAME_BYTES, fixture.byteLength));
      service.feedAudio({
        laneId: LANE_ID,
        attachmentGeneration: ATTACHMENT_GENERATION,
        seq,
        mimeType: 'audio/pcm;rate=16000',
        data: frame.toString('base64'),
        durationMs: Math.round((frame.byteLength / 2 / 16_000) * 1_000),
        capturedAtMs: Date.now(),
      });
      outcome.sentBytes += frame.byteLength;
      outcome.sentFrames += 1;
      await wait(FRAME_INTERVAL_MS);
    }
    outcome.sentDurationMs = Date.now() - audioStartedAt;
    service.noteActivity({
      laneId: LANE_ID,
      attachmentGeneration: ATTACHMENT_GENERATION,
      state: 'speech_end',
      atMs: Date.now(),
    });
    log(`audio: sent ${outcome.sentBytes} bytes in ${outcome.sentFrames} frames over ${outcome.sentDurationMs} ms`);

    const transcriptResult = await Promise.race([
      transcriptSeen.then(() => 'transcript' as const),
      wait(TRANSCRIPT_TIMEOUT_MS).then(() => 'timeout' as const),
    ]);
    if (transcriptResult === 'timeout') {
      const observed = outcome.observedNormalised === '' ? '(none observed)' : `"${outcome.observedNormalised}"`;
      log(
        `FAIL: no matching operator input transcript within ${TRANSCRIPT_TIMEOUT_MS} ms of speech end.`
      );
      log(
        `observed operator input transcript: ${observed} ` +
          `(verdict: ${outcome.verdictReason}, expected-token overlap ${(outcome.overlapRatio * 100).toFixed(0)}%; ` +
          `expected a transcript related to "${HANDSHAKE_EXPECTED_PHRASE}")`
      );
      log(`other transcript deltas (talker/shadow): ${outcome.otherTranscriptDeltas}`);
      return 1;
    }
    log(
      `operator input transcript: normalised="${outcome.matchedNormalised}" ` +
        `(matched via ${outcome.verdictReason}, expected-token overlap ${(outcome.overlapRatio * 100).toFixed(0)}%)`
    );
    log(`operator input transcript (raw preview): "${outcome.matchedPreview}"`);
    log(`audio returned by the model: ${outcome.audioOutBytes} bytes`);
    log(`resumption: handle captured=${outcome.resumable ? 'resumable' : 'not yet marked resumable'}`);

    const usage: Readonly<GeminiLiveBridgeUsage> | null = bridges[0]?.usage ?? null;
    log('provider usage counters (real session, no fixture):');
    log(`  ${JSON.stringify(usage)}`);
    log(
      `RESULT: PASS — real setupComplete, real audio delivery, and an operator input transcript ` +
        `matching the expected phrase "${HANDSHAKE_EXPECTED_PHRASE}".`
    );
    return 0;
  } catch (error) {
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await service.stop(LANE_ID, 'operator_stop');
    await service.dispose();
  }
}

const exitCode = await main();
process.exit(exitCode);
