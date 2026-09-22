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

describe('VoiceLiveMount — the relay is model-driven, not classified', () => {
  it('creates a proposal from a relay_to_worker tool call, and sends nothing', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);

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
    await relay(mount, 'check the logs.');
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
    // The relay is model-driven now: the proposal comes from the tool call.
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
