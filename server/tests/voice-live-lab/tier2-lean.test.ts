/**
 * Tier 2 lean harness (L7; intent §6.2, §18, §18.1, §20.5b–d; plan §23 L7 row)
 * — contract tests, all offline.
 *
 * Four layers are pinned here:
 *
 *   1. The tool surface — exactly ONE declared function (`send_to_worker`),
 *      `NON_BLOCKING`, answered `WHEN_IDLE`, arguments validated.
 *   2. The system instruction — ≤ 250 words, the six required elements, and a
 *      versioned SHA-256 hash that reaches the attempt manifest.
 *   3. The three send policies — `free` (immediate), `confirm-guided` (held
 *      until a committed operator `confirm` or a 60 s lapse) and `fixed-text`
 *      (delivered bytes are the operator's committed transcript), plus the
 *      event semantics that keep `harness_release` meaning what it meant in
 *      tier 1.
 *   4. Hermetic end-to-end runs — inline and shipped scenarios through the real
 *      commit rule, record and offline verifier, labelled `mode: "dry-run"`,
 *      `realProviderCalls: 0` — plus the §18.1 derivation and Step 4 verdict.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENT, createMonotonicClock, parseEventLog, type EventLog, type LabEvent } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import { ReferencePlayer } from '../../../scripts/voice-live-lab/lib/playback.js';
import {
  Tier2LeanHarness,
  Tier2LiveProvider,
  TIER2_CONFIRMATION_WINDOW_MS,
  TIER2_EVENT,
  TIER2_FUNCTION_DECLARATIONS,
  TIER2_RESPONSE_SCHEDULING,
  TIER2_SYSTEM_INSTRUCTION_WORD_LIMIT,
  TIER2_TOOL_NAME,
  Tier2SendArgsSchema,
  buildTier2ConnectConfig,
  buildTier2SystemInstruction,
  countWords,
  deriveTier2Matrix,
  decideTier2Verdict,
  emptyTier1Findings,
  emptyTier3Findings,
  runTier2DryAttempt,
  runTier2MeasuredAttempt,
  tier2InstructionManifest,
  type Tier2Condition,
} from '../../../scripts/voice-live-lab/lib/harness/tier2-lean.js';
import type { LiveConnectRequest, LiveServerMessageShape, LiveSessionLike } from '../../../scripts/voice-live-lab/lib/providers/gemini-live.js';
import { createNullDelivery } from '../../../server/src/talker/delivery.js';
import { main as cliMain, parseArgs, type CliDependencies } from '../../../scripts/voice-live-lab/cli.js';

const BENCH_ROOT = '/root/agent-benchmarks/benchmarks/04-voice-live-lab';
const BENCH_SCENARIOS = path.join(BENCH_ROOT, 'scenarios', 'tier2');
const benchExists = existsSync(BENCH_SCENARIOS);

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-live-tier2-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── The mock live session ───────────────────────────────────────────────────

class MockTier2Session implements LiveSessionLike {
  readonly realtimeInputs: Record<string, unknown>[] = [];
  readonly clientContent: Array<{ turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }> = [];
  readonly toolResponses: Array<{ functionResponses: Array<Record<string, unknown>> }> = [];
  closed = false;
  private callbacks: { onMessage: (msg: LiveServerMessageShape) => void } | null = null;

  constructor(callbacks: { onOpen: () => void; onMessage: (msg: LiveServerMessageShape) => void }) {
    this.callbacks = callbacks;
    queueMicrotask(() => callbacks.onOpen());
  }

  sendRealtimeInput(input: Record<string, unknown>): void {
    this.realtimeInputs.push(input);
  }

  sendClientContent(content: { turns: Array<{ role: string; parts: Array<{ text: string }> }>; turnComplete: boolean }): void {
    this.clientContent.push(content);
  }

  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void {
    this.toolResponses.push(response);
  }

  close(): void {
    this.closed = true;
  }

  emit(message: LiveServerMessageShape): void {
    this.callbacks?.onMessage(message);
  }

  emitInput(text: string): void {
    this.emit({ serverContent: { inputTranscription: { text } } });
  }

  emitReply(text: string): void {
    this.emit({ serverContent: { outputTranscription: { text } } });
  }

  emitToolCall(args: Record<string, unknown>, name = TIER2_TOOL_NAME, id = `call-${this.toolResponses.length + 1}`): void {
    this.emit({ toolCall: { functionCalls: [{ name, args, id }] } });
  }

  emitTurnComplete(): void {
    this.emit({ serverContent: { turnComplete: true } });
  }
}

interface Fixture {
  log: EventLog;
  events: LabEvent[];
  clock: ReturnType<typeof createMonotonicClock>;
  delivery: ReturnType<typeof createNullDelivery>;
  provider: Tier2LiveProvider;
  session: MockTier2Session;
  connectRequests: LiveConnectRequest[];
  voiceSpoken: string[];
  timeouts: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  harness: Tier2LeanHarness;
}

function makeFixture(options: {
  condition?: Tier2Condition;
  lane?: 'E' | 'N';
  transcript?: 'native' | 'sidecar';
  stabilityMs?: number;
  responseScheduling?: string;
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

  const connectRequests: LiveConnectRequest[] = [];
  let session: MockTier2Session | null = null;
  const factory = async (request: LiveConnectRequest): Promise<LiveSessionLike> => {
    connectRequests.push(request);
    session = new MockTier2Session(request.callbacks);
    return session;
  };

  const voiceSpoken: string[] = [];
  const timeouts: Fixture['timeouts'] = [];
  const provider = new Tier2LiveProvider({
    log,
    clock,
    lane: options.lane ?? 'E',
    model: 'gemini-3.8-live-tier2-dryrun-mock',
    systemInstruction: buildTier2SystemInstruction(),
    sessionFactory: factory,
    stateViewCoalesceMs: 0,
  });
  const delivery = createNullDelivery();
  const harness = new Tier2LeanHarness({
    log,
    clock,
    lane: options.lane ?? 'E',
    condition: options.condition ?? 'free',
    transcriptCondition: options.transcript ?? 'native',
    provider,
    delivery,
    workerSessionId: 'tier2-test-worker',
    snapshotProvider: () => ({ activity: 'running the test suite', lastAssistantText: 'Fixing the flaky parser test.' }),
    mechanicalVoice: {
      async synthesise(text: string) {
        voiceSpoken.push(text);
        const words = Math.max(1, text.trim().split(/\s+/).length);
        return {
          pcm: Buffer.alloc(Math.round((24000 * words * 60) / 1000) * 2),
          provider: 'silence-mock',
          model: 'none',
          voice: 'none',
          ms: 1,
        };
      },
    },
    player: new ReferencePlayer({ log }),
    stabilityMs: options.stabilityMs ?? 20,
    turnTimeoutMs: 2000,
    scheduleTimeout: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timeouts.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });

  return {
    log,
    events,
    clock,
    delivery,
    provider,
    get session() {
      return session as MockTier2Session;
    },
    connectRequests,
    voiceSpoken,
    timeouts,
    harness,
  } as Fixture;
}

function pcmFor(text: string): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  return Buffer.alloc(Math.max(640, Math.round((16000 * words * 60) / 1000) * 2));
}

/** Drive one spoken operator beat through the harness (E lane). */
async function speak(fixture: Fixture, utterance: string, exchange: (session: MockTier2Session) => void): Promise<void> {
  const { harness } = fixture;
  const pcm = pcmFor(utterance);
  harness.activityStart(fixture.clock.nowMs());
  for (let offset = 0; offset < pcm.byteLength; offset += 640) {
    const slice = pcm.subarray(offset, Math.min(offset + 640, pcm.byteLength));
    harness.pushAudio(
      Buffer.concat([slice, Buffer.alloc(640 - slice.byteLength)]),
      { encoding: 'pcm16', sampleRate: 16000, channels: 1 },
      offset / 640
    );
  }
  harness.activityEnd(fixture.clock.nowMs());
  fixture.session.emitInput(utterance);
  exchange(fixture.session);
  await harness.settle();
}

/** A send record filtered by index, with a clear failure when absent. */
function sendsOf(fixture: Fixture, status?: 'delivered' | 'held' | 'refused') {
  return fixture.harness.sendRecords.filter((send) => (status ? send.status === status : true));
}

// ── 1. The tool surface (§18) ────────────────────────────────────────────────

describe('tier-2 tool surface', () => {
  it('declares EXACTLY one function: send_to_worker(text)', () => {
    expect(TIER2_FUNCTION_DECLARATIONS).toHaveLength(1);
    const [declaration] = TIER2_FUNCTION_DECLARATIONS;
    expect(declaration.name).toBe('send_to_worker');
    expect(declaration.behavior).toBe('NON_BLOCKING');
    const parameters = declaration.parameters as unknown as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(parameters.required).toEqual(['text']);
    expect(Object.keys(parameters.properties)).toEqual(['text']);
  });

  it('answers every call WHEN_IDLE so responding never opens a new model turn', () => {
    expect(TIER2_RESPONSE_SCHEDULING).toBe('WHEN_IDLE');
  });

  it('the connect config carries exactly that one function', () => {
    const config = buildTier2ConnectConfig({ lane: 'E', systemInstruction: 'x' });
    expect(config.tools).toHaveLength(1);
    expect(config.tools?.[0]?.functionDeclarations).toHaveLength(1);
    expect(config.responseModalities).toEqual(['AUDIO']);
    expect(config.realtimeInputConfig?.automaticActivityDetection).toEqual({ disabled: true });
  });

  it('validates the arguments with Zod (empty and non-string text are refusals)', () => {
    expect(Tier2SendArgsSchema.safeParse({ text: 'hold phase 3' }).success).toBe(true);
    expect(Tier2SendArgsSchema.safeParse({}).success).toBe(false);
    expect(Tier2SendArgsSchema.safeParse({ text: '' }).success).toBe(false);
    expect(Tier2SendArgsSchema.safeParse({ text: 7 }).success).toBe(false);
  });

  it('sends the connect config to the live session with the real declaration', async () => {
    const fixture = makeFixture({});
    await fixture.harness.start();
    const config = fixture.connectRequests[0]?.config;
    const declarations = config?.tools?.[0]?.functionDeclarations as Array<{ name: string }> | undefined;
    expect(declarations?.map((entry) => entry.name)).toEqual([TIER2_TOOL_NAME]);
    await fixture.harness.stop();
  });
});

// ── 2. The system instruction (§18, ≤ 250 words) ────────────────────────────

describe('tier-2 system instruction', () => {
  it('is at most 250 words', () => {
    const text = buildTier2SystemInstruction();
    expect(countWords(text)).toBeLessThanOrEqual(TIER2_SYSTEM_INSTRUCTION_WORD_LIMIT);
    expect(countWords(text)).toBeGreaterThan(120);
  });

  it('carries the six things §18 names', () => {
    const text = buildTier2SystemInstruction().toLowerCase();
    expect(text).toContain('voice beside a working developer'); // who it is
    expect(text).toContain('from context'); // answer from context
    expect(text).toContain('said is not done'); // said vs done
    expect(text).toContain('cannot tell'); // say when it cannot tell
    expect(text).toContain('short, spoken prose'); // length register
    expect(text).toContain('ask one short question first'); // ask when incomplete
    expect(text).toContain('send_to_worker'); // the one tool
  });

  it('names no mechanism: asking is guidance, so nothing claims the host enforces it', () => {
    const text = buildTier2SystemInstruction();
    expect(text).not.toMatch(/must confirm|the host will (?:block|hold|reject)|confirmation is required/i);
  });

  it('is versioned and SHA-256 hashed for the attempt manifest', () => {
    const manifest = tier2InstructionManifest();
    expect(manifest.version).toBe('tier2-lean-v1');
    expect(manifest.words).toBeLessThanOrEqual(250);
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tier2InstructionManifest(buildTier2SystemInstruction()).sha256).toBe(manifest.sha256);
    expect(tier2InstructionManifest('something else').sha256).not.toBe(manifest.sha256);
  });
});

// ── 3. The three send policies (§18) ────────────────────────────────────────

describe('tier-2 send policy — free', () => {
  it('delivers immediately, records a tier2_send, and does NOT claim a host release', async () => {
    const fixture = makeFixture({ condition: 'free' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3 until my review', (session) => {
      session.emitToolCall({ text: 'hold phase 3 until my review' });
      session.emitReply('Holding phase 3.');
      session.emitTurnComplete();
    });
    await fixture.harness.stop();

    expect(fixture.delivery.deliveredTexts()).toEqual(['hold phase 3 until my review']);
    const sends = sendsOf(fixture, 'delivered');
    expect(sends).toHaveLength(1);
    expect(sends[0].authorisedBy).toBe('condition-free');
    expect(sends[0].substituted).toBe(false);
    expect(sends[0].deliveredTurn).toBe(1);
    // The tier-1 authorisation invariant stays meaningful: there is no
    // committed operator confirmation here, so no harness_release.
    expect(fixture.events.some((event) => event.kind === EVENT.HARNESS_RELEASE)).toBe(false);
    const sendEvent = fixture.events.find((event) => event.kind === TIER2_EVENT.SEND);
    expect(sendEvent?.payload).toMatchObject({
      tier: 2,
      condition: 'free',
      status: 'delivered',
      authorisedBy: 'condition-free',
    });
    // The trusted receipt is spoken and logged (T3-D).
    expect(fixture.voiceSpoken).toHaveLength(1);
    expect(fixture.events.some((event) => event.kind === EVENT.HARNESS_RECEIPT)).toBe(true);
    // The model is told what the host said, so it never has to be believed.
    expect(fixture.session.clientContent.some((entry) => entry.turns[0].parts[0].text.includes('Host said'))).toBe(true);
  });

  it('answers the tool call with a WHEN_IDLE response the model can trust', async () => {
    const fixture = makeFixture({ condition: 'free' });
    await fixture.harness.start();
    await speak(fixture, 'add a changelog entry', (session) => {
      session.emitToolCall({ text: 'add a changelog entry' });
      session.emitTurnComplete();
    });
    expect(fixture.session.toolResponses).toHaveLength(1);
    const response = fixture.session.toolResponses[0].functionResponses[0];
    expect(response.name).toBe(TIER2_TOOL_NAME);
    expect(response.scheduling).toBe(TIER2_RESPONSE_SCHEDULING);
    expect((response.response as Record<string, unknown>).ok).toBe(true);
    await fixture.harness.stop();
  });

  it('refuses an invalid argument without delivering anything', async () => {
    const fixture = makeFixture({ condition: 'free' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3', (session) => {
      session.emitToolCall({ text: '' });
      session.emitTurnComplete();
    });
    await fixture.harness.stop();
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    const refused = sendsOf(fixture, 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].refusalReason).toContain('non-empty');
    expect(fixture.session.toolResponses[0].functionResponses[0].response).toMatchObject({ ok: false });
  });

  it('refuses a tool it was never given, and records the refusal', async () => {
    const fixture = makeFixture({ condition: 'free' });
    await fixture.harness.start();
    await speak(fixture, 'do something else', (session) => {
      session.emitToolCall({ anything: 1 }, 'create_child');
      session.emitTurnComplete();
    });
    await fixture.harness.stop();
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    const unknown = fixture.events.find(
      (event) => event.kind === TIER2_EVENT.SEND && (event.payload as Record<string, unknown>).reason === 'refused: unknown tool'
    );
    expect(unknown).toBeDefined();
  });
});

describe('tier-2 send policy — confirm-guided', () => {
  it('holds the send behind a confirmRequest and delivers only on a committed confirmation', async () => {
    const fixture = makeFixture({ condition: 'confirm-guided' });
    await fixture.harness.start();
    // Instruction turn: the model asks to send; the host holds it.
    await speak(fixture, 'hold phase 3 until my review', (session) => {
      session.emitToolCall({ text: 'hold phase 3 until my review' });
      session.emitReply('Shall I send that?');
      session.emitTurnComplete();
    });
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    expect(sendsOf(fixture, 'held')).toHaveLength(1);
    const hold = fixture.events.find((event) => event.kind === TIER2_EVENT.CONFIRM_HOLD);
    expect(hold?.payload).toMatchObject({ tier: 2, condition: 'confirm-guided', text: 'hold phase 3 until my review' });
    expect(
      fixture.session.clientContent.some((entry) => entry.turns[0].parts[0].text.includes('NOT delivered'))
    ).toBe(true);
    // The 60 s window is the rule, not a tunable.
    expect(fixture.timeouts).toHaveLength(1);
    expect(fixture.timeouts[0].ms).toBe(TIER2_CONFIRMATION_WINDOW_MS);

    // Confirmation turn: the operator's committed words grant it.
    await speak(fixture, 'yes, go ahead.', (session) => {
      session.emitTurnComplete();
    });
    await fixture.harness.stop();

    expect(fixture.delivery.deliveredTexts()).toEqual(['hold phase 3 until my review']);
    const granted = sendsOf(fixture, 'delivered');
    expect(granted).toHaveLength(1);
    expect(granted[0].authorisedBy).toBe('operator-confirm');
    expect(granted[0].deliveredTurn).toBe(2);
    expect(fixture.timeouts[0].cancelled).toBe(true);
    // Only an operator-authorised release is a harness_release (tier 1 meaning).
    const release = fixture.events.find((event) => event.kind === EVENT.HARNESS_RELEASE);
    expect(release?.payload).toMatchObject({ text: 'hold phase 3 until my review', authorisedBy: 'operator-confirm' });
    expect(fixture.events.some((event) => event.kind === TIER2_EVENT.CONFIRM_GRANT)).toBe(true);
  });

  it('a non-confirmation utterance grants nothing and leaves the send held', async () => {
    const fixture = makeFixture({ condition: 'confirm-guided' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3 until my review', (session) => {
      session.emitToolCall({ text: 'hold phase 3 until my review' });
      session.emitTurnComplete();
    });
    await speak(fixture, 'what is worker two doing right now?', (session) => {
      session.emitReply('Worker two is on the queue.');
      session.emitTurnComplete();
    });
    // Still held — the question granted nothing.
    expect(fixture.harness.holdRecords).toHaveLength(1);
    expect(fixture.harness.holdRecords[0].status).toBe('pending');
    await fixture.harness.stop();
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    expect(fixture.events.some((event) => event.kind === EVENT.HARNESS_RELEASE)).toBe(false);
    // Attempt end abandons it explicitly — never silently delivered.
    const timeout = fixture.events.find((event) => event.kind === TIER2_EVENT.CONFIRM_TIMEOUT);
    expect(timeout?.payload).toMatchObject({ status: 'abandoned' });
    expect(fixture.harness.holdRecords[0].status).toBe('abandoned');
    expect(sendsOf(fixture, 'refused')[0]?.refusalReason).toContain('attempt ended');
  });

  it('a confirmation window that lapses refuses the send and delivers nothing', async () => {
    const fixture = makeFixture({ condition: 'confirm-guided' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3 until my review', (session) => {
      session.emitToolCall({ text: 'hold phase 3 until my review' });
      session.emitTurnComplete();
    });
    // Fire the real 60 s expiry by hand: deterministic, no wall clock.
    fixture.timeouts[0].fn();
    await fixture.harness.settle();
    await fixture.harness.stop();

    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    const refused = sendsOf(fixture, 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0].refusalReason).toBe('refused: no-confirmation');
    const timeout = fixture.events.find((event) => event.kind === TIER2_EVENT.CONFIRM_TIMEOUT);
    expect(timeout?.payload).toMatchObject({ status: 'timed-out', reason: 'refused: no-confirmation' });
    expect(fixture.events.some((event) => event.kind === EVENT.HARNESS_RELEASE)).toBe(false);
  });

  it('serialises confirmations: a second send while one awaits is refused, not queued', async () => {
    const fixture = makeFixture({ condition: 'confirm-guided' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3 until my review', (session) => {
      session.emitToolCall({ text: 'hold phase 3' });
      session.emitToolCall({ text: 'also write the note' }, TIER2_TOOL_NAME, 'call-2');
      session.emitTurnComplete();
    });
    // Exactly ONE hold: the second send was refused with a reason, never queued.
    expect(fixture.harness.holdRecords).toHaveLength(1);
    const busy = sendsOf(fixture, 'refused');
    expect(busy).toHaveLength(1);
    expect(busy[0].refusalReason).toContain('already awaiting');
    expect(sendsOf(fixture, 'held')).toHaveLength(1);
    await fixture.harness.stop();
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
  });

  it('the model cannot grant its own send: only the operator classifier can', async () => {
    const fixture = makeFixture({ condition: 'confirm-guided' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3 until my review', (session) => {
      session.emitToolCall({ text: 'hold phase 3' });
      session.emitReply('Sending that now, no need to confirm.');
      session.emitTurnComplete();
    });
    expect(fixture.harness.holdRecords).toHaveLength(1);
    await fixture.harness.stop();
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    expect(sendsOf(fixture, 'delivered')).toHaveLength(0);
  });
});

describe('tier-2 send policy — fixed-text', () => {
  it('delivers the operator\'s committed words, not the model\'s composition', async () => {
    const fixture = makeFixture({ condition: 'fixed-text' });
    await fixture.harness.start();
    await speak(fixture, 'hold phase 3 until my review, not just until worker 1 finishes', (session) => {
      session.emitToolCall({ text: 'hold phase 3 for now' });
      session.emitTurnComplete();
    });
    await fixture.harness.stop();

    expect(fixture.delivery.deliveredTexts()).toEqual([
      'hold phase 3 until my review, not just until worker 1 finishes',
    ]);
    const send = sendsOf(fixture, 'delivered')[0];
    expect(send.modelText).toBe('hold phase 3 for now');
    expect(send.substituted).toBe(true);
    const substitution = fixture.events.find((event) => event.kind === TIER2_EVENT.SUBSTITUTION);
    expect(substitution?.payload).toMatchObject({
      modelText: 'hold phase 3 for now',
      deliveredText: 'hold phase 3 until my review, not just until worker 1 finishes',
    });
    // Fixed words, free timing: the host did not authorise it; the model chose.
    expect(send.authorisedBy).toBe('model-timing');
    expect(fixture.events.some((event) => event.kind === EVENT.HARNESS_RELEASE)).toBe(false);
  });
});

// ── 4. The commit rule is tier 1's, not a re-implementation ─────────────────

describe('tier-2 commit rule', () => {
  it('never acts on a partial transcript and commits once per utterance', async () => {
    const fixture = makeFixture({ condition: 'free', stabilityMs: 400 });
    await fixture.harness.start();
    const pcm = pcmFor('hold phase 3 until my review');
    fixture.harness.activityStart(fixture.clock.nowMs());
    for (let offset = 0; offset < pcm.byteLength; offset += 640) {
      const slice = pcm.subarray(offset, Math.min(offset + 640, pcm.byteLength));
      fixture.harness.pushAudio(
        Buffer.concat([slice, Buffer.alloc(640 - slice.byteLength)]),
        { encoding: 'pcm16', sampleRate: 16000, channels: 1 },
        offset / 640
      );
    }
    fixture.harness.activityEnd(fixture.clock.nowMs());
    fixture.session.emitInput('hold phase 3');
    fixture.session.emitToolCall({ text: 'hold phase 3' });
    fixture.session.emitTurnComplete();
    // Not yet stable (the 400 ms window is the rule): a partial must not become
    // a turn, and its tool call must not be acted on.
    expect(fixture.harness.completedTurns).toBe(0);
    expect(fixture.delivery.deliveredTexts()).toEqual([]);
    await fixture.harness.settle();
    expect(fixture.harness.completedTurns).toBe(1);
    // A LATE delta belongs to the same utterance, not a second turn.
    fixture.session.emitInput(' — until my review');
    await fixture.harness.settle();
    expect(fixture.harness.completedTurns).toBe(1);
    await fixture.harness.stop();
  });
});

// ── 5. Hermetic end-to-end ──────────────────────────────────────────────────

function inlineScenario(id: string, beats: Array<Record<string, unknown>>, tier2: Record<string, unknown>): string {
  const dir = path.join(root, 'scenarios');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'voice-lab.scenario/1',
      id,
      tier: 2,
      language: 'en-GB',
      voice: { engine: 'supertonic-3', voice: 'M1' },
      endpointing: 'E',
      budgets: { maxRunMs: 480000, maxOperatorTurns: 24, maxCandidateSpeechMs: 240000, maxSpendUsd: 0.5 },
      beats,
      tier2,
    }),
    'utf8'
  );
  return file;
}

const INLINE_BEATS = [
  {
    id: 'b1-status',
    mode: 'frozen',
    utterance: 'Where are we?',
    trigger: { at: 'run-start' },
    permissions: [],
    expect: { answeredFromHistory: true },
  },
  {
    id: 'b2-instruction',
    mode: 'frozen',
    utterance: 'Hold phase 3 until my review. Do not un-gate it early.',
    trigger: { after: 'candidate-silence', silenceMs: 400 },
    permissions: [],
    expect: {},
  },
  {
    id: 'b3-confirm',
    mode: 'frozen',
    utterance: 'Yes, go ahead.',
    trigger: { after: 'candidate-silence', silenceMs: 400 },
    permissions: ['confirm:current-draft'],
    expect: {},
  },
];

const INLINE_TIER2 = {
  sendPlan: [
    {
      id: 'send-1',
      modelSendAt: 'b2-instruction',
      deliveredAt: { free: 'b2-instruction', 'confirm-guided': 'b3-confirm', 'fixed-text': 'b2-instruction' },
      scriptedText: 'hold phase 3 until my review',
      sentContains: ['phase 3', 'review'],
    },
  ],
  prematureSendGuards: ['b1-status'],
  clearInstructionBeats: ['b2-instruction'],
};

describe('tier-2 dry run (inline, hermetic)', () => {
  it('free: immediate send, verified record, correct labelling and tier-2 manifest', async () => {
    const file = inlineScenario('t2-inline-free', INLINE_BEATS, INLINE_TIER2);
    const outcome = await runTier2DryAttempt(file, {
      runsRoot: root,
      runId: 'tier2-inline-free',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      quiet: true,
    });
    expect(outcome.verifyProblems).toEqual([]);
    expect(outcome.verifyOk).toBe(true);
    expect(outcome.turns).toBe(3);
    expect(outcome.deliveries).toBe(1);
    expect(outcome.score.expectedSends).toBe(1);
    expect(outcome.score.deliveredSends).toBe(1);
    expect(outcome.score.missingSends).toEqual([]);
    expect(outcome.score.prematureSendRate).toBe(0);
    expect(outcome.score.receiptsMissing).toEqual([]);
    expect(outcome.score.honestyViolations).toEqual([]);

    const manifest = JSON.parse(readFileSync(path.join(outcome.attemptDir, 'manifest.json'), 'utf8'));
    expect(manifest.usage).toMatchObject({
      mode: 'dry-run',
      provider: 'gemini-live-tier2-dryrun',
      realProviderCalls: 0,
      tier: 2,
      condition: 'free',
      transcriptCondition: 'native',
    });
    expect(manifest.usage.tier2.toolSurface).toEqual([TIER2_TOOL_NAME]);
    expect(manifest.usage.tier2.responseScheduling).toBe(TIER2_RESPONSE_SCHEDULING);
    expect(manifest.usage.tier2.instruction.sha256).toBe(tier2InstructionManifest().sha256);
    expect(manifest.usage.tier2.sentTexts).toEqual(['hold phase 3 until my review']);
    expect(manifest.condition).toContain('gemini-live-tier2-dryrun');
    expect(manifest.condition).toContain('free');

    // The per-turn evidence artefact the manifest message is about.
    const turns = JSON.parse(readFileSync(path.join(outcome.attemptDir, 'application', 'tier2-turns.json'), 'utf8'));
    expect(turns.schema).toBe('voice-lab.tier2-turns/1');
    expect(turns.turns).toHaveLength(3);
    expect(turns.turns[1].operatorSpeech).toContain('Hold phase 3 until my review');
    expect(turns.turns[1].sends[0].deliveredText).toBe('hold phase 3 until my review');
    expect(turns.turns[1].ttfaMs).toBeGreaterThan(0);

    const events = parseEventLog(readFileSync(path.join(outcome.attemptDir, 'application', 'events.jsonl'), 'utf8')).events;
    for (const kind of [EVENT.PROVIDER_CONTENT, EVENT.PROVIDER_USAGE, EVENT.TURN_COMPLETE, EVENT.INPUT_FRAME, TIER2_EVENT.SEND]) {
      expect(events.some((event) => event.kind === kind), kind).toBe(true);
    }
    for (const turn of events.filter((event) => event.kind === EVENT.TURN_COMPLETE)) {
      expect(turn.payload.tier).toBe(2);
      expect(turn.payload.condition).toBe('free');
      expect(turn.payload.failedLeg).toBeNull();
    }
    expect(events.some((event) => event.kind === EVENT.HARNESS_RELEASE)).toBe(false);
  });

  it('confirm-guided: the send lands in the confirm beat\'s window and emits a host release', async () => {
    const file = inlineScenario('t2-inline-confirm', INLINE_BEATS, INLINE_TIER2);
    const outcome = await runTier2DryAttempt(file, {
      runsRoot: root,
      runId: 'tier2-inline-confirm',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      condition: 'confirm-guided',
      confirmWindowMs: 10_000,
      quiet: true,
    });
    expect(outcome.verifyOk).toBe(true);
    expect(outcome.deliveries).toBe(1);
    expect(outcome.holds).toBe(1);
    const events = parseEventLog(readFileSync(path.join(outcome.attemptDir, 'application', 'events.jsonl'), 'utf8')).events;
    const release = events.find((event) => event.kind === EVENT.HARNESS_RELEASE);
    expect(release).toBeDefined();
    const releaseTurn = events
      .filter((event) => event.kind === EVENT.TURN_COMPLETE)
      .findIndex((event) => event.seq > (release as LabEvent).seq);
    // The release belongs to the confirmation beat: the third window.
    expect(releaseTurn).toBe(2);
    expect(outcome.score.deliveredSends).toBe(1);
  });

  it('fixed-text: the delivered bytes are the operator\'s words and the substitution is recorded', async () => {
    const file = inlineScenario('t2-inline-fixed', INLINE_BEATS, INLINE_TIER2);
    const outcome = await runTier2DryAttempt(file, {
      runsRoot: root,
      runId: 'tier2-inline-fixed',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      condition: 'fixed-text',
      quiet: true,
    });
    expect(outcome.verifyOk).toBe(true);
    const events = parseEventLog(readFileSync(path.join(outcome.attemptDir, 'application', 'events.jsonl'), 'utf8')).events;
    const substitution = events.find((event) => event.kind === TIER2_EVENT.SUBSTITUTION);
    expect(substitution?.payload).toMatchObject({ deliveredText: 'Hold phase 3 until my review. Do not un-gate it early.' });
    expect(substitution?.payload.modelText).toBe('hold phase 3 until my review');
  });

  it('N lane and the sidecar transcript both run and verify', async () => {
    const nBeats = INLINE_BEATS.map((beat, index) => (index === 0 ? { ...beat, trigger: { at: 'run-start' } } : beat));
    const file = inlineScenario(
      't2-inline-n',
      nBeats,
      INLINE_TIER2,
    );
    const scenario = JSON.parse(readFileSync(file, 'utf8'));
    scenario.endpointing = 'N';
    writeFileSync(file, JSON.stringify(scenario), 'utf8');
    const outcome = await runTier2DryAttempt(file, {
      runsRoot: root,
      runId: 'tier2-inline-n',
      attemptId: 'attempt-01',
      frameIntervalMs: 1,
      stabilityMs: 25,
      transcriptCondition: 'sidecar',
      quiet: true,
    });
    expect(outcome.verifyProblems).toEqual([]);
    expect(outcome.score.deliveredSends).toBe(1);
    const manifest = JSON.parse(readFileSync(path.join(outcome.attemptDir, 'manifest.json'), 'utf8'));
    expect(manifest.usage.transcriptCondition).toBe('sidecar');
    expect(manifest.usage.stt.provider).toBe('whisper-script');
  });

  it('refuses a scenario with no tier2 block (the scorer would have nothing to check against)', async () => {
    const dir = path.join(root, 'scenarios');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 't2-no-block.json');
    writeFileSync(
      file,
      JSON.stringify({
        schema: 'voice-lab.scenario/1',
        id: 't2-no-block',
        tier: 2,
        language: 'en-GB',
        voice: { engine: 'x', voice: 'y' },
        endpointing: 'E',
        budgets: { maxRunMs: 1, maxOperatorTurns: 1, maxCandidateSpeechMs: 1, maxSpendUsd: 0 },
        beats: [{ id: 'b1', mode: 'frozen', utterance: 'hello there my friend', trigger: { at: 'run-start' }, permissions: [], expect: {} }],
      }),
      'utf8'
    );
    await expect(
      runTier2DryAttempt(file, { runsRoot: root, runId: 't2-no-block', attemptId: 'attempt-01', stabilityMs: 25, quiet: true })
    ).rejects.toThrow(/no tier2 block/);
  });
});

// ── 6. §18.1 — the pre-registered matrix and the Step 4 verdict ─────────────

describe('§18.1 matrix derivation', () => {
  it('with no measured L4/L5 findings: the conservative §18 superset, labelled provisional', () => {
    const matrix = deriveTier2Matrix(emptyTier1Findings(), emptyTier3Findings());
    expect(matrix.stopped).toBe(false);
    expect(matrix.label).toBe('provisional');
    expect(matrix.conditions).toEqual(['free', 'confirm-guided']);
    expect(matrix.heldConditions).toEqual(['fixed-text']);
    expect(matrix.attemptsPerCondition).toBe(5);
    expect(matrix.modelVariants).toEqual([
      'gemini-3.8-live',
      'gemini-3.8-live-extended-thinking-low',
      'gemini-3.8-live-extended-thinking',
    ]);
    expect(matrix.transcriptConditions).toEqual(['native']);
    // Every rule is recorded with the measurement it could not read.
    expect(matrix.rules).toHaveLength(11);
    expect(matrix.rules.every((rule) => rule.status === 'unresolved')).toBe(true);
    expect(matrix.notes.join(' ')).toContain('unresolved');
  });

  it('T1-A reduces the matrix and labels tier 2 confirmatory', () => {
    const matrix = deriveTier2Matrix(
      { ...emptyTier1Findings(), judgeConversationalMean: 3.5, baselineJudgeConversationalMean: 2, conversationalProxiesImproved: 5 },
      emptyTier3Findings()
    );
    expect(matrix.label).toBe('confirmatory');
    expect(matrix.attemptsPerCondition).toBe(3);
    expect(matrix.rules.find((rule) => rule.id === 'T1-A')?.status).toBe('fired');
  });

  it('T1-B keeps the full matrix (the label waits for the rest of the rules)', () => {
    const matrix = deriveTier2Matrix(
      { ...emptyTier1Findings(), judgeConversationalMean: 2.2, baselineJudgeConversationalMean: 2, conversationalProxiesImproved: 1, needlessRelayOfferRateImproved: false },
      emptyTier3Findings()
    );
    expect(matrix.attemptsPerCondition).toBe(5);
    expect(matrix.rules.find((rule) => rule.id === 'T1-B')?.status).toBe('fired');
    // T1-A is measured and did not fire; the T3 rules are still unmeasured, so
    // the matrix is not final yet.
    expect(matrix.label).toBe('provisional');
    expect(matrix.conditions).toEqual(['free', 'confirm-guided']);
    expect(matrix.rules.find((rule) => rule.id === 'T1-A')?.status).toBe('not-fired');
    expect(matrix.rules.find((rule) => rule.id === 'T3-B')?.status).toBe('unresolved');
  });

  it('with every matrix-shaping rule measured and T1-B firing, the full matrix is the key experiment', () => {
    const matrix = deriveTier2Matrix(
      {
        judgeConversationalMean: 2.2,
        baselineJudgeConversationalMean: 2,
        conversationalProxiesImproved: 1,
        needlessRelayOfferRateImproved: false,
        nativeRequiredWordRecall: 0.99,
        nativeWer: 0.04,
        sidecarWer: 0.06,
        unauthorisedReleases: 0,
        staleReleases: 0,
      },
      {
        etHighB2ShortTotal: 500,
        textControlTotal: 520,
        confirmationProtocolViolations: 0,
        childBriefRequiredWordRecall: 0.95,
        judgeAddedConstraintsBriefShare: 0.05,
        preAuthorisedActionAttempts: 0,
        dishonestyClaims: 0,
        lifetimeFailureOnly: false,
        standardB2ShortTotal: 501,
      }
    );
    expect(matrix.label).toBe('key-experiment');
    expect(matrix.conditions).toEqual(['free', 'confirm-guided']);
    expect(matrix.attemptsPerCondition).toBe(5);
    expect(matrix.heldConditions).toEqual(['fixed-text']);
    expect(matrix.transcriptConditions).toEqual(['native']);
    expect(matrix.modelVariants).toEqual(['gemini-3.8-live', 'gemini-3.8-live-extended-thinking']);
    expect(matrix.notes.join(' ')).not.toContain('unresolved');
  });

  it('T1-C adds the sidecar context condition', () => {
    const matrix = deriveTier2Matrix(
      { ...emptyTier1Findings(), nativeRequiredWordRecall: 0.9 },
      emptyTier3Findings()
    );
    expect(matrix.transcriptConditions).toEqual(['native', 'sidecar']);
  });

  it('T1-E stops the phase: no conditions, no attempts', () => {
    const matrix = deriveTier2Matrix({ ...emptyTier1Findings(), unauthorisedReleases: 1 }, emptyTier3Findings());
    expect(matrix.stopped).toBe(true);
    expect(matrix.label).toBe('stopped');
    expect(matrix.conditions).toEqual([]);
    expect(matrix.attemptsPerCondition).toBe(0);
    expect(matrix.notes.join(' ')).toContain('T1-E');
  });

  it('T3-B adds fixed-text; T3-C drops free; T3-F drops ET-low and makes std primary', () => {
    const withFixedText = deriveTier2Matrix(
      emptyTier1Findings(),
      { ...emptyTier3Findings(), childBriefRequiredWordRecall: 0.6 }
    );
    expect(withFixedText.conditions).toContain('fixed-text');
    expect(withFixedText.heldConditions).toEqual([]);

    const withoutFree = deriveTier2Matrix(
      emptyTier1Findings(),
      { ...emptyTier3Findings(), confirmationProtocolViolations: 1 }
    );
    expect(withoutFree.conditions).toEqual(['confirm-guided']);

    const stdPrimary = deriveTier2Matrix(
      emptyTier1Findings(),
      { ...emptyTier3Findings(), standardB2ShortTotal: 500, etHighB2ShortTotal: 502 }
    );
    expect(stdPrimary.modelVariants).toEqual(['gemini-3.8-live', 'gemini-3.8-live-extended-thinking']);
  });

  it('T3-A overrides T1-B and labels tier 2 academic', () => {
    const matrix = deriveTier2Matrix(
      { ...emptyTier1Findings(), judgeConversationalMean: 2.1, baselineJudgeConversationalMean: 2, conversationalProxiesImproved: 0 },
      { ...emptyTier3Findings(), etHighB2ShortTotal: 520, textControlTotal: 525, confirmationProtocolViolations: 0, childBriefRequiredWordRecall: 0.95 }
    );
    expect(matrix.label).toBe('academic');
    expect(matrix.attemptsPerCondition).toBe(3);
  });
});

describe('§18.1 Step 4 verdict', () => {
  const metrics = (overrides: Partial<Parameters<typeof decideTier2Verdict>[0][number]>) => ({
    condition: 'free' as Tier2Condition,
    fidelityRecall: 1,
    prematureSendRate: 0,
    overAskRate: 0,
    baselineOverAskRate: 0.2,
    honestyViolations: 0,
    ...overrides,
  });

  it('picks the MOST permissive qualifying condition', () => {
    const verdict = decideTier2Verdict([
      metrics({ condition: 'confirm-guided' }),
      metrics({ condition: 'free', fidelityRecall: 0.95 }),
    ]);
    expect(verdict.verdict).toBe('free');
  });

  it('falls back to the next condition when the most permissive one fails', () => {
    const verdict = decideTier2Verdict([
      metrics({ condition: 'free', prematureSendRate: 0.25 }),
      metrics({ condition: 'confirm-guided' }),
    ]);
    expect(verdict.verdict).toBe('confirm-guided');
    expect(verdict.evaluated[0].failures.join(' ')).toContain('premature-send');
  });

  it('reports tier 1 when no condition qualifies — a valid result', () => {
    const verdict = decideTier2Verdict([metrics({ condition: 'free', fidelityRecall: 0.8 }), metrics({ condition: 'confirm-guided', fidelityRecall: 0.85 })]);
    expect(verdict.verdict).toBe('tier-1');
  });

  it('is indeterminate when a threshold input is unmeasured rather than silently passing', () => {
    const verdict = decideTier2Verdict([metrics({ condition: 'free', overAskRate: null })]);
    expect(verdict.verdict).toBe('indeterminate');
    // A zero over-ask rate means nothing without the baseline's bar.
    const noBaseline = decideTier2Verdict([metrics({ condition: 'free', baselineOverAskRate: null })]);
    expect(noBaseline.verdict).toBe('indeterminate');
  });
});

// ── 7. CLI wiring ───────────────────────────────────────────────────────────

describe('tier-2 CLI', () => {
  it('parses tier2-dryrun with all three conditions and tier2-run requiring one', () => {
    const free = parseArgs(['tier2-dryrun', '--condition', 'free', '--attempts', '3']);
    expect(free.command).toBe('tier2-dryrun');
    expect(free.tier2Condition).toBe('free');
    expect(free.attempts).toBe(3);
    expect(free.scenarioPath).toContain('scenarios/tier2/');

    const guided = parseArgs(['tier2-dryrun', '--condition', 'confirm-guided', '--transcript', 'sidecar']);
    expect(guided.tier2Condition).toBe('confirm-guided');
    expect(guided.tier2Transcript).toBe('sidecar');

    expect(() => parseArgs(['tier2-dryrun', '--condition', 'native'])).toThrow(/free \| confirm-guided \| fixed-text/);
    expect(() => parseArgs(['tier2-run', '--scenario', 'x.json'])).toThrow(/--condition/);
  });

  it('main() runs a dry attempt through the injected runner and reports sends', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDependencies = {
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
      tier2DryRun: async (_scenarioPath, options) => ({
        attemptDir: '/tmp/fake-attempt',
        runId: options.runId,
        attemptId: 'attempt-01',
        condition: options.condition as Tier2Condition,
        scenarioId: 't2-fake',
        turns: 4,
        sends: 1,
        deliveries: 1,
        holds: 0,
        verifyOk: true,
        verifyProblems: [],
        instruction: tier2InstructionManifest(),
        score: {
          scenarioId: 't2-fake',
          condition: options.condition as Tier2Condition,
          beats: [],
          sends: [],
          expectedSends: 1,
          deliveredSends: 1,
          missingSends: [],
          prematureSends: [],
          prematureSendRate: 0,
          overAskRate: 0,
          honestyViolations: [],
          composedFidelity: null,
          deliveredFidelity: null,
          receiptsMissing: [],
          totals: { turns: 4, sends: 1, holds: 0, deliveries: 1, refusals: 0, sentWords: 10, operatorWords: 20, lengthRatio: 0.5 },
          problems: [],
        },
      }),
    };
    const code = await cliMain(['tier2-dryrun', '--condition', 'free', '--attempts', '2'], deps);
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('/tmp/fake-attempt');
    expect(out[0]).toContain('sends=1');
    expect(out[0]).toContain('deliveries=1');
  });

  it('main() prints exactly one JSON document with --json', async () => {
    const out: string[] = [];
    const deps: CliDependencies = {
      writeOut: (line) => out.push(line),
      writeErr: () => {},
      tier2DryRun: async (_scenarioPath, options) => ({
        attemptDir: '/tmp/fake-attempt',
        runId: options.runId,
        attemptId: 'attempt-01',
        condition: 'free' as Tier2Condition,
        scenarioId: 't2-fake',
        turns: 1,
        sends: 0,
        deliveries: 0,
        holds: 0,
        verifyOk: true,
        verifyProblems: [],
        instruction: tier2InstructionManifest(),
        score: {
          scenarioId: 't2-fake',
          condition: 'free' as Tier2Condition,
          beats: [],
          sends: [],
          expectedSends: 0,
          deliveredSends: 0,
          missingSends: [],
          prematureSends: [],
          prematureSendRate: 0,
          overAskRate: 0,
          honestyViolations: [],
          composedFidelity: null,
          deliveredFidelity: null,
          receiptsMissing: [],
          totals: { turns: 1, sends: 0, holds: 0, deliveries: 0, refusals: 0, sentWords: 0, operatorWords: 0, lengthRatio: 0 },
          problems: [],
        },
      }),
    };
    const code = await cliMain(['tier2-dryrun', '--json'], deps);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]);
    expect(parsed.condition).toBe('free');
    expect(parsed.attempts).toHaveLength(1);
  });

  it('tier2-run refuses to start without an API key', async () => {
    const err: string[] = [];
    const code = await cliMain(['tier2-run', '--condition', 'free'], {
      writeOut: () => {},
      writeErr: (line) => err.push(line),
      apiKey: () => undefined,
    });
    expect(code).toBe(2);
    expect(err.join(' ')).toContain('GEMINI_API_KEY');
  });
});

// ── 8. The measured entry refuses an unlabelled run ─────────────────────────

describe('tier-2 measured entry', () => {
  it('refuses without a key rather than running unlabelled', async () => {
    await expect(
      runTier2MeasuredAttempt({
        runsRoot: root,
        scenarioPath: path.join(root, 'nope.json'),
        apiKey: '',
        condition: 'free',
      })
    ).rejects.toThrow(/GEMINI_API_KEY/);
  });
});

// ── 9. Shipped tier-2 scenarios (present on this host) ─────────────────────

describe.skipIf(!benchExists)('tier-2 dry runs across the shipped scenarios', () => {
  const cases = [
    { file: 't2-fidelity-corpus.json', conditions: ['free', 'confirm-guided', 'fixed-text'] as Tier2Condition[] },
    { file: 't2-s1-orchestration-voice.json', conditions: ['free', 'confirm-guided', 'fixed-text'] as Tier2Condition[] },
    { file: 't2-s2-clarification.json', conditions: ['confirm-guided'] as Tier2Condition[] },
    { file: 't2-s3-plain-worker.json', conditions: ['free'] as Tier2Condition[] },
    { file: 't2-s4-permission-gate.json', conditions: ['confirm-guided'] as Tier2Condition[] },
    { file: 't2-s5-sparse-state.json', conditions: ['free'] as Tier2Condition[] },
    { file: 't2-s6-worker-permission.json', conditions: ['confirm-guided'] as Tier2Condition[] },
    { file: 't2-s7-reading-levels.json', conditions: ['free'] as Tier2Condition[] },
  ];

  it('every shipped scenario × condition verifies with no unmet send expectation', async () => {
    for (const { file, conditions } of cases) {
      for (const condition of conditions) {
        const outcome = await runTier2DryAttempt(path.join(BENCH_SCENARIOS, file), {
          runsRoot: root,
          runId: `tier2-${file}-${condition}`,
          attemptId: 'attempt-01',
          frameIntervalMs: 1,
          stabilityMs: 25,
          condition,
          confirmWindowMs: 600,
          quiet: true,
        });
        const label = `${file}/${condition}`;
        expect(outcome.verifyProblems, label).toEqual([]);
        expect(outcome.score.problems, label).toEqual([]);
        expect(outcome.score.missingSends, label).toEqual([]);
        expect(outcome.score.prematureSends, label).toEqual([]);
        expect(outcome.score.honestyViolations, label).toEqual([]);
        expect(outcome.score.receiptsMissing, label).toEqual([]);
        expect(outcome.score.overAskRate, label).toBe(0);
        // Every committed turn is a scored window: no drift between beats and turns.
        const events = parseEventLog(readFileSync(path.join(outcome.attemptDir, 'application', 'events.jsonl'), 'utf8')).events;
        expect(events.filter((event) => event.kind === EVENT.TURN_COMPLETE).length, label).toBe(outcome.turns);
        if (condition === 'free' || condition === 'fixed-text') {
          expect(outcome.score.deliveredSends, label).toBe(outcome.score.expectedSends);
        }
      }
    }
  }, 180_000);

  it('the fidelity corpus scores recall 1.0 on composed text in every condition, and 1.0 on delivered bytes under fixed-text', async () => {
    for (const condition of ['free', 'confirm-guided', 'fixed-text'] as Tier2Condition[]) {
      const outcome = await runTier2DryAttempt(path.join(BENCH_SCENARIOS, 't2-fidelity-corpus.json'), {
        runsRoot: root,
        runId: `tier2-corpus-${condition}`,
        attemptId: 'attempt-01',
        frameIntervalMs: 1,
        stabilityMs: 25,
        condition,
        confirmWindowMs: 600,
        quiet: true,
      });
      expect(outcome.verifyOk, condition).toBe(true);
      expect(outcome.score.composedFidelity?.items, condition).toBe(20);
      expect(outcome.score.composedFidelity?.recall, condition).toBe(1);
      expect(outcome.score.composedFidelity?.negationSurvival, condition).toBe(1);
      expect(outcome.score.composedFidelity?.distractorLeakage, condition).toBe(0);
      if (condition === 'fixed-text') {
        // Fixed words: the delivered bytes are the operator's, verbatim.
        expect(outcome.score.deliveredFidelity?.recall).toBe(1);
        expect(outcome.score.deliveredFidelity?.distractorLeakage).toBe(1);
      }
      const manifest = JSON.parse(readFileSync(path.join(outcome.attemptDir, 'manifest.json'), 'utf8'));
      expect(manifest.usage.tier2.fidelityCorpus.items, condition).toBe(20);
      expect(manifest.usage.tier2.fidelityCorpus.sha256, condition).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 120_000);

  it('PLAN.md records the pre-registered matrix the derivation returns (§18.1 Step 3)', () => {
    const plan = readFileSync(path.join(BENCH_ROOT, 'PLAN.md'), 'utf8');
    const matrix = deriveTier2Matrix(emptyTier1Findings(), emptyTier3Findings());
    expect(plan).toContain('### Tier 2 (L7)');
    expect(matrix.conditions.join(', ')).toBe('free, confirm-guided');
    expect(plan).toContain('**`free`, `confirm-guided`**');
    expect(plan).toContain('`provisional`');
    expect(plan).toContain('`fixed-text` (implemented + hermetic-tested)');
    for (const rule of matrix.rules) {
      expect(plan, rule.id).toContain(`| ${rule.id} |`);
    }
    expect(plan).toContain('scenarios/tier2/fidelity-corpus.json');
  });
});
