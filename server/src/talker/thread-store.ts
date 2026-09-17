/**
 * The THREAD object (Voice Mode execution plan, Phase 2 / Track A).
 *
 * The live conversation: what the operator and the talker said, in order.
 * Ephemeral, nothing in it is addressed to the worker (intent §16.1).
 *
 * STRUCTURALLY UNSENDABLE (N1, N8). This module has no route to the worker
 * and cannot produce relay text, a proposal, or a release: the only module
 * that can authorise delivery is release-store.ts, and it is driven by
 * policy-core's HostAuthorityKernel from a Proposal — never from a thread
 * turn. A thread turn is not a promotion route and there is no method here
 * that another module could use to make it one; the negative suite
 * (four-objects.test.ts) pins that absence.
 *
 * In-memory and client-neutral (D7): no DOM/window, no transport, no I/O.
 */

export type ThreadRole = 'operator' | 'talker';

export interface ThreadTurn {
  id: number;
  laneId: string;
  role: ThreadRole;
  text: string;
  /** Talker turn index at which the utterance arrived. */
  turn: number;
  /** Verbatim-log id when the turn came from the operator, else null. */
  sourceUtteranceId: number | null;
  createdAt: number;
}

const DEFAULT_THREAD_LIMIT = 200;

export interface ThreadStoreOptions {
  /** Rolling bound on retained turns (oldest evicted first). */
  limit?: number;
  /** Clock seam for deterministic tests. */
  now?: () => number;
}

export class ThreadStore {
  private turns: ThreadTurn[] = [];
  private nextId = 1;
  private readonly limit: number;
  private readonly now: () => number;

  constructor(opts?: ThreadStoreOptions) {
    this.limit = opts?.limit ?? DEFAULT_THREAD_LIMIT;
    this.now = opts?.now ?? Date.now;
  }

  /** Append one conversational turn. Returns a copy — the store keeps the original. */
  append(input: {
    laneId: string;
    role: ThreadRole;
    text: string;
    turn: number;
    sourceUtteranceId?: number;
    createdAt?: number;
  }): ThreadTurn {
    const turn: ThreadTurn = {
      id: this.nextId++,
      laneId: input.laneId,
      role: input.role,
      text: input.text,
      turn: input.turn,
      sourceUtteranceId: input.sourceUtteranceId ?? null,
      createdAt: input.createdAt ?? this.now(),
    };
    this.turns.push(turn);
    if (this.turns.length > this.limit) {
      this.turns.splice(0, this.turns.length - this.limit);
    }
    return { ...turn };
  }

  /** The most recent `count` turns of one lane, oldest first. Copies only. */
  recent(laneId: string, count: number): ThreadTurn[] {
    if (!Number.isFinite(count) || count <= 0) return [];
    return this.turns
      .filter(t => t.laneId === laneId)
      .slice(-Math.trunc(count))
      .map(t => ({ ...t }));
  }

  /** One turn by id, as a copy, or null. */
  get(id: number): ThreadTurn | null {
    const found = this.turns.find(t => t.id === id);
    return found ? { ...found } : null;
  }

  /** Retained-turn count, for one lane or the whole store. */
  size(laneId?: string): number {
    if (laneId === undefined) return this.turns.length;
    return this.turns.reduce((n, t) => (t.laneId === laneId ? n + 1 : n), 0);
  }
}
