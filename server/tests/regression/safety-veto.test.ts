/**
 * Permanent safety-veto regression suite (Voice Mode execution plan, Phase 6 —
 * Gate 6 / Track G).
 *
 * Every unsafe state must fail closed. The six veto families the plan names are
 * implemented here as `RegressionCheck`s executed through Track D's
 * `harness/run.ts` runner, so the anti-early-claim properties hold mechanically:
 * a suite that executes zero checks fails, and ONE failing veto fails the whole
 * suite (no thresholds, no averaging, no retries, no skips).
 *
 * The checks drive the REAL kernel, not a reimplementation:
 *   - `utterance-classifier.ts` / `policy-core.ts` for doubt, conditional
 *     agreement and the stale-card gate;
 *   - `proposal-store.ts` / `release-store.ts` / `HostAuthorityKernel` for
 *     tampered identities, replay and lane isolation;
 *   - `voice-router.ts` + `voice-session.ts` for the disconnect path, whose
 *     only production routing point is the router (a disconnect is
 *     bridge-owned and can never reach the kernel's `confirm`).
 *
 * Asynchronous driving (starting a lane, a disconnect, a talker turn) happens
 * before the runner executes; each check is synchronous and throws on failure,
 * so the runner's contract is untouched.
 *
 * Tests only: `server/src/**` is read-only. A check failing means a real defect
 * in the shipped code, to be raised as a parent question — never fixed here.
 */

import { describe, expect, it } from 'vitest';

import { classifyOperatorUtterance } from '../../src/talker/utterance-classifier.js';
import { HostAuthorityKernel, decideOperatorTurn, policyStateView } from '../../src/talker/policy-core.js';
import { PendingProposalStore, ProposalStore } from '../../src/talker/proposal-store.js';
import { DuplicateReleaseError, ReleaseStore } from '../../src/talker/release-store.js';
import { TalkerSession } from '../../src/talker/talker.js';
import { createNullDelivery } from '../../src/talker/delivery.js';
import type { TalkerModelClient, WorkerStateSnapshot } from '../../src/talker/types.js';
import { VoiceSessionService } from '../../src/voice/voice-session.js';
import { VoiceSessionRouter, mapBridgeEventToServerMessage } from '../../src/voice/voice-router.js';
import type {
  VoiceBridgeEmittedEvent,
  VoiceClientMessage,
  VoiceServerMessage,
} from '../../src/voice/contract.js';
import { VOICE_WIRE_VERSION, checkVoiceEnvelope } from '../../src/voice/contract.js';
import type { GeminiLiveBridgeCallbacks, VoiceBridgeLike } from '../../src/voice/types.js';
import {
  assertRegressionPass,
  runRegressionChecks,
  type RegressionCheck,
  type RegressionReport,
} from './harness/run.js';

// ── Shared helpers ─────────────────────────────────────────────────────────

const LANE = 'worker-1';
const LANE_TWO = 'worker-2';

function check(id: string, run: () => void, description?: string): RegressionCheck {
  return description === undefined ? { id, run } : { id, description, run };
}

/**
 * Execute one family through the D runner. Zero checks is already a failed
 * report; we additionally assert the expected count so a silently-shrunk suite
 * is caught, and `assertRegressionPass` fails the vitest test with the exact
 * failing veto ids when any check throws.
 */
function runFamily(id: string, checks: RegressionCheck[], minimum: number): RegressionReport {
  expect(checks.length).toBeGreaterThanOrEqual(minimum);
  const report = runRegressionChecks(id, checks);
  expect(report.executed).toBe(checks.length);
  assertRegressionPass(report);
  expect(report.failed).toEqual([]);
  return report;
}

interface Promoted {
  kernel: HostAuthorityKernel;
  proposalId: string;
  version: number;
  sha256: string;
}

/** Promote + present a proposal through the real kernel, returning its identity. */
function promoteAndPresent(
  kernel: HostAuthorityKernel,
  laneId: string,
  text = 'hold phase three until my review'
): Promoted {
  const proposal = kernel.promote({
    route: 'direct_address',
    laneId,
    tidied: text,
    sourceUtteranceId: 1,
    createdTurn: 1,
  });
  kernel.proposals.present(proposal.id, 'tidied');
  return { kernel, proposalId: proposal.id, version: proposal.version, sha256: proposal.sha256 };
}

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'running the test suite',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running, 22m'],
  pendingItems: [],
  lastAssistantText: 'Still running.',
};

function stubModel(reply = 'Understood.'): TalkerModelClient {
  return {
    async completeTurn() {
      return { text: reply, ttftMs: 1, totalMs: 2 };
    },
  };
}

// ── VETO 1 — doubt never confirms ───────────────────────────────────────────

describe('VETO 1: doubt ("not sure") never confirms', () => {
  it('drives the real classifier and policy core; a single failure fails the suite', () => {
    const checks: RegressionCheck[] = [
      check('doubt-not-sure-is-not-confirm', () => {
        expect(classifyOperatorUtterance('not sure')).not.toBe('confirm');
      }),
      check('doubt-not-sure-is-statement-or-cancel', () => {
        expect(['statement', 'cancel']).toContain(classifyOperatorUtterance('not sure'));
      }),
      check('doubt-variants-are-never-confirm', () => {
        for (const utterance of [
          'not sure',
          'I am not sure',
          'I doubt it',
          'hard to say',
          'not entirely sure',
          'I am unsure',
          'maybe not',
        ]) {
          expect(classifyOperatorUtterance(utterance), utterance).not.toBe('confirm');
        }
      }),
      check('doubt-with-a-live-draft-does-not-release', () => {
        const store = new PendingProposalStore();
        store.appendToDraft(1, 'hold phase three until my review', 1);
        const before = store.snapshotDraft();
        const decision = decideOperatorTurn(policyStateView(store, 1), { utterance: 'not sure' });
        expect(decision.kind).not.toBe('release');
        expect(store.snapshotDraft()).toEqual(before);
      }),
      check('doubt-leaves-the-draft-releasable-by-a-later-confirm', () => {
        // The safe refusal must not consume the draft: a later real confirm works.
        const store = new PendingProposalStore();
        store.appendToDraft(1, 'hold phase three until my review', 1);
        decideOperatorTurn(policyStateView(store, 1), { utterance: 'not sure' });
        const after = decideOperatorTurn(policyStateView(store, 2), { utterance: 'yes' });
        expect(after.kind).toBe('release');
      }),
    ];
    runFamily('veto-doubt', checks, 5);
  });
});

// ── VETO 2 — conditional agreement never confirms ───────────────────────────

describe('VETO 2: conditional agreement ("yes, but wait") never confirms', () => {
  it('a condition, a delay or a post-affirmation instruction is a statement', () => {
    const conditionalAgreements = [
      'yes, but wait',
      'sure, but wait',
      'yes, hold phase three',
      'ok but check line 10 first',
      'yes if the tests pass',
      'yeah, only after the tests pass',
    ];
    const checks: RegressionCheck[] = [
      check('conditional-agreement-variants-are-never-confirm', () => {
        for (const utterance of conditionalAgreements) {
          expect(classifyOperatorUtterance(utterance), utterance).not.toBe('confirm');
        }
      }),
      check('conditional-agreement-classifies-as-statement', () => {
        for (const utterance of conditionalAgreements) {
          expect(classifyOperatorUtterance(utterance), utterance).toBe('statement');
        }
      }),
      check('conditional-agreement-with-a-live-draft-does-not-release', () => {
        for (const utterance of conditionalAgreements) {
          const store = new PendingProposalStore();
          store.appendToDraft(1, 'hold phase three until my review', 1);
          const before = store.snapshotDraft();
          const decision = decideOperatorTurn(policyStateView(store, 1), { utterance });
          expect(decision.kind, utterance).not.toBe('release');
          expect(store.snapshotDraft(), utterance).toEqual(before);
        }
      }),
    ];
    runFamily('veto-conditional-agreement', checks, 3);
  });
});

// ── VETO 3 — stale / tampered proposal refuses ──────────────────────────────

describe('VETO 3: stale or tampered proposal refuses, never delivers', () => {
  it('SHA mismatch, version mismatch and stale-card echoes all refuse', () => {
    const checks: RegressionCheck[] = [
      check('tampered-sha-refuses-at-the-kernel', () => {
        const kernel = new HostAuthorityKernel();
        const p = promoteAndPresent(kernel, LANE);
        const result = kernel.confirm({
          proposalId: p.proposalId,
          identity: { version: p.version, sha256: 'f'.repeat(64) },
          idempotencyKey: 'key-tampered',
        });
        expect(result).toMatchObject({ kind: 'refused', reason: 'stale' });
        expect(kernel.releases.history()).toEqual([]);
        expect(kernel.proposals.get(p.proposalId)?.status).toBe('presented');
      }),
      check('wrong-version-refuses-at-the-kernel', () => {
        const kernel = new HostAuthorityKernel();
        const p = promoteAndPresent(kernel, LANE);
        const result = kernel.confirm({
          proposalId: p.proposalId,
          identity: { version: p.version + 1, sha256: p.sha256 },
          idempotencyKey: 'key-version',
        });
        expect(result).toMatchObject({ kind: 'refused', reason: 'stale' });
        expect(kernel.releases.history()).toEqual([]);
      }),
      check('sha-mismatch-refuses-at-the-store-without-consuming', () => {
        const store = new ProposalStore();
        const proposal = store.create({
          laneId: LANE,
          route: 'direct_address',
          sourceUtteranceId: 1,
          tidied: 'hold phase three',
          createdTurn: 1,
        });
        store.present(proposal.id, 'tidied');
        const take = store.takeForConfirmation({
          proposalId: proposal.id,
          identity: { version: proposal.version, sha256: '0'.repeat(64) },
        });
        expect(take.kind).toBe('stale');
        expect(store.get(proposal.id)?.status).toBe('presented');
        expect(store.live(LANE)?.id).toBe(proposal.id);
      }),
      check('a-stale-card-echo-in-the-talker-path-refuses-and-keeps-the-draft', () => {
        const store = new PendingProposalStore();
        store.appendToDraft(1, 'hold phase three until my review', 1);
        const identity = store.describeCurrentProposal();
        expect(identity).not.toBeNull();
        const tampered = { version: identity!.version, hash: `${identity!.hash.slice(0, -1)}0` };
        const before = store.snapshotDraft();
        const decision = decideOperatorTurn(policyStateView(store, 1), {
          utterance: 'yes',
          proposalRef: tampered,
        });
        expect(decision.kind).toBe('refuse-stale-card');
        expect(store.snapshotDraft()).toEqual(before);
        // A matching echo still releases — the gate is not simply refusing.
        const matching = decideOperatorTurn(policyStateView(store, 2), {
          utterance: 'yes',
          proposalRef: { version: identity!.version, hash: identity!.hash },
        });
        expect(matching.kind).toBe('release');
      }),
      check('the-wire-confirm-refuses-instruction-text-and-a-missing-identity', () => {
        const envelope = { version: VOICE_WIRE_VERSION, laneId: LANE, attachmentGeneration: 1 };
        const withText = checkVoiceEnvelope(
          {
            ...envelope,
            type: 'proposal_confirm',
            proposalId: 'prop-1',
            variant: 'tidied',
            idempotencyKey: 'k',
            text: 'send it',
          },
          'client-to-server'
        );
        expect(withText).toEqual({ ok: false, code: 'voice_client_text_forbidden' });
        const noIdentity = checkVoiceEnvelope(
          { ...envelope, type: 'proposal_confirm', variant: 'tidied', idempotencyKey: 'k' },
          'client-to-server'
        );
        expect(noIdentity).toEqual({ ok: false, code: 'voice_confirm_requires_proposal' });
      }),
    ];
    runFamily('veto-stale-tampered', checks, 5);
  });
});

// ── VETO 4 — replay answers duplicate_refusal, exactly once ─────────────────

describe('VETO 4: replay answers duplicate_refusal and delivers exactly once', () => {
  it('a repeated confirmation never produces a second release', () => {
    const checks: RegressionCheck[] = [
      check('replayed-confirmation-is-a-duplicate-refusal', () => {
        const kernel = new HostAuthorityKernel();
        const p = promoteAndPresent(kernel, LANE);
        const identity = { version: p.version, sha256: p.sha256 };
        const first = kernel.confirm({ proposalId: p.proposalId, identity, idempotencyKey: 'key-1' });
        expect(first.kind).toBe('authorised');
        kernel.recordDelivery({
          proposalId: p.proposalId,
          idempotencyKey: 'key-1',
          outcome: { status: 'delivered', mechanism: 'steer' },
          receiptTimestamp: 1,
        });
        const replay = kernel.confirm({ proposalId: p.proposalId, identity, idempotencyKey: 'key-2' });
        expect(replay).toMatchObject({ kind: 'duplicate_refusal', proposalId: p.proposalId });
        expect(kernel.releases.history()).toHaveLength(1);
      }),
      check('a-reused-idempotency-key-refuses-without-consuming-the-second-proposal', () => {
        const kernel = new HostAuthorityKernel();
        const one = promoteAndPresent(kernel, LANE, 'one');
        kernel.confirm({
          proposalId: one.proposalId,
          identity: { version: one.version, sha256: one.sha256 },
          idempotencyKey: 'shared-key',
        });
        kernel.recordDelivery({
          proposalId: one.proposalId,
          idempotencyKey: 'shared-key',
          outcome: { status: 'delivered' },
          receiptTimestamp: 1,
        });
        const two = promoteAndPresent(kernel, LANE_TWO, 'two');
        const replay = kernel.confirm({
          proposalId: two.proposalId,
          identity: { version: two.version, sha256: two.sha256 },
          idempotencyKey: 'shared-key',
        });
        expect(replay).toMatchObject({ kind: 'duplicate_refusal' });
        expect(kernel.proposals.get(two.proposalId)?.status).toBe('presented'); // not consumed
        expect(kernel.releases.history()).toHaveLength(1);
      }),
      check('a-released-proposal-is-spent-even-before-its-receipt-is-recorded', () => {
        const kernel = new HostAuthorityKernel();
        const p = promoteAndPresent(kernel, LANE);
        const identity = { version: p.version, sha256: p.sha256 };
        expect(kernel.confirm({ proposalId: p.proposalId, identity, idempotencyKey: 'key-first' }).kind).toBe(
          'authorised'
        );
        const replay = kernel.confirm({ proposalId: p.proposalId, identity, idempotencyKey: 'key-second' });
        expect(replay).toMatchObject({ kind: 'duplicate_refusal' });
        expect(kernel.releases.history()).toEqual([]);
      }),
      check('the-append-only-release-log-refuses-a-duplicate-record', () => {
        const releases = new ReleaseStore();
        releases.record({
          proposalId: 'prop-1',
          sha256: 'a'.repeat(64),
          idempotencyKey: 'key-1',
          targetLane: LANE,
          deliveryOutcome: { status: 'delivered' },
          receiptTimestamp: 1,
        });
        expect(() =>
          releases.record({
            proposalId: 'prop-1',
            sha256: 'a'.repeat(64),
            idempotencyKey: 'key-2',
            targetLane: LANE,
            deliveryOutcome: { status: 'delivered' },
            receiptTimestamp: 2,
          })
        ).toThrow(DuplicateReleaseError);
        expect(releases.history()).toHaveLength(1);
      }),
    ];
    runFamily('veto-replay', checks, 4);
  });
});

// ── VETO 5 — mid-speech disconnect never dispatches ─────────────────────────

/** The real service under a mock provider bridge (hermetic — no network). */
class NullBridge implements VoiceBridgeLike {
  static instances: NullBridge[] = [];
  readonly resumptionHandle: string | null = null;
  callbacks: GeminiLiveBridgeCallbacks;
  closed = false;
  constructor(options: { callbacks: GeminiLiveBridgeCallbacks } & Record<string, unknown>) {
    this.callbacks = options.callbacks;
    NullBridge.instances.push(this);
  }
  async connect(): Promise<void> {}
  sendAudio(_pcm: Buffer): boolean {
    return true;
  }
  sendContextText(_text: string): boolean {
    return true;
  }
  activityStart(): void {}
  activityEnd(): void {}
  close(): void {
    this.closed = true;
  }
}

describe('VETO 5: a mid-speech disconnect never triggers dispatch', () => {
  it('the disconnect path cannot reach the kernel, and a talker draft is not dispatched', async () => {
    // ── (a) Drive the real router + service through a mid-speech disconnect ──
    NullBridge.instances = [];
    const kernelCalls: VoiceClientMessage[] = [];
    let wouldDispatch = false;
    const service = new VoiceSessionService({
      bridgeFactory: (options) => new NullBridge(options as never),
    });
    // The router does not relay events (Phase 5 binds that); observe the
    // service's own emitted events and translate them with the real mapper.
    const emitted: VoiceBridgeEmittedEvent[] = [];
    service.subscribe((event) => emitted.push(event));
    const wire = (): VoiceServerMessage[] =>
      emitted
        .map((event) => mapBridgeEventToServerMessage(event, service.getState(lane)))
        .filter((message): message is VoiceServerMessage => message !== null);
    const router = new VoiceSessionRouter({
      service,
      kernel: {
        async handle(_context, message) {
          kernelCalls.push(message);
          if (message.type === 'proposal_confirm') wouldDispatch = true;
          return null;
        },
      },
    });
    const context = { send: (_message: VoiceServerMessage) => {} };
    const lane = 'lane-1:probe';
    const envelope = { version: VOICE_WIRE_VERSION as 1, laneId: lane, attachmentGeneration: 1 };

    await router.handle(context, {
      ...envelope,
      type: 'voice_session_start',
      workerSessionId: 'session-abc',
    } as VoiceClientMessage);
    const bridge = NullBridge.instances[0];
    bridge.callbacks.onState?.('live', 'ready');

    // Operator is mid-speech: local VAD says speaking, a partial transcript has
    // arrived, but there is no final delta and no confirmation.
    await router.handle(context, {
      ...envelope,
      type: 'voice_activity_state',
      state: 'speech_start',
      atMs: 1,
    } as VoiceClientMessage);
    bridge.callbacks.onInputTranscription?.('hold on half a sec', 2);

    // The connection drops mid-speech.
    await router.handle(context, {
      ...envelope,
      type: 'voice_session_stop',
      reason: 'client_disconnect',
    } as VoiceClientMessage);

    const stoppedState = service.getState(lane)?.state;
    const operatorDeltas = wire().filter(
      (message) => message.type === 'transcript_delta' && message.speaker === 'operator'
    );
    const leakedFrames = wire().filter(
      (message) => message.type === 'receipt_event' || message.type === 'proposal_resolved'
    );

    // ── (b) Drive the real talker through the same shape ────────────────────
    const delivery = createNullDelivery();
    const session = new TalkerSession({
      model: stubModel(),
      delivery,
      workerSessionId: 'worker-1',
      snapshotProvider: () => SNAPSHOT,
    });
    await session.handleOperatorTurn('tell the worker to hold phase three until my review');
    await session.handleOperatorTurn('wait, hold on a sec');
    const deliveredAfterDisconnect = delivery.deliveredTexts().length;
    await session.handleOperatorTurn('yes');
    const deliveredAfterConfirm = delivery.deliveredTexts().length;

    const checks: RegressionCheck[] = [
      check('disconnect-stops-the-lane-without-a-dispatch', () => {
        expect(stoppedState).toBe('stopped');
        expect(kernelCalls).toEqual([]);
        expect(wouldDispatch).toBe(false);
      }),
      check('only-a-final-operator-delta-could-source-anything', () => {
        expect(operatorDeltas.length).toBeGreaterThan(0);
        for (const delta of operatorDeltas) {
          expect(delta.type === 'transcript_delta' && delta.final).toBe(false);
        }
      }),
      check('a-disconnect-leaks-no-receipt-or-resolution-frame', () => {
        expect(leakedFrames).toEqual([]);
      }),
      check('a-mid-speech-fragment-in-the-talker-does-not-dispatch', () => {
        expect(deliveredAfterDisconnect).toBe(0);
      }),
      check('the-same-draft-still-dispatches-once-on-a-real-confirm', () => {
        // Positive control: the test above is not vacuous — a real confirm sends.
        expect(deliveredAfterConfirm).toBe(1);
      }),
    ];
    runFamily('veto-disconnect', checks, 5);
  });
});

// ── VETO 6 — lane isolation ─────────────────────────────────────────────────

describe('VETO 6: a proposal releases only onto its own lane', () => {
  it('worker 1 wording cannot release onto worker 2, and each lane keeps its own live proposal', () => {
    const checks: RegressionCheck[] = [
      check('target-lane-is-the-creation-lane-not-a-caller-choice', () => {
        const kernel = new HostAuthorityKernel();
        const one = promoteAndPresent(kernel, LANE, 'lane one instruction');
        const result = kernel.confirm({
          proposalId: one.proposalId,
          identity: { version: one.version, sha256: one.sha256 },
          idempotencyKey: 'key-lane-1',
        });
        expect(result.kind).toBe('authorised');
        if (result.kind === 'authorised') expect(result.targetLane).toBe(LANE);
      }),
      check('confirming-lane-2-does-not-release-or-consume-lane-1', () => {
        const kernel = new HostAuthorityKernel();
        const one = promoteAndPresent(kernel, LANE, 'lane one instruction');
        const two = promoteAndPresent(kernel, LANE_TWO, 'lane two instruction');
        const result = kernel.confirm({
          proposalId: two.proposalId,
          identity: { version: two.version, sha256: two.sha256 },
          idempotencyKey: 'key-lane-2',
        });
        expect(result.kind).toBe('authorised');
        if (result.kind === 'authorised') expect(result.targetLane).toBe(LANE_TWO);
        // Lane 1's proposal is untouched and still the lane's live proposal.
        expect(kernel.proposals.get(one.proposalId)?.status).toBe('presented');
        expect(kernel.proposals.live(LANE)?.id).toBe(one.proposalId);
      }),
      check('one-live-proposal-per-lane-supersedes-within-a-lane-only', () => {
        const store = new ProposalStore();
        const laneOneFirst = store.create({
          laneId: LANE,
          route: 'direct_address',
          sourceUtteranceId: 1,
          tidied: 'first',
          createdTurn: 1,
        });
        const laneTwo = store.create({
          laneId: LANE_TWO,
          route: 'direct_address',
          sourceUtteranceId: 2,
          tidied: 'other lane',
          createdTurn: 1,
        });
        const laneOneSecond = store.create({
          laneId: LANE,
          route: 'direct_address',
          sourceUtteranceId: 3,
          tidied: 'second',
          createdTurn: 2,
        });
        expect(store.get(laneOneFirst.id)?.status).toBe('superseded');
        expect(store.live(LANE)?.id).toBe(laneOneSecond.id);
        expect(store.get(laneTwo.id)?.status).not.toBe('superseded');
        expect(store.live(LANE_TWO)?.id).toBe(laneTwo.id);
      }),
      check('a-confirm-of-a-released-lane-1-proposal-does-not-touch-lane-2', () => {
        const kernel = new HostAuthorityKernel();
        const one = promoteAndPresent(kernel, LANE, 'lane one instruction');
        const two = promoteAndPresent(kernel, LANE_TWO, 'lane two instruction');
        kernel.confirm({
          proposalId: one.proposalId,
          identity: { version: one.version, sha256: one.sha256 },
          idempotencyKey: 'key-1',
        });
        const replay = kernel.confirm({
          proposalId: one.proposalId,
          identity: { version: one.version, sha256: one.sha256 },
          idempotencyKey: 'key-2',
        });
        expect(replay.kind).toBe('duplicate_refusal');
        expect(kernel.proposals.live(LANE_TWO)?.id).toBe(two.proposalId);
        expect(kernel.releases.history()).toEqual([]);
      }),
    ];
    runFamily('veto-lane-isolation', checks, 4);
  });
});

// ── Coverage meta-check ─────────────────────────────────────────────────────

describe("VETO coverage: the plan's six families are all present and executed", () => {
  it('names every plan veto and runs the full runner contract', () => {
    const report = runRegressionChecks('veto-summary', [
      check('doubt-family-exists', () => {
        expect(classifyOperatorUtterance('not sure')).not.toBe('confirm');
      }),
      check('conditional-family-exists', () => {
        expect(classifyOperatorUtterance('yes, but wait')).toBe('statement');
      }),
      check('stale-family-exists', () => {
        const store = new ProposalStore();
        const p = store.create({
          laneId: LANE,
          route: 'direct_address',
          sourceUtteranceId: 1,
          tidied: 'x',
          createdTurn: 1,
        });
        store.present(p.id, 'tidied');
        expect(
          store.takeForConfirmation({ proposalId: p.id, identity: { version: 0, sha256: 'x' } }).kind
        ).toBe('stale');
      }),
      check('replay-family-exists', () => {
        const kernel = new HostAuthorityKernel();
        const p = promoteAndPresent(kernel, LANE);
        const identity = { version: p.version, sha256: p.sha256 };
        kernel.confirm({ proposalId: p.proposalId, identity, idempotencyKey: 'a' });
        expect(kernel.confirm({ proposalId: p.proposalId, identity, idempotencyKey: 'b' }).kind).toBe(
          'duplicate_refusal'
        );
      }),
      check('disconnect-family-exists', () => {
        // A disconnect is bridge-owned; the kernel's one authorising method
        // takes a proposal identity and can never be reached by a stop reason.
        expect(typeof HostAuthorityKernel.prototype.confirm).toBe('function');
      }),
      check('lane-isolation-family-exists', () => {
        const kernel = new HostAuthorityKernel();
        const one = promoteAndPresent(kernel, LANE);
        expect(kernel.proposals.live(LANE)?.laneId).toBe(LANE);
        expect(kernel.proposals.live(LANE_TWO)).toBeNull();
        expect(one.proposalId).toBeTruthy();
      }),
    ]);
    expect(report.executed).toBe(6);
    assertRegressionPass(report);
  });
});