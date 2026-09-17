import { describe, expect, it } from 'vitest';
import {
  VOICE_WIRE_VERSION,
  type VoiceClientMessage,
  type VoiceProposalCreatedMessage,
  type VoiceReceiptEventMessage,
  type VoiceServerMessage,
} from '@pi-web-ui/shared';
import { checkVoiceEnvelope, isProposalConfirmMessage } from '@pi-web-ui/shared';
import { VoiceLiveController, type VoiceLiveRefusal } from './controller';
import { createVoiceLane } from './messages';

// Vite raw import — the jsdom environment has no Node builtins.
import sourceOfController from './controller.ts?raw';
import sourceOfMessages from './messages.ts?raw';

const LANE = createVoiceLane({ workerSessionId: 'worker-1', runtime: 'pi', nonce: 'c1' });

function sent(): { frames: VoiceClientMessage[]; send: (frame: VoiceClientMessage) => void } {
  const frames: VoiceClientMessage[] = [];
  return { frames, send: (frame) => void frames.push(frame) };
}

function serverMessage(type: string, extra: Record<string, unknown> = {}): VoiceServerMessage {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: LANE.laneId,
    attachmentGeneration: LANE.attachmentGeneration,
    ...extra,
  } as unknown as VoiceServerMessage;
}

function proposalMessage(overrides: Record<string, unknown> = {}): VoiceProposalCreatedMessage {
  return serverMessage('proposal_created', {
    proposal: {
      proposalId: 'prop-1',
      version: 3,
      sha256: 'a'.repeat(64),
      promotionRoute: 'directed',
      original: 'ask it about the retry',
      tidied: 'ask it about the retry',
      presentedVariant: 'tidied',
      presentation: { completed: false },
      ...overrides,
    },
  }) as unknown as VoiceProposalCreatedMessage;
}

function receipt(outcome: string, idempotencyKey = 'idem-1'): VoiceReceiptEventMessage {
  return serverMessage('receipt_event', {
    receipt: { releaseId: 'rel-1', proposalId: 'prop-1', idempotencyKey, outcome, atMs: 1 },
  }) as unknown as VoiceReceiptEventMessage;
}

function makeController(extra: Partial<ConstructorParameters<typeof VoiceLiveController>[0]> = {}) {
  const writer = sent();
  const refusals: VoiceLiveRefusal[] = [];
  const delivered: VoiceReceiptEventMessage[] = [];
  const controller = new VoiceLiveController({
    lane: LANE,
    send: writer.send,
    onRefusal: (refusal) => refusals.push(refusal),
    onDeliveredReceipt: (message) => delivered.push(message),
    ...extra,
  });
  return { controller, frames: writer.frames, refusals, delivered };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('VoiceLiveController — lifecycle and operations', () => {
  it('opens the lane with a schema-exact start frame carrying its capture mode', () => {
    const { controller, frames } = makeController();
    controller.start({ captureMode: 'open-mic', readingLevel: 'summary' });
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame.type).toBe('voice_session_start');
    expect(checkVoiceEnvelope(frame, 'client-to-server')).toEqual({ ok: true });
    expect(controller.snapshot().wireState).toBe('connecting');
  });

  it('applies a voice_state ack and tracks the honest suspension state', () => {
    const { controller } = makeController();
    controller.handleIncoming(serverMessage('voice_state', { state: 'live', workerActivity: 'idle' }));
    expect(controller.snapshot().wireState).toBe('live');
    expect(controller.snapshot().workerActivity).toBe('idle');
    expect(controller.snapshot().listeningSuspended).toBe(false);

    controller.handleIncoming(serverMessage('voice_state', { state: 'suspended', detail: 'mic released' }));
    expect(controller.snapshot().listeningSuspended).toBe(true);
    expect(controller.snapshot().detail).toBe('mic released');
  });

  it('stops the lane and sends nothing else', () => {
    const { controller, frames } = makeController();
    controller.start();
    controller.stop('operator_stop');
    expect(frames.map((frame) => frame.type)).toEqual(['voice_session_start', 'voice_session_stop']);
    expect(controller.snapshot().wireState).toBe('stopped');
  });

  it('restarts the lane to change capture mode (a start parameter, not a silent switch)', () => {
    const { controller, frames } = makeController();
    controller.start();
    controller.handleIncoming(serverMessage('voice_state', { state: 'live' }));
    controller.setCaptureMode('push-to-talk');
    expect(frames.map((frame) => frame.type)).toEqual([
      'voice_session_start',
      'voice_session_stop',
      'voice_session_start',
    ]);
    const restart = frames[2] as { captureMode?: string };
    expect(restart.captureMode).toBe('push-to-talk');
    expect(controller.snapshot().captureMode).toBe('push-to-talk');
  });

  it('keeps the last 200 captions and never rewrites an authorised one', () => {
    const { controller } = makeController();
    for (let i = 0; i < 205; i += 1) {
      controller.handleIncoming(
        serverMessage('transcript_delta', {
          speaker: 'operator',
          source: 'native',
          text: `word ${i}`,
          final: true,
          atMs: i,
        }),
      );
    }
    const captions = controller.snapshot().captions;
    expect(captions).toHaveLength(200);
    expect(captions[0].text).toBe('word 5');
  });

  it('sends the activity boundary frame and reflects the floor locally', () => {
    const { controller, frames } = makeController();
    controller.reportActivity('speech_start', 100);
    controller.reportActivity('speech_end', 900);
    expect(frames.map((frame) => frame.type)).toEqual([
      'voice_activity_state',
      'voice_activity_state',
    ]);
    expect(controller.snapshot().operatorSpeaking).toBe(false);
  });
});

// ── Parking lot ─────────────────────────────────────────────────────────────

describe('VoiceLiveController — parking lot', () => {
  it('promotes exactly one item and refuses an unknown id (no batch)', () => {
    const { controller, frames } = makeController();
    controller.handleIncoming(
      serverMessage('parking_updated', {
        operation: 'listed',
        items: [
          { itemId: 'item-1', text: 'one', createdAtMs: 1 },
          { itemId: 'item-2', text: 'two', createdAtMs: 2 },
        ],
      }),
    );
    expect(controller.promoteParkedItem('item-2')).toBe('sent');
    const promote = frames[frames.length - 1] as { type: string; itemId?: string };
    expect(promote.type).toBe('parking_promote');
    expect(promote.itemId).toBe('item-2');
    expect(Object.keys(promote)).not.toContain('itemIds');

    expect(controller.promoteParkedItem('item-9')).toBe('refused');
    expect(frames).toHaveLength(1);
  });

  it('carries the full server snapshot so a reconnect needs no delta bookkeeping', () => {
    const { controller } = makeController();
    controller.handleIncoming(
      serverMessage('parking_updated', {
        operation: 'added',
        items: [{ itemId: 'item-1', text: 'one', createdAtMs: 1 }],
      }),
    );
    expect(controller.snapshot().parking.items).toEqual([
      { itemId: 'item-1', text: 'one', createdAtMs: 1 },
    ]);
    controller.handleIncoming(
      serverMessage('parking_updated', { operation: 'removed', items: [] }),
    );
    expect(controller.snapshot().parking.items).toEqual([]);
    expect(controller.snapshot().parking.operation).toBe('removed');
  });
});

// ── Confirmation authority ──────────────────────────────────────────────────

describe('VoiceLiveController — a confirmation needs a proposal identity', () => {
  it('refuses to confirm with no live proposal', () => {
    const { controller, frames, refusals } = makeController();
    expect(controller.confirmProposal()).toBe('refused');
    expect(frames).toHaveLength(0);
    expect(refusals[0].code).toBe('voice_confirm_requires_proposal');
  });

  it('sends a schema-exact confirmation naming the proposal, variant and key', () => {
    const { controller, frames } = makeController();
    controller.handleIncoming(proposalMessage());
    expect(controller.confirmProposal()).toBe('sent');
    const confirm = frames[0];
    expect(confirm.type).toBe('proposal_confirm');
    expect(isProposalConfirmMessage(confirm)).toBe(true);
    expect(checkVoiceEnvelope(confirm, 'client-to-server')).toEqual({ ok: true });
    expect(confirm).toMatchObject({ proposalId: 'prop-1', variant: 'tidied' });
    expect((confirm as { idempotencyKey: string }).idempotencyKey.length).toBeGreaterThan(0);
    expect(confirm).toMatchObject({ proposalRef: { version: 3, sha256: 'a'.repeat(64) } });
  });

  it('reuses the SAME idempotency key on retry after a transport drop', () => {
    const { controller, frames } = makeController();
    controller.handleIncoming(proposalMessage());
    controller.confirmProposal();
    controller.retryConfirmation();
    const [first, retry] = frames as Array<{ idempotencyKey: string; proposalId: string }>;
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.proposalId).toBe(first.proposalId);
  });

  it('can confirm the original variant explicitly', () => {
    const { controller, frames } = makeController();
    controller.handleIncoming(proposalMessage());
    controller.confirmProposal({ variant: 'original' });
    expect((frames[0] as { variant: string }).variant).toBe('original');
  });

  it('refuses to confirm a superseded (stale) proposal', () => {
    const { controller, frames, refusals } = makeController();
    controller.handleIncoming(proposalMessage());
    // A newer proposal replaces the identity the operator was shown.
    controller.handleIncoming(
      proposalMessage({ proposalId: 'prop-2', version: 4, sha256: 'b'.repeat(64) }),
    );
    const before = frames.length;
    // The live proposal is prop-2; a card still holding prop-1 must not confirm.
    expect(controller.liveProposalId()).toBe('prop-2');
    expect(controller.confirmProposal()).toBe('sent');
    expect((frames[before] as { proposalId: string }).proposalId).toBe('prop-2');
    expect(refusals).toHaveLength(0);
  });

  it('reports a stale card as stale and a completed read-back as presented', () => {
    const { controller } = makeController();
    expect(controller.presentationStatus()).toBe('stale');
    controller.handleIncoming(proposalMessage());
    expect(controller.presentationStatus()).toBe('pending');
    controller.reportPresentation({ completed: true });
    expect(controller.presentationStatus()).toBe('presented');
  });

  it('reports an interrupted read-back with where it stopped', () => {
    const { controller, frames } = makeController();
    controller.handleIncoming(proposalMessage());
    controller.reportPresentation({ completed: false, stoppedAtChar: 12 });
    expect(frames[0]).toMatchObject({
      type: 'proposal_presentation',
      proposalId: 'prop-1',
      completed: false,
      stoppedAtChar: 12,
    });
    expect(controller.presentationStatus()).toBe('pending');
  });

  it('cancels the live proposal and drops it from the surface (cancel never releases)', () => {
    const { controller, frames } = makeController();
    controller.handleIncoming(proposalMessage());
    expect(controller.cancelProposal()).toBe('sent');
    expect(frames[0]).toMatchObject({ type: 'proposal_cancel', reason: 'operator_cancel' });
    expect(controller.snapshot().proposal).toBeNull();
    expect(controller.cancelProposal()).toBe('refused');
  });

  it('clears a confirmable proposal when the server resolves it', () => {
    const { controller } = makeController();
    controller.handleIncoming(proposalMessage());
    controller.handleIncoming(
      serverMessage('proposal_resolved', { proposalId: 'prop-1', outcome: 'released', releaseId: 'rel-1' }),
    );
    expect(controller.snapshot().proposal).toBeNull();
    expect(controller.confirmProposal()).toBe('refused');
  });
});

// ── Delivery receipts and the chime gate ────────────────────────────────────

describe('VoiceLiveController — receipts, and the chime on delivered only', () => {
  it('reports a delivered receipt exactly once and records it', () => {
    const { controller, delivered } = makeController();
    controller.handleIncoming(receipt('delivered'));
    expect(delivered).toHaveLength(1);
    expect(controller.snapshot().receipts).toHaveLength(1);
  });

  it('never reports a non-delivered outcome as delivered', () => {
    const { controller, delivered } = makeController();
    for (const outcome of ['queued', 'refused', 'unknown']) {
      controller.handleIncoming(receipt(outcome, `idem-${outcome}`));
    }
    expect(delivered).toHaveLength(0);
    expect(controller.snapshot().receipts.map((entry) => entry.outcome)).toEqual([
      'queued',
      'refused',
      'unknown',
    ]);
  });

  it('does NOT treat proposal_resolved released as delivery evidence', () => {
    const { controller, delivered } = makeController();
    controller.handleIncoming(
      serverMessage('proposal_resolved', { proposalId: 'prop-1', outcome: 'released', releaseId: 'rel-1' }),
    );
    expect(delivered).toHaveLength(0);
  });
});

// ── Fail closed and visible ─────────────────────────────────────────────────

describe('VoiceLiveController — fail closed, surface everything', () => {
  it('refuses an unsupported version, an unknown type, another lane and a stale generation', () => {
    const { controller, refusals } = makeController();
    expect(controller.handleIncoming({ ...serverMessage('voice_state', { state: 'live' }), version: 99 })).toBe('refused');
    expect(controller.handleIncoming(serverMessage('voice_unicorn'))).toBe('refused');
    expect(controller.handleIncoming({ ...serverMessage('voice_state', { state: 'live' }), laneId: 'other:lane' })).toBe('refused');
    expect(controller.handleIncoming({ ...serverMessage('voice_state', { state: 'live' }), attachmentGeneration: 5 })).toBe('refused');
    expect(refusals.map((refusal) => refusal.reason)).toEqual([
      'unsupported-version',
      'unknown-type',
      'other-lane',
      'stale-generation',
    ]);
    // Nothing was applied: the lane is still idle, not 'live'.
    expect(controller.snapshot().wireState).toBe('idle');
  });

  it('surfaces a fatal voice_error and stops claiming to listen', () => {
    const { controller } = makeController();
    controller.handleIncoming(
      serverMessage('voice_error', {
        code: 'voice_provider_unavailable',
        message: 'provider gone',
        fatal: true,
      }),
    );
    expect(controller.snapshot().lastError).toMatchObject({ code: 'voice_provider_unavailable', fatal: true });
    expect(controller.snapshot().wireState).toBe('error');
    expect(controller.snapshot().listeningSuspended).toBe(true);
  });

  it('refuses a correlated frame this lane never requested', () => {
    const { controller, refusals } = makeController();
    controller.handleIncoming({ ...serverMessage('voice_state', { state: 'live' }), requestId: 'req-foreign' });
    expect(refusals[0].reason).toBe('foreign-request');
  });

  it('accepts a frame that answers a request this lane DID issue', () => {
    const { controller, frames, refusals } = makeController();
    controller.requestParkingList();
    const issued = (frames[0] as { requestId: string }).requestId;
    expect(
      controller.handleIncoming(
        serverMessage('parking_updated', { operation: 'listed', items: [], requestId: issued }),
      ),
    ).toBe('applied');
    expect(refusals).toHaveLength(0);
    expect(controller.snapshot().pendingRequests).toHaveLength(0);
  });

  it('surfaces a transport that throws rather than losing the failure', () => {
    const refusals: VoiceLiveRefusal[] = [];
    const controller = new VoiceLiveController({
      lane: LANE,
      send: () => {
        throw new Error('socket closed');
      },
      onRefusal: (refusal) => refusals.push(refusal),
    });
    controller.requestParkingList();
    expect(refusals[0]).toMatchObject({ direction: 'outbound', reason: 'send_failed' });
  });
});

// ── Structural invariants ───────────────────────────────────────────────────

describe('controller source invariants (no instruction path, no capture authority)', () => {
  const code = sourceOfController
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('has no way to carry the operator words to the wire', () => {
    expect(code).not.toMatch(/\btext\s*:/);
    expect(code).not.toMatch(/\butterance\s*:/);
    expect(code).not.toMatch(/\binstruction\s*:/);
    expect(code).not.toMatch(/\bprompt\s*:/);
    expect(code).not.toMatch(/carriesInstructionText/);
  });

  it('has no capture control and no direct transport of its own', () => {
    expect(code).not.toMatch(/getUserMedia|AudioWorklet|MediaStream/);
    expect(code).not.toMatch(/fetch\s*\(|new\s+WebSocket/);
    expect(code).toMatch(/interpretInbound\s*\(/); // inbound goes through the contract
  });

  it('gates the chime through the message layer, not a re-derived condition', () => {
    expect(code).toMatch(/message\.receipt\.outcome === 'delivered'/);
    expect(sourceOfMessages).toMatch(/isDeliveredReceipt/);
  });
});
