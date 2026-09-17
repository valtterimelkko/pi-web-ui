/**
 * Gemini Live provider adapter (L4, plan §16.2) — contract tests.
 *
 * The adapter is the narrow, fully-injectable seam between the lab and
 * @google/genai 1.52.0 `ai.live.connect`. Every test here runs 100 % offline:
 * a mock session factory captures the connect request and hands back a
 * scripted session whose `onmessage` the test drives by hand. Nothing here
 * needs an API key, a socket or a model.
 *
 * What is pinned:
 *   - the tier-1 connect config (modalities, both transcriptions, session
 *     resumption, E/N activity detection, the two declared functions with
 *     NON_BLOCKING behaviour);
 *   - audio in  → sendRealtimeInput base64 chunks (plus E-lane markers);
 *   - events out → provider_content / provider_usage / lifecycle on the log,
 *     with the exact callback surface the tier-1 harness consumes;
 *   - tool-call handling (mark_addressed_to_talker / offer_ask_worker) with
 *     the SILENT-scheduled acknowledgement;
 *   - state-view context updates: coalesced ≥ 2 s apart, never mid-speech.
 */
import { describe, expect, it } from 'vitest';

import { EVENT, type EventLog, type LabEvent, type MonotonicClock } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import {
  TIER1_FUNCTION_DECLARATIONS,
  TIER1_TOOL_NAMES,
  buildTier1ConnectConfig,
  createGenaiLiveSessionFactory,
  GeminiLiveProvider,
  type LiveServerMessageShape,
  type LiveSessionFactory,
  type LiveSessionLike,
} from '../../../scripts/voice-live-lab/lib/providers/gemini-live.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

class MockLiveSession implements LiveSessionLike {
  realtimeInputs: Array<Record<string, unknown>> = [];
  clientContents: Array<Record<string, unknown>> = [];
  toolResponses: Array<Record<string, unknown>> = [];
  closed = false;
  closeReason = '';
  onMessage: ((msg: LiveServerMessageShape) => void) | null = null;
  onOpen: (() => void) | null = null;

  sendRealtimeInput(input: Record<string, unknown>): void {
    this.realtimeInputs.push(input);
  }

  sendClientContent(content: Record<string, unknown>): void {
    this.clientContents.push(content);
  }

  sendToolResponse(response: Record<string, unknown>): void {
    this.toolResponses.push(response);
  }

  close(reason = 'test'): void {
    this.closed = true;
    this.closeReason = reason;
  }

  /** Drive a server message through the adapter's callback by hand. */
  deliver(msg: LiveServerMessageShape): void {
    this.onMessage?.(msg);
  }
}

interface ScheduledTask {
  fn: () => void;
  delayMs: number;
}

/** Captures connect requests; hands out mock sessions wired to `deliver`. */
function mockFactory() {
  const requests: Array<{ model: string; config: Record<string, unknown> }> = [];
  const sessions: MockLiveSession[] = [];
  const factory: LiveSessionFactory = async (request) => {
    requests.push({ model: request.model, config: request.config as Record<string, unknown> });
    const session = new MockLiveSession();
    session.onMessage = request.callbacks.onMessage;
    session.onOpen = request.callbacks.onOpen;
    sessions.push(session);
    // The real socket fires onopen once the connection is up.
    request.callbacks.onOpen();
    return session;
  };
  return { factory, requests, sessions };
}

function manualClock(): MonotonicClock & { now: number; advance(ms: number): void } {
  const state = { now: 0 };
  return {
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
    advance(ms: number) {
      state.now += ms;
    },
    nowMs() {
      return state.now;
    },
    originIso() {
      return '2026-09-17T00:00:00Z';
    },
  };
}

/** Immediate, collected scheduler: tests fire tasks after advancing the clock. */
function manualScheduler() {
  const tasks: ScheduledTask[] = [];
  return {
    tasks,
    schedule(fn: () => void, delayMs: number): () => void {
      tasks.push({ fn, delayMs });
      return () => {};
    },
    fireAll(): void {
      while (tasks.length > 0) tasks.shift()!.fn();
    },
    fireNext(): void {
      const task = tasks.shift();
      if (task) task.fn();
    },
  };
}

interface Harness {
  provider: GeminiLiveProvider;
  events: LabEvent[];
  log: EventLog;
  session: MockLiveSession;
  requests: Array<{ model: string; config: Record<string, unknown> }>;
  scheduler: ReturnType<typeof manualScheduler>;
  clock: ReturnType<typeof manualClock>;
  audio: Buffer[];
  transcriptions: string[];
  outputs: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown>; id: string }>;
  turnCompletes: number[];
  interruptions: number[];
}

async function makeProvider(overrides: {
  lane?: 'E' | 'N';
  model?: string;
  coalesceMs?: number;
} = {}): Promise<Harness> {
  const clock = manualClock();
  const events: LabEvent[] = [];
  const log: EventLog = {
    append(input) {
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
  const { factory, requests, sessions } = mockFactory();
  const scheduler = manualScheduler();
  const captured: Pick<Harness, 'audio' | 'transcriptions' | 'outputs' | 'toolCalls' | 'turnCompletes' | 'interruptions'> = {
    audio: [],
    transcriptions: [],
    outputs: [],
    toolCalls: [],
    turnCompletes: [],
    interruptions: [],
  };
  const provider = new GeminiLiveProvider({
    log,
    clock,
    lane: overrides.lane ?? 'E',
    model: overrides.model ?? 'gemini-3.8-live',
    systemInstruction: 'test instruction',
    sessionFactory: factory,
    scheduler: scheduler.schedule,
    stateViewCoalesceMs: overrides.coalesceMs ?? 2000,
    onAudioPcm: (pcm) => captured.audio.push(pcm),
    onInputTranscriptionDelta: (text) => captured.transcriptions.push(text),
    onOutputTranscriptionDelta: (text) => captured.outputs.push(text),
    onToolCall: (call) => captured.toolCalls.push(call),
    onTurnComplete: (atMs) => {
      captured.turnCompletes.push(atMs);
    },
    onInterrupted: (atMs) => {
      captured.interruptions.push(atMs);
    },
  });
  await provider.connect();
  const session = sessions[0];
  expect(session).toBeDefined();
  return {
    provider,
    events,
    log,
    session,
    requests,
    scheduler,
    clock,
    ...captured,
  };
}

function pcmSine(frames: number): Buffer {
  const buf = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) buf.writeInt16LE(Math.round(5000 * Math.sin(i / 8)), i * 2);
  return buf;
}

// ── The connect config ───────────────────────────────────────────────────────

describe('tier-1 connect config', () => {
  it('declares exactly the two tier-1 functions with NON_BLOCKING behaviour', () => {
    expect([...TIER1_TOOL_NAMES]).toEqual(['mark_addressed_to_talker', 'offer_ask_worker']);
    expect(TIER1_FUNCTION_DECLARATIONS).toHaveLength(2);
    for (const declaration of TIER1_FUNCTION_DECLARATIONS) {
      expect(declaration.behavior).toBe('NON_BLOCKING');
      expect(typeof declaration.description).toBe('string');
      expect(declaration.name).toBeTruthy();
    }
  });

  it('configures audio modalities, both transcriptions and session resumption', () => {
    const config = buildTier1ConnectConfig({ lane: 'E', systemInstruction: 'sys' });
    expect(config.responseModalities).toEqual(['AUDIO']);
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.sessionResumption).toEqual({});
    const declarations = config.tools?.[0]?.functionDeclarations ?? [];
    expect(declarations).toHaveLength(2);
    expect(config.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
  });

  it('E lane disables automatic activity detection; N lane leaves it natural', () => {
    const e = buildTier1ConnectConfig({ lane: 'E', systemInstruction: 's' });
    expect(e.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    const n = buildTier1ConnectConfig({ lane: 'N', systemInstruction: 's' });
    expect(n.realtimeInputConfig).toEqual({ automaticActivityDetection: {} });
  });
});

// ── Connection and audio in ──────────────────────────────────────────────────

describe('GeminiLiveProvider connection and audio streaming', () => {
  it('connects with the tier-1 config and the requested model', async () => {
    const h = await makeProvider({ model: 'gemini-3.8-live-extended-thinking' });
    expect(h.requests[0].model).toBe('gemini-3.8-live-extended-thinking');
    expect(h.requests[0].config.responseModalities).toEqual(['AUDIO']);
    expect(h.requests[0].config.sessionResumption).toEqual({});
    const lifecycle = h.events.filter((e) => e.kind === EVENT.LIFECYCLE);
    expect(lifecycle.some((e) => e.payload.event === 'connected')).toBe(true);
  });

  it('streams pushed PCM as base64 16 kHz realtime audio chunks', async () => {
    const h = await makeProvider();
    const frame = pcmSine(320); // 20 ms at 16 kHz
    h.provider.pushAudio(frame, { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 0);
    h.provider.pushAudio(frame, { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 1);
    expect(h.session.realtimeInputs).toHaveLength(2);
    for (const input of h.session.realtimeInputs) {
      const audio = input.audio as { mimeType: string; data: string };
      expect(audio.mimeType).toBe('audio/pcm;rate=16000');
      expect(Buffer.from(audio.data, 'base64').equals(frame)).toBe(true);
    }
  });

  it('sends activity markers in the E lane only', async () => {
    const e = await makeProvider({ lane: 'E' });
    e.provider.activityStart(0);
    e.provider.activityEnd(400);
    const markers = e.session.realtimeInputs.filter((i) => i.activityStart !== undefined || i.activityEnd !== undefined);
    expect(markers).toHaveLength(2);
    expect(markers[0].activityStart).toEqual({});
    expect(markers[1].activityEnd).toEqual({});

    const n = await makeProvider({ lane: 'N' });
    n.provider.activityStart(0);
    n.provider.activityEnd(400);
    const nMarkers = n.session.realtimeInputs.filter((i) => i.activityStart !== undefined || i.activityEnd !== undefined);
    expect(nMarkers).toHaveLength(0);
  });

  it('counts pushed audio bytes for usage accounting', async () => {
    const h = await makeProvider();
    const frame = pcmSine(320);
    h.provider.pushAudio(frame, { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 0);
    h.provider.pushAudio(frame, { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 1);
    expect(h.provider.pushedBytes).toBe(frame.byteLength * 2);
    expect(h.provider.pushedMs).toBeCloseTo(40, 5);
  });
});

// ── Events out ───────────────────────────────────────────────────────────────

describe('GeminiLiveProvider server-message handling', () => {
  it('emits provider_content and callbacks for input transcription deltas', async () => {
    const h = await makeProvider();
    h.session.deliver({ serverContent: { inputTranscription: { text: 'hold phase' } } });
    h.session.deliver({ serverContent: { inputTranscription: { text: ' three' } } });
    expect(h.transcriptions).toEqual(['hold phase', ' three']);
    const contents = h.events.filter((e) => e.kind === EVENT.PROVIDER_CONTENT);
    expect(contents).toHaveLength(2);
    expect(contents[0].payload.inputTranscription).toBe('hold phase');
  });

  it('decodes audio parts to PCM and reports byte accounting', async () => {
    const h = await makeProvider();
    const pcm = pcmSine(240); // 24 kHz output-rate samples
    h.session.deliver({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] },
      },
    });
    expect(h.audio).toHaveLength(1);
    expect(h.audio[0].equals(pcm)).toBe(true);
    const contents = h.events.filter((e) => e.kind === EVENT.PROVIDER_CONTENT);
    expect(contents[0].payload.parts).toEqual([{ mimeType: 'audio/pcm;rate=24000', audioBytes: pcm.byteLength }]);
  });

  it('emits output transcription deltas', async () => {
    const h = await makeProvider();
    h.session.deliver({ serverContent: { outputTranscription: { text: 'Holding that' } } });
    expect(h.outputs).toEqual(['Holding that']);
  });

  it('signals turn completion and interruption through the callbacks', async () => {
    const h = await makeProvider();
    h.session.deliver({ serverContent: { turnComplete: true } });
    expect(h.turnCompletes).toHaveLength(1);
    h.session.deliver({ serverContent: { interrupted: true } });
    expect(h.interruptions).toHaveLength(1);
    const content = h.events.filter((e) => e.kind === EVENT.PROVIDER_CONTENT).at(-1);
    expect(content?.payload.interrupted).toBe(true);
  });

  it('emits provider_usage with usageMetadata fields including thoughtsTokenCount', async () => {
    const h = await makeProvider();
    h.session.deliver({
      usageMetadata: { promptTokenCount: 120, responseTokenCount: 30, totalTokenCount: 150, thoughtsTokenCount: 11 },
    });
    const usage = h.events.filter((e) => e.kind === EVENT.PROVIDER_USAGE);
    expect(usage).toHaveLength(1);
    expect(usage[0].payload).toMatchObject({
      promptTokenCount: 120,
      responseTokenCount: 30,
      totalTokenCount: 150,
      thoughtsTokenCount: 11,
    });
  });

  it('surfaces tier-1 tool calls and acknowledges them with SILENT scheduling', async () => {
    const h = await makeProvider();
    h.session.deliver({
      toolCall: { functionCalls: [{ name: 'mark_addressed_to_talker', args: {}, id: 'call-1' }] },
    });
    expect(h.toolCalls).toEqual([{ name: 'mark_addressed_to_talker', args: {}, id: 'call-1' }]);
    const contents = h.events.filter((e) => e.kind === EVENT.PROVIDER_CONTENT);
    expect(contents.at(-1)?.payload.toolCall).toMatchObject({ name: 'mark_addressed_to_talker', id: 'call-1' });
    // The acknowledgement must not trigger a new model turn (SILENT).
    expect(h.session.toolResponses).toHaveLength(1);
    const responses = h.session.toolResponses[0].functionResponses as Array<Record<string, unknown>>;
    expect(responses[0]).toMatchObject({ id: 'call-1', name: 'mark_addressed_to_talker', scheduling: 'SILENT' });
  });

  it('records lifecycle facts: setupComplete, resumption handle and goAway', async () => {
    const h = await makeProvider();
    h.session.deliver({ setupComplete: true });
    h.session.deliver({ sessionResumptionUpdate: { newHandle: 'handle-abc', resumable: true } });
    h.session.deliver({ goAway: { timeLeft: '30s' } });
    const lifecycle = h.events.filter((e) => e.kind === EVENT.LIFECYCLE);
    expect(lifecycle.map((e) => e.payload.event)).toEqual(['connected', 'setupComplete', 'sessionResumptionUpdate', 'goAway']);
    expect(h.provider.resumptionHandle).toBe('handle-abc');
    expect(h.provider.goAwayReceived).toBe(true);
  });

  it('ignores messages after close without throwing', async () => {
    const h = await makeProvider();
    h.provider.close('attempt-end');
    expect(h.session.closed).toBe(true);
    expect(() => h.session.deliver({ serverContent: { turnComplete: true } })).not.toThrow();
    expect(h.turnCompletes).toHaveLength(0);
  });
});

// ── State-view context updates ───────────────────────────────────────────────

describe('state-view context updates (§16.2 coalescing)', () => {
  it('sends the first update immediately as a turnComplete:false client content', async () => {
    const h = await makeProvider();
    h.provider.updateStateView('STATE VIEW v1');
    expect(h.session.clientContents).toHaveLength(1);
    const content = h.session.clientContents[0];
    expect(content.turnComplete).toBe(false);
    const turns = content.turns as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(turns[0].role).toBe('user');
    expect(turns[0].parts[0].text).toBe('STATE VIEW v1');
  });

  it('coalesces updates closer than the window: the latest text wins', async () => {
    const h = await makeProvider({ coalesceMs: 2000 });
    h.provider.updateStateView('STATE VIEW v1');
    h.clock.advance(500);
    h.provider.updateStateView('STATE VIEW v2');
    h.clock.advance(300);
    h.provider.updateStateView('STATE VIEW v3');
    // Only the first went out; one task is pending for the coalesced window.
    expect(h.session.clientContents).toHaveLength(1);
    expect(h.scheduler.tasks).toHaveLength(1);
    h.clock.advance(1500);
    h.scheduler.fireAll();
    expect(h.session.clientContents).toHaveLength(2);
    const turns = h.session.clientContents[1].turns as Array<{ parts: Array<{ text: string }> }>;
    expect(turns[0].parts[0].text).toBe('STATE VIEW v3');
  });

  it('sends updates ≥ the window apart immediately, without coalescing', async () => {
    const h = await makeProvider({ coalesceMs: 2000 });
    h.provider.updateStateView('v1');
    h.clock.advance(2000);
    h.provider.updateStateView('v2');
    expect(h.session.clientContents).toHaveLength(2);
    expect(h.scheduler.tasks).toHaveLength(0);
  });

  it('never sends mid-speech: a request during operator speech is deferred to the release', async () => {
    const h = await makeProvider({ coalesceMs: 2000 });
    h.provider.setSpeechActive(true);
    h.provider.updateStateView('deferred view');
    expect(h.session.clientContents).toHaveLength(0);
    h.provider.setSpeechActive(false);
    // Floor release flushes a pending update even inside the coalesce window.
    expect(h.session.clientContents).toHaveLength(1);
    const turns = h.session.clientContents[0].turns as Array<{ parts: Array<{ text: string }> }>;
    expect(turns[0].parts[0].text).toBe('deferred view');
  });

  it('sends an urgent context note immediately when speech is not active', async () => {
    const h = await makeProvider();
    h.provider.sendContextUpdate('Mechanical: "Noted — still holding that."');
    expect(h.session.clientContents).toHaveLength(1);
    const turns = h.session.clientContents[0].turns as Array<{ parts: Array<{ text: string }> }>;
    expect(turns[0].parts[0].text).toContain('Noted');
  });

  it('holds an urgent note while speech is active and flushes it on release', async () => {
    const h = await makeProvider();
    h.provider.setSpeechActive(true);
    h.provider.sendContextUpdate('held note');
    expect(h.session.clientContents).toHaveLength(0);
    h.provider.setSpeechActive(false);
    expect(h.session.clientContents).toHaveLength(1);
  });
});

// ── The real factory seam ────────────────────────────────────────────────────

describe('createGenaiLiveSessionFactory', () => {
  it('refuses to build a factory without an API key', () => {
    expect(() => createGenaiLiveSessionFactory('')).toThrow(/GEMINI_API_KEY/i);
  });

  it('returns a factory that maps the structural shapes onto ai.live.connect', async () => {
    const factory = createGenaiLiveSessionFactory('test-key-not-used-offline');
    expect(typeof factory).toBe('function');
  });
});
