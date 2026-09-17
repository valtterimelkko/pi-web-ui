/**
 * Tier 1 guarded live harness (L4, plan §16) — contract tests.
 *
 * Three layers are pinned here, all offline:
 *
 *   1. `TranscriptCommitTracker` — the 400 ms transcript-stabilisation commit
 *      rule (§16.3) as a pure state machine, driven by a manual clock.
 *   2. `Tier1GuardedHarness` — the guarded native harness: policy-core
 *      decisions executed against a scripted live provider, native vs sidecar
 *      transcript conditions, mechanical gate transitions with trusted
 *      audio, the duck player, and honest playback accounting.
 *   3. `runTier1DryAttempt` — the hermetic end-to-end: scenario beats →
 *      driver → harness (mock live client + scripted shadow ASR) → immutable
 *      record → offline verifier, labelled `mode: "dry-run"`,
 *      `realProviderCalls: 0`.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, createMonotonicClock, parseEventLog, type EventLog, type LabEvent } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import { ReferencePlayer } from '../../../scripts/voice-live-lab/lib/playback.js';
import { GeminiLiveProvider, type LiveServerMessageShape, type LiveSessionFactory, type LiveSessionLike } from '../../../scripts/voice-live-lab/lib/providers/gemini-live.js';
import { TranscriptCommitTracker, Tier1GuardedHarness, buildTier1SystemInstruction } from '../../../scripts/voice-live-lab/lib/harness/tier1-guarded.js';
import { runTier1DryAttempt } from '../../../scripts/voice-live-lab/lib/tier1-dryrun.js';
import { main as cliMain, parseArgs, type CliDependencies } from '../../../scripts/voice-live-lab/cli.js';
import { createNullDelivery } from '../../../server/src/talker/delivery.js';

const BENCH_SCENARIOS = '/root/agent-benchmarks/benchmarks/04-voice-live-lab/scenarios/tier1';
const benchExists = existsSync(BENCH_SCENARIOS);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-tier1-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── 1. The commit rule (§16.3), as a pure state machine ─────────────────────

describe('TranscriptCommitTracker — the 400 ms commit rule', () => {
  function tracker(lane: 'E' | 'N', stabilityMs = 400) {
    return new TranscriptCommitTracker({ lane, stabilityMs });
  }

  it('E lane: commits only after activityEnd AND 400 ms of transcript stability', () => {
    const t = tracker('E');
    t.onDelta('hold phase three until my review', 0);
    t.onDelta('hold phase three until my review.', 100);
    t.onActivityEnd(150);
    // Stability is measured from the LAST delta: before 100 + 400 the
    // transcript is still fresh — partial, never committed.
    expect(t.poll(100 + 399)).toBeNull();
    const commit = t.poll(100 + 400);
    expect(commit).not.toBeNull();
    expect(commit?.text).toContain('hold phase three');
    expect(commit?.boundary).toBe('activity-end');
    // Speech end anchors on the provider's end-of-turn signal.
    expect(commit?.speechEndAtMs).toBe(150);
  });

  it('E lane: without activityEnd the utterance never commits', () => {
    const t = tracker('E');
    t.onDelta('hold phase three', 0);
    expect(t.poll(5000)).toBeNull();
    expect(t.hasOpenTurn()).toBe(true);
  });

  it('a later delta restarts the stability window (late transcription is not committed early)', () => {
    const t = tracker('E');
    t.onDelta('hold phase', 0);
    t.onActivityEnd(50);
    expect(t.poll(399)).toBeNull(); // still inside the stability window…
    t.onDelta('hold phase three', 400); // …a new delta arrives and restarts it
    expect(t.poll(500)).toBeNull(); // only 100 ms since the last delta
    expect(t.poll(799)).toBeNull(); // still 1 ms short of 400 ms
    expect(t.poll(800)).not.toBeNull(); // 400 ms of stability since the restart
  });

  it('N lane: the 400 ms no-delta window IS the end-of-speech signal', () => {
    const t = tracker('N');
    t.onDelta('how is it going', 10);
    expect(t.poll(200)).toBeNull();
    const commit = t.poll(10 + 400);
    expect(commit).not.toBeNull();
    expect(commit?.boundary).toBe('vad-silence');
    expect(commit?.speechEndAtMs).toBe(10);
  });

  it('never commits a transcript that is empty after relay-normalise', () => {
    const t = tracker('N');
    // ASR noise: a whitespace-only "transcript" is never an operator turn.
    t.onDelta('   ', 0);
    expect(t.poll(5000)).toBeNull();
    // The noise turn was discarded, not left open.
    expect(t.hasOpenTurn()).toBe(false);
  });

  it('reports the commit latency and resets after a commit', () => {
    const t = tracker('N');
    t.onDelta('hold phase three', 0);
    const commit = t.poll(400);
    expect(commit?.commitAtMs).toBe(400);
    expect(commit?.commitLatencyMs).toBe(400);
    expect(t.hasOpenTurn()).toBe(false);
    // The next utterance starts fresh.
    t.onDelta('yes go ahead', 1000);
    const second = t.poll(1400);
    expect(second?.text).toBe('yes go ahead');
  });
});

// ── 2. The guarded harness ───────────────────────────────────────────────────

// ── scripted live session (manual, per-test determinism) ────────────────────

class ScriptedLiveSession implements LiveSessionLike {
  onMessage: ((msg: LiveServerMessageShape) => void) | null = null;
  onOpen: (() => void) | null = null;
  realtimeInputs: Array<Record<string, unknown>> = [];
  clientContents: Array<Record<string, unknown>> = [];
  closed = false;

  sendRealtimeInput(input: Record<string, unknown>): void {
    this.realtimeInputs.push(input);
  }
  sendClientContent(content: Record<string, unknown>): void {
    this.clientContents.push(content);
  }
  sendToolResponse(_response: Record<string, unknown>): void {
    /* acknowledged; bookkeeping not asserted here */
  }
  close(): void {
    this.closed = true;
  }
  deliver(msg: LiveServerMessageShape): void {
    this.onMessage?.(msg);
  }

  /**
   * Emit one scripted operator exchange: transcription deltas, then (for a
   * conversational turn) the native reply audio + output transcription, an
   * optional tool call, and turnComplete. `onActivityEnd` triggers it in the
   * E lane; the harness's own provider forwarding drives it.
   */
  emitExchange(transcript: string, reply: string | null, toolCall?: string, atMs = 0): void {
    const words = transcript.split(/\s+/);
    const half = Math.max(1, Math.ceil(words.length / 2));
    this.deliver({ serverContent: { inputTranscription: { text: words.slice(0, half).join(' ') } } });
    this.deliver({ serverContent: { inputTranscription: { text: ` ${words.slice(half).join(' ')}` } } });
    if (reply !== null) {
      this.deliver({
        serverContent: {
          outputTranscription: { text: reply },
          modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: sinePcm(words.length * 12).toString('base64') } }] },
        },
      });
      if (toolCall) this.deliver({ toolCall: { functionCalls: [{ name: toolCall, args: {}, id: `call-${toolCall}` }] } });
      this.deliver({ serverContent: { turnComplete: true } });
    }
    void atMs;
  }
}

function sinePcm(samples: number): Buffer {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(5000 * Math.sin(i / 8)), i * 2);
  return buf;
}

function scriptedFactory() {
  const requests: Array<{ model: string; config: Record<string, unknown> }> = [];
  let session: ScriptedLiveSession | null = null;
  const factory: LiveSessionFactory = async (request) => {
    requests.push({ model: request.model, config: request.config as Record<string, unknown> });
    session = new ScriptedLiveSession();
    session.onMessage = request.callbacks.onMessage;
    session.onOpen = request.callbacks.onOpen;
    request.callbacks.onOpen();
    return session;
  };
  return {
    factory,
    requests,
    get session(): ScriptedLiveSession {
      if (!session) throw new Error('session not connected yet');
      return session;
    },
  };
}

/** Scripted "Whisper" shadow ASR: pops authored utterances (last repeats). */
function scriptedShadowAsr(utterances: string[]) {
  const queue = [...utterances];
  const served: string[] = [];
  return {
    served,
    calls: 0,
    async transcribe(_pcm: Buffer) {
      this.calls += 1;
      const text = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? '');
      served.push(text);
      return { text, provider: 'whisper-mock', model: 'large-v3', ms: 4, usage: { scripted: true } };
    },
  };
}

/** Silence mechanical voice with honest byte accounting (~60 ms per word). */
function silenceMechanicalVoice() {
  const spoken: string[] = [];
  return {
    spoken,
    async synthesise(text: string) {
      spoken.push(text);
      const words = Math.max(1, text.trim().split(/\s+/).length);
      return {
        pcm: Buffer.alloc(Math.round((24000 * words * 60) / 1000) * 2),
        provider: 'silence-mock',
        model: 'none',
        voice: 'none',
        ms: 1,
      };
    },
  };
}

interface Fixture {
  log: EventLog;
  events: LabEvent[];
  clock: ReturnType<typeof createMonotonicClock>;
  recordedDelivery: { texts: string[] };
  provider: GeminiLiveProvider;
  factory: ReturnType<typeof scriptedFactory>;
  shadow: ReturnType<typeof scriptedShadowAsr>;
  voice: ReturnType<typeof silenceMechanicalVoice>;
  player: ReferencePlayer;
  harness: Tier1GuardedHarness;
}

function makeFixture(options: {
  lane?: 'E' | 'N';
  condition?: 'native' | 'sidecar';
  shadowUtterances?: string[];
  stabilityMs?: number;
  stateViewCoalesceMs?: number;
  turnTimeoutMs?: number;
  worldSnapshot?: Record<string, unknown>;
}): Fixture {
  const clock = createMonotonicClock();
  const events: LabEvent[] = [];
  const log = {
    append(input: { source: string; kind: string; id?: string; payload?: Record<string, unknown> }) {
      const event: LabEvent = {
        seq: events.length + 1,
        tMs: clock.nowMs(),
        source: input.source,
        kind: input.kind,
        id: input.id ?? `${input.source}:${input.kind}:${events.length + 1}`,
        payload: input.payload ?? {},
      };
      events.push(event);
      return event;
    },
  } as unknown as EventLog;

  const factory = scriptedFactory();
  const provider = new GeminiLiveProvider({
    log,
    clock,
    lane: options.lane ?? 'E',
    model: 'gemini-3.8-live-dryrun-mock',
    systemInstruction: 'dry-run instruction',
    sessionFactory: factory.factory,
    stateViewCoalesceMs: options.stateViewCoalesceMs ?? 0,
  });
  const shadow = scriptedShadowAsr(options.shadowUtterances ?? []);
  const voice = silenceMechanicalVoice();
  const player = new ReferencePlayer({ log });
  const recordedDelivery = createNullDelivery();
  const condition = options.condition ?? 'native';

  const harness = new Tier1GuardedHarness({
    log,
    clock,
    lane: options.lane ?? 'E',
    condition,
    provider,
    delivery: recordedDelivery,
    workerSessionId: 'tier1-test',
    snapshotProvider: () => options.worldSnapshot ?? { activity: 'refactoring the export module; suite running', lastAssistantText: 'CSV writer done with tests; JSON path next.' },
    shadowAsr: condition === 'sidecar' || options.shadowUtterances ? shadow : shadow,
    mechanicalVoice: voice,
    player,
    // Compressed for hermetic speed; the REAL 400 ms window is pinned by the
    // TranscriptCommitTracker unit tests above.
    stabilityMs: options.stabilityMs ?? 40,
    turnTimeoutMs: options.turnTimeoutMs ?? 5000,
  });

  return { log, events, clock, recordedDelivery, provider, factory, shadow, voice, player, harness };
}

/** Drive one spoken operator beat through the harness (E lane). */
async function speak(fixture: Fixture, utterancePcm: Buffer, scripted: { transcript: string; reply: string | null; toolCall?: string }): Promise<void> {
  const frame = Buffer.alloc(640);
  const { harness } = fixture;
  harness.activityStart(fixture.clock.nowMs());
  for (let offset = 0; offset + frame.byteLength <= utterancePcm.byteLength + frame.byteLength; offset += frame.byteLength) {
    if (offset >= utterancePcm.byteLength) break;
    const slice = utterancePcm.subarray(offset, Math.min(offset + frame.byteLength, utterancePcm.byteLength));
    const padded = Buffer.concat([slice, Buffer.alloc(frame.byteLength - slice.byteLength)]);
    harness.pushAudio(padded, { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, offset / frame.byteLength);
  }
  harness.activityEnd(fixture.clock.nowMs());
  // The scripted provider emits on the activity-end marker, exactly as a
  // native exchange would close.
  fixture.factory.session.emitExchange(scripted.transcript, scripted.reply, scripted.toolCall);
  await fixture.harness.settle();
}

function utterancePcmFor(text: string): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const frames = Math.round((16000 * words * 60) / 1000);
  return sinePcm(frames);
}

describe('Tier1GuardedHarness — the guarded native path', () => {
  it('drafts a statement conversationally, then releases it on a spoken confirmation', async () => {
    const f = makeFixture({
      shadowUtterances: ['hold phase 3 until my review', 'yes go ahead'],
    });
    await f.harness.start();

    await speak(f, utterancePcmFor('hold phase 3 until my review'), {
      transcript: 'hold phase 3 until my review',
      reply: 'Understood — I will hold that for your go-ahead.',
    });
    expect(f.harness.proposals.snapshotDraft()?.utterances.map((u) => u.text).join(' ')).toContain('phase 3');
    expect(f.events.some((e) => e.kind === EVENT.HARNESS_DRAFT_APPEND)).toBe(true);
    expect(f.recordedDelivery.deliveredTexts()).toEqual([]);

    await speak(f, utterancePcmFor('yes go ahead'), { transcript: 'yes go ahead', reply: null });
    // THE single send path: the released bytes are the draft's, never the confirmation's.
    expect(f.recordedDelivery.deliveredTexts()).toEqual(['hold phase 3 until my review']);
    const release = f.events.find((e) => e.kind === EVENT.HARNESS_RELEASE);
    expect(release?.payload).toMatchObject({ text: 'hold phase 3 until my review', outcome: 'delivered', mechanism: 'prompt', ack: 'sending that now' });
    // The trusted ack was spoken mechanically at receipt tier.
    expect(f.voice.spoken).toContain('sending that now');
    expect(f.harness.turnRecords).toHaveLength(2);

    await f.harness.stop('test-end');
  });

  it('a spoken confirmation with nothing held is the mechanical dead end — never a send', async () => {
    const f = makeFixture({ shadowUtterances: ['yes go ahead'] });
    await f.harness.start();
    await speak(f, utterancePcmFor('yes go ahead'), { transcript: 'yes go ahead', reply: null });
    expect(f.recordedDelivery.deliveredTexts()).toEqual([]);
    const mech = f.events.filter((e) => e.kind === EVENT.HARNESS_MECHANICAL);
    expect(mech.some((e) => String(e.payload.reply).startsWith('Nothing is held right now'))).toBe(true);
    expect(f.voice.spoken.some((t) => t.startsWith('Nothing is held right now'))).toBe(true);
    await f.harness.stop('test-end');
  });

  it('native condition: the Gemini transcript decides and the shadow ASR is a fidelity reference only', async () => {
    const f = makeFixture({
      condition: 'native',
      shadowUtterances: ['hold phase 3 until my review (whisper rendering)'],
    });
    await f.harness.start();
    await speak(f, utterancePcmFor('hold phase 3 until my review'), {
      transcript: 'hold phase 3 until my review',
      reply: 'Holding that.',
    });
    const turn = f.harness.turnRecords[0];
    expect(turn.transcript).toBe('hold phase 3 until my review');
    expect(turn.shadowTranscript).toContain('whisper rendering');
    expect(turn.condition).toBe('native');
    expect(f.shadow.calls).toBe(1);
    await f.harness.stop('test-end');
  });

  it('sidecar condition: the Whisper transcript decides and the Gemini transcript is the shadow', async () => {
    const f = makeFixture({
      condition: 'sidecar',
      shadowUtterances: ['hold phase 3 until my review'],
    });
    await f.harness.start();
    // The native transcript renders the review word differently; the sidecar
    // transcript is what the gate must decide on.
    await speak(f, utterancePcmFor('hold phase 3 until my view'), {
      transcript: 'hold phase 3 until my view',
      reply: 'Holding that.',
    });
    const turn = f.harness.turnRecords[0];
    expect(turn.transcript).toBe('hold phase 3 until my review');
    expect(turn.shadowTranscript).toBe('hold phase 3 until my view');
    expect(turn.condition).toBe('sidecar');
    expect(f.harness.proposals.snapshotDraft()?.utterances[0]?.text).toContain('review');
    await f.harness.stop('test-end');
  });

  it('mark_addressed_to_talker suppresses the draft candidate (suppression only, never creation)', async () => {
    const f = makeFixture({ shadowUtterances: ['catch me up — read me the full version of what the worker has done'] });
    await f.harness.start();
    await speak(f, utterancePcmFor('catch me up — read me the full version of what the worker has done'), {
      transcript: 'catch me up — read me the full version of what the worker has done',
      reply: 'Here is where we stand: the suite is green.',
      toolCall: 'mark_addressed_to_talker',
    });
    expect(f.harness.proposals.snapshotDraft()).toBeNull();
    expect(f.events.some((e) => e.kind === EVENT.HARNESS_DRAFT_APPEND)).toBe(false);
    await f.harness.stop('test-end');
  });

  it('offer_ask_worker holds the operator\'s OWN question as a candidate that still needs confirmation', async () => {
    const f = makeFixture({ shadowUtterances: ['is the queue implementation solid?'] });
    await f.harness.start();
    await speak(f, utterancePcmFor('is the queue implementation solid?'), {
      transcript: 'is the queue implementation solid?',
      reply: 'I have not reviewed that code myself. Want me to ask the worker?',
      toolCall: 'offer_ask_worker',
    });
    const draft = f.harness.proposals.snapshotDraft();
    expect(draft?.utterances.map((u) => u.text)).toEqual(['is the queue implementation solid?']);
    // A composition batch opened, so the receipt is due (one per relay).
    expect(f.events.some((e) => e.kind === EVENT.HARNESS_RECEIPT)).toBe(true);
    expect(f.recordedDelivery.deliveredTexts()).toEqual([]);
    await f.harness.stop('test-end');
  });

  it('a cancel clears the held draft and a draftable residue composes fresh', async () => {
    const f = makeFixture({
      shadowUtterances: ['hold phase 3 until my review', 'forget it — tell the worker to use the dry run instead'],
    });
    await f.harness.start();
    await speak(f, utterancePcmFor('hold phase 3 until my review'), {
      transcript: 'hold phase 3 until my review',
      reply: 'Holding that.',
    });
    expect(f.harness.proposals.snapshotDraft()).not.toBeNull();
    await speak(f, utterancePcmFor('forget it — tell the worker to use the dry run instead'), {
      transcript: 'forget it — tell the worker to use the dry run instead',
      reply: 'Scrapped. Holding the new version.',
    });
    const draft = f.harness.proposals.snapshotDraft();
    expect(draft?.utterances.map((u) => u.text).join(' ')).toContain('dry run');
    expect(draft?.utterances.map((u) => u.text).join(' ')).not.toContain('phase 3');
    expect(f.events.some((e) => e.kind === EVENT.HARNESS_MECHANICAL && e.payload.kind === 'cancel')).toBe(true);
    await f.harness.stop('test-end');
  });

  it('duck profile: the operator floor drops the gain while speech is active', async () => {
    const f = makeFixture({ shadowUtterances: ['how is it going'] });
    await f.harness.start();
    expect(f.player.stats().currentGain).toBe(1);
    f.harness.activityStart(f.clock.nowMs());
    expect(f.player.operatorHoldsFloor).toBe(true);
    expect(f.player.stats().currentGain).toBe(0.15);
    f.harness.activityEnd(f.clock.nowMs());
    f.factory.session.emitExchange('how is it going', 'All quiet — suite green.');
    await f.harness.settle();
    expect(f.player.operatorHoldsFloor).toBe(false);
    expect(f.player.stats().currentGain).toBe(1);
    const gains = f.events.filter((e) => e.kind === EVENT.PLAYBACK_GAIN);
    expect(gains.length).toBeGreaterThanOrEqual(2);
    await f.harness.stop('test-end');
  });

  it('mechanical gate: native audio queued before the decision is discarded and the accounting stays balanced', async () => {
    // The scripted mock SPEAKS even on a confirm-shaped turn (a real model
    // would); the guarded harness discards what it queued once the gate
    // decides the turn is mechanical.
    const f = makeFixture({ shadowUtterances: ['yes go ahead'] });
    await f.harness.start();
    await speak(f, utterancePcmFor('yes go ahead'), {
      transcript: 'yes go ahead',
      reply: 'Right away!',
    });
    expect(f.player.accountingBalanced()).toBe(true);
    // The model's words must not be what the operator heard for a gated turn.
    const mech = f.events.filter((e) => e.kind === EVENT.HARNESS_MECHANICAL);
    expect(mech.length).toBeGreaterThanOrEqual(1);
    await f.harness.stop('test-end');
  });

  it('N lane: commits from the silence window without an activityEnd marker', async () => {
    const f = makeFixture({ lane: 'N', shadowUtterances: ['how is it going'] });
    await f.harness.start();
    // No activity markers: frames + transcription deltas only.
    f.harness.pushAudio(utterancePcmFor('how is it going'), { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 0);
    f.factory.session.emitExchange('how is it going', 'All quiet.');
    // The provider's speech flag rises on the first delta…
    await f.harness.settle();
    expect(f.harness.turnRecords).toHaveLength(1);
    expect(f.harness.turnRecords[0].boundary).toBe('vad-silence');
    await f.harness.stop('test-end');
  });

  it('state view is sent at start and after harness transitions', async () => {
    const f = makeFixture({ shadowUtterances: ['hold phase 3 until my review'], stateViewCoalesceMs: 0 });
    await f.harness.start();
    // Initial view at run start.
    expect(f.factory.session.clientContents.length).toBeGreaterThanOrEqual(1);
    await speak(f, utterancePcmFor('hold phase 3 until my review'), {
      transcript: 'hold phase 3 until my review',
      reply: 'Holding that.',
    });
    // A draft transition schedules a fresh view (coalescing window is 0 here).
    const views = f.factory.session.clientContents.length;
    expect(views).toBeGreaterThanOrEqual(2);
    await f.harness.stop('test-end');
  });

  it('a conversational turn whose model never completes is a failed leg, honestly recorded', async () => {
    const f = makeFixture({ shadowUtterances: ['how is it going'], turnTimeoutMs: 30 });
    await f.harness.start();
    f.harness.pushAudio(utterancePcmFor('how is it going'), { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 0);
    f.harness.activityEnd(f.clock.nowMs());
    // Deltas arrive; the mock NEVER emits turnComplete.
    f.factory.session.deliver({ serverContent: { inputTranscription: { text: 'how is it going' } } });
    await f.harness.settle();
    expect(f.harness.turnRecords).toHaveLength(1);
    expect(f.harness.turnRecords[0].failedLeg).toBe('model');
    expect(f.harness.turnRecords[0].reply).toContain("couldn't reach");
    await f.harness.stop('test-end');
  });

  it('flush commits a turn whose stability window the attempt ends inside', async () => {
    const f = makeFixture({ shadowUtterances: ['hold phase 3'] });
    await f.harness.start();
    f.harness.pushAudio(utterancePcmFor('hold phase 3'), { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 0);
    f.factory.session.deliver({ serverContent: { inputTranscription: { text: 'hold phase 3' } } });
    f.factory.session.deliver({ serverContent: { outputTranscription: { text: 'Held.' } } });
    f.factory.session.deliver({ serverContent: { turnComplete: true } });
    // No settle long enough for stability; flush closes the attempt.
    await f.harness.flush();
    expect(f.harness.turnRecords).toHaveLength(1);
    expect(f.harness.turnRecords[0].boundary).toBe('flush');
    await f.harness.stop('test-end');
  });

  it('ttfa is measured from speech end to the first audio handed to the player', async () => {
    const f = makeFixture({ shadowUtterances: ['how is it going'] });
    await f.harness.start();
    await speak(f, utterancePcmFor('how is it going'), {
      transcript: 'how is it going',
      reply: 'All quiet.',
    });
    const turn = f.harness.turnRecords[0];
    expect(turn.speechEndAtMs).toBeGreaterThan(0);
    expect(turn.firstAudioAtMs).toBeGreaterThan(0);
    expect(turn.ttfaMs).toBeGreaterThan(0);
    expect(turn.ttfaMs).toBe(turn.firstAudioAtMs - turn.speechEndAtMs);
    await f.harness.stop('test-end');
  });
});

describe('buildTier1SystemInstruction (§16.2 wiring)', () => {
  it('drops the text-marker lines and adds the function-call contract and the never-send rule', () => {
    const base = [
      'You are the operator\'s talker.',
      'Answer from the snapshot and end the reply with the tag [[to-talker]] when addressed to you.',
      'Offer [[ask-worker]] when you cannot answer.',
      'The harness — not you — delivers messages.',
    ].join('\n');
    const instruction = buildTier1SystemInstruction(base);
    expect(instruction).not.toContain('[[to-talker]]');
    expect(instruction).not.toContain('[[ask-worker]]');
    expect(instruction).toContain('mark_addressed_to_talker');
    expect(instruction).toContain('offer_ask_worker');
    expect(instruction).toContain('You never send; the host sends');
    expect(instruction).toContain('The harness — not you — delivers messages.');
  });
});

// ── 3. Hermetic dry-run end-to-end ───────────────────────────────────────────

describe.skipIf(!benchExists)('tier-1 dry run across shipped scenarios', () => {
  it('t1-s1 (native, E): verifies clean with two gated releases and dry-run labelling', async () => {
    const scenarioPath = path.join(BENCH_SCENARIOS, 't1-s1-orchestration-voice.json');
    const outcome = await runTier1DryAttempt(scenarioPath, {
      runsRoot: root,
      runId: 'tier1-dryrun-s1-native',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      quiet: true,
    });
    expect(outcome.verifyProblems).toEqual([]);
    expect(outcome.verifyOk).toBe(true);

    const spokenBeats = outcome.scenario.beats.filter((b) => {
      const utterance = b.mode === 'frozen' ? b.utterance : b.branches?.[0]?.utterance;
      return Boolean(utterance);
    });
    expect(outcome.turns).toBe(spokenBeats.length);
    expect(outcome.releases).toBe(2);

    const events = parseEventLog(readFileSync(path.join(outcome.attempt.attemptDir, 'application', 'events.jsonl'), 'utf8')).events;
    for (const kind of [EVENT.PROVIDER_CONTENT, EVENT.PROVIDER_USAGE, EVENT.TURN_COMPLETE, EVENT.INPUT_FRAME]) {
      expect(events.some((e) => e.kind === kind)).toBe(true);
    }
    for (const turn of events.filter((e) => e.kind === EVENT.TURN_COMPLETE)) {
      expect(turn.payload.failedLeg).toBeNull();
      expect(Number(turn.payload.ttfaMs)).toBeGreaterThan(0);
      expect(String(turn.payload.transcript).length).toBeGreaterThan(0);
      expect(turn.payload.condition).toBe('native');
    }

    const manifest = JSON.parse(readFileSync(path.join(outcome.attempt.attemptDir, 'manifest.json'), 'utf8'));
    expect(manifest.usage).toMatchObject({
      mode: 'dry-run',
      provider: 'gemini-live-dryrun',
      realProviderCalls: 0,
      transcriptCondition: 'native',
    });
    expect(manifest.condition).toContain('gemini-live-dryrun');
  });

  it('t1-s1 (sidecar, E): the deciding transcript is the shadow ASR text', async () => {
    const scenarioPath = path.join(BENCH_SCENARIOS, 't1-s1-orchestration-voice.json');
    const outcome = await runTier1DryAttempt(scenarioPath, {
      runsRoot: root,
      runId: 'tier1-dryrun-s1-sidecar',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      condition: 'sidecar',
      quiet: true,
    });
    expect(outcome.verifyOk).toBe(true);
    expect(outcome.releases).toBe(2);
    const events = parseEventLog(readFileSync(path.join(outcome.attempt.attemptDir, 'application', 'events.jsonl'), 'utf8')).events;
    for (const turn of events.filter((e) => e.kind === EVENT.TURN_COMPLETE)) {
      expect(turn.payload.condition).toBe('sidecar');
      expect(String(turn.payload.shadowTranscript).length).toBeGreaterThan(0);
    }
  });

  it('every remaining shipped scenario verifies with the expected release count', async () => {
    const cases = [
      { file: 't1-s2-clarification.json', releases: 2 },
      { file: 't1-s3-plain-worker.json', releases: 1 },
      { file: 't1-s4-permission-gate.json', releases: 2 },
      { file: 't1-s5-sparse-state.json', releases: 1 },
      { file: 't1-s6-worker-permission.json', releases: 2 },
      { file: 't1-s7-reading-levels.json', releases: 0 },
    ];
    for (const { file, releases } of cases) {
      const outcome = await runTier1DryAttempt(path.join(BENCH_SCENARIOS, file), {
        runsRoot: root,
        runId: `tier1-dryrun-${file}`,
        attemptId: 'attempt-01',
        frameIntervalMs: 1,
        stabilityMs: 25,
        quiet: true,
      });
      expect(outcome.verifyProblems, file).toEqual([]);
      expect(outcome.releases, file).toBe(releases);
      // Turn-complete count equals the spoken beats: no drift between beats
      // and scored windows.
      const turns = parseEventLog(readFileSync(path.join(outcome.attempt.attemptDir, 'application', 'events.jsonl'), 'utf8')).events.filter((e) => e.kind === EVENT.TURN_COMPLETE);
      expect(turns.length, file).toBe(outcome.turns);
    }
  }, 120000);

  it('N lane: an inline scenario runs hermetically and verifies', async () => {
    const scenarioPath = path.join(root, 'scenarios', 'inline-n.json');
    mkdirSync(path.dirname(scenarioPath), { recursive: true });
    writeFileSync(
      path.dirname(scenarioPath) + '/inline-n.json',
      JSON.stringify({
        schema: 'voice-lab.scenario/1',
        id: 't1-inline-n',
        tier: 1,
        world: null,
        language: 'en-GB',
        voice: { engine: 'supertonic-3', voice: 'M1' },
        endpointing: 'N',
        budgets: { maxRunMs: 480000, maxOperatorTurns: 24, maxCandidateSpeechMs: 240000, maxSpendUsd: 0.5 },
        beats: [
          { id: 'b1-hold', mode: 'frozen', utterance: 'hold phase 3 until my review', trigger: { at: 'run-start' }, permissions: [], expect: { relay: false, draftCreated: true, requiredWords: ['phase 3'] } },
          { id: 'b2-confirm', mode: 'frozen', utterance: 'yes, go ahead.', trigger: { after: 'candidate-silence', silenceMs: 600 }, permissions: ['confirm:current-draft'], expect: { relay: true, releasedContains: ['phase 3'], ackIsTrusted: true } },
        ],
      }),
      'utf8'
    );
    const outcome = await runTier1DryAttempt(scenarioPath, {
      runsRoot: root,
      runId: 'tier1-dryrun-inline-n',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      quiet: true,
    });
    expect(outcome.verifyProblems).toEqual([]);
    expect(outcome.releases).toBe(1);
    for (const turn of outcome.harnessTurns) {
      expect(turn.boundary).toBe('vad-silence');
    }
  });
});

// ── 4. The CLI surface ──────────────────────────────────────────────────────

describe('tier1 CLI commands', () => {
  it('parses tier1-dryrun options, including the condition selector', () => {
    const parsed = parseArgs([
      'tier1-dryrun',
      '--scenario',
      '/tmp/s.json',
      '--condition',
      'sidecar',
      '--stability-ms',
      '25',
      '--attempts',
      '2',
    ]);
    expect(parsed.command).toBe('tier1-dryrun');
    expect(parsed.scenarioPath).toBe('/tmp/s.json');
    expect(parsed.condition).toBe('sidecar');
    expect(parsed.stabilityMs).toBe(25);
    expect(parsed.attempts).toBe(2);
  });

  it('parses tier1-run options and passes the model and whisper endpoint', () => {
    const parsed = parseArgs(['tier1-run', '--scenario', '/tmp/s.json', '--model', 'gemini-3.8-live-extended-thinking', '--whisper-endpoint', 'http://127.0.0.1:9000']);
    expect(parsed.command).toBe('tier1-run');
    expect(parsed.model).toBe('gemini-3.8-live-extended-thinking');
    expect(parsed.whisperEndpoint).toBe('http://127.0.0.1:9000');
  });

  it('tier1-run refuses without an API key — never an unlabelled attempt', async () => {
    const err: string[] = [];
    const code = await cliMain(['tier1-run', '--scenario', '/tmp/whatever.json'], {
      writeOut: () => {},
      writeErr: (line: string) => err.push(line),
      apiKey: () => undefined,
    } satisfies CliDependencies);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('GEMINI_API_KEY');
  });

  it('tier1-dryrun via the CLI verifies the attempt and exits 0', async () => {
    if (!benchExists) return;
    const out: string[] = [];
    const code = await cliMain(
      [
        'tier1-dryrun',
        '--scenario',
        path.join(BENCH_SCENARIOS, 't1-s3-plain-worker.json'),
        '--runs-root',
        root,
        '--frame-interval-ms',
        '1',
        '--stability-ms',
        '20',
      ],
      { writeOut: (line: string) => out.push(line), writeErr: () => {} } satisfies CliDependencies
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('verify=ok');
    expect(out.join('\n')).toContain('releases=1');
  }, 60000);
});
