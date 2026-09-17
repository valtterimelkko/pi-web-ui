/**
 * The PARKING LOT object (Voice Mode execution plan, Phase 2 / Track A).
 *
 * An ordered, operator-visible list of things flagged while the worker was
 * busy (intent §16.2). Parked items survive turns and lane switches, are
 * individually promotable, and can be read back on request.
 *
 * BATCH SENDING IS DENIED IN CODE. N3 is per instruction, and a batch
 * promotion would quietly defeat it, so there is deliberately no bulk path:
 * `promote` takes exactly one id, and the only multi-id method is the
 * `promoteBatch` trap, which throws. Nothing here can release anything —
 * promotion hands one item to the caller; only an explicit promotion route in
 * policy-core's HostAuthorityKernel turns that item into a Proposal.
 *
 * In-memory and client-neutral (D7): no DOM/window, no transport, no I/O.
 */

export interface ParkedItem {
  id: string;
  text: string;
  createdAt: number;
  /** The verbatim-log utterance the item came from (provenance). */
  sourceUtteranceId: number;
}

/** Thrown by the bulk-promotion trap: batching would defeat per-item consent. */
export class BatchPromotionDeniedError extends Error {
  readonly code = 'batch_promotion_denied';
  readonly attempted: number;

  constructor(attempted: number) {
    super(
      `Batch promotion denied: ${attempted} items were offered, but the parking lot promotes exactly one item at a time (N3).`
    );
    this.name = 'BatchPromotionDeniedError';
    this.attempted = attempted;
  }
}

export class ParkedItemNotFoundError extends Error {
  readonly code = 'parked_item_not_found';

  constructor(itemId: string) {
    super(`Parked item not found: ${itemId}`);
    this.name = 'ParkedItemNotFoundError';
  }
}

export interface ParkingLotOptions {
  /** Clock seam for deterministic tests. */
  now?: () => number;
}

export class ParkingLot {
  private items: ParkedItem[] = [];
  private promoted: ParkedItem[] = [];
  private nextId = 1;
  private readonly now: () => number;

  constructor(opts?: ParkingLotOptions) {
    this.now = opts?.now ?? Date.now;
  }

  /** Park one item. Returns a copy; ordering is insertion order. */
  add(input: { text: string; sourceUtteranceId: number; createdAt?: number }): ParkedItem {
    const item: ParkedItem = {
      id: `park-${this.nextId++}`,
      text: input.text,
      createdAt: input.createdAt ?? this.now(),
      sourceUtteranceId: input.sourceUtteranceId,
    };
    this.items.push(item);
    return { ...item };
  }

  /** The parked items, oldest first, as copies. */
  list(): ParkedItem[] {
    return this.items.map(item => ({ ...item }));
  }

  size(): number {
    return this.items.length;
  }

  /**
   * Promote exactly one parked item out of the lot. The item leaves the list
   * (it is on its way to becoming a proposal, not still "to raise later") and
   * is retained in the promoted log for provenance. Throws when the id is
   * unknown or already promoted.
   */
  promote(itemId: string): ParkedItem {
    const index = this.items.findIndex(item => item.id === itemId);
    if (index < 0) throw new ParkedItemNotFoundError(itemId);
    const [item] = this.items.splice(index, 1);
    this.promoted.push(item);
    return { ...item };
  }

  /**
   * The bulk-promotion trap (documented at the top of this module). There is
   * no way to promote several items in one call; this method exists so that an
   * attempted batch fails loudly and mechanically rather than through
   * omission. The lot is untouched.
   */
  promoteBatch(_itemIds: readonly string[]): never {
    throw new BatchPromotionDeniedError(_itemIds.length);
  }

  /** Promoted-item log (provenance), as copies. */
  promotedItems(): ParkedItem[] {
    return this.promoted.map(item => ({ ...item }));
  }
}
