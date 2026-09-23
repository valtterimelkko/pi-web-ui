/**
 * Deterministic episode director (native-primary plan §4.2(4), §5.3).
 *
 * A finite-state machine built from a corpus episode. It speaks ONLY frozen
 * operator wording (episode input turns and repair-branch sayings — enforced
 * structurally: every speak action's text comes from those fields), and it
 * advances on OBSERVATIONS, never on a blind timer:
 *
 *   - an adaptive confirm/steer turn is spoken only after a candidate whose
 *     text satisfies the episode's declared slots has been observed AND that
 *     identity's presentation has completed;
 *   - an amend/cancel turn is spoken after any presented candidate (the
 *     operator reacts to what was presented), and it invalidates that
 *     identity: a later candidate must carry a NEW identity;
 *   - an adaptive-repair turn is spoken when a candidate arrives that fails
 *     the slot check (the misheard-correction case, C17);
 *   - repair branches (frozen wording) fire on silence past a deadline or a
 *     mismatched candidate when no repair turn exists; at most one
 *     clarification is ever spoken (plan §5.3 budget), the second event is a
 *     terminal interaction failure;
 *   - an observed release the director never approved is a terminal
 *     safety failure — the run stops and the verifier grades it.
 *
 * The clock is injected; the same observation script always produces the same
 * action sequence.
 */

import type { Episode, EpisodeExpectedSlots } from './corpus.js';
export type { EpisodeExpectedSlots };

// ── Slot checking (the definition both the director and the verifier use) ──

export function normaliseUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SlotVerdict {
  matched: boolean;
  reasons: string[];
}

/** Deterministic slot/constraint check of a candidate payload against an episode's slots.
 *  Entries may declare alternates "hotfix|hot fix" — any alternative satisfies. */
export function checkSlots(payloadText: string, slots: EpisodeExpectedSlots): SlotVerdict {
  const payload = normaliseUtterance(payloadText);
  const reasons: string[] = [];
  const matchesAny = (entry: string): boolean =>
    entry
      .split('|')
      .some((alt) => payload.includes(normaliseUtterance(alt)));
  for (const entry of slots.mustContain) {
    if (!matchesAny(entry)) {
      reasons.push(`missing required content: "${entry}"`);
    }
  }
  for (const forbidden of slots.mustNotContain) {
    if (forbidden
      .split('|')
      .every((alt) => payload.includes(normaliseUtterance(alt)))) {
      reasons.push(`forbidden content present: "${forbidden}"`);
    }
  }
  for (const forbiddenStart of slots.mustNotStartWith ?? []) {
    if (payload.startsWith(normaliseUtterance(forbiddenStart))) {
      reasons.push(`forbidden opening: "${forbiddenStart}"`);
    }
  }
  for (const slot of slots.numericSlots ?? []) {
    const accepted = slot.acceptAnyOf.some((alt) => payload.includes(normaliseUtterance(alt)));
    if (!accepted) reasons.push(`numeric slot missing: ${slot.value}`);
  }
  return { matched: reasons.length === 0, reasons };
}

// ── Observations and actions ────────────────────────────────────────────────

export type DirectorObservation =
  | { kind: 'candidate'; payloadText: string; identity: string; atMs: number }
  | { kind: 'presentation'; identity: string; complete: boolean; atMs: number }
  | { kind: 'release'; identity: string; atMs: number }
  | { kind: 'delivery'; identity: string; atMs: number }
  | { kind: 'worker-store'; identity: string; ok: boolean; atMs: number }
  | { kind: 'response'; text: string; atMs: number }
  /** The mount parked the relay while the worker was busy (W4 busy parking). */
  | { kind: 'parked'; itemId: string; atMs: number };

export type DirectorAction =
  | { type: 'speak'; turnId: string; text: string }
  | { type: 'await'; reason: string; deadlineMs: number }
  /** Soak: the operator stays silent for a fixed, recorded interval. */
  | { type: 'pace'; ms: number }
  /** Soak: drop the voice transport; the product must reconnect through its own paths. */
  | { type: 'reconnect-transport' }
  /** Busy parking: promote EXACTLY ONE observed parked item via the product's own control. */
  | { type: 'promote'; itemId: string }
  /** Attachment switch: swap the attached worker through the product's own control. */
  | { type: 'switch-attachment' }
  | {
      type: 'terminal';
      status: 'complete' | 'interaction-failure' | 'safety-failure';
      reason: string;
    };

type PhaseKind =
  | 'speak'
  | 'await-candidate'
  | 'await-presentation'
  | 'await-response'
  | 'await-release'
  | 'await-delivery'
  | 'await-worker-store'
  | 'await-parked'
  | 'promote'
  | 'switch'
  | 'pace'
  | 'reconnect';

interface Phase {
  kind: PhaseKind;
  /** For speak phases: the episode turn to speak. */
  turnId?: string;
  text?: string;
  /** Strict phases require slot-matched candidates (confirm/steer); relaxed accept any presentation (amend/cancel). */
  strict?: boolean;
  /** For pace phases. */
  paceMs?: number;
  deadlineMs: number;
  enteredAtMs: number | null;
}

export interface DirectorOptions {
  now: () => number;
}

const TERMINAL_COMPLETE: DirectorAction = {
  type: 'terminal',
  status: 'complete',
  reason: 'episode flow completed',
};

const AWAIT_LABELS: Record<string, string> = {
  'await-candidate': 'candidate',
  'await-presentation': 'presentation',
  'await-response': 'response',
  'await-release': 'release',
  'await-delivery': 'delivery',
  'await-worker-store': 'worker store',
  'await-parked': 'parked item',
};

export class EpisodeDirector {
  private readonly episode: Episode;
  private readonly now: () => number;
  private readonly phases: Phase[] = [];
  private cursor = 0;

  private candidateIdentity: string | null = null;
  private candidateText: string | null = null;
  /** A candidate observed while a speak phase was current (fix-loop C20). */
  private pendingCandidate: { identity: string; payloadText: string } | null = null;
  /** A COMPLETED presentation observed while a speak phase was current (fix-loop pass 4, C20). */
  private pendingPresentation: { identity: string; complete: boolean } | null = null;
  /** A parked item observed while a speak phase was current (W4 busy parking). */
  private pendingParked: { itemId: string } | null = null;
  /** The ONE observed parked item this journey promotes (W4). */
  private parkedItemId: string | null = null;
  private presented = false;
  private approvedIdentity: string | null = null;
  private invalidatedIdentities = new Set<string>();
  private repairEvents = 0;
  private repairTurnUsed = false;
  private clarificationUsed = false;
  private done = false;
  private terminal: DirectorAction | null = null;

  constructor(episode: Episode, options: DirectorOptions) {
    if (episode.holdout) {
      throw new Error(
        `${episode.id}: holdout wording is frozen by a separate validator — the director cannot drive it until then`
      );
    }
    this.episode = episode;
    this.now = options.now;
    this.phases.push(...this.buildProgram());
  }

  // ── Program construction ────────────────────────────────────────────────

  private buildProgram(): Phase[] {
    const phases: Phase[] = [];
    const d = this.episode.perStepDeadlinesMs;
    const routesRelay = this.routesRelay;
    for (const turn of this.episode.inputTurns) {
      switch (turn.kind) {
        case 'opening':
        case 'conversational':
          phases.push({ kind: 'speak', turnId: turn.id, text: turn.text, deadlineMs: 0, enteredAtMs: null });
          break;
        case 'adaptive-repair':
          // Reactive: spoken when a candidate fails the slot check. Not a program phase.
          break;
        case 'adaptive-amend':
        case 'adaptive-cancel':
          phases.push({ kind: 'await-candidate', strict: false, deadlineMs: d.candidateMs, enteredAtMs: null });
          phases.push({ kind: 'await-presentation', deadlineMs: d.presentationMs, enteredAtMs: null });
          phases.push({ kind: 'speak', turnId: turn.id, text: turn.text, deadlineMs: 0, enteredAtMs: null });
          break;
        case 'adaptive-repeat':
          phases.push({ kind: 'speak', turnId: turn.id, text: turn.text, deadlineMs: 0, enteredAtMs: null });
          break;
        case 'adaptive-confirm':
        case 'adaptive-steer':
          phases.push({ kind: 'await-candidate', strict: true, deadlineMs: d.candidateMs, enteredAtMs: null });
          phases.push({ kind: 'await-presentation', deadlineMs: d.presentationMs, enteredAtMs: null });
          phases.push({ kind: 'speak', turnId: turn.id, text: turn.text, deadlineMs: 0, enteredAtMs: null });
          break;
        case 'adaptive-promote':
          // The operator promotes exactly one parked item through the
          // product's own path (W4): the FSM waits for the OBSERVED parked
          // item, then emits the promote action. The promoted proposal and its
          // presentation are consumed by the NEXT confirm turn's phases.
          phases.push({ kind: 'await-parked', deadlineMs: d.candidateMs, enteredAtMs: null });
          phases.push({ kind: 'promote', deadlineMs: 0, enteredAtMs: null });
          break;
        case 'soak-pace':
          phases.push({ kind: 'pace', paceMs: turn.paceMs ?? 0, deadlineMs: 0, enteredAtMs: null });
          break;
        case 'soak-reconnect':
          phases.push({ kind: 'reconnect', deadlineMs: 0, enteredAtMs: null });
          break;
        case 'adaptive-switch':
          // W4 attachment switch: the operator switches the attached worker
          // through the product's own switch control. The pending proposal's
          // retirement (H1 cancel-before-retarget) is OBSERVED on the wire,
          // never assumed here.
          phases.push({ kind: 'switch', deadlineMs: 0, enteredAtMs: null });
          break;
      }
    }
    if (routesRelay) {
      phases.push({ kind: 'await-release', deadlineMs: d.deliveryMs, enteredAtMs: null });
      phases.push({ kind: 'await-delivery', deadlineMs: d.deliveryMs, enteredAtMs: null });
      phases.push({ kind: 'await-worker-store', deadlineMs: d.workerStoreMs, enteredAtMs: null });
    } else {
      phases.push({ kind: 'await-response', deadlineMs: d.candidateMs, enteredAtMs: null });
    }
    return phases;
  }

  private get repairTurn(): { turnId: string; text: string } | null {
    const turn = this.episode.inputTurns.find((candidate) => candidate.kind === 'adaptive-repair');
    return turn ? { turnId: turn.id, text: turn.text } : null;
  }

  private get routesRelay(): boolean {
    return this.episode.permittedRouteOutcomes.some((outcome) =>
      ['relay-proposal', 'parks-while-busy', 'steer-busy'].includes(outcome)
    );
  }

  private get clarification(): { turnId: string; text: string } | null {
    const branch = this.episode.repairBranches.find((candidate) => candidate.action === 'one-clarification');
    if (branch?.say) return { turnId: 'repair-1', text: branch.say };
    const repeat = this.episode.repairBranches.find((candidate) => candidate.action === 'repeat-identical');
    if (repeat) return { turnId: 'repair-1', text: this.episode.inputTurns[0].text };
    return null;
  }

  // ── Stepping ────────────────────────────────────────────────────────────

  step(observation?: DirectorObservation): DirectorAction {
    if (this.done && this.terminal) return this.terminal;

    const timedOut = this.checkTimeout();
    if (timedOut) return timedOut;

    if (observation) {
      const handled = this.feed(observation);
      if (handled) return handled;
    }
    return this.activate();
  }

  private checkTimeout(): DirectorAction | null {
    for (let index = this.cursor; index < this.phases.length; index += 1) {
      const phase = this.phases[index];
      if (phase.kind === 'speak') continue;
      if (phase.enteredAtMs === null) break; // not yet active: nothing to time out
      const elapsed = this.now() - phase.enteredAtMs;
      if (elapsed <= phase.deadlineMs) break;
      return this.repairOrFail(`deadline exceeded waiting for ${phase.kind.replace('await-', '')}`);
    }
    return null;
  }

  /** Frozen repair wording on the first event; terminal interaction failure on the second. */
  private repairOrFail(reason: string): DirectorAction {
    this.repairEvents += 1;
    const repairTurn = this.repairTurn;
    if (repairTurn && !this.repairTurnUsed) {
      this.repairTurnUsed = true;
      this.resetCandidateSegment();
      return { type: 'speak', turnId: repairTurn.turnId, text: repairTurn.text };
    }
    const clarification = this.clarification;
    if (clarification && !this.clarificationUsed) {
      this.clarificationUsed = true;
      this.resetCandidateSegment();
      return { type: 'speak', turnId: clarification.turnId, text: clarification.text };
    }
    return this.fail('interaction-failure', `${reason}; repair budget exhausted (plan §5.3)`);
  }

  private resetCandidateSegment(): void {
    this.candidateIdentity = null;
    this.candidateText = null;
    this.pendingCandidate = null;
    this.pendingPresentation = null;
    this.presented = false;
    // Re-arm the active candidate/presentation/parked phases with fresh deadlines.
    for (const phase of this.phases) {
      if (phase.kind === 'await-candidate' || phase.kind === 'await-presentation' || phase.kind === 'await-parked') {
        if (phase.enteredAtMs !== null) phase.enteredAtMs = this.now();
      }
    }
  }

  private fail(status: 'interaction-failure' | 'safety-failure', reason: string): DirectorAction {
    this.done = true;
    this.terminal = { type: 'terminal', status, reason };
    return this.terminal;
  }

  private complete(): DirectorAction {
    this.done = true;
    this.terminal = TERMINAL_COMPLETE;
    return this.terminal;
  }

  private feed(observation: DirectorObservation): DirectorAction | null {
    const phase = this.phases[this.cursor];
    if (!phase) return null;

    // Safety first: a release the director never approved is always a stop.
    if (observation.kind === 'release') {
      if (this.approvedIdentity === null || observation.identity !== this.approvedIdentity) {
        return this.fail(
          'safety-failure',
          this.approvedIdentity === null
            ? 'unauthorised release: no approval was given by the operator flow'
            : `mis-targeted release: ${observation.identity} != approved ${this.approvedIdentity}`
        );
      }
    }

    switch (phase.kind) {
      case 'speak':
      case 'pace':
      case 'reconnect':
      case 'switch':
        // A candidate may arrive while the operator turn is still being spoken
        // (fix-loop pass 1, C20) — while a soak pace/reconnect window is in
        // progress (for a 150-second pace step this is the NORM, not a race) —
        // or while a promote/switch gesture runs (the pending proposal exists
        // across the gesture). Record it so the next await-candidate phase is
        // satisfied by it instead of demanding a repeat that never comes.
        if (observation.kind === 'candidate') {
          if (!this.routesRelay) {
            return this.fail('safety-failure', 'forbidden proposal: conversation-only episode produced a candidate');
          }
          if (this.invalidatedIdentities.has(observation.identity)) {
            return this.fail(
              'safety-failure',
              `identity reuse after cancel/amend: ${observation.identity} was invalidated`
            );
          }
          this.pendingCandidate = { identity: observation.identity, payloadText: observation.payloadText };
        }
        // The presentation-side analogue (fix-loop pass 4, C20): a COMPLETED
        // presentation may also land inside a speak window (the client renders
        // the read-back while the next operator turn is playing). Record it so
        // the later await-presentation phase is satisfied by it instead of
        // waiting for a repeat that never comes. Incomplete presentations carry
        // no satisfiable fact and are dropped, exactly as the await path does.
        if (observation.kind === 'presentation' && observation.complete) {
          if (!this.invalidatedIdentities.has(observation.identity)) {
            this.pendingPresentation = { identity: observation.identity, complete: true };
          }
        }
        // A parked announcement may also land inside a speak window: record it
        // so the later await-parked phase is satisfied without a repeat.
        if (observation.kind === 'parked' && this.pendingParked === null) {
          this.pendingParked = { itemId: observation.itemId };
        }
        return null;
      case 'await-candidate':
      case 'await-presentation': {
        if (observation.kind === 'candidate') {
          const routesRelay = this.routesRelay;
          if (!routesRelay) {
            return this.fail('safety-failure', 'forbidden proposal: conversation-only episode produced a candidate');
          }
          if (this.invalidatedIdentities.has(observation.identity)) {
            return this.fail(
              'safety-failure',
              `identity reuse after cancel/amend: ${observation.identity} was invalidated`
            );
          }
          if (phase.strict) {
            const verdict = checkSlots(observation.payloadText, this.episode.expectedSlots);
            if (!verdict.matched) {
              return this.repairOrFail(
                `mismatched candidate: ${verdict.reasons.join('; ')}`
              );
            }
          }
          this.candidateIdentity = observation.identity;
          this.candidateText = observation.payloadText;
          // The revised candidate's presentation must be observed afresh: a
          // stored presentation belongs to the OLD identity (fix-loop pass 4).
          this.pendingPresentation = null;
          // A revised candidate restarts the presentation requirement.
          if (phase.kind === 'await-presentation') {
            phase.enteredAtMs = this.now();
            return { type: 'await', reason: 'candidate revised; presentation required again', deadlineMs: phase.deadlineMs };
          }
          this.advance();
          return null;
        }
        if (observation.kind === 'presentation' && phase.kind === 'await-presentation') {
          if (!observation.complete || observation.identity !== this.candidateIdentity) return null;
          this.presented = true;
          this.advance();
          return null;
        }
        return null;
      }
      case 'await-parked': {
        if (observation.kind === 'parked' && this.parkedItemId === null) {
          // Exactly one item is ever promoted; the first observed park wins.
          this.parkedItemId = observation.itemId;
          this.advance();
        }
        return null;
      }
      case 'await-response': {
        if (observation.kind === 'response') {
          this.responseText = observation.text;
          return this.complete();
        }
        if (observation.kind === 'candidate') {
          return this.fail('safety-failure', 'forbidden proposal: conversation-only episode produced a candidate');
        }
        return null;
      }
      case 'await-release': {
        if (observation.kind === 'release') {
          this.advance();
          return null;
        }
        return null;
      }
      case 'await-delivery': {
        if (observation.kind === 'delivery' && observation.identity === this.approvedIdentity) {
          this.advance();
          return null;
        }
        return null;
      }
      case 'await-worker-store': {
        if (observation.kind === 'worker-store') {
          if (!observation.ok) {
            return this.fail('interaction-failure', 'worker store check failed: approved input was not persisted');
          }
          return this.complete();
        }
        return null;
      }
      default:
        return null;
    }
  }

  private responseText: string | null = null;

  private advance(): void {
    this.cursor += 1;
  }

  /** Speak the current phase if due; activate the next awaiting phase otherwise. */
  private activate(): DirectorAction {
    while (this.cursor < this.phases.length) {
      const phase = this.phases[this.cursor];
      if (phase.kind === 'speak') {
        const text = phase.text ?? '';
        this.cursor += 1;
        const turn = this.episode.inputTurns.find((candidate) => candidate.id === phase.turnId);
        if (turn?.kind === 'adaptive-amend' || turn?.kind === 'adaptive-cancel') {
          if (this.candidateIdentity) this.invalidatedIdentities.add(this.candidateIdentity);
          if (this.pendingCandidate) this.invalidatedIdentities.add(this.pendingCandidate.identity);
          this.pendingCandidate = null;
          this.pendingPresentation = null;
          this.candidateIdentity = null;
          this.candidateText = null;
          this.presented = false;
        }
        if (turn?.kind === 'adaptive-confirm' || turn?.kind === 'adaptive-steer') {
          this.approvedIdentity = this.candidateIdentity;
        }
        // The NEXT await phase arms when it is first POLLED, not here: the
        // runner speaks the frozen utterance (device playback + pipeline entry
        // take real time), and the deadline must measure model latency from the
        // end of the operator's speech — never transport time.
        return { type: 'speak', turnId: phase.turnId ?? turn?.id ?? 'unknown', text };
      }
      // A candidate recorded during a speak phase satisfies an await-candidate
      // phase the moment that phase is entered — before its deadline is armed
      // (fix-loop pass 1, C20). Strict phases still grade it; amend/cancel
      // invalidation and the repair reset clear it.
      if (
        phase.kind === 'await-candidate' &&
        phase.enteredAtMs === null &&
        this.pendingCandidate &&
        !this.invalidatedIdentities.has(this.pendingCandidate.identity)
      ) {
        const pending = this.pendingCandidate;
        this.pendingCandidate = null;
        if (phase.strict) {
          const verdict = checkSlots(pending.payloadText, this.episode.expectedSlots);
          if (!verdict.matched) {
            return this.repairOrFail(`mismatched candidate: ${verdict.reasons.join('; ')}`);
          }
        }
        this.candidateIdentity = pending.identity;
        this.candidateText = pending.payloadText;
        this.advance();
        continue;
      }
      // A completed presentation recorded during a speak phase satisfies an
      // await-presentation phase the moment that phase is entered — before its
      // deadline is armed — when it carries the CURRENT candidate's identity
      // (fix-loop pass 4, C20). A revised candidate's identity never matches a
      // stale store, so a fresh presentation is still required there.
      if (
        phase.kind === 'await-presentation' &&
        phase.enteredAtMs === null &&
        this.pendingPresentation?.complete === true &&
        this.pendingPresentation.identity === this.candidateIdentity
      ) {
        this.presented = true;
        this.pendingPresentation = null;
        this.advance();
        continue;
      }
      // A parked item recorded during a speak phase satisfies the await-parked
      // phase the moment it is entered (W4 busy parking).
      if (phase.kind === 'await-parked' && phase.enteredAtMs === null && this.pendingParked) {
        if (this.parkedItemId === null) this.parkedItemId = this.pendingParked.itemId;
        this.pendingParked = null;
        this.advance();
        continue;
      }
      if (phase.kind === 'pace') {
        this.cursor += 1;
        return { type: 'pace', ms: phase.paceMs ?? 0 };
      }
      if (phase.kind === 'reconnect') {
        this.cursor += 1;
        return { type: 'reconnect-transport' };
      }
      if (phase.kind === 'switch') {
        this.cursor += 1;
        return { type: 'switch-attachment' };
      }
      if (phase.kind === 'promote') {
        this.cursor += 1;
        if (this.parkedItemId === null) {
          // Unreachable in a well-formed program (promote only follows a
          // satisfied await-parked); if it ever happens, it is an honest
          // interaction failure — never a fabricated promote.
          return this.repairOrFail('no parked item was observed to promote');
        }
        return { type: 'promote', itemId: this.parkedItemId };
      }
      if (phase.enteredAtMs === null) phase.enteredAtMs = this.now();
      return { type: 'await', reason: `waiting for ${AWAIT_LABELS[phase.kind] ?? phase.kind}`, deadlineMs: phase.deadlineMs };
    }
    return this.complete();
  }

  // ── Introspection for records/tests ─────────────────────────────────────

  get state(): {
    candidateIdentity: string | null;
    candidateText: string | null;
    presented: boolean;
    approvedIdentity: string | null;
    responseText: string | null;
    parkedItemId: string | null;
  } {
    return {
      candidateIdentity: this.candidateIdentity,
      candidateText: this.candidateText,
      presented: this.presented,
      approvedIdentity: this.approvedIdentity,
      responseText: this.responseText,
      parkedItemId: this.parkedItemId,
    };
  }
}
