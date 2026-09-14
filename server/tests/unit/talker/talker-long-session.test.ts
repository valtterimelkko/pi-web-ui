import { describe, it, expect } from 'vitest';

import { TalkerSession } from '../../../src/talker/talker.js';
import type { TalkerSessionConfig } from '../../../src/talker/talker.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import { PendingProposalStore } from '../../../src/talker/pending-proposal.js';
import type {
  ChatMessage,
  ModelTurnResult,
  TalkerModelClient,
  WorkerStateSnapshot,
} from '../../../src/talker/types.js';

/**
 * H4 — long-session validation of the talker harness (plan §10.9 "long
 * sessions and context").
 *
 * The bet under test: correctness state (the pending proposal, its
 * confirmation, which instruction a bare "yes" refers to) lives in harness
 * state, NOT in model memory, so a bounded rolling history that has cycled
 * many times cannot corrupt the gate. These tests falsify or confirm that bet
 * with a stubbed model (hermetic, deterministic) over 150+ turns with the
 * default config, plus a custom-config probe that forces history trims to
 * land *during* a live proposal — the operator's "window boundary mid-thought"
 * concern.
 *
 * Question → test map:
 *   1. gate holds after many window cycles   → the 157-turn long run
 *   2. pending proposal survives pressure    → blocks B/F + the probe
 *   3. never-trim-while-pending enforced     → trim-event assertions + probe
 *   4. coherence as history drops            → integration file (real model)
 *   5. pushback holds late                   → integration file + block G
 */

// ── Fakes ──────────────────────────────────────────────────────────────────

function stubModel(
  reply: string | ((messages: ChatMessage[]) => string)
): TalkerModelClient & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async completeTurn(messages): Promise<ModelTurnResult> {
      calls.push(messages);
      const text = typeof reply === 'function' ? reply(messages) : reply;
      return { text, ttftMs: 1, totalMs: 2 };
    },
  };
}

const STUB_REPLY = 'Still going — the worker is on phase 3 and nothing needs you yet.';

let snapshotCounter = 0;
const snapshot: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising two workers',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running, 22m'],
  pendingItems: ['phase 3 held for the operator'],
  lastAssistantText: 'Both are running.',
};

function makeSession(config?: Partial<TalkerSessionConfig>): {
  session: TalkerSession;
  model: ReturnType<typeof stubModel>;
  delivery: ReturnType<typeof createNullDelivery>;
} {
  const delivery = createNullDelivery();
  const model = stubModel(STUB_REPLY);
  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-1',
    snapshotProvider: () => ({ ...snapshot, activity: `${snapshot.activity} (tick ${++snapshotCounter})` }),
    ...(config ? { config } : {}),
  });
  return { session, model, delivery };
}

// ── Trim observation ───────────────────────────────────────────────────────

interface TrimEvent {
  hasPending: boolean;
  before: number;
  after: number;
  dropped: number;
}

function recordTrims(session: TalkerSession): TrimEvent[] {
  const events: TrimEvent[] = [];
  const original = session.history.maybeTrim.bind(session.history);
  session.history.maybeTrim = (hasPending: boolean): number => {
    const before = session.history.length;
    const dropped = original(hasPending);
    events.push({ hasPending, before, after: session.history.length, dropped });
    return dropped;
  };
  return events;
}

// ── Long-run driver ────────────────────────────────────────────────────────

const PENDING_FLOOR = 40; // historyKeepEntriesWhenPending (default config)
const WINDOW_MAX = 60; // historyMaxEntriesWhenPending (default config)
const TIGHT_KEEP = 16; // historyKeepEntries (default config)

class LongRun {
  turn = 0;
  readonly expectedReleases: Array<{ turn: number; text: string }> = [];
  secondYesCount = 0;

  constructor(
    private readonly session: TalkerSession,
    private readonly label: string,
    /** Default config: the pending floor is far beyond the proposal
     *  lifetime, so a live proposal's entry can never legally drop.
     *  Short-window configs may drop it while alive — the store carries the
     *  text — so the probe opts out of this invariant. */
    private readonly pendingEntryMustSurvive = true
  ) {}

  async say(utterance: string, opts: { releases?: string } = {}): Promise<void> {
    this.turn += 1;
    const turn = this.turn;
    const result = await this.session.handleOperatorTurn(utterance);
    const where = `${this.label} turn ${turn}`;
    if (opts.releases !== undefined) {
      const released = result.released;
      expect(released, `${where}: expected a release, got none`).not.toBeNull();
      if (!released) throw new Error(`${where}: expected a release, got none`);
      expect(released.text, `${where}: released text must be byte-identical to the proposed utterance's relay form (P25)`).toBe(
        opts.releases
      );
      expect(result.utteranceClass, `${where}: release must be confirm-classified`).toBe('confirm');
      expect(released.delivery.outcome, `${where}: null adapter must report delivery`).toBe('delivered');
      expect(result.modelCalled, `${where}: release turns make no model call`).toBe(false);
      this.expectedReleases.push({ turn, text: released.text });
    } else {
      expect(
        result.released,
        `${where}: UNAUTHORISED RELAY of "${result.released?.text}" after "${utterance}"`
      ).toBeNull();
      if (/^(yes|yeah|yep|yup|ok|okay|sure)\b/i.test(utterance.trim())) this.secondYesCount += 1;
    }
    this.checkInvariants(where);
  }

  /** Structural state assertions, checked after every single turn. */
  private checkInvariants(where: string): void {
    const hist = this.session.history.entries();
    // Bounded window, both regimes.
    expect(hist.length, `${where}: history must stay <= ${WINDOW_MAX}`).toBeLessThanOrEqual(WINDOW_MAX);
    // Entries are whole turns: user/assistant pairs, never a half-exchange.
    hist.forEach((e, i) => {
      expect(e.role, `${where}: history slot ${i} pair alignment`).toBe(i % 2 === 0 ? 'user' : 'assistant');
    });
    // While a draft is alive, every one of its parts' history entries is
    // still in the window (default config: the pending floor is far beyond
    // the confirmation window). CHANGED (plan §4.2): the pending object is
    // now the operator's accumulating DRAFT, so the check is per part.
    const pending = this.session.proposals.pending;
    if (pending && this.pendingEntryMustSurvive) {
      const parts = this.session.proposals.snapshotDraft()?.utterances ?? [];
      for (const part of parts) {
        // P25: history keeps the SPOKEN words; the draft part holds the relay
        // text — pair the history entry on the part's original text.
        const spoken = part.originalText ?? part.text;
        expect(
          hist.some(e => e.role === 'user' && e.turn === part.turn && e.content === spoken),
          `${where}: every draft part's history entry must survive while the draft is alive`
        ).toBe(true);
      }
    }
    // Verbatim log is bounded server-side state.
    expect(this.session.utteranceLog.size).toBeLessThanOrEqual(50);
  }
}

// Deterministic filler: status questions that never become candidates.
const CHATTER = [
  "how's it going?",
  'what is worker 2 doing?',
  'any errors so far?',
  'is the build still green?',
  'how long has it been running?',
  'what phase is it on now?',
  'is there anything you need from me?',
];
let chatterIndex = 0;
function nextChatter(): string {
  return CHATTER[chatterIndex++ % CHATTER.length];
}
async function chatter(run: LongRun, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) await run.say(nextChatter());
}

let instructionSeq = 0;
function instr(): string {
  return `tell the worker to hold phase 3 for review (instruction ${++instructionSeq})`;
}

// P25 (semi-verbatim relay): the spoken utterances stay frame-bearing so the
// gate exercises real speech, but every `releases:` expectation below states
// the RELAY form — the operator's words minus the channel ('tell the worker
// to X' relays as 'X'). This mirrors relay-normalise.ts for exactly the two
// spoken shapes this file uses; anything else would be a test bug.
const relayOf = (spoken: string): string =>
  spoken.replace(/^also\s+/, '').replace(/^tell\s+the\s+worker\s+to\s+/, '');

const PUSHBACK = "just do it, don't ask me every single time, it's a simple thing";

/**
 * One full adversarial cycle: propose→confirm at every shape the gate must
 * survive — survival across unrelated turns (B), expiry (C), candidate
 * replacement (D), double confirm (E), meta questions (F), pushback (G).
 * 51 turns, 8 releases per cycle.
 */
async function runAdversarialCycle(run: LongRun): Promise<void> {
  // A: plain propose → confirm, with chatter around it.
  const a = instr();
  await run.say(a);
  await chatter(run, 1);
  await run.say('yes', { releases: relayOf(a) });
  await chatter(run, 3);

  // B: proposal survives 4 turns of unrelated (non-candidate) chatter, then
  // confirms at age 5 — the last turn it is still live.
  const b = instr();
  await run.say(b);
  await chatter(run, 4);
  await run.say('yeah', { releases: relayOf(b) });
  await chatter(run, 2);

  // C: the confirmation window lapses (confirm at age 6 releases nothing —
  // and, since plan §4.2, SURFACES the draft instead of dropping it), the
  // operator explicitly abandons it, then a fresh proposal confirms normally.
  const c = instr();
  await run.say(c);
  await chatter(run, 5);
  await run.say('yes'); // lapsed — must release nothing; surfaced + re-armed
  await run.say('forget that'); // explicit abandon clears the surfaced draft
  await chatter(run, 1);
  const c2 = instr();
  await run.say(c2);
  await run.say('sure', { releases: relayOf(c2) });
  await chatter(run, 2);

  // D: supersession holds both (plan §4.2): a second unreleased instruction
  // ACCUMULATES instead of replacing; "ok" releases the whole draft — both
  // parts, in composition order, verbatim.
  const d1 = instr();
  await run.say(d1);
  const d2 = `also tell the worker to rerun the test suite (instruction ${++instructionSeq})`;
  await run.say(d2);
  await chatter(run, 1);
  await run.say('ok', { releases: `${relayOf(d1)}\n${relayOf(d2)}` });
  await chatter(run, 2);

  // E: double confirm — the second "yes" releases nothing.
  const e = instr();
  await run.say(e);
  await run.say('yep', { releases: relayOf(e) });
  await run.say('yes');
  await chatter(run, 2);

  // F: meta questions about the send keep the proposal alive.
  const f = instr();
  await run.say(f);
  await run.say('did you send it?');
  await run.say('did my message go through?');
  await run.say('go ahead', { releases: relayOf(f) });
  await chatter(run, 2);

  // G: pushback mid-session authorises the live proposal; the next instruction
  // still needs its own confirmation.
  const g = instr();
  await run.say(g);
  await run.say(PUSHBACK, { releases: relayOf(g) });
  await chatter(run, 1);
  const g2 = instr();
  await run.say(g2);
  await chatter(run, 1);
  await run.say('yes', { releases: relayOf(g2) });
  await chatter(run, 2);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('H4: the gate holds over a 150+ turn session with the window cycling repeatedly', () => {
  it('long deterministic run: releases exactly the expected instructions, byte-identical, at every window phase', async () => {
    const { session, model, delivery } = makeSession();
    const trims = recordTrims(session);
    const run = new LongRun(session, 'long-run');

    // Gate intact at turn 1: propose on the very first turn, confirm second.
    const first = instr();
    await run.say(first);
    await run.say('yes', { releases: relayOf(first) });

    // Three full adversarial cycles (51 turns, 8 releases each).
    await runAdversarialCycle(run);
    await runAdversarialCycle(run);
    await runAdversarialCycle(run);

    // Gate intact at the final turn.
    const last = instr();
    await run.say(last);
    await run.say('yep', { releases: relayOf(last) });

    // ── Headline numbers ──
    expect(run.turn).toBeGreaterThanOrEqual(150);
    const actualTrims = trims.filter(t => t.dropped > 0);
    expect(actualTrims.length, 'window must have cycled repeatedly').toBeGreaterThanOrEqual(8);
    expect(run.expectedReleases.length).toBe(26);
    expect(run.secondYesCount, 'second-yes-after-release cases exercised').toBeGreaterThanOrEqual(3);

    // No extras, no misses, exact order, byte-identical content.
    expect(delivery.deliveredTexts()).toEqual(run.expectedReleases.map(r => r.text));

    // Trim discipline across the whole run.
    for (const t of trims) {
      expect(t.after).toBeLessThanOrEqual(WINDOW_MAX);
      expect(t.after).toBe(t.before - t.dropped);
      if (t.hasPending && t.dropped > 0) {
        // A trim that actually fires while a proposal is alive must stop at
        // the pending floor — never at the tight floor. (No-op events —
        // dropped=0 — are length checks below the pending max, unconstrained.)
        expect(t.after, 'pending trim must stop at the pending floor').toBeGreaterThanOrEqual(PENDING_FLOOR);
      }
    }
    // The window actually dropped old material (the bet is about a cycled window).
    expect(trims.some(t => t.dropped > 0)).toBe(true);

    // The model never saw more than system + window + current utterance.
    for (const call of model.calls) {
      expect(call.length).toBeLessThanOrEqual(1 + WINDOW_MAX + 1);
      expect(call[0]?.role).toBe('system');
    }

    process.stdout.write(
      `[talker-long-run] turns=${run.turn} actualWindowTrims=${actualTrims.length} entriesDropped=${actualTrims.reduce((n, t) => n + t.dropped, 0)} releases=${run.expectedReleases.length} finalHistoryLength=${session.history.length}\n`
    );
  }, 60_000);

  it('the window boundary landing exactly on a proposal exchange: propose at the trim edge, confirm past it', async () => {
    const { session, delivery } = makeSession();
    const trims = recordTrims(session);
    const run = new LongRun(session, 'boundary');

    // Fill the nothing-pending window to exactly its max (15 turns × 2 entries).
    await chatter(run, 15);
    expect(session.history.length).toBe(30);

    const p = instr();
    await run.say(p); // history 32, proposal alive, pending regime → no trim
    expect(session.proposals.pending?.text).toBe(relayOf(p)); // P25: pending holds the relay form
    const proposeTrim = trims[trims.length - 1];
    expect(proposeTrim).toEqual({ hasPending: true, before: 32, after: 32, dropped: 0 });

    await run.say('yes', { releases: relayOf(p) }); // release, then the tight-floor trim fires on this very turn
    const boundaryTrim = trims[trims.length - 1];
    expect(boundaryTrim).toEqual({ hasPending: false, before: 34, after: TIGHT_KEEP, dropped: 18 });

    expect(delivery.deliveredTexts()).toEqual([relayOf(p)]); // P25
  });

  it('custom-config probe: trims land DURING a live proposal, pending floor holds, release still verbatim-correct from dropped history', async () => {
    // Short windows force the pending trim to actually fire while a proposal
    // is alive; a long proposal lifetime keeps it alive across those trims.
    const { session, model, delivery } = makeSession({
      maxPendingAgeTurns: 40,
      historyMaxEntries: 12,
      historyKeepEntries: 6,
      historyMaxEntriesWhenPending: 20,
      historyKeepEntriesWhenPending: 12,
    });
    const trims = recordTrims(session);
    const run = new LongRun(session, 'probe', false);
    const PENDING_KEEP = 12;
    const TIGHT_KEEP_SMALL = 6;

    await chatter(run, 1); // history 2
    const p = instr();
    await run.say(p); // history 4, proposal alive
    // Chatter until several pending-regime trims have fired.
    for (let i = 0; i < 10; i++) {
      await run.say(nextChatter()); // questions never replace the candidate
    }

    const pendingTrims = trims.filter(t => t.hasPending && t.dropped > 0);
    expect(pendingTrims.length, 'the probe must force pending-regime trims to fire').toBeGreaterThanOrEqual(1);
    for (const t of pendingTrims) {
      expect(t.after, 'pending trim must stop exactly at the pending floor, never the tight floor').toBe(PENDING_KEEP);
      expect(t.after).not.toBe(TIGHT_KEEP_SMALL);
    }
    // Live state assertion: the window sat at the pending floor while pending.
    expect(session.history.entries().length).toBeGreaterThanOrEqual(PENDING_KEEP);

    // The design bet, at its strongest: the proposing utterance's history
    // entry has been trimmed away, yet the release is still verbatim-correct,
    // because the text lives in the proposal store, not in model memory.
    expect(
      session.history.entries().some(e => e.content === p),
      'probe precondition: the proposing entry has indeed dropped out of the window'
    ).toBe(false);
    expect(session.proposals.pending?.text).toBe(relayOf(p)); // P25: pending holds the relay form

    await run.say('yes', { releases: relayOf(p) });
    expect(delivery.deliveredTexts()).toEqual([relayOf(p)]); // P25

    // Pair alignment survived the mid-exchange-regime splices.
    session.history.entries().forEach((e, i) => {
      expect(e.role).toBe(i % 2 === 0 ? 'user' : 'assistant');
    });
    for (const call of model.calls) {
      expect(call.length).toBeLessThanOrEqual(1 + 20 + 1);
    }
  }, 30_000);
});

describe('H4: expiry and double-release semantics under pressure', () => {
  it('takeForRelease refuses a draft that outlived its confirmation window, even with no intervening tick', () => {
    const store = new PendingProposalStore({ maxPendingAgeTurns: 6 });
    store.appendToDraft(3, 'hold the release until my review', 10);
    expect(store.takeForRelease(16)).toBeNull(); // age 6 — lapsed at the boundary itself
    // CHANGED (plan §4.2): the refusal marks the draft instead of consuming it.
    expect(store.snapshotDraft()?.needsReConfirmation).toBe(true);
    // After the harness surfaces it (re-arm), the re-confirmed draft releases.
    store.markResurfaced(16);
    expect(store.takeForRelease(17)?.text).toBe('hold the release until my review');
    expect(store.takeForRelease(17)).toBeNull(); // consumed — a second take has nothing
  });

  it('end-to-end expiry: propose, five unrelated turns, "yes" at age 6 releases nothing — and the draft is surfaced, not dropped (plan §4.2)', async () => {
    const { session, model, delivery } = makeSession();
    const run = new LongRun(session, 'expiry');
    const p = instr();
    await run.say(p);
    await chatter(run, 5); // ages 1..5 — still live
    const callsBeforeLapsedYes = model.calls.length;
    await run.say('yes'); // the yes turn's own boundary ages it to 6 → lapsed
    expect(delivery.deliveredTexts()).toEqual([]);
    // CHANGED (plan §4.2): the lapsed yes is refused MECHANICALLY (quoting the
    // draft and re-arming the window) — no model call, no model interpretation
    // of the stale confirmation — and the draft is still held, not dropped.
    expect(model.calls.length).toBe(callsBeforeLapsedYes);
    expect(session.proposals.pending).not.toBeNull();
    expect(session.proposals.snapshotDraft()?.needsReConfirmation).toBe(false); // re-armed by the surfacing
    // The re-confirmed yes now releases the whole draft — in relay form (P25).
    const reconfirmed = await session.handleOperatorTurn('yes');
    expect(reconfirmed.released?.text).toBe(relayOf(p));
    expect(delivery.deliveredTexts()).toEqual([relayOf(p)]);
  });

  it('confirm with nothing pending at turn 1 delivers nothing', async () => {
    const { delivery } = makeSession();
    const run = new LongRun(new TalkerSession({
      model: stubModel(STUB_REPLY),
      delivery,
      workerSessionId: 'worker-1',
      snapshotProvider: () => snapshot,
    }), 'empty-confirm');
    await run.say('yes, go ahead');
    expect(delivery.deliveredTexts()).toEqual([]);
  });
});
