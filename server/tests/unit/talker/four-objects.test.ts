import { describe, it, expect } from 'vitest';

/**
 * Phase 2 (Voice Mode execution, Wave 0 child A): the four-object authority
 * kernel. Thread, Parking Lot, Proposal and Release each exist as their own
 * object, and the negative tests below pin the separations the design exists
 * to buy:
 *   - a thread turn is structurally unsendable — no code path from it to a
 *     release (N1/N8);
 *   - a proposal exists only through one of the three promotion routes, and
 *     at most one is live per lane;
 *   - the delivered card-identity gate is preserved (version + SHA-256),
 *     including the original-variant refusal;
 *   - a release is append-only and idempotent: a duplicate confirmation is a
 *     refusal, never a second delivery; an unknown outcome is first-class and
 *     must be reconciled;
 *   - the typed read-only operations cannot create a proposal or a release.
 */
import { ThreadStore } from '../../../src/talker/thread-store.js';
import { ParkingLot, BatchPromotionDeniedError } from '../../../src/talker/parking-lot.js';
import {
  ProposalStore,
  UnknownPromotionRouteError,
  type PromotionRoute,
} from '../../../src/talker/proposal-store.js';
import { ReleaseStore, DuplicateReleaseError } from '../../../src/talker/release-store.js';
import { HostAuthorityKernel } from '../../../src/talker/policy-core.js';

const LANE = 'worker-1';

function makeKernel() {
  return new HostAuthorityKernel({
    history: {
      recent: (limit: number) =>
        [
          { role: 'user' as const, text: 'run the tests' },
          { role: 'assistant' as const, text: 'test run started' },
          { role: 'user' as const, text: 'also check the parser' },
        ].slice(-limit),
      total: () => 42,
    },
    files: {
      read: (relativePath: string) => (relativePath === 'src/app.ts' ? 'export const app = 1;' : null),
    },
  });
}

/** Promote and present one proposal, returning its identity echo. */
function promoteAndPresent(kernel: HostAuthorityKernel, tidied = 'hold phase three', original?: string) {
  const proposal = kernel.promote({
    route: 'direct_address',
    laneId: LANE,
    tidied,
    ...(original !== undefined ? { original } : {}),
    sourceUtteranceId: 7,
    createdTurn: 1,
  });
  kernel.proposals.present(proposal.id, 'tidied');
  return { proposal, identity: { version: proposal.version, sha256: proposal.sha256 } };
}

// ── Thread: where thinking happens, and nowhere to send it ─────────────────

describe('THREAD — in-memory conversation, structurally unsendable', () => {
  it('exposes no send, deliver, release, relay or promote method at all', () => {
    const methods = Object.getOwnPropertyNames(ThreadStore.prototype);
    for (const forbidden of ['send', 'deliver', 'release', 'relay', 'promote', 'publish', 'dispatch']) {
      expect(methods).not.toContain(forbidden);
    }
  });

  it('records turns in order with provenance, and returns copies (the store stays the source of truth)', () => {
    const threads = new ThreadStore();
    const first = threads.append({ laneId: LANE, role: 'operator', text: 'what is it doing?', turn: 1 });
    threads.append({ laneId: LANE, role: 'talker', text: 'Running the tests.', turn: 1 });
    expect(first.id).toBe(1);
    expect(first.sourceUtteranceId).toBeNull();
    expect(threads.recent(LANE, 5).map(t => t.text)).toEqual(['what is it doing?', 'Running the tests.']);
    const copy = threads.recent(LANE, 1)[0];
    copy.text = 'tampered';
    expect(threads.recent(LANE, 1)[0].text).toBe('Running the tests.');
  });

  it('appending thread turns creates no proposal and no release', () => {
    const kernel = makeKernel();
    kernel.threads.append({ laneId: LANE, role: 'operator', text: 'tell the worker to hold phase three', turn: 1 });
    kernel.threads.append({ laneId: LANE, role: 'talker', text: 'Noted.', turn: 1 });
    expect(kernel.proposals.live(LANE)).toBeNull();
    expect(kernel.proposals.list()).toEqual([]);
    expect(kernel.releases.history()).toEqual([]);
  });

  it('a thread turn cannot be promoted through any route — the only creation path refuses it', () => {
    const kernel = makeKernel();
    const turn = kernel.threads.append({ laneId: LANE, role: 'operator', text: 'release me', turn: 1 });
    expect(() =>
      kernel.promote({
        route: 'thread_turn' as PromotionRoute,
        laneId: LANE,
        tidied: turn.text,
        sourceUtteranceId: 1,
        createdTurn: 1,
      } as never)
    ).toThrow(UnknownPromotionRouteError);
    expect(kernel.proposals.list()).toEqual([]);
    expect(kernel.releases.history()).toEqual([]);
  });
});

// ── Parking Lot: things to raise later, one at a time ──────────────────────

describe('PARKING LOT — ordered, individually promotable, batch sending denied', () => {
  it('adds, lists in order, and promotes exactly one item out of the lot', () => {
    const lot = new ParkingLot();
    const a = lot.add({ text: 'ask about retry logic', sourceUtteranceId: 1 });
    const b = lot.add({ text: 'mention the parser', sourceUtteranceId: 2 });
    expect(lot.list().map(i => i.text)).toEqual(['ask about retry logic', 'mention the parser']);
    expect(a).toMatchObject({ id: 'park-1', text: 'ask about retry logic', sourceUtteranceId: 1 });
    expect(typeof a.createdAt).toBe('number');

    const promoted = lot.promote(a.id);
    expect(promoted.id).toBe(a.id);
    expect(lot.size()).toBe(1);
    expect(lot.list().map(i => i.text)).toEqual(['mention the parser']);
    expect(lot.promote(b.id).id).toBe(b.id);
    expect(lot.list()).toEqual([]);
  });

  it('promoting an unknown or already-promoted item throws', () => {
    const lot = new ParkingLot();
    expect(() => lot.promote('park-99')).toThrow(/not found/i);
    const a = lot.add({ text: 'one', sourceUtteranceId: 1 });
    lot.promote(a.id);
    expect(() => lot.promote(a.id)).toThrow(/not found/i);
  });

  it('batch promotion is denied in code — and the trap leaves the lot untouched', () => {
    const lot = new ParkingLot();
    lot.add({ text: 'one', sourceUtteranceId: 1 });
    lot.add({ text: 'two', sourceUtteranceId: 2 });
    let caught: unknown;
    try {
      lot.promoteBatch(['park-1', 'park-2']);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BatchPromotionDeniedError);
    expect((caught as BatchPromotionDeniedError).code).toBe('batch_promotion_denied');
    expect(lot.list().map(i => i.text)).toEqual(['one', 'two']);
  });
});

// ── Proposal: one live per lane, created only through the three routes ─────

describe('PROPOSAL — creation only through the three promotion routes', () => {
  it('the store refuses any route outside the three (a thread turn is not a route)', () => {
    const proposals = new ProposalStore();
    expect(() =>
      proposals.create({
        laneId: LANE,
        route: 'thread_turn' as PromotionRoute,
        tidied: 'x',
        sourceUtteranceId: 1,
        createdTurn: 1,
      })
    ).toThrow(UnknownPromotionRouteError);
    expect(proposals.list()).toEqual([]);
  });

  it('direct address creates a draft proposal with identity, bytes and provenance', () => {
    const kernel = makeKernel();
    const proposal = kernel.promote({
      route: 'direct_address',
      laneId: LANE,
      tidied: 'hold phase three',
      original: 'hold phase three please',
      sourceUtteranceId: 9,
      createdTurn: 3,
    });
    expect(proposal.status).toBe('draft');
    expect(proposal.laneId).toBe(LANE);
    expect(proposal.promotionRoute).toBe('direct_address');
    expect(proposal.sourceUtteranceId).toBe(9);
    expect(proposal.tidied).toBe('hold phase three');
    expect(proposal.original).toBe('hold phase three please');
    expect(proposal.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proposal.presentedVariant).toBeNull();
  });

  it('parked-item promotion uses the parked item’s own words and removes it from the lot', () => {
    const kernel = makeKernel();
    const item = kernel.parkingLot.add({ text: 'ask about the retry logic', sourceUtteranceId: 4 });
    const proposal = kernel.promote({
      route: 'parked_item_promotion',
      laneId: LANE,
      parkedItemId: item.id,
      sourceUtteranceId: 4,
      createdTurn: 2,
    });
    expect(proposal.tidied).toBe('ask about the retry logic');
    expect(proposal.promotionRoute).toBe('parked_item_promotion');
    expect(kernel.parkingLot.list()).toEqual([]);
  });

  it('accepted-offer promotion requires a real offer and relays the operator’s own question', () => {
    const kernel = makeKernel();
    expect(() =>
      kernel.promote({
        route: 'accepted_offer',
        laneId: LANE,
        offerId: 'offer-99',
        sourceUtteranceId: 5,
        createdTurn: 2,
      })
    ).toThrow(/offer/i);

    const offered = kernel.ops.offerAskWorker({
      question: 'why did the auth retry handler drop the token on line 42?',
      reason: 'cannot answer from what I hold',
      sourceUtteranceId: 5,
      topic: 'auth retry',
    });
    expect(offered.kind).toBe('offered');
    const offer = offered.kind === 'offered' ? offered.offer : null;
    const proposal = kernel.promote({
      route: 'accepted_offer',
      laneId: LANE,
      offerId: offer!.id,
      sourceUtteranceId: 5,
      createdTurn: 3,
    });
    expect(proposal.tidied).toBe('why did the auth retry handler drop the token on line 42?');
    expect(proposal.promotionRoute).toBe('accepted_offer');
    // An offer is consumed by its one promotion: it cannot be promoted twice.
    expect(() =>
      kernel.promote({
        route: 'accepted_offer',
        laneId: LANE,
        offerId: offer!.id,
        sourceUtteranceId: 5,
        createdTurn: 4,
      })
    ).toThrow(/already accepted/i);
  });

  it('keeps at most one live proposal per lane: a new promotion supersedes the old one', () => {
    const kernel = makeKernel();
    const first = kernel.promote({
      route: 'direct_address',
      laneId: LANE,
      tidied: 'first bytes',
      sourceUtteranceId: 1,
      createdTurn: 1,
    });
    const second = kernel.promote({
      route: 'direct_address',
      laneId: LANE,
      tidied: 'second bytes',
      sourceUtteranceId: 2,
      createdTurn: 2,
    });
    expect(second.id).not.toBe(first.id);
    expect(kernel.proposals.live(LANE)?.id).toBe(second.id);
    expect(kernel.proposals.get(first.id)?.status).toBe('superseded');
    // A superseded proposal can never release.
    kernel.proposals.present(second.id, 'tidied');
    const stale = kernel.confirm({
      proposalId: first.id,
      identity: { version: first.version, sha256: first.sha256 },
      idempotencyKey: 'key-stale',
    });
    expect(stale).toMatchObject({ kind: 'refused', reason: 'not_live' });
    expect(kernel.releases.history()).toEqual([]);
  });
});

// ── The delivered card identity / staleness / variant gates ────────────────

describe('PROPOSAL — the delivered identity gate is preserved', () => {
  it('a matching version + SHA-256 authorises exactly one release', () => {
    const kernel = makeKernel();
    const { proposal, identity } = promoteAndPresent(kernel);
    const result = kernel.confirm({ proposalId: proposal.id, identity, idempotencyKey: 'key-1' });
    expect(result.kind).toBe('authorised');
    expect(kernel.proposals.get(proposal.id)?.status).toBe('released');
    expect(kernel.proposals.live(LANE)).toBeNull();
  });

  it('a wrong version refuses as stale and releases nothing', () => {
    const kernel = makeKernel();
    const { proposal, identity } = promoteAndPresent(kernel);
    const result = kernel.confirm({
      proposalId: proposal.id,
      identity: { ...identity, version: identity.version + 1 },
      idempotencyKey: 'key-1',
    });
    expect(result).toMatchObject({ kind: 'refused', reason: 'stale' });
    expect(kernel.releases.history()).toEqual([]);
    expect(kernel.proposals.get(proposal.id)?.status).toBe('presented');
  });

  it('a tampered SHA-256 refuses as stale and releases nothing', () => {
    const kernel = makeKernel();
    const { proposal, identity } = promoteAndPresent(kernel);
    const result = kernel.confirm({
      proposalId: proposal.id,
      identity: { ...identity, sha256: 'f'.repeat(64) },
      idempotencyKey: 'key-1',
    });
    expect(result).toMatchObject({ kind: 'refused', reason: 'stale' });
    expect(kernel.releases.history()).toEqual([]);
  });

  it('the original variant is refused unless the current proposal advertised one', () => {
    const kernel = makeKernel();
    const clean = promoteAndPresent(kernel, 'run the deploy checks');
    const refused = kernel.confirm({
      proposalId: clean.proposal.id,
      variant: 'original',
      identity: clean.identity,
      idempotencyKey: 'key-clean',
    });
    expect(refused).toMatchObject({ kind: 'refused', reason: 'original_not_offered' });
    expect(kernel.releases.history()).toEqual([]);

    const otherLane = new HostAuthorityKernel();
    const raw = otherLane.promote({
      route: 'direct_address',
      laneId: 'worker-2',
      tidied: 'hold phase three',
      original: 'um, hold phase three, please',
      sourceUtteranceId: 1,
      createdTurn: 1,
    });
    otherLane.proposals.present(raw.id, 'original');
    const allowed = otherLane.confirm({
      proposalId: raw.id,
      variant: 'original',
      identity: { version: raw.version, sha256: raw.sha256 },
      idempotencyKey: 'key-raw',
    });
    expect(allowed.kind).toBe('authorised');
  });
});

// ── Release: append-only, idempotent, unknown-first-class ──────────────────

describe('RELEASE — append-only, idempotent, receipted', () => {
  it('records the full receipt shape and refuses a duplicate confirmation before any second delivery', () => {
    const kernel = makeKernel();
    const { proposal, identity } = promoteAndPresent(kernel);
    const first = kernel.confirm({ proposalId: proposal.id, identity, idempotencyKey: 'key-1' });
    expect(first.kind).toBe('authorised');
    const receipt = kernel.recordDelivery({
      proposalId: proposal.id,
      idempotencyKey: 'key-1',
      outcome: { status: 'delivered', mechanism: 'steer' },
      receiptTimestamp: 1_700_000_000_000,
    });
    expect(receipt).toEqual({
      proposalId: proposal.id,
      sha256: proposal.sha256,
      idempotencyKey: 'key-1',
      targetLane: LANE,
      deliveryOutcome: { status: 'delivered', mechanism: 'steer' },
      receiptTimestamp: 1_700_000_000_000,
    });

    // A duplicate confirmation is a refusal — and never a second release.
    const duplicate = kernel.confirm({
      proposalId: proposal.id,
      identity,
      idempotencyKey: 'key-2',
    });
    expect(duplicate).toMatchObject({ kind: 'duplicate_refusal', proposalId: proposal.id });
    expect(kernel.releases.history()).toHaveLength(1);
  });

  it('a duplicate confirmation before the receipt is recorded is still a duplicate refusal', () => {
    const kernel = makeKernel();
    const { proposal, identity } = promoteAndPresent(kernel);
    const first = kernel.confirm({ proposalId: proposal.id, identity, idempotencyKey: 'key-first' });
    expect(first.kind).toBe('authorised');
    // No recordDelivery yet: the proposal is spent the moment it is confirmed.
    const duplicate = kernel.confirm({ proposalId: proposal.id, identity, idempotencyKey: 'key-second' });
    expect(duplicate).toMatchObject({ kind: 'duplicate_refusal', proposalId: proposal.id });
    expect(kernel.releases.history()).toEqual([]);
  });

  it('re-using an idempotency key for a different proposal is a duplicate refusal, not a delivery', () => {
    const kernel = makeKernel();
    const one = kernel.promote({
      route: 'direct_address',
      laneId: LANE,
      tidied: 'one',
      sourceUtteranceId: 1,
      createdTurn: 1,
    });
    kernel.proposals.present(one.id, 'tidied');
    kernel.confirm({
      proposalId: one.id,
      identity: { version: one.version, sha256: one.sha256 },
      idempotencyKey: 'shared-key',
    });
    kernel.recordDelivery({
      proposalId: one.id,
      idempotencyKey: 'shared-key',
      outcome: { status: 'delivered' },
      receiptTimestamp: 1,
    });

    const two = kernel.promote({
      route: 'direct_address',
      laneId: 'worker-2',
      tidied: 'two',
      sourceUtteranceId: 2,
      createdTurn: 2,
    });
    kernel.proposals.present(two.id, 'tidied');
    const result = kernel.confirm({
      proposalId: two.id,
      identity: { version: two.version, sha256: two.sha256 },
      idempotencyKey: 'shared-key',
    });
    expect(result).toMatchObject({ kind: 'duplicate_refusal' });
    expect(kernel.proposals.get(two.id)?.status).toBe('presented'); // not consumed
    expect(kernel.releases.history()).toHaveLength(1);
  });

  it('the log is append-only: returned records are copies and a second record for a proposal throws', () => {
    const releases = new ReleaseStore();
    const entry = {
      proposalId: 'prop-1',
      sha256: 'a'.repeat(64),
      idempotencyKey: 'key-1',
      targetLane: LANE,
      deliveryOutcome: { status: 'delivered' as const },
      receiptTimestamp: 10,
    };
    releases.record(entry);
    const history = releases.history();
    history[0].deliveryOutcome = { status: 'refused', reason: 'tampered' };
    expect(releases.history()[0].deliveryOutcome).toEqual({ status: 'delivered' });
    expect(() => releases.record({ ...entry, deliveryOutcome: { status: 'delivered' } })).toThrow(
      DuplicateReleaseError
    );
    expect(releases.history()).toHaveLength(1);
  });

  it('an unknown outcome is first-class and must be reconciled by an appended record', () => {
    const kernel = makeKernel();
    const { proposal, identity } = promoteAndPresent(kernel);
    kernel.confirm({ proposalId: proposal.id, identity, idempotencyKey: 'key-unknown' });
    kernel.recordDelivery({
      proposalId: proposal.id,
      idempotencyKey: 'key-unknown',
      outcome: { status: 'unknown', reason: 'timeout after submission' },
      receiptTimestamp: 20,
    });
    const pending = kernel.releases.needsReconciliation();
    expect(pending).toHaveLength(1);
    expect(pending[0].deliveryOutcome).toEqual({ status: 'unknown', reason: 'timeout after submission' });

    const resolved = kernel.reconcile({
      idempotencyKey: 'key-unknown',
      outcome: { status: 'delivered' },
      receiptTimestamp: 30,
    });
    expect(resolved.reconciledFrom).toBe(20);
    expect(kernel.releases.needsReconciliation()).toEqual([]);
    // Append-only: the original unknown record is still in the log.
    expect(kernel.releases.history()).toHaveLength(2);
    expect(kernel.releases.history()[0].deliveryOutcome).toEqual({
      status: 'unknown',
      reason: 'timeout after submission',
    });
    // Re-reconciling a settled key is refused.
    expect(() =>
      kernel.reconcile({
        idempotencyKey: 'key-unknown',
        outcome: { status: 'delivered' },
        receiptTimestamp: 40,
      })
    ).toThrow(/reconcil/i);
  });
});

// ── The typed read-only operations ─────────────────────────────────────────

describe('READ-ONLY OPERATIONS — typed, bounded, and without prompt authority', () => {
  it('exposes exactly the five declared operations and nothing that can send', () => {
    const kernel = makeKernel();
    expect(Object.keys(kernel.ops).sort()).toEqual([
      'offerAskWorker',
      'parkItem',
      'readParkingLot',
      'retrieveFileContext',
      'retrieveSessionHistory',
    ]);
    for (const forbidden of ['send', 'release', 'deliver', 'promote', 'confirm']) {
      expect((kernel.ops as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it('park_item and read_parking_lot touch the lot only — never a proposal or a release', () => {
    const kernel = makeKernel();
    const item = kernel.ops.parkItem({ text: 'ask about retry logic', sourceUtteranceId: 3 });
    expect(kernel.ops.readParkingLot()).toEqual([item]);
    expect(kernel.proposals.list()).toEqual([]);
    expect(kernel.releases.history()).toEqual([]);
  });

  it('offer_ask_worker records an offer, never a proposal, and suppresses a second offer on the topic', () => {
    const kernel = makeKernel();
    const first = kernel.ops.offerAskWorker({
      question: 'why did the retry handler drop the token?',
      reason: 'worker must inspect the code',
      sourceUtteranceId: 4,
      topic: 'retry',
    });
    expect(first.kind).toBe('offered');
    const second = kernel.ops.offerAskWorker({
      question: 'why did the retry handler drop the token?',
      reason: 'worker must inspect the code',
      sourceUtteranceId: 5,
      topic: 'retry',
    });
    expect(second.kind).toBe('duplicate_offer_refused');
    expect(kernel.proposals.list()).toEqual([]);
    expect(kernel.releases.history()).toEqual([]);
  });

  it('retrieve_session_history is bounded to the declared window and copied', () => {
    const kernel = makeKernel();
    const result = kernel.ops.retrieveSessionHistory({ turnsBack: 2 });
    expect(result.turns.map(t => t.text)).toEqual(['test run started', 'also check the parser']);
    expect(result.total).toBe(42);
    expect(result.truncated).toBe(true);
  });

  it('retrieve_file_context reads a safe relative path and refuses absolute paths and traversal', () => {
    const kernel = makeKernel();
    expect(kernel.ops.retrieveFileContext({ relativePath: 'src/app.ts' })).toEqual({
      kind: 'read',
      relativePath: 'src/app.ts',
      text: 'export const app = 1;',
    });
    expect(kernel.ops.retrieveFileContext({ relativePath: '/etc/passwd' })).toMatchObject({
      kind: 'refused',
      reason: 'invalid_path',
    });
    expect(kernel.ops.retrieveFileContext({ relativePath: '../../etc/passwd' })).toMatchObject({
      kind: 'refused',
      reason: 'invalid_path',
    });
  });
});
