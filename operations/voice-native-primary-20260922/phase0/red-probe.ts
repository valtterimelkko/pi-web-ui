/**
 * PHASE 0 RED PROBE — conductor-owned, TEMPORARY.
 *
 * Purpose: reproduce (or clear) the five defect classes named in the plan §2
 * at baseline master fa1eb393, before any child is dispatched. This file is
 * deleted after its output is captured to the private evidence root; the
 * owning children write the durable RED tests.
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
import { normaliseRelayText } from '../../../src/talker/relay-normalise.js';
import { classifyOperatorUtterance } from '../../../src/talker/utterance-classifier.js';
import { PendingProposalStore } from '../../../src/talker/proposal-store.js';
import { VoiceLiveMount } from '../../../src/websocket/voice-live-mount.js';

const LANE = 'lane-1';
const GENERATION = 1;

class FakeService implements VoiceBridgeService {
  private readonly listeners = new Set<(event: VoiceBridgeEmittedEvent) => void>();
  readonly states = new Map<string, VoiceBridgeLaneState>();
  readonly starts: VoiceBridgeStartOptions[] = [];

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

function makeDelivery(outcome: DeliveryOutcome = { outcome: 'delivered', mechanism: 'prompt' }): WorkerDelivery {
  return {
    describe: () => 'test delivery',
    async deliver() {
      return outcome;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function startLane(mount: VoiceLiveMount, sent: Sent[], service: FakeService): Promise<void> {
  const code = await mount.route(
    'client-1',
    { send: (message) => sent.push(message as unknown as Sent) },
    {
      type: 'voice_session_start',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      workerSessionId: 'worker-1',
    } as never
  );
  expect(code).toBeNull();
  expect(service.starts).toHaveLength(1);
}

function utterance(service: FakeService, text: string): void {
  service.emit({
    kind: 'transcript',
    laneId: LANE,
    attachmentGeneration: GENERATION,
    speaker: 'operator',
    source: 'native',
    text,
    final: true,
    atMs: 1,
  });
}

// ── 1. Punctuation-free relay addressing ────────────────────────────────────
describe('RED-1 relay addressing without a separator', () => {
  it('strips "Relay to worker I want to find out about Podpoint"', () => {
    const r = normaliseRelayText('Relay to worker I want to find out about Podpoint');
    expect(r.text).toBe('I want to find out about Podpoint');
  });
  it('strips "Ask the worker I want to find out about Podpoint"', () => {
    const r = normaliseRelayText('Ask the worker I want to find out about Podpoint');
    expect(r.text).toBe('I want to find out about Podpoint');
  });
  it('CONTROL: strips "Relay to worker: I want to find out about Podpoint"', () => {
    const r = normaliseRelayText('Relay to worker: I want to find out about Podpoint');
    expect(r.text).toBe('I want to find out about Podpoint');
  });
  it('CONTROL: strips "Ask the worker to investigate the alternative"', () => {
    const r = normaliseRelayText('Ask the worker to investigate the alternative');
    expect(r.text).toBe('investigate the alternative');
  });
});

// ── 2. Casual / qualified confirmation ──────────────────────────────────────
describe('RED-2 casual or qualified confirmation', () => {
  const cases: Array<[string, string]> = [
    ['not sure', 'statement'],
    ['sure, but wait', 'statement'],
    ['yes, hold phase three', 'statement'],
    ['I said yes', 'statement'],
    ['yes', 'confirm'],
  ];
  for (const [text, want] of cases) {
    it(`classifies "${text}" as ${want}`, () => {
      expect(classifyOperatorUtterance(text)).toBe(want);
    });
  }
});

// ── 3. Correction must replace, not accumulate ──────────────────────────────
describe('RED-3 correction replaces the failed attempt', () => {
  it('a corrected repeat does not concatenate the first attempt', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, 'Investigate the alternative', 1);
    store.appendToDraft(2, 'Investigate the alternative, but do not change anything', 2);
    const snap = store.snapshotDraft() as { utterances: Array<{ text: string }> } | null;
    const joined = snap?.utterances.map((u) => u.text).join(' ') ?? '';
    // Desired: the corrected version alone is releasable.
    expect(joined).toBe('Investigate the alternative, but do not change anything');
  });
});

// ── 4+5. Native promotion: original wording and async source binding ────────
describe('RED-4/5 native promotion provenance', () => {
  it('RED-4 preserves the originating operator original text with the proposal', async () => {
    const service = new FakeService();
    const sent: Sent[] = [];
    const mount = new VoiceLiveMount({
      service,
      delivery: makeDelivery(),
      isWorkerBusy: async () => false,
    });
    await startLane(mount, sent, service);
    utterance(service, 'I want to find out about Podpoint');
    await flush();
    await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'Find out about Podpoint' },
      atMs: 2,
    });
    const created = sent.find((f) => f.type === 'proposal_created') as
      | { proposal?: { original?: string; tidied?: string } }
      | undefined;
    // Desired: the operator's own recognised words are preserved as the
    // original variant; the store currently defaults original to the model's
    // tidied text, so this shows the model text instead of the spoken words.
    expect(created?.proposal?.original).toBe('I want to find out about Podpoint');
  });

  it('RED-5 binds the relay tool call to its originating utterance, never the latest', async () => {
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
    utterance(service, 'Actually, forget that for a moment'); // utterance 2 — arrives before the async tool returns
    await flush();
    await mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'Investigate the alternative' },
      atMs: 3,
    });
    const created = sent.filter((f) => f.type === 'proposal_created') as Array<{
      proposal?: { sourceUtteranceId?: number };
    }>;
    const bound = created.length > 0 ? (created[0]?.proposal?.sourceUtteranceId ?? 'absent') : 'refused';
    // Desired: bound to utterance 1, or refused as ambiguous. Never the latest.
    expect({ bound }).toEqual({ bound: 1 });
  });
});
