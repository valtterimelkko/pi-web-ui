/**
 * Capture one REAL native voice lane, end to end.
 *
 * This is the lab the operator asked for after reporting that the talker's voice
 * "starts talking on top of each other". It runs the operator's scenario on a real
 * lane — real disposable server, real Gemini Live session, real spoken operator
 * audio, the contract's own `voice_audio_chunk` frames — and keeps the model's
 * audio EXACTLY as the client received it, so the shape of that audio can be
 * analysed afterwards instead of guessed at.
 *
 * Everything here is a measurement:
 *   - the operator's question is synthesised speech (Supertonic, local, no
 *     credentials), never a sine wave or silence — a fake operator leg fails closed;
 *   - the server is a disposable instance outside the production cgroup, with its
 *     own state dir, token and socket;
 *   - every inbound frame is kept with its arrival time, and the audio payloads are
 *     written to disk as PCM so a later analysis reads the same bytes the client did;
 *   - nothing here plays audio, and nothing in the product is bypassed: the frames
 *     are the ones the real server sent a real lane.
 *
 * It deliberately does NOT touch production and never restarts anything.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { synthesiseFixtures } from '../../voice-live-lab/lib/fixtures.js';
import { bootDisposableServer, waitForHealth, type DisposableServer } from '../../voice-live-lab/lib/voice-slice/disposable-server.js';
import { login, SLICE_ORIGIN, VoiceWireClient } from '../../voice-live-lab/lib/voice-slice/ws-client.js';
import { createHttpTier3Api } from '../../voice-live-lab/lib/tier3-tools.js';
import type { ArrivedChunk } from './schedule.js';

/** The operator's question, designed to elicit a multi-sentence answer. */
export const DEFAULT_QUESTION =
  'Please summarise what you can see about this session in a few sentences, and then tell me what you would check first and why.';

export const DEFAULT_WORKER_MODEL = 'google/gemini-3.8-flash';
export const LANE_ID = 'voice-lane-lab-1';
export const ATTACHMENT_GENERATION = 1;

export interface LaneCaptureOptions {
  repoRoot: string;
  /** Where the attempt's audio and frames are written. */
  outDir: string;
  question?: string;
  /** How long to keep listening after the operator stops speaking. */
  listenMs?: number;
  workerModel?: string;
  log: (line: string) => void;
}

export interface CapturedFrame {
  atMs: number;
  direction: 'in' | 'out';
  type: string;
  frame: Record<string, unknown>;
}

export interface LaneCapture {
  workerSessionId: string;
  laneId: string;
  chunks: ArrivedChunk[];
  /** Every frame, with audio payloads replaced by their length (never the bytes). */
  frames: CapturedFrame[];
  /** One entry per audio chunk as the client received it. */
  chunkRecords: Array<{
    seq: number;
    arrivedAtMs: number;
    declaredDurationMs: number;
    mimeType: string;
    base64Chars: number;
    sampleCount: number;
    sha256: string;
    pcmPath: string;
  }>;
  /** Transcript deltas, for correlating what was said with what was heard. */
  transcripts: Array<{ atMs: number; speaker: string; text: string; final: boolean }>;
  /** Provider/lane events that shape the audio (interruptions, turn ends). */
  events: Array<{ atMs: number; type: string; detail: string }>;
  operatorQuestion: { text: string; durationMs: number; rms: number };
  serverStateDir: string;
}

interface LaneFixture {
  pcm: Buffer;
  durationMs: number;
  rms: number;
}

function rmsOfPcm16(pcm: Buffer): number {
  if (pcm.byteLength < 2) return 0;
  const samples = pcm.byteLength / 2;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = pcm.readInt16LE(index * 2) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

async function synthesiseQuestion(outDir: string, text: string, log: (line: string) => void): Promise<LaneFixture> {
  const manifest = await synthesiseFixtures({
    outDir,
    specs: [{ id: 'lane-question', text }],
    log,
  });
  const entry = manifest.fixtures.find((fixture) => fixture.id === 'lane-question');
  if (!entry) throw new Error('the operator question was not synthesised');
  const pcm = readFileSync(entry.pcm16kPath);
  const rms = rmsOfPcm16(pcm);
  if (pcm.byteLength < 4_000) throw new Error(`the operator question is implausibly short (${pcm.byteLength} bytes)`);
  if (rms < 0.005) {
    // Anti-cheat, inherited from the slice: a silent or synthetic operator leg
    // would let the lane "pass" without anyone having said anything.
    throw new Error(`the operator question is silent (rms=${rms.toFixed(5)}) — refusing to run on fake audio`);
  }
  return { pcm, durationMs: (pcm.byteLength / 2 / 16_000) * 1000, rms };
}

function decodePcm16Base64(data: string): Float32Array {
  const bytes = Buffer.from(data, 'base64');
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2) / 32768;
  return samples;
}

/**
 * Boot a disposable lane, speak the question with real audio, and keep everything
 * the server sent back.
 */
export async function captureLane(options: LaneCaptureOptions): Promise<LaneCapture> {
  const question = options.question ?? DEFAULT_QUESTION;
  const listenMs = options.listenMs ?? 65_000;
  const log = options.log;
  const audioDir = path.join(options.outDir, 'audio');
  mkdirSync(audioDir, { recursive: true, mode: 0o700 });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('GEMINI_API_KEY is not set: a measured lane run must never run unlabelled.');
  }

  let server: DisposableServer | null = null;
  let client: VoiceWireClient | null = null;
  try {
    server = await bootDisposableServer({
      repoRoot: options.repoRoot,
      env: {
        GEMINI_API_KEY: apiKey,
        LOG_FORMAT: 'json',
        // The disposable server refuses the /ws upgrade unless this origin is
        // allowed; a bare CLI shell carries no ALLOWED_ORIGINS.
        ALLOWED_ORIGINS: SLICE_ORIGIN,
        // The live engine is the lane under test, not the cascade fallback.
        VOICE_MODE_ENGINE: 'gemini-live',
        AUTH_PASSWORD: 'voice-lane-lab',
      },
      log,
    });
    await waitForHealth(server.httpPort);
    const session = await login(server.httpPort, server.authPassword);
    log(`disposable server up: http=${server.httpPort} state=${server.stateDir}`);

    const fixture = await synthesiseQuestion(path.join(audioDir, 'operator'), question, log);
    log(`operator question: ${fixture.durationMs.toFixed(0)}ms rms=${fixture.rms.toFixed(3)}`);

    const api = createHttpTier3Api({ socketPath: server.socketPath, tokenPath: server.tokenPath });
    const workspaceDir = path.join(server.stateDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const created = (await api.createSession({
      runtime: 'pi',
      cwd: workspaceDir,
      model: options.workerModel ?? DEFAULT_WORKER_MODEL,
      thinkingLevel: 'low',
      source: 'voice-lane-lab',
      label: 'voice-lane-lab-worker',
    } as never)) as { sessionId: string };
    log(`worker session: ${created.sessionId}`);

    client = await VoiceWireClient.connect(server.httpPort, session, log);
    const lane = { laneId: LANE_ID, attachmentGeneration: ATTACHMENT_GENERATION };
    client.sendVoice({
      type: 'voice_session_start',
      version: 1,
      ...lane,
      workerSessionId: created.sessionId,
      runtime: 'pi',
      captureMode: 'push-to-talk',
      readingLevel: 'verbatim',
    } as never);
    const live = await client.waitFor({
      label: 'voice lane live',
      timeoutMs: 60_000,
      predicate: (frame) =>
        (frame.type === 'voice_state' && (frame as { state?: string }).state === 'live') || frame.type === 'voice_error',
    });
    if (live.type === 'voice_error') throw new Error(`the voice lane failed to start: ${JSON.stringify(live)}`);
    log('voice lane live; speaking the question');

    const envelope = { version: 1 as const, ...lane };
    client.sendVoice({ type: 'voice_activity_state', ...envelope, state: 'speech_start', atMs: Date.now() } as never);
    const chunkBytes = 640; // 20 ms of 16 kHz PCM16
    for (let offset = 0; offset < fixture.pcm.byteLength; offset += chunkBytes) {
      const slice = fixture.pcm.subarray(offset, Math.min(offset + chunkBytes, fixture.pcm.byteLength));
      client.sendVoice({
        type: 'voice_audio_chunk',
        ...envelope,
        seq: client.nextAudioSeq(),
        mimeType: 'audio/pcm;rate=16000',
        data: slice.toString('base64'),
        durationMs: (slice.byteLength / 2 / 16_000) * 1000,
        capturedAtMs: Date.now(),
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    client.sendVoice({ type: 'voice_activity_state', ...envelope, state: 'speech_end', atMs: Date.now() } as never);

    // Listen for the whole answer, then a tail so a late turn is still captured.
    await new Promise((resolve) => setTimeout(resolve, listenMs));

    const records = client.received;
    const chunks: ArrivedChunk[] = [];
    const chunkRecords: LaneCapture['chunkRecords'] = [];
    const frames: CapturedFrame[] = [];
    const transcripts: LaneCapture['transcripts'] = [];
    const events: LaneCapture['events'] = [];

    for (const record of records) {
      const frame = record.frame;
      const type = String(frame.type ?? 'unknown');
      // INBOUND ONLY. The wire client records both directions in one list, and the
      // operator's own 16 kHz frames carry their own seq sequence — counting them
      // as model speech would manufacture a duplicate-seq defect out of the
      // harness measuring itself (observed on the first run of this lab).
      const inbound = record.direction === 'in';
      if (type === 'voice_audio_chunk' && inbound) {
        const data = typeof frame.data === 'string' ? frame.data : '';
        const samples = decodePcm16Base64(data);
        const payload = Buffer.from(data, 'base64');
        const seq = Number(frame.seq ?? -1);
        const pcmPath = path.join(audioDir, `chunk-${String(seq).padStart(4, '0')}.pcm`);
        writeFileSync(pcmPath, payload);
        chunks.push({
          seq,
          arrivedAtMs: record.atMs,
          samples,
          mimeType: String(frame.mimeType ?? ''),
          declaredDurationMs: Number(frame.durationMs ?? 0),
        });
        chunkRecords.push({
          seq,
          arrivedAtMs: record.atMs,
          declaredDurationMs: Number(frame.durationMs ?? 0),
          mimeType: String(frame.mimeType ?? ''),
          base64Chars: data.length,
          sampleCount: samples.length,
          sha256: createHash('sha256').update(payload).digest('hex'),
          pcmPath,
        });
      } else if (type === 'transcript_delta' && inbound) {
        transcripts.push({
          atMs: record.atMs,
          speaker: String(frame.speaker ?? ''),
          text: String(frame.text ?? ''),
          final: frame.final === true,
        });
      } else if (inbound && (type === 'voice_state' || type === 'voice_error' || type === 'receipt_event')) {
        events.push({ atMs: record.atMs, type, detail: JSON.stringify(frame).slice(0, 400) });
      }
      if (!inbound) continue;
      frames.push({
        atMs: record.atMs,
        direction: record.direction,
        type,
        frame: typeof frame.data === 'string' ? { ...frame, data: `<${frame.data.length} base64 chars>` } : frame,
      });
    }

    log(`captured: ${chunks.length} model audio chunks, ${transcripts.length} transcript deltas, ${events.length} events`);
    if (chunks.some((chunk) => chunk.mimeType !== 'audio/pcm;rate=24000')) {
      // Model speech is 24 kHz by contract. Anything else here means the capture
      // picked up a different leg, and the measurement would be of the wrong
      // stream — refuse rather than analyse it.
      throw new Error(
        `captured model audio with unexpected formats: ${[...new Set(chunks.map((chunk) => chunk.mimeType))].join(', ')}`
      );
    }

    // Stop the lane explicitly so the disposable server tears its provider session
    // down rather than leaving it to time out.
    try {
      client.sendVoice({ type: 'voice_session_stop', ...envelope, reason: 'capture complete' } as never);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } catch {
      /* best effort: the run's evidence is already captured */
    }

    writeFileSync(path.join(options.outDir, 'frames.ndjson'), frames.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    writeFileSync(path.join(options.outDir, 'chunks.json'), JSON.stringify(chunkRecords, null, 2) + '\n');
    writeFileSync(path.join(options.outDir, 'transcripts.json'), JSON.stringify(transcripts, null, 2) + '\n');

    return {
      workerSessionId: created.sessionId,
      laneId: LANE_ID,
      chunks,
      frames,
      chunkRecords,
      transcripts,
      events,
      operatorQuestion: { text: question, durationMs: fixture.durationMs, rms: fixture.rms },
      serverStateDir: server.stateDir,
    };
  } finally {
    if (client) client.close();
    if (server) await server.stop().catch(() => undefined);
  }
}

/** Kept so a caller can assert the disposable server really wrote its own state. */
export function stateDirExists(capture: LaneCapture): boolean {
  return existsSync(capture.serverStateDir);
}
