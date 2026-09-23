/**
 * Phase 5 (Track F) mount tests — the router handler, the kernel delegate and
 * the operator-speech adapter, against a fake bridge service and a recording
 * delivery adapter. Hermetic: no provider, no socket, no worker.
 *
 * The invariants pinned here are the ones the vertical slice depends on:
 *   - a confirmation is refused unless it names a live proposal for this lane
 *     with a matching identity and a completed read-back;
 *   - the delivery adapter is reached ONLY through an authorised confirmation,
 *     and it receives the proposal's exact retained bytes;
 *   - a duplicate confirmation never delivers twice;
 *   - directed speech creates a proposal while the worker is idle and parks
 *     while the worker is busy; ordinary speech does neither;
 *   - a spoken confirmation releases the lane's live proposal.
 */

import { describe, expect, it } from 'vitest';

import type {
  VoiceBridgeEmittedEvent,
  VoiceBridgeLaneState,
  VoiceBridgeService,
  VoiceBridgeStartOptions,
  VoiceStopReason,
  VoiceActivityNote,
  VoiceReadingLevel,
  VoiceBridgeContextUpdate,
  VoiceAudioInputChunk,
} from '../../../src/voice/contract.js';
import type { DeliveryOutcome, WorkerDelivery } from '../../../src/talker/types.js';
import { VoiceLiveMount } from '../../../src/websocket/voice-live-mount.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

const LANE = 'lane-1';
const GENERATION = 1;

class FakeService implements VoiceBridgeService {
  private readonly listeners = new Set<(event: VoiceBridgeEmittedEvent) => void>();
  readonly states = new Map<string, VoiceBridgeLaneState>();
  readonly starts: VoiceBridgeStartOptions[] = [];
  readonly contextUpdates: VoiceBridgeContextUpdate[] = [];
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
  injectContext(_laneId: string, update: VoiceBridgeContextUpdate): void {
    this.contextUpdates.push(update);
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
  [key: string]: unknown;
}

function makeDelivery(outcome: DeliveryOutcome = { outcome: 'delivered', mechanism: 'prompt' }): WorkerDelivery & {
  calls: Array<{ workerSessionId: string; text: string }>;
} {
  const calls: Array<{ workerSessionId: string; text: string }> = [];
  return {
    calls,
    describe: () => 'test delivery',
    async deliver({ workerSessionId, text }) {
      calls.push({ workerSessionId, text });
      return outcome;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A real bounded wait (the transcription-race tests stage late arrivals). */
const waitMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A relay whose tool payload the test keeps a handle on, without awaiting yet. */
function startRelay(
  mount: VoiceLiveMount,
  text: string,
  atMs: number,
): Promise<Record<string, unknown>> {
  return mount.handleToolRequest({
    laneId: LANE,
    name: 'relay_to_worker',
    args: { text },
    atMs,
  }) as Promise<Record<string, unknown>>;
}

async function startLane(
  mount: VoiceLiveMount,
  sent: Sent[],
  service: FakeService,
  workerSessionId = 'worker-1'
): Promise<void> {
  const code = await mount.route(
    'client-1',
    { send: (message) => sent.push(message as unknown as Sent) },
    {
      type: 'voice_session_start',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      workerSessionId,
    } as never
  );
  expect(code).toBeNull();
  expect(service.starts).toHaveLength(1);
}

function utterance(service: FakeService, text: string, generation = GENERATION): void {
  service.emit({
    kind: 'transcript',
    laneId: LANE,
    attachmentGeneration: generation,
    speaker: 'operator',
    source: 'native',
    text,
    final: true,
    atMs: 1,
  });
}

/** The model-driven relay: the native talker calls `relay_to_worker`. */
async function relay(mount: VoiceLiveMount, text: string): Promise<void> {
  await mount.handleToolRequest({ laneId: LANE, name: 'relay_to_worker', args: { text }, atMs: 1 });
}

/** The same call, but capturing the tool payload the bridge hands the model. */
async function relayResponse(
  mount: VoiceLiveMount,
  text: string,
): Promise<Record<string, unknown>> {
  const response = await mount.handleToolRequest({
    laneId: LANE,
    name: 'relay_to_worker',
    args: { text },
    atMs: 1,
  });
  expect(response).toBeDefined();
  return response as Record<string, unknown>;
}

describe('VoiceLiveMount — the relay is model-driven, not classified', () => {
  it('tells the model the HOST reads the proposal back — it does not recite it (H2)', async () => {
    // Fix-loop pass 1: the tool response asked the model to "Read the exact
    // text back to the operator verbatim"; the models usually did not, and
    // presentation stalled before anything could be confirmed.
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests.');
    await flush();
    const response = await relayResponse(mount, 'check the tests.');
    const note = response.note as string;
    expect(typeof note).toBe('string');
    expect(note).toMatch(/The host reads the proposal aloud to the operator/i);
    expect(note).toMatch(/do not read it back yourself/i);
    expect(note).toMatch(/prepared/i);
    expect(note).toMatch(/after they hear it/i);
    // The falsified verbatim-recital instruction is gone.
    expect(note).not.toMatch(/read the exact text back to the operator verbatim/i);
    // The delivery-honesty language is kept byte-intact.
    expect(note).toMatch(/nothing has been sent yet/);
    expect(note).toMatch(/Do not claim it was sent/);
  });

  it('creates a proposal from a relay_to_worker tool call, and sends nothing', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    // The relay answers something the operator said: the source it binds to.
    utterance(service, 'check the tests');
    await flush();

    const payload = await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'check the tests' },
      atMs: 1,
    });

    expect(payload).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
    const created = sent.filter((frame) => frame.type === 'proposal_created');
    expect(created).toHaveLength(1);
    expect((created[0].proposal as { tidied: string }).tidied).toBe('check the tests');
    // The tool call can only propose; nothing reaches the worker without approval.
    expect(delivery.calls).toHaveLength(0);
  });

  it('parks a relay_to_worker call while the worker is busy', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => true });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests');
    await flush();

    const payload = await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'check the tests' },
      atMs: 1,
    });

    expect(payload).toMatchObject({ ok: true, status: 'parked' });
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);
    const parking = sent.filter((frame) => frame.type === 'parking_updated');
    expect(parking).toHaveLength(1);
    expect((parking[0].items as Array<{ text: string }>)[0].text).toBe('check the tests');
    expect(delivery.calls).toHaveLength(0);
  });

  it('refuses an empty relay without creating a proposal', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    const payload = await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: '   ' },
      atMs: 1,
    });
    expect(payload).toMatchObject({ ok: false });
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);
  });

  it('ignores an identical relay tool call inside the duplicate window', async () => {
    // Observed live 2026-09-22: the model emitted the same relay twice 483 ms
    // apart and the operator was shown two identical parked items.
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests');
    await flush();
    const first = await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'check the tests' },
      atMs: 1_000,
    });
    const repeat = await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'check the tests' },
      atMs: 1_483,
    });
    expect(first).toMatchObject({ status: 'awaiting_operator_approval' });
    expect(repeat).toMatchObject({ status: 'duplicate_ignored' });
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(1);
  });

  it('honours the same relay again once the duplicate window has passed', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests');
    await flush();
    await mount.handleToolRequest({ laneId: LANE, name: 'relay_to_worker', args: { text: 'check the tests' }, atMs: 1_000 });
    const later = await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'check the tests' },
      atMs: 10_000,
    });
    expect(later).toMatchObject({ status: 'awaiting_operator_approval' });
    expect(sent.filter((frame) => frame.type === 'proposal_created').length).toBeGreaterThanOrEqual(2);
  });

  it('a relay call while a proposal is live carries the correction guidance (C18, pass-9)', async () => {
    // The model relayed only the correction clause and lost the deploy
    // instruction. The tool response now tells it, at the moment of the call,
    // that a correction must be the FULL amended instruction.
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'Relay to worker, deploy the hot fix to staging.');
    await flush();
    const first = (await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'deploy the hot fix to staging' },
      atMs: 1_000,
    })) as { note?: string };
    expect(first.note ?? '').not.toMatch(/CORRECTS that relay/);

    utterance(service, 'Wait, do not deploy anything until I approve it in the ticket first.');
    await flush();
    const second = (await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'do not deploy anything until I approve it in the ticket first' },
      atMs: 2_000,
    })) as { note?: string };
    expect(second.note ?? '').toMatch(/CORRECTS that relay/);
    expect(second.note ?? '').toMatch(/FULL corrected instruction/);
  });
});

describe('VoiceLiveMount — frame routing and the release predicate', () => {
  it('refuses a frame for a lane it never accepted', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const code = await mount.route(
      'client-1',
      { send: () => {} },
      { type: 'proposal_confirm', version: 1, laneId: 'nope', attachmentGeneration: 1, proposalId: 'p', variant: 'tidied', idempotencyKey: 'k' } as never
    );
    expect(code).toBe('voice_lane_unknown');
  });

  it('refuses a stale attachment generation', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    const code = await mount.route(
      'client-1',
      { send: () => {} },
      { type: 'parking_list', version: 1, laneId: LANE, attachmentGeneration: 99 } as never
    );
    expect(code).toBe('voice_generation_stale');
  });

  it('records a capture fault the client reported, and counts it', async () => {
    // The 2026-09-18 native-lane failure: the microphone could not start in the
    // deployed UI and NO server-side record existed. The client now says so.
    const service = new FakeService();
    const evidence: Array<Record<string, unknown>> = [];
    const metrics = new OperationalMetrics();
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
      metrics,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);

    const code = await mount.route('client-1', { send: () => {} }, {
      type: 'voice_activity_state',
      version: 1,
      laneId: LANE,
      attachmentGeneration: 1,
      state: 'speech_end',
      atMs: 1_700_000_000_000,
      captureFault: { reason: 'worklet_unavailable', detail: 'blocked by CSP', atMs: 1_700_000_000_000 },
    } as never);

    expect(code).toBeNull();
    const faultEvent = evidence.find((event) => event.event === 'voice_capture_fault');
    expect(faultEvent).toBeTruthy();
    expect(faultEvent?.reason).toBe('worklet_unavailable');
    expect(faultEvent?.detail).toBe('blocked by CSP');
    expect(metrics.snapshot().voice.live.captureFaultTotal).toEqual({ worklet_unavailable: 1 });
  });

  it('buckets an unrecognised capture-fault reason so the counter stays bounded', () => {
    const metrics = new OperationalMetrics();
    metrics.recordVoiceCaptureFault('something_new_from_a_future_client');
    metrics.recordVoiceCaptureFault('capture_failed');
    expect(metrics.snapshot().voice.live.captureFaultTotal).toEqual({ other: 1, capture_failed: 1 });
  });

  it('hands the live talker the WHOLE session when it fits, then only the deltas', async () => {
    // Measured: a full session is free on the live provider up to ~82k tokens, so
    // the old 12k cap was not buying anything. Deltas afterwards, because a live
    // session ACCUMULATES context and re-sending 40k tokens per change walks it
    // into the stall (docs/plans/VOICE-TALKER-FULL-SESSION-BRIEF.md).
    const service = new FakeService();
    const evidence: Array<Record<string, unknown>> = [];
    const rows = Array.from({ length: 300 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `message ${i} `.padEnd(400, 'x'),
    }));
    let entries = [...rows];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
      workerBrief: async () => ({ activity: 'idle', entries, total: entries.length }),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);

    await mount.refreshWorkerStatuses();
    const first = service.contextUpdates.at(-1)?.note ?? '';
    expect(first).toContain('WORKER SESSION HISTORY');
    expect(first).toContain('message 1 x');   // the WHOLE session, not a recent slice
    expect(first).toContain('message 298 ');
    expect(evidence.filter((event) => event.event === 'worker_brief_injected').at(-1)?.mode).toBe('full');

    // New work: a delta, not another 120k characters.
    entries = [...entries, { role: 'assistant', text: 'and finally a purple triangle' }];
    await mount.refreshWorkerStatuses();
    const delta = service.contextUpdates.at(-1)?.note ?? '';
    expect(delta).toContain('purple triangle');
    expect(delta).not.toContain('message 1 x');
    expect(delta.length).toBeLessThan(1_000);
    expect(evidence.filter((event) => event.event === 'worker_brief_injected').at(-1)?.mode).toBe('delta');
  });

  it('falls back to a bounded window above the ceiling, and says what it is not showing', async () => {
    const service = new FakeService();
    const rows = Array.from({ length: 1_000 }, (_, i) => ({
      role: 'assistant' as const,
      text: `bulk ${i} `.padEnd(400, 'y'),
    }));
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      workerBrief: async () => ({ activity: 'idle', entries: rows, total: rows.length }),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    await mount.refreshWorkerStatuses();

    const note = service.contextUpdates.at(-1)?.note ?? '';
    expect(note).toContain('WORKER SESSION HISTORY');
    expect(note).toMatch(/earlier are not included/);
    expect(note.length).toBeLessThan(20_000);
  });

  it('answers a read_worker_history call with the messages the window hid', async () => {
    const service = new FakeService();
    const rows = [
      { role: 'user' as const, text: 'Please find out why the retry handler dropped the session token.' },
      { role: 'assistant' as const, text: 'Traced it to the auth retry wrapper clearing the header early.' },
      { role: 'user' as const, text: 'Unrelated: rename the parking glyph.' },
      { role: 'assistant' as const, text: 'Renamed; it is a purple triangle now.' },
    ];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
      workerBrief: async () => ({ activity: 'idle', entries: rows, total: rows.length }),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    await mount.refreshWorkerStatuses();

    const payload = await mount.handleToolRequest({
      laneId: LANE,
      name: 'read_worker_history',
      args: { query: 'retry handler session token' },
      atMs: 1_700_000_000_000,
    });

    // The tool RESPONSE carries the text: the model reads it in the same turn.
    expect(String(payload && payload.history)).toContain('auth retry wrapper');
    expect(String(payload && payload.history)).toMatch(/searched 4 messages/);
    expect(evidence.filter((event) => event.event === 'worker_history_retrieved').at(-1)?.matches).toBeGreaterThan(0);
  });

  it('answers retrieval for anything it cannot see with a plain "not in the session"', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      workerBrief: async () => ({
        activity: 'idle',
        entries: [{ role: 'user', text: 'only a tiny bit of work here' }],
        total: 1,
      }),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);

    const payload = await mount.handleToolRequest({
      laneId: LANE,
      name: 'read_worker_history',
      args: { query: 'kubernetes ingress certificate rotation' },
      atMs: 1,
    });
    expect(String(payload && payload.history)).toMatch(/No message in this session matches/i);
  });

  it('has no payload for an unknown tool (nothing is silently forwarded)', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    expect(
      await mount.handleToolRequest({ laneId: LANE, name: 'not_a_tool' as never, args: {}, atMs: 1 })
    ).toBeUndefined();
  });

  it('injects the status alone when the host cannot read a brief (never an invented one)', async () => {
    const service = new FakeService();
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => true,
      evidence: (event) => evidence.push(event),
      workerBrief: async () => {
        throw new Error('session not loaded');
      },
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    await mount.refreshWorkerStatuses();

    const last = service.contextUpdates.at(-1);
    expect(last?.statusLine).toBe('CURRENT STATUS: RUNNING');
    expect(last?.note).toBeUndefined();
    // And the journal says so POSITIVELY. The 2026-09-18 operator report was
    // diagnosable only by noticing which event was missing; a lane handed a status
    // line and nothing about the work now records that fact itself.
    expect(evidence.filter((event) => event.event === 'worker_brief_empty')).toHaveLength(1);
    expect(evidence.filter((event) => event.event === 'worker_brief_injected')).toHaveLength(0);
  });

  it('delivers the exact retained bytes when a confirmation is authorised', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests.');
    await flush();
    await relay(mount, 'check the tests.');

    const proposal = sent.find((frame) => frame.type === 'proposal_created') as Sent;
    expect(proposal).toBeDefined();
    const payload = proposal.proposal as { proposalId: string; tidied: string; version: number; sha256: string };
    expect(payload.tidied).toBe('check the tests.');

    // A tampered identity echo is refused and consumes nothing.
    const refused = await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      {
        type: 'proposal_confirm',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: payload.proposalId,
        variant: 'tidied',
        idempotencyKey: 'idem-bad',
        proposalRef: { version: payload.version, sha256: 'ff'.repeat(32) },
      } as never
    );
    expect(refused).toBe('voice_proposal_stale');
    expect(delivery.calls).toHaveLength(0);

    // The genuine confirmation delivers byte-for-byte what the proposal held.
    // H3: the read-back must have completed before a release is allowed, and the
    // identity echo is required on the typed path.
    await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      {
        type: 'proposal_presentation',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: payload.proposalId,
        presentedVariant: 'tidied',
        completed: true,
      } as never
    );
    const code = await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      {
        type: 'proposal_confirm',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: payload.proposalId,
        variant: 'tidied',
        idempotencyKey: 'idem-1',
        proposalRef: { version: payload.version, sha256: payload.sha256 },
      } as never
    );
    expect(code).toBeNull();
    expect(delivery.calls).toEqual([{ workerSessionId: 'worker-1', text: payload.tidied }]);
    const receipt = sent.find((frame) => frame.type === 'receipt_event') as Sent;
    expect((receipt.receipt as { outcome: string }).outcome).toBe('delivered');
  });

  it('never delivers twice for a duplicate confirmation', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests.');
    await flush();
    await relay(mount, 'check the tests.');
    const payload = (sent.find((frame) => frame.type === 'proposal_created') as Sent).proposal as {
      proposalId: string;
      version: number;
      sha256: string;
    };
    const send = (message: unknown): void => {
      sent.push(message as Sent);
    };
    const confirm = (idempotencyKey: string): Promise<string | null> =>
      mount.route(
        'client-1',
        { send },
        {
          type: 'proposal_confirm',
          version: 1,
          laneId: LANE,
          attachmentGeneration: GENERATION,
          proposalId: payload.proposalId,
          variant: 'tidied',
          idempotencyKey,
          // H3: the typed/card path requires the identity echo.
          proposalRef: { version: payload.version, sha256: payload.sha256 },
        } as never
      );
    // H3: and a completed read-back (the presentation state, now enforced).
    await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_presentation',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: payload.proposalId,
        presentedVariant: 'tidied',
        completed: true,
      } as never
    );
    expect(await confirm('idem-a')).toBeNull();
    expect(await confirm('idem-b')).toBe('voice_proposal_stale');
    expect(delivery.calls).toHaveLength(1);
  });

  it('refuses a confirmation whose read-back reported itself incomplete', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests.');
    await flush();
    await relay(mount, 'check the tests.');
    const payload = (sent.find((frame) => frame.type === 'proposal_created') as Sent).proposal as {
      proposalId: string;
      version: number;
      sha256: string;
    };
    const send = (message: unknown): void => {
      sent.push(message as Sent);
    };
    await mount.route(
      'client-1',
      { send },
      {
        type: 'proposal_presentation',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        proposalId: payload.proposalId,
        presentedVariant: 'tidied',
        completed: false,
        stoppedAtChar: 3,
      } as never
    );
    const code = await confirmWith(mount, send, payload.proposalId, payload.version, payload.sha256, 'idem-incomplete');
    expect(code).toBe('voice_presentation_incomplete');
    expect(delivery.calls).toHaveLength(0);
  });

  it('promotes one parked item and keeps the rest parked', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => true });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the logs.');
    await flush();
    await relay(mount, 'check the logs.');
    utterance(service, 'update the changelog.');
    await flush();
    await relay(mount, 'update the changelog.');

    const parking = sent.filter((frame) => frame.type === 'parking_updated');
    expect(parking).toHaveLength(2);
    const items = (parking[1].items as Array<{ itemId: string; text: string }>);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('check the logs.');
    expect(items[1].text).toBe('update the changelog.');

    const code = await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      { type: 'parking_promote', version: 1, laneId: LANE, attachmentGeneration: GENERATION, itemId: items[0].itemId } as never
    );
    expect(code).toBeNull();
    const created = sent.find((frame) => frame.type === 'proposal_created') as Sent;
    const payload = created.proposal as { promotionRoute: string; sourceItemId: string; tidied: string };
    expect(payload.promotionRoute).toBe('parked_item');
    expect(payload.sourceItemId).toBe(items[0].itemId);
    expect(payload.tidied).toBe(items[0].text);

    await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      { type: 'parking_list', version: 1, laneId: LANE, attachmentGeneration: GENERATION } as never
    );
    const listed = sent.filter((frame) => frame.type === 'parking_updated').at(-1) as Sent;
    expect((listed.items as unknown[]).length).toBe(1);
    expect((listed.items as Array<{ itemId: string }>)[0].itemId).toBe(items[1].itemId);
  });
});

describe('VoiceLiveMount — the operator-speech adapter', () => {
  it('holds nothing for ordinary conversational speech (no relay tool call)', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    // A commission-shaped utterance with NO `relay_to_worker` call is now just
    // conversation: the mechanical predicate that used to hold it is gone.
    utterance(service, 'Tell the worker to check the tests.');
    utterance(service, 'I keep thinking about the retry handler.');
    utterance(service, 'What would you check first?');
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);
    expect(sent.filter((frame) => frame.type === 'parking_updated')).toHaveLength(0);
    expect(delivery.calls).toHaveLength(0);
  });

  it('releases the live proposal on a spoken confirmation, with a stable idempotency key', async () => {
    const service = new FakeService();
    const delivery = makeDelivery({ outcome: 'delivered', mechanism: 'steer' });
    // The echo window (M6) is a separate concern; disabled here so this test
    // isolates the spoken presentation gate.
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      echoSuppressionWindowMs: 0,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    // The relay is model-driven now: the proposal comes from the tool call,
    // answering what the operator just said (its binding source).
    utterance(service, 'check the tests');
    await flush();
    await mount.handleToolRequest({ laneId: LANE, name: 'relay_to_worker', args: { text: 'check the tests' }, atMs: 1 });
    const proposal = (sent.find((frame) => frame.type === 'proposal_created') as Sent).proposal as {
      tidied: string;
    };

    // H3(c): the talker's spoken read-back IS the presentation (intent §18.2).
    service.emit({
      kind: 'transcript',
      laneId: LANE,
      attachmentGeneration: GENERATION,
      speaker: 'talker',
      source: 'native',
      text: `I will ask the worker to ${proposal.tidied}`,
      final: true,
      atMs: 1,
    });
    await flush();

    utterance(service, 'Yes, send that.');
    await flush();
    expect(delivery.calls).toEqual([{ workerSessionId: 'worker-1', text: proposal.tidied }]);
    const receipts = sent.filter((frame) => frame.type === 'receipt_event');
    expect(receipts).toHaveLength(1);
    expect((receipts[0].receipt as { mechanism: string }).mechanism).toBe('steer');

    // A repeated spoken confirmation is a duplicate gesture and must not send again.
    utterance(service, 'Yes, send that.');
    await flush();
    expect(delivery.calls).toHaveLength(1);
  });

  it('cancels the live proposal on a spoken cancel', async () => {
    const service = new FakeService();
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests');
    await flush();
    await mount.handleToolRequest({ laneId: LANE, name: 'relay_to_worker', args: { text: 'check the tests' }, atMs: 1 });
    utterance(service, 'No, forget it.');
    await flush();
    const resolved = sent.filter((frame) => frame.type === 'proposal_resolved');
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as { outcome: string }).outcome).toBe('cancelled');
  });
});

/** Confirm a proposal with an explicit identity echo. */
async function confirmWith(
  mount: VoiceLiveMount,
  send: (message: unknown) => void,
  proposalId: string,
  version: number,
  sha256: string,
  idempotencyKey: string
): Promise<string | null> {
  return mount.route(
    'client-1',
    { send },
    {
      type: 'proposal_confirm',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      proposalId,
      variant: 'tidied',
      idempotencyKey,
      proposalRef: { version, sha256 },
    } as never
  );
}

describe('VoiceLiveMount — what the talker said, and why', () => {
  it('records the talker’s reply and its tool calls, so a complaint is checkable', async () => {
    const service = new FakeService();
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);

    service.emit({
      kind: 'transcript',
      laneId: LANE,
      attachmentGeneration: 1,
      speaker: 'talker',
      text: 'From what I can see, the worker rewrote the retry handler and added a test.',
      final: true,
      atMs: 1_700_000_000_100,
    } as never);
    service.emit({
      kind: 'tool_call',
      laneId: LANE,
      attachmentGeneration: 1,
      callId: 'c1',
      name: 'read_worker_history',
      args: {},
      atMs: 1_700_000_000_101,
    } as never);
    await Promise.resolve();

    const reply = evidence.find((event) => event.event === 'talker_reply');
    expect(reply?.excerpt).toContain('rewrote the retry handler');
    expect(reply?.chars).toBeGreaterThan(20);
    expect(evidence.find((event) => event.event === 'talker_tool_call')?.tool).toBe('read_worker_history');
  });
});

// ── Phase 3 (native-primary, child H): relay/approval fidelity ──────────────

/** Relay with an explicit tool-call timestamp (the duplicate window needs real gaps). */
async function relayAt(mount: VoiceLiveMount, text: string, atMs: number): Promise<Record<string, unknown>> {
  return (
    (await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text },
      atMs,
    })) as Record<string, unknown>
  );
}

describe('Phase 3 — independent original-wording retention (RED-4)', () => {
  it('preserves the originating operator words as the proposal original', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    await startLane(mount, sent, service);
    utterance(service, 'I want to find out about Podpoint');
    await flush();
    await relayAt(mount, 'Find out about Podpoint', 2);
    const created = sent.find((f) => f.type === 'proposal_created') as {
      proposal?: { original?: string; tidied?: string; sourceUtteranceId?: number };
    };
    // The operator's own recognised words — not the model's tidied text.
    expect(created?.proposal?.original).toBe('I want to find out about Podpoint');
    expect(created?.proposal?.tidied).toBe('Find out about Podpoint');
    expect(created?.proposal?.sourceUtteranceId).toBe(1);
  });

  it('a tidied relay identical to the spoken words offers no spurious variant', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    await startLane(mount, sent, service);
    utterance(service, 'check the build');
    await flush();
    await relayAt(mount, 'check the build', 2);
    const created = sent.find((f) => f.type === 'proposal_created') as {
      proposal?: { original?: string; tidied?: string };
    };
    expect(created?.proposal?.original).toBe(created?.proposal?.tidied);
  });
});

describe('Phase 3 — source-turn binding (RED-5)', () => {
  it('binds the relay tool call to its originating utterance, never the latest', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
    });
    await startLane(mount, sent, service);
    utterance(service, 'Investigate the alternative'); // utterance 1 — the originating one
    await flush();
    utterance(service, 'Actually, forget that for a moment'); // utterance 2 — before the async tool returns
    await flush();
    await relayAt(mount, 'Investigate the alternative', 3);
    const created = sent.filter((f) => f.type === 'proposal_created') as Array<{
      proposal?: { sourceUtteranceId?: number };
    }>;
    expect(created).toHaveLength(1);
    expect(created[0]?.proposal?.sourceUtteranceId).toBe(1);
    // The promotion evidence carries the same provenance.
    const promotion = evidence.find((event) => event.event === 'promotion_authorised');
    expect(promotion?.utteranceId).toBe(1);
  });

  it('refuses an ambiguous relay: no proposal, an honest tool response, evidence', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
    });
    await startLane(mount, sent, service);
    utterance(service, 'Investigate the alternative');
    await flush();
    utterance(service, 'Also, what is the largest file in the repo');
    await flush();
    // The relay matches neither utterance: provenance is ambiguous, hold.
    const response = await relayAt(mount, 'Deploy the staging branch', 3);
    expect(response).toMatchObject({ ok: false, reason: 'ambiguous_source' });
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(0);
    expect(sent.filter((f) => f.type === 'parking_updated')).toHaveLength(0);
    const refusal = evidence.find((event) => event.event === 'relay_tool_call_refused');
    expect(refusal?.reason).toBe('ambiguous_source');
  });

  it('a refused relay leaves the next legitimate relay unaffected (a refusal consumes nothing)', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    await startLane(mount, sent, service);
    utterance(service, 'Investigate the alternative');
    await flush();
    utterance(service, 'Also, what is the largest file in the repo');
    await flush();
    await relayAt(mount, 'Deploy the staging branch', 3); // refused
    // The operator re-asks with distinctive content: the new relay binds to
    // THIS utterance alone (the earlier ones share none of its tokens).
    utterance(service, 'please check the podpoint charger firmware version');
    await flush();
    const response = await relayAt(mount, 'check the podpoint charger firmware version', 5);
    expect(response).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
    const created = sent.filter((f) => f.type === 'proposal_created');
    expect(created).toHaveLength(1);
    expect(((created[0] as { proposal?: { sourceUtteranceId?: number } }).proposal)?.sourceUtteranceId).toBe(3);
  });

  it('RACE (a): a delayed call after a correction binds the corrected utterance, not the original', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => false });
    await startLane(mount, sent, service);
    utterance(service, 'check the build'); // utterance 1 — superseded
    await flush();
    utterance(service, 'check the build but do not deploy'); // utterance 2 — the correction
    await flush();
    // The tool call lands AFTER the correction: provenance follows the
    // corrected words (containment: 3/7 tokens vs u1 is below the floor).
    const response = await relayAt(mount, 'check the build but do not deploy', 3);
    expect(response).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
    const created = sent.find((f) => f.type === 'proposal_created') as {
      proposal?: { sourceUtteranceId?: number; original?: string };
    };
    expect(created?.proposal?.sourceUtteranceId).toBe(2);
    expect(created?.proposal?.original).toBe('check the build but do not deploy');
  });

  it('RACE (b): an attachment-generation change strands pre-bump provenance — the relay refuses, never binds stale', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
    });
    await startLane(mount, sent, service);
    utterance(service, 'check the tests.'); // generation 1 provenance
    await flush();

    // The lane rebinds at generation 2 (worker switch / reattach): a fresh
    // lane record, an empty provenance window.
    const code = await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      {
        type: 'voice_session_start',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION + 1,
        workerSessionId: 'worker-1',
      } as never
    );
    expect(code).toBeNull();

    // The delayed call from the OLD generation arrives: it can no longer be
    // tied to anything the operator said on THIS attachment — it refuses.
    const response = await relayAt(mount, 'check the tests.', 3);
    expect(response).toMatchObject({ ok: false, reason: 'unbound_source' });
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(0);
    const refusal = evidence.find((event) => event.event === 'relay_tool_call_refused');
    expect(refusal?.reason).toBe('unbound_source');

    // The new attachment works normally: fresh words, bound relay.
    utterance(service, 'check the tests.', GENERATION + 1);
    await flush();
    const ok = await relayAt(mount, 'check the tests.', 4);
    expect(ok).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
    const created = sent.filter((f) => f.type === 'proposal_created');
    expect(created).toHaveLength(1);
    // The new attachment restarts its provenance counter: the first post-bump
    // utterance is id 1 ON THIS GENERATION (no stale ids carried over).
    expect(((created[0] as { proposal?: { sourceUtteranceId?: number } }).proposal)?.sourceUtteranceId).toBe(1);
  });

  it('parks with the bound source and promotes carrying the operator original', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({ service, delivery: makeDelivery(), isWorkerBusy: async () => true });
    await startLane(mount, sent, service);
    utterance(service, 'I want to find out about Podpoint');
    await flush();
    const response = await relayAt(mount, 'Find out about Podpoint', 2);
    expect(response).toMatchObject({ ok: true, status: 'parked' });
    // Promote the parked item.
    const parked = sent.find((f) => f.type === 'parking_updated') as {
      items?: Array<{ itemId: string; sourceUtteranceId?: number }>;
    };
    const itemId = parked?.items?.[0]?.itemId as string;
    const promoteCode = await mount.route(
      'client-1',
      { send: (message) => sent.push(message as unknown as Sent) },
      {
        type: 'parking_promote',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        itemId,
        requestId: 'promote-1',
      } as never
    );
    expect(promoteCode).toBeNull();
    const created = sent.find((f) => f.type === 'proposal_created') as {
      proposal?: { original?: string; sourceUtteranceId?: number; promotionRoute?: string };
    };
    expect(created?.proposal?.promotionRoute).toBe('parked_item');
    expect(created?.proposal?.sourceUtteranceId).toBe(1);
    expect(created?.proposal?.original).toBe('I want to find out about Podpoint');
  });
});

describe('Phase 3 — exact host read-back', () => {
  it('a gloss does not complete the spoken presentation; only the exact bytes do', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      echoSuppressionWindowMs: 0,
      evidence: (event) => evidence.push(event),
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'run tests');
    await flush();
    await relayAt(mount, 'run tests', 1);
    const created = sent.find((f) => f.type === 'proposal_created') as { proposal?: { tidied: string } };
    expect(created?.proposal?.tidied).toBe('run tests');

    // The talker GLOSSES — paraphrases without speaking the candidate bytes.
    service.emit({
      kind: 'transcript',
      laneId: LANE,
      attachmentGeneration: GENERATION,
      speaker: 'talker',
      source: 'native',
      text: 'the tests should run shortly',
      final: true,
      atMs: 2,
    } as never);
    await flush();
    // The gloss is recorded as a gloss, and it completed nothing.
    expect(evidence.find((event) => event.event === 'spoken_read_back_gloss')?.chars).toBeGreaterThan(0);

    utterance(service, 'Yes, send that.');
    await flush();
    expect(delivery.calls).toHaveLength(0); // the gate holds: bytes were never read back
    const refused = evidence.find((event) => event.event === 'spoken_confirm_refused');
    expect(refused?.code).toBe('voice_presentation_incomplete');

    // The talker reads the EXACT bytes back (inside a natural sentence).
    service.emit({
      kind: 'transcript',
      laneId: LANE,
      attachmentGeneration: GENERATION,
      speaker: 'talker',
      source: 'native',
      text: 'I am sending exactly this: run tests',
      final: true,
      atMs: 3,
    } as never);
    await flush();

    utterance(service, 'Yes, send that.');
    await flush();
    expect(delivery.calls).toEqual([{ workerSessionId: 'worker-1', text: 'run tests' }]);
  });

  it('still releases when the talker speaks the exact candidate in its announcement (pinned flow)', async () => {
    const service = new FakeService();
    const delivery = makeDelivery({ outcome: 'delivered', mechanism: 'steer' });
    const mount = new VoiceLiveMount({
      service,
      delivery,
      isWorkerBusy: async () => false,
      echoSuppressionWindowMs: 0,
    });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the tests');
    await flush();
    await relayAt(mount, 'check the tests', 1);
    service.emit({
      kind: 'transcript',
      laneId: LANE,
      attachmentGeneration: GENERATION,
      speaker: 'talker',
      source: 'native',
      text: 'I will ask the worker to check the tests',
      final: true,
      atMs: 2,
    } as never);
    await flush();
    utterance(service, 'Yes, send that.');
    await flush();
    expect(delivery.calls).toEqual([{ workerSessionId: 'worker-1', text: 'check the tests' }]);
  });
});

describe('Phase 3 — repeated identical requests after a cancel (C19)', () => {
  it('an identical relay after a spoken cancel creates a NEW proposal, not a duplicate ignore', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false, echoSuppressionWindowMs: 0 });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the build');
    await flush();
    await relayAt(mount, 'check the build', 1);
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(1);
    // Spoken cancel clears the held relay.
    utterance(service, 'No, forget it.');
    await flush();
    const resolved = sent.filter((f) => f.type === 'proposal_resolved');
    expect(resolved).toHaveLength(1);
    // Same words again within the duplicate window: a new identity and a new approval.
    const response = await relayAt(mount, 'check the build', 2_000);
    expect(response).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(2);
  });

  it('still ignores a true double emission within the window (regression control)', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'check the build');
    await flush();
    await relayAt(mount, 'check the build', 1);
    const response = await relayAt(mount, 'check the build', 400);
    expect(response).toMatchObject({ ok: true, status: 'duplicate_ignored' });
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(1);
  });
});

describe('H3 — transcription grace for the relay source binding', () => {
  const RELAY = 'restart the payment service';

  it('GRACE (a): a relay issued before the final transcript lands waits for it and binds', async () => {
    // Fix-loop pass 3 (C03/C19/C20): the model relays from its audio
    // understanding BEFORE the host's final operator transcript lands, so the
    // binding window is still empty at call time. The host must wait a bounded
    // grace for the late final transcript instead of refusing an honest relay.
    const service = new FakeService();
    const sent: Sent[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
      relaySourceGraceMs: 2_000,
      relaySourceGracePollMs: 10,
    });
    await startLane(mount, sent, service);
    // The tool call arrives against an EMPTY window…
    const pending = startRelay(mount, RELAY, 1);
    // …and the operator's final transcript lands during the grace period.
    await waitMs(30);
    utterance(service, RELAY);
    const response = await pending;

    expect(response).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
    const created = sent.filter((f) => f.type === 'proposal_created');
    expect(created).toHaveLength(1);
    // The late-arriving utterance was recorded, is eligible, and is the source.
    expect((created[0] as { proposal?: { sourceUtteranceId?: number } }).proposal?.sourceUtteranceId).toBe(1);
    // The journal shows the race being absorbed.
    const waited = evidence.find((event) => event.event === 'relay_binding_waited');
    expect(waited?.arrived).toBe(true);
    expect(Number(waited?.waitedMs)).toBeGreaterThan(0);
  });

  it('GRACE (b): nothing arrives inside the grace — refused exactly as before, and the refusal consumes nothing', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
      relaySourceGraceMs: 80,
      relaySourceGracePollMs: 10,
    });
    await startLane(mount, sent, service);

    const response = await startRelay(mount, RELAY, 1);

    expect(response).toMatchObject({ ok: false, reason: 'unbound_source' });
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(0);
    expect(sent.filter((f) => f.type === 'parking_updated')).toHaveLength(0);
    // The wait is recorded honestly: bounded, and nothing arrived.
    const waited = evidence.find((event) => event.event === 'relay_binding_waited');
    expect(waited?.arrived).toBe(false);
    const waitedMs = Number(waited?.waitedMs);
    expect(waitedMs).toBeGreaterThanOrEqual(70);
    expect(waitedMs).toBeLessThan(1_000);
    // A refused relay never held the duplicate slot: the same words again go
    // through the whole binding path again (and are refused again, still
    // against an empty window), never `duplicate_ignored`.
    const repeat = await startRelay(mount, RELAY, 2_000);
    expect(repeat).toMatchObject({ ok: false, reason: 'unbound_source' });
    expect(evidence.filter((event) => event.event === 'relay_binding_waited').length).toBeGreaterThanOrEqual(2);
    // And the next legitimate relay — after the operator speaks — binds fine.
    utterance(service, RELAY);
    await flush();
    const bound = await startRelay(mount, RELAY, 4_000);
    expect(bound).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
  });

  it('GRACE (c): with candidates present the binding never waits — ambiguity semantics unchanged', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const evidence: Array<Record<string, unknown>> = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      evidence: (event) => evidence.push(event),
      relaySourceGraceMs: 400,
      relaySourceGracePollMs: 10,
    });
    await startLane(mount, sent, service);
    utterance(service, 'Investigate the alternative');
    await flush();
    utterance(service, 'Also, what is the largest file in the repo');
    await flush();

    const response = await startRelay(mount, 'Deploy the staging branch', 3);

    // Two candidates, neither matches: ambiguous, refused — with NO grace
    // wait (the wait exists only for an empty window).
    expect(response).toMatchObject({ ok: false, reason: 'ambiguous_source' });
    expect(evidence.filter((event) => event.event === 'relay_binding_waited')).toHaveLength(0);
    const refusal = evidence.find((event) => event.event === 'relay_tool_call_refused');
    expect(refusal?.reason).toBe('ambiguous_source');
  });

  it('GRACE (d): two identical relays racing on an empty window create ONE proposal, not two', async () => {
    // Both calls enter the grace wait; the transcript arrives; the first to
    // wake binds and takes the duplicate slot, so the second must be told
    // `duplicate_ignored` — the guard still holds across the new await.
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
      relaySourceGraceMs: 2_000,
      relaySourceGracePollMs: 10,
    });
    await startLane(mount, sent, service);

    const first = startRelay(mount, RELAY, 1);
    await waitMs(20); // both calls are now polling an empty window
    const second = startRelay(mount, RELAY, 2);
    await waitMs(20);
    utterance(service, RELAY);

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    // Exactly one binds and one is duplicate-ignored — WHICH one binds depends
    // on the polling wake order (real timers), and is not part of the
    // contract. That one proposal exists, and the duplicate slot was taken
    // before the second binding, is.
    expect(firstResponse).toMatchObject({ ok: true });
    expect(secondResponse).toMatchObject({ ok: true });
    expect([firstResponse.status, secondResponse.status].sort()).toEqual([
      'awaiting_operator_approval',
      'duplicate_ignored',
    ]);
    expect(sent.filter((f) => f.type === 'proposal_created')).toHaveLength(1);
  });
});
