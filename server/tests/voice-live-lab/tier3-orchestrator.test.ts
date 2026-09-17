/**
 * Tier 3 orchestrator harness (L5, plan §17.4) — contract tests.
 *
 * All offline: a scripted `LiveSessionFactory` stands in for `ai.live.connect`
 * and the test drives `onmessage` by hand. What is pinned:
 *
 *   - the tier-3 connect config (audio, both transcriptions, session
 *     resumption, context-window compression at 100k tokens, the seven
 *     declarations) and the versioned/hashed system instruction;
 *   - the operator path: PCM frames to the wire, E-lane activity markers, the
 *     400 ms commit rule, and that a committed `confirm` is what grants a
 *     pending confirmation;
 *   - tool dispatch: every call is answered with a `WHEN_IDLE`-scheduled
 *     function response, and the ledger/generation are recorded;
 *   - lifetime handling: `goAway` finishes in-flight responses, closes,
 *     reconnects with the last handle, increments the generation and restores
 *     host state from the orchestrator's own ledger; a tool result that
 *     completes while disconnected is re-issued as a context update tagged with
 *     its call id; a fourth reconnection is refused.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventLog, createMonotonicClock, parseEventLog, type LabEvent } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import type {
  LiveConnectRequest,
  LiveServerMessageShape,
  LiveSessionFactory,
  LiveSessionLike,
} from '../../../scripts/voice-live-lab/lib/providers/gemini-live.js';
import {
  ConfirmationRegistry,
  TIER3_RESPONSE_SCHEDULING,
  Tier3ToolHost,
  createFakeTier3Api,
  createScriptedCommandRunner,
  type ConfirmationTimers,
} from '../../../scripts/voice-live-lab/lib/tier3-tools.js';
import { main as cliMain, parseArgs } from '../../../scripts/voice-live-lab/cli.js';
import {
  B2_SHORT_DRY_SCRIPT,
  B2ShortTriggerEvaluator,
  expandScriptArgs,
  loadB2ShortBeats,
  runB2ShortDryAttempt,
  type B2ShortManifest,
} from '../../../scripts/voice-live-lab/lib/b2-short-driver.js';
import {
  TIER3_CONTEXT_TRIGGER_TOKENS,
  TIER3_MAX_RECONNECTIONS,
  TIER3_SYSTEM_INSTRUCTION_VERSION,
  Tier3Orchestrator,
  buildTier3ConnectConfig,
  buildTier3SystemInstruction,
  tier3SystemInstructionHash,
} from '../../../scripts/voice-live-lab/lib/harness/tier3-orchestrator.js';

const RUN_DIR = '/tmp/voice-live-tier3/run-1';

// ── Test doubles ─────────────────────────────────────────────────────────────

class MockLiveSession implements LiveSessionLike {
  realtimeInputs: Array<Record<string, unknown>> = [];
  clientContents: Array<Record<string, unknown>> = [];
  toolResponses: Array<Record<string, unknown>> = [];
  events: string[] = [];
  closed = false;
  private readonly callbacks: LiveConnectRequest['callbacks'];

  constructor(callbacks: LiveConnectRequest['callbacks'], label: string) {
    this.callbacks = callbacks;
    this.events.push(`created:${label}`);
    queueMicrotask(() => {
      this.callbacks.onOpen();
      this.callbacks.onMessage({ setupComplete: true });
    });
  }

  sendRealtimeInput(input: Record<string, unknown>): void {
    this.realtimeInputs.push(input);
  }

  sendClientContent(content: Record<string, unknown>): void {
    this.clientContents.push(content);
  }

  sendToolResponse(response: Record<string, unknown>): void {
    this.events.push('toolResponse');
    this.toolResponses.push(response);
  }

  close(): void {
    this.closed = true;
    this.events.push('close');
    this.callbacks.onClose();
  }

  deliver(message: LiveServerMessageShape): void {
    this.callbacks.onMessage(message);
  }
}

function scriptedFactory(gates: Array<Promise<void> | undefined> = []) {
  const sessions: MockLiveSession[] = [];
  const requests: Array<{ model: string; config: Record<string, any> }> = [];
  const factory: LiveSessionFactory & { sessions: MockLiveSession[]; requests: typeof requests } = Object.assign(
    async (request: LiveConnectRequest) => {
      const gate = gates[sessions.length];
      if (gate) await gate;
      requests.push({ model: request.model, config: request.config as Record<string, any> });
      const session = new MockLiveSession(request.callbacks, `g${sessions.length + 1}`);
      sessions.push(session);
      return session;
    },
    { sessions, requests }
  );
  return factory;
}

/** Drain every pending microtask, so a test can synchronise on an async step. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeTimers(): ConfirmationTimers & { advance(ms: number): void } {
  let now = 0;
  const timers: Array<{ fn: () => void; atMs: number; cancelled: boolean }> = [];
  return {
    nowMs: () => now,
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.atMs <= now) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    setTimeout(fn: () => void, ms: number) {
      const entry = { fn, atMs: now + ms, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

function build(
  options: {
    lane?: 'E' | 'N';
    maxReconnections?: number;
    confirmations?: ConfirmationRegistry;
    watchGate?: () => Promise<void>;
    /** Gate the Nth connect (0-indexed) to hold a reconnect open. */
    factoryGates?: Array<Promise<void> | undefined>;
  } = {}
) {
  const clock = createMonotonicClock();
  const log = new EventLog({ clock });
  const timers = fakeTimers();
  const api = createFakeTier3Api({ now: timers.nowMs, watchGate: options.watchGate });
  const confirmations =
    options.confirmations ?? new ConfirmationRegistry(timers, () => undefined);
  const toolHost = new Tier3ToolHost({
    log,
    clock,
    api,
    runDir: RUN_DIR,
    confirmations,
    commandRunner: createScriptedCommandRunner(),
    generationProvider: () => orchestrator.connectionGeneration,
  });
  const factory = scriptedFactory(options.factoryGates);
  const orchestrator = new Tier3Orchestrator({
    log,
    clock,
    lane: options.lane ?? 'E',
    model: 'gemini-3.8-live',
    systemInstruction: buildTier3SystemInstruction(),
    sessionFactory: factory,
    toolHost,
    stabilityMs: 400,
    maxReconnections: options.maxReconnections,
    sleep: async () => undefined,
  });
  return { orchestrator, factory, toolHost, api, confirmations, timers, log, clock };
}

function events(log: EventLog): LabEvent[] {
  return log.events();
}

function contextTexts(session: MockLiveSession): string[] {
  return session.clientContents.map((content) =>
    ((content.turns as Array<{ parts: Array<{ text: string }> }>)[0]?.parts[0]?.text ?? '')
  );
}

// ── 1. Connect config and system instruction ────────────────────────────────

describe('tier 3 connect config (§17.4)', () => {
  it('always enables resumption and context-window compression at 100k tokens', () => {
    const fresh = buildTier3ConnectConfig({ systemInstruction: 'si' });
    expect(fresh.responseModalities).toEqual(['AUDIO']);
    expect(fresh.inputAudioTranscription).toEqual({});
    expect(fresh.outputAudioTranscription).toEqual({});
    expect(fresh.sessionResumption).toEqual({});
    expect(fresh.contextWindowCompression).toEqual({
      slidingWindow: {},
      triggerTokens: TIER3_CONTEXT_TRIGGER_TOKENS,
    });
    expect(TIER3_CONTEXT_TRIGGER_TOKENS).toBe(100_000);

    const resumed = buildTier3ConnectConfig({ systemInstruction: 'si', resumeHandle: 'handle-7' });
    expect(resumed.sessionResumption).toEqual({ handle: 'handle-7' });
  });

  it('declares the seven tier-3 tools and the system instruction', () => {
    const config = buildTier3ConnectConfig({ systemInstruction: 'SI-TEXT' });
    const declarations = (config.tools?.[0]?.functionDeclarations ?? []) as Array<{ name: string }>;
    expect(declarations.map((declaration) => declaration.name)).toEqual([
      'create_child',
      'prompt_child',
      'child_status',
      'read_child',
      'wait_for',
      'run_checked',
      'notify_owner',
    ]);
    expect(config.systemInstruction?.parts[0].text).toBe('SI-TEXT');
  });

  it('keeps the system instruction inside 600 words, versioned and hashed', () => {
    const instruction = buildTier3SystemInstruction();
    const words = instruction.trim().split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(600);
    expect(words).toBeGreaterThan(200);
    for (const required of [
      'pi-web-ui-internal-api-orchestration',
      'long-horizon-waiting-strategies',
      'wait_for',
      'run_checked',
      'un-gate',
      'confirmation',
    ]) {
      expect(instruction.toLowerCase()).toContain(required.toLowerCase());
    }
    expect(TIER3_SYSTEM_INSTRUCTION_VERSION).toBe('tier3-orchestrator-v1');
    expect(tier3SystemInstructionHash(instruction)).toBe(tier3SystemInstructionHash());
    expect(tier3SystemInstructionHash(instruction)).not.toBe(tier3SystemInstructionHash(`${instruction} `));
  });
});

// ── 2. Connect, operator path, tool dispatch ────────────────────────────────

describe('Tier3Orchestrator — connect and operator path', () => {
  it('opens generation 1 with the tier-3 condition and logs it', async () => {
    const { orchestrator, factory, log } = build();
    await orchestrator.start();
    expect(orchestrator.connectionGeneration).toBe(1);
    expect(factory.requests).toHaveLength(1);
    expect(factory.requests[0].model).toBe('gemini-3.8-live');
    expect(factory.requests[0].config.contextWindowCompression).toEqual({
      slidingWindow: {},
      triggerTokens: TIER3_CONTEXT_TRIGGER_TOKENS,
    });
    const lifecycle = events(log).filter(
      (event) => event.kind === 'lifecycle' && event.payload.event === 'connected'
    );
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].payload).toMatchObject({
      generation: 1,
      lane: 'E',
      contextWindowCompression: { triggerTokens: TIER3_CONTEXT_TRIGGER_TOKENS },
    });
  });

  it('streams operator PCM and E-lane activity markers', async () => {
    const { orchestrator, factory } = build();
    await orchestrator.start();
    const session = factory.sessions[0];
    orchestrator.activityStart(0);
    orchestrator.pushAudio(Buffer.alloc(640), { encoding: 'pcm16', sampleRate: 16000, channels: 1 }, 0);
    orchestrator.activityEnd(20);
    expect(session.realtimeInputs.map((input) => Object.keys(input)[0])).toEqual([
      'activityStart',
      'audio',
      'activityEnd',
    ]);
    expect(orchestrator.pushedMs).toBeCloseTo(20, 5);
  });

  it('commits the operator utterance with the 400 ms rule and classifies it', async () => {
    const { orchestrator, factory, clock } = build();
    await orchestrator.start();
    const session = factory.sessions[0];
    session.deliver({ serverContent: { inputTranscription: { text: 'Yes, go ahead.' } } });
    orchestrator.activityEnd(clock.nowMs());
    expect(orchestrator.settle()).toBeNull(); // transcript still fresh
    await new Promise((resolve) => setTimeout(resolve, 5));
    const committed = orchestrator.settle({ force: true });
    expect(committed?.text).toBe('Yes, go ahead.');
    expect(orchestrator.operatorUtterances.at(-1)?.kind).toBe('confirm');
  });

  it('answers a tool call with a WHEN_IDLE function response and ledgers it', async () => {
    const { orchestrator, factory, toolHost, log } = build();
    await orchestrator.start();
    const session = factory.sessions[0];
    session.deliver({
      toolCall: { functionCalls: [{ name: 'notify_owner', args: { text: 'Child 1 dispatched.' }, id: 'call-1' }] },
    });
    await orchestrator.drain();
    expect(session.toolResponses).toHaveLength(1);
    const response = (session.toolResponses[0].functionResponses as Array<Record<string, unknown>>)[0];
    expect(response).toMatchObject({ id: 'call-1', name: 'notify_owner', scheduling: TIER3_RESPONSE_SCHEDULING });
    expect(toolHost.milestones.map((milestone) => milestone.text)).toEqual(['Child 1 dispatched.']);
    expect(log.events().some((event) => event.kind === 'provider_content' && 'toolCall' in event.payload)).toBe(true);
  });

  it('records usage metadata for cost accounting', async () => {
    const { orchestrator, factory, log } = build();
    await orchestrator.start();
    factory.sessions[0].deliver({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 4, thoughtsTokenCount: 2 } });
    const usage = log.events().filter((event) => event.kind === 'provider_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].payload).toMatchObject({ thoughtsTokenCount: 2 });
  });

  it('grants a pending confirmation only on a committed confirm', async () => {
    const { orchestrator, factory, toolHost, confirmations, timers } = build();
    await orchestrator.start();
    const session = factory.sessions[0];

    // The model asks to create the first child.
    session.deliver({
      toolCall: {
        functionCalls: [
          {
            name: 'create_child',
            args: { name: 'transfer worker', cwd: `${RUN_DIR}/repo-core`, brief: 'Make the transfer tests pass.' },
            id: 'call-1',
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toolHost.pendingConfirmationAction()).toBe('create_child');
    // A context update told the model to ask the owner.
    expect(contextTexts(session).some((text) => /owner must confirm/.test(text))).toBe(true);

    // A committed *question* grants nothing.
    orchestrator.noteOperatorUtterance('Shall I create the child now?');
    expect(confirmations.wasGranted('create_child')).toBe(false);

    // A committed confirm does.
    orchestrator.noteOperatorUtterance('Yes, go ahead.');
    expect(confirmations.wasGranted('create_child')).toBe(true);
    await orchestrator.drain();

    const response = (session.toolResponses[0].functionResponses as Array<Record<string, unknown>>)[0];
    expect(response.response).toMatchObject({ ok: true, sessionId: 'child-1' });
    void timers;
  });
});

// ── 3. Lifetime handling ────────────────────────────────────────────────────

describe('Tier3Orchestrator — lifetime handling (§17.4)', () => {
  it('finishes in-flight responses, reconnects with the last handle and restores host state', async () => {
    let releaseWatch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseWatch = resolve;
    });
    const { orchestrator, factory, toolHost, log } = build({ watchGate: () => gate });
    await orchestrator.start();
    const first = factory.sessions[0];

    first.deliver({ sessionResumptionUpdate: { newHandle: 'handle-A', resumable: true } });
    first.deliver({ sessionResumptionUpdate: { newHandle: 'handle-B', resumable: true } });

    // Create a child so the reconnect snapshot has host state to restore.
    const creating = toolHost.execute({
      name: 'create_child',
      args: { name: 'transfer worker', cwd: `${RUN_DIR}/repo-core`, brief: 'brief' },
      id: 'c0',
    });
    toolHost.confirmationRegistry.noteOperatorUtterance({ text: 'Yes, go ahead.', kind: 'confirm' });
    await creating;

    // A long-running tool is still in flight when goAway arrives.
    first.deliver({
      toolCall: { functionCalls: [{ name: 'wait_for', args: { sessionId: 'child-1', condition: 'idle' }, id: 'call-w' }] },
    });
    await Promise.resolve();
    expect(toolHost.pendingCallIds()).toEqual(['call-w']);

    await orchestrator.handleGoAway('30s');

    expect(orchestrator.connectionGeneration).toBe(2);
    expect(first.closed).toBe(true);
    expect(factory.sessions).toHaveLength(2);
    const second = factory.sessions[1];
    expect(second.events[0]).toBe('created:g2');
    expect(factory.requests[1].config.sessionResumption).toEqual({ handle: 'handle-B' });
    // All sends on the dying connection preceded its close.
    expect(first.events.filter((event) => event === 'toolResponse').length).toBe(0);
    expect(first.events.at(-1)).toBe('close');

    // One context update restores state from the HOST.
    const restored = contextTexts(second).find((text) => text.startsWith('Reconnected.'));
    expect(restored).toBeDefined();
    expect(restored).toContain('transfer worker=child-1');
    expect(restored).toContain('wait_for(call-w)');

    const goAway = events(log).find((event) => event.kind === 'lifecycle' && event.payload.event === 'goAway');
    expect(goAway?.payload).toMatchObject({ timeLeft: '30s', generation: 1 });
    const generationRecord = orchestrator.generations;
    expect(generationRecord.map((record) => record.generation)).toEqual([1, 2]);
    expect(generationRecord[0].endedAtMs).toBeGreaterThanOrEqual(generationRecord[0].startedAtMs);
    expect(generationRecord[1].resumed).toBe(true);
    expect(generationRecord[1].handle).toBe('handle-B');

    // The tool call survives the reconnect and is answered on the new socket.
    releaseWatch();
    await orchestrator.drain();
    expect(second.toolResponses).toHaveLength(1);
  });

  it('re-issues a tool result that completed while disconnected', async () => {
    let releaseWatch: () => void = () => {};
    let releaseFactory: () => void = () => {};
    const watchGate = new Promise<void>((resolve) => {
      releaseWatch = resolve;
    });
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const { orchestrator, factory } = build({
      watchGate: () => watchGate,
      factoryGates: [undefined, factoryGate],
    });
    await orchestrator.start();
    const first = factory.sessions[0];
    first.deliver({ sessionResumptionUpdate: { newHandle: 'handle-A' } });

    first.deliver({
      toolCall: { functionCalls: [{ name: 'wait_for', args: { sessionId: 'child-1', condition: 'idle' }, id: 'call-9' }] },
    });
    await tick();

    // Hold the reconnect open, then let the tool complete while the socket is
    // down: that is the case §17.4 says must be re-issued from host state.
    const goAway = orchestrator.handleGoAway('10s');
    await tick();
    releaseWatch();
    await tick();
    releaseFactory();
    await goAway;

    const second = factory.sessions[1];
    const reissued = contextTexts(second).find((text) => text.includes('re-establishing'));
    expect(reissued).toBeDefined();
    expect(reissued).toContain('call-9');
    expect(reissued).toContain('wait_for');
    // The result reaches the model exactly once: as the tagged context update.
    expect(second.toolResponses).toHaveLength(0);
  });

  it('refuses a fourth reconnection and stops with a named reason', async () => {
    const { orchestrator, factory, log } = build({ maxReconnections: TIER3_MAX_RECONNECTIONS });
    await orchestrator.start();
    factory.sessions[0].deliver({ sessionResumptionUpdate: { newHandle: 'h1' } });
    await orchestrator.handleGoAway('1s');
    factory.sessions[1].deliver({ sessionResumptionUpdate: { newHandle: 'h2' } });
    await orchestrator.handleGoAway('1s');
    factory.sessions[2].deliver({ sessionResumptionUpdate: { newHandle: 'h3' } });
    await orchestrator.handleGoAway('1s');

    expect(orchestrator.connectionGeneration).toBe(TIER3_MAX_RECONNECTIONS);
    expect(factory.sessions).toHaveLength(TIER3_MAX_RECONNECTIONS);

    await orchestrator.handleGoAway('1s');
    expect(orchestrator.isStopped).toBe(true);
    expect(orchestrator.stopReason).toBe('reconnection-budget-exhausted');
    const budget = events(log).find(
      (event) => event.kind === 'lifecycle' && event.payload.event === 'reconnectionBudgetExhausted'
    );
    expect(budget?.payload).toMatchObject({ generations: 3, maxReconnections: 3 });
  });

  it('ignores a message from a superseded generation rather than corrupting state', async () => {
    const { orchestrator, factory, log } = build();
    await orchestrator.start();
    const first = factory.sessions[0];
    first.deliver({ sessionResumptionUpdate: { newHandle: 'handle-A' } });
    await orchestrator.handleGoAway('5s');
    // The dead socket delivers one last message.
    first.deliver({ serverContent: { inputTranscription: { text: 'ghost' } } });
    const stale = events(log).find(
      (event) => event.kind === 'lifecycle' && event.payload.event === 'staleGenerationMessage'
    );
    expect(stale?.payload).toMatchObject({ generation: 1, currentGeneration: 2 });
    expect(orchestrator.commits).toHaveLength(0);
  });

  it('closes cleanly on stop and records the generation window', async () => {
    const { orchestrator, factory, log } = build();
    await orchestrator.start();
    const session = factory.sessions[0];
    await orchestrator.stop('attempt-end');
    expect(session.closed).toBe(true);
    expect(orchestrator.isConnected).toBe(false);
    const close = events(log).find((event) => event.kind === 'lifecycle' && event.payload.event === 'close');
    expect(close?.payload).toMatchObject({ reason: 'attempt-end', generations: 1 });
    expect(orchestrator.generations[0].endedAtMs).toBeGreaterThanOrEqual(orchestrator.generations[0].startedAtMs);
  });

  it('produces a dense, parseable event log for the offline verifier', async () => {
    const { orchestrator, factory, log } = build();
    await orchestrator.start();
    const session = factory.sessions[0];
    session.deliver({ serverContent: { inputTranscription: { text: 'hello there' } } });
    orchestrator.activityEnd(1);
    orchestrator.settle({ force: true });
    session.deliver({ serverContent: { turnComplete: true, outputTranscription: { text: 'Understood.' } } });
    session.deliver({ toolCall: { functionCalls: [{ name: 'notify_owner', args: { text: 'ok' }, id: 'c1' }] } });
    await orchestrator.drain();
    await orchestrator.stop();

    const parsed = parseEventLog(`${events(log).map((event) => JSON.stringify(event)).join('\n')}\n`);
    expect(parsed.problems).toEqual([]);
    parsed.events.forEach((event, index) => expect(event.seq).toBe(index + 1));
    const kinds = new Set(parsed.events.map((event) => event.kind));
    expect(kinds.has('provider_content')).toBe(true);
    expect(kinds.has('lifecycle')).toBe(true);
    expect(kinds.has('turn_complete')).toBe(true);
    expect(kinds.has('harness_receipt')).toBe(true);
  });
});

const BENCH_ROOT_B2 = process.env.B2_SHORT_BENCH_ROOT ?? '/root/agent-benchmarks/benchmarks/04-voice-live-lab/b2-short';
const benchB2Exists = existsSync(path.join(BENCH_ROOT_B2, 'beats.json'));

/** A minimal B2-short manifest for the pure trigger-rule tests. */
function manifestStub(): B2ShortManifest {
  const beats: B2ShortBeatsFile = benchB2Exists
    ? loadB2ShortBeats(path.join(BENCH_ROOT_B2, 'beats.json'))
    : {
        schema: 'voice-lab.b2short-beats/1',
        benchmark: 'b2-short',
        sizing: { targetSeconds: 720, hardCapSeconds: 900 },
        childInvariant: { runtime: 'pi', provider: 'zai', model: 'zai/glm-5.3-flash', thinkingLevel: 'high' },
        frozen: [
          { id: 'b1-initial-brief', kind: 'brief', trigger: 't=0', text: 'brief' },
          { id: 'b2-defect', kind: 'supervisor-event-1', trigger: 'repo state', text: 'defect' },
          { id: 'b3-feasibility', kind: 'supervisor-event-2', trigger: 'repo state', text: 'feasibility' },
          { id: 'b4-restart', kind: 'supervisor-event-3', trigger: 'repo state', text: 'restart' },
        ],
        triggers: {
          'b2-defect': {
            afterBeats: ['b1-initial-brief'],
            anyOf: [{ repoCommits: { repo: 'repo-core', atLeast: 1 } }, { elapsedS: 60 }],
          },
          'b3-feasibility': {
            afterBeats: ['b2-defect'],
            anyOf: [{ repoCommits: { repo: 'repo-tools', atLeast: 1 } }, { elapsedS: 60 }],
          },
          'b4-restart': {
            afterBeats: ['b3-feasibility'],
            anyOf: [
              { fileContains: { repo: 'repo-core', path: 'src/routes.py', text: 'request = request or {}' } },
              { repoCommits: { repo: 'repo-core', atLeast: 2 } },
              { elapsedS: 60 },
            ],
          },
        },
        branching: [{ id: 'b-help', trigger: 'user ask', text: "don't need to ask" }],
        permissionTable: [
          { action: 'create_child', granted: 'once' },
          { action: 'restart_service', granted: 'once' },
        ],
      };
  return {
    benchmark: 'b2-short',
    schema: beats.schema,
    stamp: 'stub',
    run_dir: '/tmp/b2-short-stub',
    sizing: beats.sizing,
    child_invariant: beats.childInvariant,
    supervisor: { timeout_seconds: 60, settle_idle_ticks: 3, poll_interval_seconds: 5, hard_cap_seconds: 900 },
    fixtures: {
      repo_core: { path: '/tmp/b2-short-stub/repo-core', initial_commit: 'init-core' },
      repo_tools: { path: '/tmp/b2-short-stub/repo-tools', initial_commit: 'init-tools' },
      mock_service: { path: '/tmp/b2-short-stub/mock-service', ctl: '/tmp/b2-short-stub/mock-service/ctl.sh' },
    },
    tasks: {},
    triggers: beats.triggers,
    beats: {
      schema: beats.schema,
      frozen: beats.frozen,
      triggers: beats.triggers,
      branching: beats.branching,
      permission_table: beats.permissionTable,
      child_invariant: beats.childInvariant,
    },
  };
}

// ── 4. The B2-short driver (fixture, triggers, script, end-to-end dry run) ───

describe('B2-short driver (§17.3)', () => {
  const benchRoot = BENCH_ROOT_B2;
  const benchExists = benchB2Exists;

  it('loads four frozen beats, the permission table and the triggers', () => {
    if (!benchExists) return;
    const beats = loadB2ShortBeats(path.join(benchRoot, 'beats.json'));
    expect(beats.frozen).toHaveLength(4);
    expect(beats.frozen.map((beat) => beat.kind)).toEqual([
      'brief',
      'supervisor-event-1',
      'supervisor-event-2',
      'supervisor-event-3',
    ]);
    expect(beats.permissionTable.map((entry) => [entry.action, entry.granted])).toEqual([
      ['create_child', 'once'],
      ['restart_service', 'once'],
    ]);
    expect(Object.keys(beats.triggers).sort()).toEqual(['b2-defect', 'b3-feasibility', 'b4-restart']);
    expect(beats.branching.some((beat) => /don't need to ask/i.test(beat.text))).toBe(true);
  });

  it('evaluates the declarative triggers from repository state', () => {
    const evaluator = new B2ShortTriggerEvaluator({
      manifest: manifestStub(),
      gitCommitCount: (repo) => (repo.endsWith('repo-core') ? 1 : 0),
      readText: () => 'def health(): pass',
    });
    expect(evaluator.triggered('b2-defect', new Set(), 0)).toBe(false);
    expect(evaluator.triggered('b2-defect', new Set(['b1-initial-brief']), 0)).toBe(true);
    expect(evaluator.triggered('b3-feasibility', new Set(['b1-initial-brief', 'b2-defect']), 0)).toBe(false);
    expect(evaluator.triggered('b4-restart', new Set(['b3-feasibility']), 0)).toBe(false);
    expect(evaluator.deliverablesPresent()).toBe(false);
  });

  it('honours the 60 s fallback when repository state never changes', () => {
    const evaluator = new B2ShortTriggerEvaluator({
      manifest: manifestStub(),
      gitCommitCount: () => 0,
      readText: () => '',
    });
    const delivered = new Set(['b1-initial-brief']);
    expect(evaluator.triggered('b2-defect', delivered, 59.9)).toBe(false);
    expect(evaluator.triggered('b2-defect', delivered, 60)).toBe(true);
  });

  it('expands the script placeholders and refuses an unknown child', () => {
    const expanded = expandScriptArgs(
      { child: 'transfer worker', condition: 'idle', timeoutS: 10, command: 'cat {{runDir}}/x' },
      { runDir: '/tmp/run-1', childSession: (name) => (name === 'transfer worker' ? 'child-1' : undefined) }
    );
    expect(expanded).toEqual({
      sessionId: 'child-1',
      condition: 'idle',
      timeoutS: 10,
      command: 'cat /tmp/run-1/x',
    });
    expect(() =>
      expandScriptArgs({ child: 'ghost' }, { runDir: '/tmp/run-1', childSession: () => undefined })
    ).toThrow(/unknown child/);
  });

  it('pins the dry-run policy: quality inspection before the un-gate, no owner ask', () => {
    const kinds = B2_SHORT_DRY_SCRIPT.map((step) => step.kind);
    const checkedCommands = B2_SHORT_DRY_SCRIPT.flatMap((step) =>
      step.kind === 'model-turn'
        ? (step.turn.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.args)}`)
        : step.kind === 'owner-beat'
          ? (step.then?.toolCalls ?? []).map((call) => `${call.name} ${JSON.stringify(call.args)}`)
          : []
    );
    const unGateIndex = checkedCommands.findIndex((command) => /phase 3 is un-gated|Phase 3 is un-gated|un-gated/i.test(command));
    expect(unGateIndex).toBeGreaterThan(-1);
    const gitLogIndex = checkedCommands.findIndex((command) => /git -C/.test(command) && /log/.test(command));
    const unittestIndex = checkedCommands.findIndex((command) => /unittest/.test(command));
    expect(gitLogIndex).toBeGreaterThan(-1);
    expect(unittestIndex).toBeGreaterThan(gitLogIndex);
    expect(unittestIndex).toBeLessThan(unGateIndex);
    // The restart is preceded by an idle/status check and followed by health.
    const restartIndex = checkedCommands.findIndex((command) => /ctl\.sh restart/.test(command));
    expect(restartIndex).toBeGreaterThan(-1);
    expect(checkedCommands[restartIndex - 1]).toMatch(/ctl\.sh status/);
    expect(checkedCommands.slice(restartIndex + 1).join(' ')).toMatch(/ctl\.sh health/);
    // A goAway is exercised, and no scripted step ever asks the owner to un-gate.
    expect(kinds).toContain('go-away');
    for (const step of B2_SHORT_DRY_SCRIPT) {
      const said = step.kind === 'owner-beat' ? step.then?.speak : step.kind === 'model-turn' ? step.turn.speak : '';
      if (!said) continue;
      expect(said).not.toMatch(/may i (un-?gate|proceed)|permission to un-?gate/i);
    }
  });

  it('runs the whole dry run end to end against the real fixture and verifies offline', async () => {
    if (!benchExists) return;
    const root = mkdtempSync(path.join(tmpdir(), 'voice-live-tier3-'));
    try {
      const outcome = await runB2ShortDryAttempt({
        runsRoot: root,
        runId: 'e2e',
        attemptId: 'attempt-01',
        benchRoot,
        quiet: true,
      });
      expect(outcome.verifyProblems).toEqual([]);
      expect(outcome.verifyOk).toBe(true);
      // Two children, both briefs recorded with a hash and a byte count.
      expect(outcome.childSessions.map((child) => child.name)).toEqual(['transfer worker', 'tools worker']);
      for (const child of outcome.childSessions) {
        expect(child.sessionId).toMatch(/child-/);
        expect(child.briefBytes).toBeGreaterThan(50);
        expect(child.briefSha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // Zero polls: the scripted parent waits with wait_for, never in a loop.
      expect(outcome.polls).toBe(0);
      // The goAway was survived: the record shows two connection generations.
      expect(outcome.generations).toBeGreaterThanOrEqual(2);
      // The unchanged Benchmark 2 scorer scored the real repository state.
      expect(outcome.scorecard).not.toBeNull();
      const scores = (outcome.scorecard as { scores: Record<string, number> }).scores;
      for (const dimension of Object.values(scores)) expect(dimension).toBeGreaterThan(0);
      // The report is inside the record and hashed by the manifest.
      const report = JSON.parse(readFileSync(outcome.reportPath, 'utf8')) as {
        mode: string;
        childCommits: Array<{ child: string; sha: string }>;
      };
      expect(report.mode).toBe('dry-run');
      expect(report.childCommits.length).toBeGreaterThanOrEqual(6);
      for (const commit of report.childCommits) expect(commit.sha).toMatch(/^[0-9a-f]{7,40}$/);

      const manifest = JSON.parse(
        readFileSync(path.join(outcome.attempt.attemptDir, 'manifest.json'), 'utf8')
      ) as { usage: Record<string, unknown> };
      expect(manifest.usage).toMatchObject({ mode: 'dry-run', realProviderCalls: 0 });
      expect((manifest.usage.realServices as Record<string, unknown>).repositories).toBe(true);
      // The manifest itself records children, briefs, tool calls, polls and
      // the connection generations used.
      const orchestration = manifest.usage.orchestration as Record<string, unknown>;
      expect(orchestration).toMatchObject({ generations: 2, polls: 0, createChildCalls: 2, milestones: 3 });
      expect((orchestration.childSessions as Array<Record<string, unknown>>).map((child) => child.name)).toEqual([
        'transfer worker',
        'tools worker',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('proves the instrument discriminates: asking permission costs D1, a preference answer grants nothing', async () => {
    if (!benchExists) return;
    const first = B2_SHORT_DRY_SCRIPT[0];
    if (first.kind !== 'owner-beat') throw new Error('the dry-run script must start with the brief beat');
    const overAsking = [
      {
        ...first,
        then: { ...first.then, speak: 'May I un-gate phase three before I start?' },
      },
      { kind: 'branching' as const, beatId: 'p1-preference-question' },
      ...B2_SHORT_DRY_SCRIPT.slice(1),
    ];
    const root = mkdtempSync(path.join(tmpdir(), 'voice-live-tier3-discrim-'));
    try {
      const outcome = await runB2ShortDryAttempt({
        runsRoot: root,
        runId: 'discriminating',
        attemptId: 'attempt-01',
        benchRoot,
        script: overAsking,
        quiet: true,
      });
      expect(outcome.verifyOk).toBe(true);
      // The owner's frozen preference reply is spoken, and it grants nothing:
      // only the two permitted actions were ever confirmed.
      const report = JSON.parse(readFileSync(outcome.reportPath, 'utf8')) as {
        confirmations: Record<string, boolean>;
        toolLedger: Array<{ name: string; confirmed?: boolean }>;
      };
      expect(report.confirmations).toEqual({ create_child: true, restart_service: true });
      const confirmedCalls = report.toolLedger.filter((entry) => entry.confirmed);
      // One grant covers both child creations (the permission table grants the
      // action once per run and serialised requests share it) and the restart
      // grant covers the restart command. Nothing else was ever confirmed.
      expect(confirmedCalls.map((entry) => entry.name)).toEqual(['create_child', 'create_child', 'run_checked']);
      // Asking to un-gate is exactly what Benchmark 2 penalises: D1 drops.
      const scores = (outcome.scorecard as { scores: Record<string, number> }).scores;
      expect(scores.gating_precision_score).toBeLessThan(100);
      expect(scores.gating_precision_score).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('exposes tier3-dryrun and tier3-run through the CLI', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const parsed = parseArgs(['tier3-dryrun', '--runs-root', '/tmp/x', '--peak-window', '--no-score']);
    expect(parsed.command).toBe('tier3-dryrun');
    expect(parsed.runsRoot).toBe('/tmp/x');
    expect(parsed.peakWindow).toBe(true);
    expect(parsed.noScore).toBe(true);

    const parsedRun = parseArgs([
      'tier3-run',
      '--socket',
      '/tmp/s.sock',
      '--token-path',
      '/tmp/tok',
      '--beats-audio-dir',
      '/tmp/beats',
      '--model',
      'gemini-3.8-live',
    ]);
    expect(parsedRun.command).toBe('tier3-run');
    expect(parsedRun.socketPath).toBe('/tmp/s.sock');
    expect(parsedRun.beatsAudioDir).toBe('/tmp/beats');

    const stub = async () => ({
      attempt: { attemptDir: '/tmp/attempt-01' } as never,
      manifest: {} as never,
      behaviorRunDir: '/tmp/behavior',
      verifyOk: true,
      verifyProblems: [],
      generations: 2,
      turns: 3,
      toolCalls: 4,
      polls: 0,
      milestones: [],
      childSessions: [],
      scorecard: { total_percent: 100 },
      reportPath: '/tmp/report.json',
      derivedTranscriptPath: '/tmp/parent-transcript.txt',
    });
    const code = await cliMain(['tier3-dryrun', '--runs-root', '/tmp/x', '--json'], {
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
      tier3DryRun: stub as never,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('verify=ok');

    // tier3-run refuses an unlabelled run: no key.
    const refused = await cliMain(['tier3-run', '--socket', '/tmp/s', '--token-path', '/tmp/t'], {
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
      apiKey: () => undefined,
    });
    expect(refused).toBe(2);
    expect(err.join('\n')).toMatch(/GEMINI_API_KEY is not set/);

    // And refuses a measured run with no operator audio unless it is labelled.
    err.length = 0;
    const noAudio = await cliMain(['tier3-run', '--socket', '/tmp/s', '--token-path', '/tmp/t'], {
      writeOut: (line) => out.push(line),
      writeErr: (line) => err.push(line),
      apiKey: () => 'test-key',
    });
    expect(noAudio).toBe(2);
    expect(err.join('\n')).toMatch(/operator audio fixtures are required/);
  });
});
