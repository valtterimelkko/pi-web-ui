/**
 * The typed read-only operations of the host authority kernel (Voice Mode
 * execution plan, Phase 2 / Track A; intent §19.2–§19.4).
 *
 * These are the only new capabilities the freed talker may exercise, each a
 * pure kernel/server function over injected read sources:
 *
 *   retrieve_session_history({ turnsBack })
 *   retrieve_file_context({ relativePath })
 *   park_item({ text, sourceUtteranceId })
 *   read_parking_lot()
 *   offer_ask_worker({ question, reason, sourceUtteranceId, topic? })
 *
 * NO TRANSPORT. These functions speak no wire protocol and touch no
 * WebSocket; the bridge and the client call them, never the reverse.
 *
 * NO MODEL PROMPT AUTHORITY. None of them can supply consent, compose or
 * replace delivery text, or create a proposal or a release: `park_item` and
 * `offer_ask_worker` write the parking lot and the offer registry, and a
 * promotion (with its own explicit route) is still required before anything
 * can become a proposal. A decline or an offer can never widen the gate.
 *
 * CLIENT-NEUTRAL (D7): no DOM/window/browser assumptions, in-memory only.
 */

import type { WorkerHistoryEntry } from './types.js';
import { ParkingLot, type ParkedItem } from './parking-lot.js';

/** Read-only seam for the worker session's earlier conversation (P20 shape). */
export interface WorkerHistoryReader {
  /** Most recent `limit` messages, oldest first. */
  recent(limit: number): WorkerHistoryEntry[];
  /** Total messages the reader can see (for honest truncation disclosure). */
  total(): number;
}

/** Read-only seam for file context inside the attached working directory. */
export interface FileContextReader {
  /** Read a relative path, or null when it cannot be read. */
  read(relativePath: string): string | null;
}

export type FileContextResult =
  | { kind: 'read'; relativePath: string; text: string }
  | { kind: 'refused'; relativePath: string; reason: 'invalid_path' | 'not_found' };

/** Bounds on retrieval, so a spoken request cannot pull an unbounded window. */
export const SESSION_HISTORY_MAX_TURNS_BACK = 200;

export interface KernelOffer {
  id: string;
  question: string;
  reason: string;
  sourceUtteranceId: number;
  /** Topic key for the one-offer-per-topic rule; null when untopiced. */
  topic: string | null;
  status: 'offered' | 'accepted' | 'declined';
  createdAt: number;
}

export type OfferAskWorkerResult =
  | { kind: 'offered'; offer: KernelOffer }
  | { kind: 'duplicate_offer_refused'; existing: KernelOffer };

export class OfferNotFoundError extends Error {
  readonly code = 'offer_not_found';
  constructor(offerId: string) {
    super(`Offer not found: ${offerId}`);
    this.name = 'OfferNotFoundError';
  }
}

export class OfferStateError extends Error {
  readonly code = 'offer_state';
  constructor(offerId: string, detail: string) {
    super(`Offer '${offerId}' cannot be accepted: ${detail}`);
    this.name = 'OfferStateError';
  }
}

/**
 * The talker's ask-the-worker offer registry. An offer is a proposal the
 * talker suggested, not one the operator authorised: accepting it is the
 * explicit step that lets the `accepted_offer` promotion route create a
 * Proposal from the OPERATOR'S OWN question bytes. At most one offer per
 * topic (intent §18.3): a repeat — including one after a decline — is
 * refused, never re-nagged.
 */
export class AskWorkerOffers {
  private offers: KernelOffer[] = [];
  private nextId = 1;
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  offer(input: {
    question: string;
    reason: string;
    sourceUtteranceId: number;
    topic?: string;
    createdAt?: number;
  }): OfferAskWorkerResult {
    const topic = input.topic ?? null;
    if (topic !== null) {
      const existing = this.offers.find(o => o.topic === topic);
      if (existing) return { kind: 'duplicate_offer_refused', existing: { ...existing } };
    }
    const offer: KernelOffer = {
      id: `offer-${this.nextId++}`,
      question: input.question,
      reason: input.reason,
      sourceUtteranceId: input.sourceUtteranceId,
      topic,
      status: 'offered',
      createdAt: input.createdAt ?? this.now(),
    };
    this.offers.push(offer);
    return { kind: 'offered', offer: { ...offer } };
  }

  get(offerId: string): KernelOffer | null {
    const found = this.offers.find(o => o.id === offerId);
    return found ? { ...found } : null;
  }

  /** Accept an offer for promotion. A declined or already-accepted offer cannot be accepted again. */
  accept(offerId: string): KernelOffer {
    const found = this.offers.find(o => o.id === offerId);
    if (!found) throw new OfferNotFoundError(offerId);
    if (found.status === 'declined') throw new OfferStateError(offerId, 'the operator declined this offer');
    if (found.status === 'accepted') throw new OfferStateError(offerId, 'this offer was already accepted and promoted');
    found.status = 'accepted';
    return { ...found };
  }

  decline(offerId: string): KernelOffer {
    const found = this.offers.find(o => o.id === offerId);
    if (!found) throw new OfferNotFoundError(offerId);
    found.status = 'declined';
    return { ...found };
  }
}

/** The declared read-only surface the talker/host may call. */
export interface KernelReadOnlyOperations {
  retrieveSessionHistory(input: { turnsBack: number }): {
    turns: WorkerHistoryEntry[];
    total: number;
    truncated: boolean;
  };
  retrieveFileContext(input: { relativePath: string }): FileContextResult;
  parkItem(input: { text: string; sourceUtteranceId: number }): ParkedItem;
  readParkingLot(): ParkedItem[];
  offerAskWorker(input: {
    question: string;
    reason: string;
    sourceUtteranceId: number;
    topic?: string;
  }): OfferAskWorkerResult;
}

/**
 * Whether a path can be passed to `retrieve_file_context`: relative only, no
 * traversal, no absolute/drive/UNC/system prefixes, no null bytes.
 */
export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.trim() === '') return false;
  if (relativePath.includes('\u0000')) return false;
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || relativePath.startsWith('~')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(relativePath)) return false;
  return !relativePath.split(/[\\/]+/).some(segment => segment === '..');
}

export function createReadOnlyKernelOperations(sources: {
  history: WorkerHistoryReader;
  files: FileContextReader;
  parkingLot: ParkingLot;
  offers: AskWorkerOffers;
}): KernelReadOnlyOperations {
  return {
    retrieveSessionHistory(input) {
      const requested = Number.isFinite(input.turnsBack) ? Math.trunc(input.turnsBack) : 1;
      const turnsBack = Math.max(1, Math.min(SESSION_HISTORY_MAX_TURNS_BACK, requested));
      const total = sources.history.total();
      const turns = sources.history.recent(turnsBack).map(turn => ({ ...turn }));
      return { turns, total, truncated: total > turns.length };
    },

    retrieveFileContext(input) {
      if (!isSafeRelativePath(input.relativePath)) {
        return { kind: 'refused', relativePath: input.relativePath, reason: 'invalid_path' };
      }
      const text = sources.files.read(input.relativePath);
      if (text === null) {
        return { kind: 'refused', relativePath: input.relativePath, reason: 'not_found' };
      }
      return { kind: 'read', relativePath: input.relativePath, text };
    },

    parkItem(input) {
      return sources.parkingLot.add({ text: input.text, sourceUtteranceId: input.sourceUtteranceId });
    },

    readParkingLot() {
      return sources.parkingLot.list();
    },

    offerAskWorker(input) {
      return sources.offers.offer(input);
    },
  };
}
