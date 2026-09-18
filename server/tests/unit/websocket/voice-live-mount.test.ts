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
import { VoiceLiveMount, isDirectedWorkerInstruction } from '../../../src/websocket/voice-live-mount.js';

const LANE = 'lane-1';
const GENERATION = 1;

class FakeService implements VoiceBridgeService {
  private readonly listeners = new Set<(event: VoiceBridgeEmittedEvent) => void>();
  readonly states = new Map<string, VoiceBridgeLaneState>();
  readonly starts: VoiceBridgeStartOptions[] = [];
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
  injectContext(_laneId: string, _update: VoiceBridgeContextUpdate): void {}
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

describe('isDirectedWorkerInstruction', () => {
  it('recognises an explicit commission frame', () => {
    expect(isDirectedWorkerInstruction('Tell the worker to check the tests.')).toBe(true);
    expect(isDirectedWorkerInstruction('Ask it whether the build is green.')).toBe(true);
    expect(isDirectedWorkerInstruction('Let the worker know the deploy is done.')).toBe(true);
  });

  it('does not treat ordinary conversational speech as directed', () => {
    expect(isDirectedWorkerInstruction('I keep thinking about the retry handler.')).toBe(false);
    expect(isDirectedWorkerInstruction('It should not drop the session token.')).toBe(false);
    expect(isDirectedWorkerInstruction('What would you check first?')).toBe(false);
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

  it('delivers the exact retained bytes when a confirmation is authorised', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'Tell the worker to check the tests.');
    await flush();

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
    utterance(service, 'Tell the worker to check the tests.');
    await flush();
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
    utterance(service, 'Tell the worker to check the tests.');
    await flush();
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
    utterance(service, 'Tell the worker to check the logs.');
    await flush();
    utterance(service, 'Ask it to update the changelog.');
    await flush();

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
  it('proposes a directed instruction while the worker is idle and does not interrupt it', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'Tell the worker to check the tests.');
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(1);
    expect(sent.filter((frame) => frame.type === 'parking_updated')).toHaveLength(0);
    expect(delivery.calls).toHaveLength(0);
  });

  it('parks a directed instruction while the worker is busy', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => true });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'Tell the worker to check the tests.');
    await flush();
    expect(sent.filter((frame) => frame.type === 'proposal_created')).toHaveLength(0);
    const parking = sent.filter((frame) => frame.type === 'parking_updated');
    expect(parking).toHaveLength(1);
    expect((parking[0].items as Array<{ text: string }>)[0].text).toBe('check the tests.');
    expect(delivery.calls).toHaveLength(0);
  });

  it('holds nothing for ordinary conversational speech', async () => {
    const service = new FakeService();
    const delivery = makeDelivery();
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
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
    const mount = new VoiceLiveMount({ service, delivery, isWorkerBusy: async () => false });
    const sent: Sent[] = [];
    await startLane(mount, sent, service);
    utterance(service, 'Tell the worker to check the tests.');
    await flush();
    const proposal = (sent.find((frame) => frame.type === 'proposal_created') as Sent).proposal as {
      tidied: string;
    };

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
    utterance(service, 'Tell the worker to check the tests.');
    await flush();
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
