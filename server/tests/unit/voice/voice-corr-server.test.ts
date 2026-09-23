/**
 * Wave-3 Track K — server safety & honesty corrections (review R findings).
 *
 * Every finding gets a test here that fails against the pre-fix tree and passes
 * after the correction:
 *   H1 never retarget a lane's worker silently inside one generation
 *   H2 bounded lane lifetime + an honest capacity code
 *   M1 exactly-once under concurrent confirms sharing an idempotency key
 *   M2 honest `unknown` receipts + reachable reconciliation
 *   M3 requestId echo on answering frames
 *   M4 worker-status context injection actually wired
 *   M5 commission lead-in / polite interpolation strip
 *   M6 echo/self-transcript exclusion on the native path
 *   L1 evidence-log hygiene (excerpt + scrub; full text never logged)
 *   M8 envelope-faithful rate refusals (connection transport; own file)
 *   H3-server presentation enforcement (seed, no fabricated identity, spoken
 *     read-back)
 *
 * Hermetic: a fake bridge service, a recording delivery adapter, an injected
 * clock. No provider, no socket, no worker.
 */
import { describe, expect, it } from 'vitest';

import type {
  VoiceActivityNote,
  VoiceAudioInputChunk,
  VoiceBridgeContextUpdate,
  VoiceBridgeEmittedEvent,
  VoiceBridgeLaneState,
  VoiceBridgeService,
  VoiceBridgeStartOptions,
  VoiceReadingLevel,
  VoiceStopReason,
} from '../../../src/voice/contract.js';
import type { DeliveryOutcome, WorkerDelivery } from '../../../src/talker/types.js';
import {
  VoiceLiveMount,
  VOICE_LANE_CAPACITY_CODE,
  createLogEvidenceSink,
  projectEvidenceEvent,
} from '../../../src/websocket/voice-live-mount.js';
import { normaliseRelayText } from '../../../src/talker/relay-normalise.js';

// ── Harness ─────────────────────────────────────────────────────────────────

class FakeService implements VoiceBridgeService {
  private readonly listeners = new Set<(event: VoiceBridgeEmittedEvent) => void>();
  readonly states = new Map<string, VoiceBridgeLaneState>();
  readonly starts: VoiceBridgeStartOptions[] = [];
  readonly contexts: Array<{ laneId: string; update: VoiceBridgeContextUpdate }> = [];
  stopped: Array<{ laneId: string; reason: VoiceStopReason }> = [];

  async start(options: VoiceBridgeStartOptions): Promise<void> {
    this.starts.push(options);
    this.states.set(options.laneId, {
      laneId: options.laneId,
      attachmentGeneration: options.attachmentGeneration,
      state: 'live',
      workerActivity: 'idle',
      readingLevel: options.readingLevel,
      captureMode: options.captureMode,
      resumable: false,
      startedAtMs: 1,
      lastEventAtMs: 1,
    });
    this.emit({
      kind: 'state',
      laneId: options.laneId,
      attachmentGeneration: options.attachmentGeneration,
      state: 'live',
    });
  }

  async stop(laneId: string, reason: VoiceStopReason): Promise<void> {
    this.stopped.push({ laneId, reason });
    this.states.delete(laneId);
  }

  feedAudio(_chunk: VoiceAudioInputChunk & { laneId: string; attachmentGeneration: number }): void {}
  noteActivity(_note: VoiceActivityNote): void {}
  injectContext(laneId: string, update: VoiceBridgeContextUpdate): void {
    this.contexts.push({ laneId, update });
  }
  setReadingLevel(_laneId: string, _level: VoiceReadingLevel): void {}
  getState(laneId: string): VoiceBridgeLaneState | null {
    return this.states.get(laneId) ?? null;
  }
  subscribe(listener: (event: VoiceBridgeEmittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async dispose(): Promise<void> {
    this.listeners.clear();
  }

  emit(event: VoiceBridgeEmittedEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

interface Sent {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

interface Ctx {
  send: (message: unknown) => void;
  clientId: string;
}

function ctx(sent: Sent[], clientId = 'c1'): Ctx {
  return { clientId, send: (message) => sent.push(message as Sent) };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

interface DeliveryHarness extends WorkerDelivery {
  calls: Array<{ workerSessionId: string; text: string }>;
}

function recordingDelivery(
  result: DeliveryOutcome | (() => DeliveryOutcome) = { outcome: 'delivered', mechanism: 'prompt' }
): DeliveryHarness {
  const calls: Array<{ workerSessionId: string; text: string }> = [];
  return {
    calls,
    describe: () => 'test delivery',
    async deliver(input) {
      calls.push(input);
      if (typeof result === 'function') return result();
      if (result.outcome === 'unknown') throw new Error(result.reason);
      return result;
    },
  };
}

function throwingDelivery(message = 'transport reset after submit'): DeliveryHarness {
  const calls: Array<{ workerSessionId: string; text: string }> = [];
  return {
    calls,
    describe: () => 'throwing delivery',
    async deliver(input) {
      calls.push(input);
      throw new Error(message);
    },
  };
}

async function startLane(
  mount: VoiceLiveMount,
  sent: Sent[],
  laneId: string,
  opts: { generation?: number; worker?: string; requestId?: string; clientId?: string } = {}
): Promise<string | null> {
  return mount.route(opts.clientId ?? 'c1', ctx(sent, opts.clientId) as never, {
    type: 'voice_session_start',
    version: 1,
    laneId,
    attachmentGeneration: opts.generation ?? 1,
    workerSessionId: opts.worker ?? 'W1',
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  } as never);
}

function utterance(service: FakeService, laneId: string, text: string, generation = 1): void {
  service.emit({
    kind: 'transcript',
    laneId,
    attachmentGeneration: generation,
    speaker: 'operator',
    source: 'native',
    text,
    final: true,
    atMs: 1,
  });
}

/**
 * The model-driven relay (owner directive, 2026-09-22). The native talker
 * decides to relay and calls `relay_to_worker`; the transcript is no longer
 * mechanically classified. Tests use this instead of the removed predicate.
 */
async function relayToWorker(service: FakeService, mount: VoiceLiveMount, laneId: string, text: string): Promise<void> {
  // Phase 3: a relay binds to what the operator said. Every test relay is
  // preceded by the matching final operator utterance — the real flow — so
  // the tool call has provenance to bind to.
  utterance(service, laneId, text);
  await flush();
  await mount.handleToolRequest({ laneId, name: 'relay_to_worker', args: { text }, atMs: 1 });
}

function talkerSays(service: FakeService, laneId: string, text: string, generation = 1): void {
  service.emit({
    kind: 'transcript',
    laneId,
    attachmentGeneration: generation,
    speaker: 'talker',
    source: 'native',
    text,
    final: true,
    atMs: 1,
  });
}

/** One talker audio chunk: the mechanical fact that put TTS in the room. */
function talkerAudio(service: FakeService, laneId: string, seq: number): void {
  service.emit({
    kind: 'audio_out',
    laneId,
    attachmentGeneration: 1,
    seq,
    mimeType: 'audio/pcm;rate=24000',
    data: '',
    durationMs: 200,
    atMs: 1,
  });
}

/** The client's local VAD boundary, routed the way the wire delivers it. */
async function speech(
  mount: VoiceLiveMount,
  sent: Sent[],
  laneId: string,
  state: 'speech_start' | 'speech_end'
): Promise<void> {
  await mount.route('c1', ctx(sent) as never, {
    type: 'voice_activity_state',
    version: 1,
    laneId,
    attachmentGeneration: 1,
    state,
    atMs: 1,
  } as never);
}

function echoSuspect(events: Record<string, unknown>[], reason: string): Record<string, unknown>[] {
  return events.filter((event) => event.event === 'operator_utterance_echo_suspect' && event.reason === reason);
}

interface ProposalRef {
  proposalId: string;
  version: number;
  sha256: string;
  tidied: string;
  original: string;
  presentation: { completed: boolean };
}

function proposalFrom(sent: Sent[], index = -1): ProposalRef {
  const frames = sent.filter((frame) => frame.type === 'proposal_created');
  const frame = index < 0 ? frames.at(index) : frames[index];
  return frame.proposal as ProposalRef;
}

async function reportPresentation(
  mount: VoiceLiveMount,
  sent: Sent[],
  laneId: string,
  proposal: ProposalRef,
  completed = true,
  generation = 1
): Promise<string | null> {
  return mount.route('c1', ctx(sent) as never, {
    type: 'proposal_presentation',
    version: 1,
    laneId,
    attachmentGeneration: generation,
    proposalId: proposal.proposalId,
    presentedVariant: 'tidied',
    completed,
  } as never);
}

async function confirm(
  mount: VoiceLiveMount,
  sent: Sent[],
  laneId: string,
  proposal: ProposalRef,
  idempotencyKey: string,
  opts: { echo?: boolean; requestId?: string; generation?: number; variant?: string } = {}
): Promise<string | null> {
  return mount.route('c1', ctx(sent) as never, {
    type: 'proposal_confirm',
    version: 1,
    laneId,
    attachmentGeneration: opts.generation ?? 1,
    proposalId: proposal.proposalId,
    variant: opts.variant ?? 'tidied',
    idempotencyKey,
    ...(opts.echo === false
      ? {}
      : { proposalRef: { version: proposal.version, sha256: proposal.sha256 } }),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  } as never);
}

/** Start a lane, create a proposal by speech, and complete its presentation. */
async function proposalReady(
  mount: VoiceLiveMount,
  service: FakeService,
  sent: Sent[],
  laneId = 'lane-1',
  worker = 'W1'
): Promise<ProposalRef> {
  await startLane(mount, sent, laneId, { worker });
  await relayToWorker(service, mount, laneId, 'check the tests.');
  await flush();
  const proposal = proposalFrom(sent);
  await reportPresentation(mount, sent, laneId, proposal);
  return proposal;
}

// ─ H1: never retarget a lane's delivery worker silently ─────────────────────

describe('H1: a same-generation worker change resolves the live proposal before retargeting', () => {
  it('does not deliver a W1 proposal to W2 after a same-generation start naming W2', async () => {
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1', { worker: 'W1' });
    await relayToWorker(service, mount, 'lane-1', 'check the tests.');
    await flush();
    const proposal = proposalFrom(sent);

    // Same lane, SAME generation, different worker.
    const code = await startLane(mount, sent, 'lane-1', { worker: 'W2' });
    expect(code).toBeNull();

    // The live proposal was resolved explicitly, never silently retargeted.
    const resolved = sent.filter((frame) => frame.type === 'proposal_resolved');
    expect(resolved.some((frame) => frame.outcome === 'replaced')).toBe(true);
    const mountEvidence = (mount as unknown as { evidence: (e: Record<string, unknown>) => void }).evidence;
    expect(mountEvidence).toBeTypeOf('function');

    // A confirmation of the W1 proposal can no longer reach anyone.
    await reportPresentation(mount, sent, 'lane-1', proposal);
    const refused = await confirm(mount, sent, 'lane-1', proposal, 'k-retarget');
    expect(refused).not.toBeNull();
    expect(delivery.calls).toHaveLength(0);
  });

  it('retargets the lane so later deliveries go to the new worker (and records why)', async () => {
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1', { worker: 'W1' });
    await relayToWorker(service, mount, 'lane-1', 'check the tests.');
    await flush();
    await startLane(mount, sent, 'lane-1', { worker: 'W2' });

    const retarget = events.find(
      (event) => event.event === 'proposal_resolved' && event.reason === 'worker_retarget_same_generation'
    );
    expect(retarget).toBeDefined();

    // A fresh proposal after the retarget delivers to W2.
    await relayToWorker(service, mount, 'lane-1', 'rerun the suite.');
    await flush();
    const second = proposalFrom(sent);
    await reportPresentation(mount, sent, 'lane-1', second);
    expect(await confirm(mount, sent, 'lane-1', second, 'k-after')).toBeNull();
    expect(delivery.calls).toEqual([{ workerSessionId: 'W2', text: second.tidied }]);
  });

  it('keeps the generation-bump path resolving the live proposal', async () => {
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1', { worker: 'W1', generation: 1 });
    await relayToWorker(service, mount, 'lane-1', 'check the tests.');
    await flush();
    const proposal = proposalFrom(sent);
    await startLane(mount, sent, 'lane-1', { worker: 'W1', generation: 2 });
    expect(
      events.some(
        (event) =>
          event.event === 'proposal_resolved' && event.reason === 'worker_switch_generation_bump'
      )
    ).toBe(true);
    await reportPresentation(mount, sent, 'lane-1', proposal, true, 1);
    expect(await confirm(mount, sent, 'lane-1', proposal, 'k-bump', { generation: 1 })).not.toBeNull();
    expect(delivery.calls).toHaveLength(0);
  });
});

// ── H2: bounded lane lifetime + honest capacity code ────────────────────────

describe('H2: detached lanes are reclaimed and a genuine cap refuses honestly', () => {
  it('reclaims a detached lane after the grace window, so lifecycle cannot exhaust the table', async () => {
    const clock = makeClock();
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      now: clock.now,
      laneReapGraceMs: 1_000,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-old');
    expect(mount.bindings.size).toBe(1);

    await mount.detachClient('c1');
    expect(mount.bindings.size).toBe(0);

    clock.advance(2_000);
    expect(await startLane(mount, sent, 'lane-new')).toBeNull();
    expect((mount as unknown as { lanes: Map<string, unknown> }).lanes.size).toBe(1);
  });

  it('keeps a briefly-detached lane revivable inside the grace window (resume)', async () => {
    const clock = makeClock();
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      now: clock.now,
      laneReapGraceMs: 30_000,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await mount.detachClient('c1');
    clock.advance(1_000);
    expect(await startLane(mount, sent, 'lane-1')).toBeNull();
    const lane = (mount as unknown as { lanes: Map<string, { detachedAtMs: number | null }> }).lanes.get('lane-1');
    expect(lane?.detachedAtMs).toBeNull();
  });

  it('refuses a genuinely full table with an honest capacity code (not voice_internal_error)', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      laneReapGraceMs: 0,
    });
    const sent: Sent[] = [];
    for (let i = 0; i < 64; i++) {
      expect(await startLane(mount, sent, `lane-fill-${i}`)).toBeNull();
    }
    const code = await startLane(mount, sent, 'lane-65');
    expect(code).toBe(VOICE_LANE_CAPACITY_CODE);
    expect(code).not.toBe('voice_internal_error');
  });

  it('recovers a full table once the clients detach (the R probe-4 shape)', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      // A long grace: recovery here must come from capacity pressure, not expiry.
      laneReapGraceMs: 30_000,
    });
    const sent: Sent[] = [];
    for (let i = 0; i < 64; i++) {
      expect(await startLane(mount, sent, `lane-fill-${i}`)).toBeNull();
    }
    expect(await startLane(mount, sent, 'lane-65')).toBe(VOICE_LANE_CAPACITY_CODE);

    await mount.detachClient('c1');
    expect(mount.bindings.size).toBe(0);
    const afterDisconnect = await startLane(mount, sent, 'lane-after-disconnect');
    expect(afterDisconnect).toBeNull();
    expect((mount as unknown as { lanes: Map<string, unknown> }).lanes.size).toBe(1);
  });
});

// ── M1: exactly-once across concurrent confirms sharing a key ────────────────

describe('M1: concurrent confirms sharing an idempotency key deliver exactly once', () => {
  it('delivers once and refuses the loser with a duplicate, never a second receipt', async () => {
    const service = new FakeService();
    const calls: Array<{ workerSessionId: string; text: string }> = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivery: WorkerDelivery = {
      describe: () => 'gated delivery',
      async deliver(input) {
        await gate;
        calls.push(input);
        return { outcome: 'delivered' };
      },
    };
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1', { worker: 'W1' });
    await startLane(mount, sent, 'lane-2', { worker: 'W2' });
    await relayToWorker(service, mount, 'lane-1', 'do one.');
    await relayToWorker(service, mount, 'lane-2', 'do two.');
    await flush();
    const p1 = proposalFrom(sent, 0);
    const p2 = proposalFrom(sent, 1);
    await reportPresentation(mount, sent, 'lane-1', p1);
    await reportPresentation(mount, sent, 'lane-2', p2);

    const r1 = confirm(mount, sent, 'lane-1', p1, 'SHARED');
    const r2 = confirm(mount, sent, 'lane-2', p2, 'SHARED');
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    const [c1, c2] = await Promise.all([r1, r2]);
    await flush();

    expect(calls).toHaveLength(1);
    expect(mount.kernel.releases.history()).toHaveLength(1);
    expect([c1, c2].filter((code) => code === null)).toHaveLength(1);
    const receipts = sent.filter((frame) => frame.type === 'receipt_event');
    expect(receipts).toHaveLength(1);
  });
});

// ── M2: honest unknown receipts + reachable reconciliation ───────────────────

describe('M2: a post-submission failure is an unknown receipt, not a refusal', () => {
  it('records unknown + reconcile and makes the reconciliation obligation reachable', async () => {
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = throwingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    const proposal = await proposalReady(mount, service, sent);
    expect(await confirm(mount, sent, 'lane-1', proposal, 'k-unknown')).toBeNull();

    const receipt = sent.find((frame) => frame.type === 'receipt_event')?.receipt as {
      outcome: string;
      unknownCause?: string;
      reconcile?: boolean;
    };
    expect(receipt.outcome).toBe('unknown');
    expect(receipt.unknownCause).toBe('transport_error');
    expect(receipt.reconcile).toBe(true);
    expect(mount.kernel.pendingReconciliations()).toHaveLength(1);
    expect(
      events.some((event) => event.event === 'delivery_receipt' && event.outcome === 'unknown' && event.reconcile === true)
    ).toBe(true);
  });

  it('still records a genuine returned refusal as refused', async () => {
    const service = new FakeService();
    const delivery = recordingDelivery({ outcome: 'refused', reason: 'no such worker session' });
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    const proposal = await proposalReady(mount, service, sent);
    expect(await confirm(mount, sent, 'lane-1', proposal, 'k-refused')).toBeNull();
    const receipt = sent.find((frame) => frame.type === 'receipt_event')?.receipt as { outcome: string };
    expect(receipt.outcome).toBe('refused');
    expect(mount.kernel.pendingReconciliations()).toHaveLength(0);
  });
});

// ─ M3: requestId echo ──────────────────────────────────────────────────────

describe('M3: the server echoes requestId on answering frames', () => {
  it('echoes the start requestId on the live state ack', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: recordingDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1', { requestId: 'req-start' });
    const live = sent.find((frame) => frame.type === 'voice_state' && frame.state === 'live');
    expect(live?.requestId).toBe('req-start');
  });

  it('echoes requestId on parking_list and on the confirm result', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: recordingDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    const proposal = await proposalReady(mount, service, sent);
    await mount.route('c1', ctx(sent) as never, {
      type: 'parking_list',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      requestId: 'req-park',
    } as never);
    const parking = sent.filter((frame) => frame.type === 'parking_updated').at(-1);
    expect(parking?.requestId).toBe('req-park');

    await confirm(mount, sent, 'lane-1', proposal, 'k-echo', { requestId: 'req-confirm' });
    const resolved = sent.find((frame) => frame.type === 'proposal_resolved' && frame.outcome === 'released');
    const receipt = sent.find((frame) => frame.type === 'receipt_event');
    expect(resolved?.requestId).toBe('req-confirm');
    expect(receipt?.requestId).toBe('req-confirm');
  });
});

// ── M4: worker-status context injection is wired ─────────────────────────────

describe('M4: worker-status changes are injected as structured, coalesced context', () => {
  it('injects one structured update per change and nothing for an unchanged status', async () => {
    const service = new FakeService();
    let busy = false;
    const mount = new VoiceLiveMount({ service, delivery: recordingDelivery(), isWorkerBusy: async () => busy });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    await mount.refreshWorkerStatuses();
    expect(service.contexts).toHaveLength(1);
    expect(service.contexts[0].update).toMatchObject({
      workerActivity: 'idle',
      statusLine: 'CURRENT STATUS: IDLE',
    });

    await mount.refreshWorkerStatuses();
    expect(service.contexts).toHaveLength(1); // unchanged → nothing new

    busy = true;
    await mount.refreshWorkerStatuses();
    expect(service.contexts).toHaveLength(2);
    expect(service.contexts[1].update).toMatchObject({
      workerActivity: 'busy',
      statusLine: 'CURRENT STATUS: RUNNING',
    });
  });

  it('defers injection while the operator is speaking and flushes on speech end', async () => {
    const service = new FakeService();
    let busy = false;
    const mount = new VoiceLiveMount({ service, delivery: recordingDelivery(), isWorkerBusy: async () => busy });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await mount.refreshWorkerStatuses(); // idle injected
    expect(service.contexts).toHaveLength(1);

    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      state: 'speech_start',
      atMs: 1,
    } as never);
    busy = true;
    await mount.refreshWorkerStatuses();
    expect(service.contexts).toHaveLength(1); // nothing injected while the operator speaks

    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      state: 'speech_end',
      atMs: 2,
    } as never);
    expect(service.contexts).toHaveLength(2);
    expect(service.contexts[1].update.workerActivity).toBe('busy');
  });
});

// ─ M5: commission lead-in / polite interpolation ────────────────────────────

describe('M5: the commission channel is stripped from lead-in and interpolated shapes', () => {
  it('strips a lead-in particle before the commission frame', () => {
    const result = normaliseRelayText('yeah tell the worker to, um, check the, uh, retry handler');
    expect(result.text).not.toMatch(/tell\s+the\s+worker/i);
    expect(result.text).toContain('check the, retry handler');
  });

  it('strips a polite interpolation inside the commission frame', () => {
    expect(normaliseRelayText('Please tell the worker, if you would, to check line 10.').text).toBe(
      'check line 10.'
    );
    expect(normaliseRelayText('Could you tell the worker, if you could, to hold phase three?').text).toBe(
      'hold phase three?'
    );
  });

  it('does not regress the F-5 shape and leaves an unknown continuation alone', () => {
    expect(normaliseRelayText('Ask it to update the changelog.').text).toBe('update the changelog.');
    expect(normaliseRelayText('ask the worker nicely to stop').text).toBe('ask the worker nicely to stop');
  });

  it('keeps the particle on ordinary speech (only a following commission is the channel)', () => {
    expect(normaliseRelayText('yeah, the tests are green').text).toBe('yeah, the tests are green');
    expect(normaliseRelayText('please check the logs').text).toBe('please check the logs');
  });
});

// ── M6: echo / self-transcript exclusion ─────────────────────────────────────

describe('M6: talker echo never releases the gate', () => {
  it('ignores a confirmation inside the echo window and accepts a later one', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await relayToWorker(service, mount, 'lane-1', 'check the tests.');
    await flush();
    // The talker's read-back completes the presentation AND puts its audio in
    // the room. The echo window is armed by that AUDIO (M5): transcripts are
    // not sound, so the chunks are emitted explicitly here.
    talkerAudio(service, 'lane-1', 0);
    clock.advance(200);
    talkerAudio(service, 'lane-1', 1);
    clock.advance(200);
    talkerSays(service, 'lane-1', 'I will ask the worker to check the tests.');
    await flush();

    clock.advance(200);
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();
    expect(delivery.calls).toHaveLength(0);
    expect(
      events.some(
        (event) => event.event === 'operator_utterance_echo_suspect' && event.reason === 'talker_audio_window'
      )
    ).toBe(true);

    clock.advance(5_000);
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();
    expect(delivery.calls).toHaveLength(1);
  });

  it('never creates a proposal from a spoken instruction alone (only the model relays)', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: recordingDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      state: 'speech_start',
      atMs: 1,
    } as never);
    // A commission-shaped transcript is now just conversation: no proposal.
    // It is ALSO echo-suspect (speech is active), so it is never recorded as a
    // relay source — the operator's words while speech is active are dropped.
    utterance(service, 'lane-1', 'Tell the worker to check the tests.');
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);

    // Only the model's relay tool call creates the proposal, and operator speech
    // state is not an authority gate on it. But the relay still needs a SOURCE:
    // the only words it could bind to were echo-suspect and never recorded, so
    // the honest answer is a provenance refusal, not a guess.
    await mount.handleToolRequest({ laneId: 'lane-1', name: 'relay_to_worker', args: { text: 'check the tests.' }, atMs: 1 });
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);

    // Speech ends; the operator's next words are recorded, and the relay binds
    // and creates — the speech state itself never gated anything.
    await mount.route('c1', ctx(sent) as never, {
      type: 'voice_activity_state',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      state: 'speech_end',
      atMs: 2,
    } as never);
    utterance(service, 'lane-1', 'check the tests.');
    await flush();
    await mount.handleToolRequest({ laneId: 'lane-1', name: 'relay_to_worker', args: { text: 'check the tests.' }, atMs: 3 });
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(1);
  });

  it('flags a transcript that reproduces the talker output even outside the time window', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 100,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    talkerSays(service, 'lane-1', 'I have asked the worker to check the retry handler.');
    await flush();
    clock.advance(60_000);
    utterance(service, 'lane-1', 'I have asked the worker to check the retry handler.');
    await flush();
    expect(
      events.some(
        (event) => event.event === 'operator_utterance_echo_suspect' && event.reason === 'talker_output_overlap'
      )
    ).toBe(true);
  });
});

// ── M6-fix (W4 campaign M4): the echo guard must not discard a genuine late final ─

/**
 * The W4 `*-et-high` failure (C01/C03/C05): the extended-thinking talker
 * starts speaking before the operator's transcript finalises, so the final
 * lands inside the talker's audio window and the guard suppressed it with
 * `talker_audio_window` — no kernel utterance, the relay bound to zero
 * candidates, `unbound_source`, cell dead. The discriminator the guard was
 * missing is WHEN the operator actually spoke: the client already reports
 * its own VAD boundaries (`voice_activity_state`). The time window alone may
 * suppress only when the operator's speech window OVERLAPS the talker's
 * audio; a speech window that ended before the talker's audio began is a
 * genuine utterance whose transcript finalised late.
 */
describe('M6-fix: a final whose speech window precedes the talker audio is genuine, not echo', () => {
  const OPERATOR_TEXT = 'I want to find out about Pod Point.';

  it('(the defect) accepts a late final whose speech ended before the talker audio began, binds the relay, and releases through the ordinary gate', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    // The operator speaks and stops (the client's local VAD boundaries).
    await speech(mount, sent, 'lane-1', 'speech_start');
    clock.advance(150);
    await speech(mount, sent, 'lane-1', 'speech_end');

    // The et-high model answers BEFORE the operator's transcript finalises:
    // talker audio is in the room from t+450 onward and keeps the window alive.
    clock.advance(300);
    talkerAudio(service, 'lane-1', 0);
    clock.advance(250);
    talkerAudio(service, 'lane-1', 1);

    // The final transcript lands INSIDE the talker's audio window — but the
    // operator's own speech window had already closed.
    clock.advance(250);
    utterance(service, 'lane-1', OPERATOR_TEXT);
    await flush();

    expect(echoSuspect(events, 'talker_audio_window')).toHaveLength(0);
    expect(events.filter((event) => event.event === 'operator_utterance_late_final_accepted')).toHaveLength(1);

    // The relay binds to the accepted utterance and the ordinary gate runs.
    await mount.handleToolRequest({ laneId: 'lane-1', name: 'relay_to_worker', args: { text: OPERATOR_TEXT }, atMs: 2 });
    await flush();
    const proposal = proposalFrom(sent);
    await reportPresentation(mount, sent, 'lane-1', proposal);
    expect(await confirm(mount, sent, 'lane-1', proposal, 'k-late-final')).toBeNull();
    expect(delivery.calls).toEqual([{ workerSessionId: 'W1', text: proposal.tidied }]);
  });

  it('still suppresses when the operator VAD fires inside the talker audio (the true echo shape)', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    // The talker is speaking.
    talkerAudio(service, 'lane-1', 0);
    clock.advance(400);
    talkerAudio(service, 'lane-1', 1);

    // The operator's VAD opens and closes INSIDE the talker's audio: the mic
    // plausibly holds the talker's voice, so the transcript is echo-suspect.
    await speech(mount, sent, 'lane-1', 'speech_start');
    clock.advance(200);
    await speech(mount, sent, 'lane-1', 'speech_end');
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();

    const suspect = echoSuspect(events, 'talker_audio_window');
    expect(suspect).toHaveLength(1);
    expect(suspect[0].speechOverlap).toBe('overlaps');
    expect(events.some((event) => event.event === 'operator_utterance_late_final_accepted')).toBe(false);

    // Never gate input: the relay it would have fed has no source (the honest
    // refusal the campaign records — but here it is the CORRECT outcome).
    await mount.handleToolRequest({ laneId: 'lane-1', name: 'relay_to_worker', args: { text: 'Yes, send that.' }, atMs: 2 });
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);
    expect(delivery.calls).toHaveLength(0);
  });

  it('keeps the conservative suppression when no activity frames were ever sent', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    talkerAudio(service, 'lane-1', 0);
    clock.advance(400);
    talkerAudio(service, 'lane-1', 1);
    clock.advance(200);
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();

    const suspect = echoSuspect(events, 'talker_audio_window');
    expect(suspect).toHaveLength(1);
    expect(suspect[0].speechOverlap).toBe('unknown');
  });

  it('still suppresses an otherwise-accepted late final that reproduces the talker output (content backstop stays armed)', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    // Speech ended before the talker audio began — the time rule would accept.
    await speech(mount, sent, 'lane-1', 'speech_start');
    clock.advance(150);
    await speech(mount, sent, 'lane-1', 'speech_end');
    clock.advance(300);
    talkerAudio(service, 'lane-1', 0);
    talkerSays(service, 'lane-1', 'I have asked the worker to check the retry handler.');
    clock.advance(300);

    // …but the bytes are the talker's own last output: the time-independent
    // content rule suppresses regardless of the window arithmetic.
    utterance(service, 'lane-1', 'I have asked the worker to check the retry handler.');
    await flush();

    expect(echoSuspect(events, 'talker_output_overlap')).toHaveLength(1);
    expect(events.some((event) => event.event === 'operator_utterance_late_final_accepted')).toBe(false);
  });

  it('consumes the accepted speech window, so a later window-less final inside the talker audio stays conservative', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: recordingDelivery(),
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    await speech(mount, sent, 'lane-1', 'speech_start');
    clock.advance(150);
    await speech(mount, sent, 'lane-1', 'speech_end');
    clock.advance(300);
    talkerAudio(service, 'lane-1', 0);
    clock.advance(400);
    talkerAudio(service, 'lane-1', 1);
    clock.advance(250);
    utterance(service, 'lane-1', OPERATOR_TEXT);
    await flush();
    expect(events.filter((event) => event.event === 'operator_utterance_late_final_accepted')).toHaveLength(1);

    // The talker keeps speaking; a further final arrives with NO new VAD
    // frames. The accepted window was consumed, so this one is unknown and
    // keeps today's conservative suppression.
    talkerAudio(service, 'lane-1', 2);
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();

    const suspect = echoSuspect(events, 'talker_audio_window');
    expect(suspect).toHaveLength(1);
    expect(suspect[0].speechOverlap).toBe('unknown');
  });
});

// ── M5 (voice-native campaign): the echo window is armed by AUDIO, not text ──

/**
 * The et-high confound the W4 fix could not see (C01-et-high/attempt-03): the
 * echo window armed on BOTH `audio_out` and talker transcript events. A
 * talker transcript final routinely flushes a second or more AFTER its audio
 * finished (the provider flushes finals at the turn boundary), so the
 * transcript re-armed the suppression window over a quiet room, the
 * operator's VAD then opened "inside" that phantom window, and the genuine
 * spoken confirm was suppressed as echo — no release, deadline exceeded.
 *
 * Echo is acoustic: the operator's microphone can only pick up the talker
 * while the talker's audio is actually playing. The window (and the
 * mid-speech overlap mark) must arm from `audio_out` alone. Talker
 * transcripts keep their other jobs — the content backstop
 * (`lastTalkerFinalText`) and the spoken read-back — untouched.
 */
describe('M5: the echo window is armed by talker audio, not by talker transcripts', () => {
  it('(the C01-et-high defect) accepts a confirm spoken after the audio stopped but inside a transcript-armed window, and releases', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    // t1: the proposal exists; the talker reads it back aloud.
    await relayToWorker(service, mount, 'lane-1', 'Relay to worker I want to find out about Podpoint.');
    await flush();
    const proposal = proposalFrom(sent);

    // The read-back AUDIO plays in real-time chunks and stops at t=0.4 s.
    talkerAudio(service, 'lane-1', 0);
    clock.advance(400);
    talkerAudio(service, 'lane-1', 1);
    // The read-back TRANSCRIPT final flushes 1.1 s AFTER the audio stopped —
    // nothing is in the room. (It still completes the spoken presentation.)
    clock.advance(1_100);
    talkerSays(service, 'lane-1', `I will ask the worker to ${proposal.tidied}`);
    await flush();

    // The director's quiescence wait passes; the operator confirms at t=1.7 s
    // — after the audio-armed window expired (t=1.4 s) but inside the window
    // the transcript re-armed (t=1.5 s → 2.5 s).
    clock.advance(200);
    await speech(mount, sent, 'lane-1', 'speech_start');
    clock.advance(1_500);
    await speech(mount, sent, 'lane-1', 'speech_end');

    // Seconds of silence; then, as in the real run, the talker's next final
    // lands a heartbeat before the operator's own transcript finalises.
    clock.advance(4_800);
    talkerSays(service, 'lane-1', 'I will send that over for approval now.');
    clock.advance(100);
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();

    // The confirm is genuine: no talker audio was playing — or armed —
    // anywhere near it. It must reach the gate and release the proposal.
    expect(echoSuspect(events, 'talker_audio_window')).toHaveLength(0);
    expect(events.some((event) => event.event === 'operator_utterance' && event.text === 'Yes, send that.')).toBe(true);
    expect(delivery.calls).toEqual([{ workerSessionId: 'W1', text: proposal.tidied }]);
  });

  it('a talker transcript landing while the operator VAD is open marks nothing (transcripts are not sound)', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    // No audio_out has ever been emitted: nothing of the talker is in the
    // room. The operator speaks; a talker final flushes mid-speech (the turn
    // boundary catching up with long-settled audio).
    await speech(mount, sent, 'lane-1', 'speech_start');
    clock.advance(200);
    talkerSays(service, 'lane-1', 'I have asked the worker to check the retry handler.');
    clock.advance(200);
    await speech(mount, sent, 'lane-1', 'speech_end');
    clock.advance(400);
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();

    // Today the transcript re-armed the window and marked the open VAD, so
    // the final was suppressed. Nothing acoustic happened: gate input.
    expect(echoSuspect(events, 'talker_audio_window')).toHaveLength(0);
    expect(events.some((event) => event.event === 'operator_utterance' && event.text === 'Yes, send that.')).toBe(true);
  });

  it('a talker text-only turn (no audio_out ever) arms nothing: a later window-less final is not suppressed', async () => {
    const clock = makeClock();
    const events: Record<string, unknown>[] = [];
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      now: clock.now,
      echoSuppressionWindowMs: 1_000,
      evidence: (event) => events.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');

    // A text-only turn produced a transcript final but never any audio —
    // nothing was in the room to echo.
    talkerSays(service, 'lane-1', 'I have asked the worker to check the retry handler.');
    clock.advance(600);
    // The operator's final arrives with no activity frames either.
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();

    expect(echoSuspect(events, 'talker_audio_window')).toHaveLength(0);
    expect(events.some((event) => event.event === 'operator_utterance' && event.text === 'Yes, send that.')).toBe(true);
  });
});

// ── H3-server: presentation enforcement ─────────────────────────────────────

describe('H3-server: a release requires a presented proposal and a real identity', () => {
  it('announces presentation.completed=false and refuses a confirm before a presentation report', async () => {
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await relayToWorker(service, mount, 'lane-1', 'deploy to staging.');
    await flush();
    const proposal = proposalFrom(sent);
    expect(proposal.presentation.completed).toBe(false);

    const code = await confirm(mount, sent, 'lane-1', proposal, 'k-not-presented');
    expect(code).toBe('voice_presentation_incomplete');
    expect(delivery.calls).toHaveLength(0);
  });

  it('refuses a typed confirm with no identity echo (no fabrication from the live proposal)', async () => {
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    const proposal = await proposalReady(mount, service, sent);
    const code = await confirm(mount, sent, 'lane-1', proposal, 'k-no-echo', { echo: false });
    expect(code).toBe('voice_confirm_requires_proposal');
    expect(delivery.calls).toHaveLength(0);

    // The same confirm WITH the echo and a completed presentation does release.
    expect(await confirm(mount, sent, 'lane-1', proposal, 'k-echo-ok')).toBeNull();
    expect(delivery.calls).toHaveLength(1);
  });

  it('refuses a spoken confirm before the talker read-back and accepts it after', async () => {
    const service = new FakeService();
    const delivery = recordingDelivery();
    // The echo window is a separate concern (M6); disable it here so this test
    // isolates the presentation gate.
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      echoSuppressionWindowMs: 0,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await relayToWorker(service, mount, 'lane-1', 'check the tests.');
    await flush();

    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();
    expect(delivery.calls).toHaveLength(0);

    talkerSays(service, 'lane-1', 'I will ask the worker to check the tests.');
    await flush();
    utterance(service, 'lane-1', 'Yes, send that.');
    await flush();
    expect(delivery.calls).toHaveLength(1);
  });

  it('never fabricates a release through a presentation for another proposal', async () => {
    const service = new FakeService();
    const delivery = recordingDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, 'lane-1');
    await relayToWorker(service, mount, 'lane-1', 'check the tests.');
    await flush();
    const first = proposalFrom(sent);
    // A report naming a different proposal does not present the live one.
    await mount.route('c1', ctx(sent) as never, {
      type: 'proposal_presentation',
      version: 1,
      laneId: 'lane-1',
      attachmentGeneration: 1,
      proposalId: 'prop-does-not-exist',
      presentedVariant: 'tidied',
      completed: true,
    } as never);
    const code = await confirm(mount, sent, 'lane-1', first, 'k-other');
    expect(code).toBe('voice_presentation_incomplete');
    expect(delivery.calls).toHaveLength(0);
  });
});

// ── L1: evidence-log hygiene ────────────────────────────────────────────────

describe('L1: the default evidence sink never logs full instruction text', () => {
  it('projects text fields to a bounded excerpt and scrubs credential shapes', () => {
    const long = 'check the retry handler '.repeat(20);
    const secret = 'AIzaSENTINEL0123456789abcdefghij';
    const projected = projectEvidenceEvent({
      event: 'confirm_authorised',
      bytes: long,
      relayText: `${secret} please`,
      original: long,
      tidied: long,
      text: long,
    });
    expect(projected.bytes).toBeUndefined();
    expect(projected.relayText).toBeUndefined();
    expect(String(projected.bytesExcerpt).length).toBeLessThanOrEqual(120);
    expect(projected.bytesChars).toBe(long.length);
    expect(projected.bytesTruncated).toBe(true);

    const lines: string[] = [];
    const sink = createLogEvidenceSink({ info: (message) => lines.push(message) });
    sink({
      event: 'confirm_authorised',
      bytes: long,
      relayText: `${secret} please`,
      original: long,
      tidied: long,
      text: long,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(long);
    expect(lines[0]).not.toContain(secret);
    expect(lines[0]).toContain('bytesExcerpt');
    expect(lines[0]).toContain('relayTextExcerpt');
  });
});