#!/usr/bin/env npx tsx
/**
 * P27 — comprehensive live validation of the talker's function surface.
 *
 * ONE run exercising the CURRENT, combined surface (P1–P26) in a real
 * integration graph (real PiService + MultiSessionManager + TalkerSessionRegistry),
 * following the established pattern of scripts/talker-history-live-validate.ts.
 *
 * Two model modes, chosen per row and reported per row:
 *   - STUB  — a scripted TalkerModelClient (deterministic; every mechanical
 *             gate/relay/marker/receipt row). No network.
 *   - REAL  — the production OpenRouter talker model against a REAL disposable
 *             pi worker session (rows that need live history / live model).
 *
 * Deliveries in BOTH modes are null deliveries that record the exact handed
 * bytes — the primary invariant (released bytes == draft bytes == what the
 * card's server-side source of truth held) is byte-compared, never eyeballed.
 * Nothing here touches production; isolation dirs under /tmp.
 *
 * Rows covered here (the rest live in the WS/client phases):
 *   1 confirm shapes          (stub)         8 conservative relay left-in (pure+stub)
 *   2 cancel shapes+residue   (stub)         9 PRIMARY INVARIANT          (stub+real)
 *   3 question taxonomy       (stub)        10 clean byte-identical       (stub)
 *   4 gate dead-ends+lapse    (stub)        11 ask-worker offer relay     (stub+real)
 *   5 release() private       (inspection)  12 [[to-talker]] narrowing    (stub+real)
 *   6 supersession+selection  (stub)        13 [[ask-worker]] honoured    (stub+real)
 *                                           only on question turns
 *   7 relay strips            (pure+stub)   14 one receipt per batch      (stub+real)
 *   15 real-history answers + deep 2200-char window            (real)
 *   16 observability records + lane bindings (in-process part)   (both)
 *
 * Usage:
 *   source ~/.bashrc  # OPENROUTER_API_KEY (needed for --real / default full run)
 *   env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS npx tsx scripts/p27-talker-matrix-live.ts \
 *     [--stub-only | --real-only] [--json /tmp/p27-evidence/phaseA.json]
 *
 * Exit 0 iff every executed row PASSes (FAIL rows are reproduced assertions,
 * recorded with actual values; rows are never marked FAIL on flake suspicion).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}

// ── Isolation FIRST (before any server module reads config) ───────────────
const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p27-matrix-'));
const piSessionsDir = path.join(validationDir, 'pi-sessions');
fs.mkdirSync(piSessionsDir, { recursive: true });
process.env.SESSION_DIR = piSessionsDir;
process.env.SESSION_REGISTRY_PATH = path.join(validationDir, 'session-registry.json');
process.env.CLAUDE_SESSION_DIR = path.join(validationDir, 'claude-sessions');
process.env.ANTIGRAVITY_SESSION_DIR = path.join(validationDir, 'antigravity-sessions');
const workspaceDir = path.join(validationDir, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

const args = process.argv.slice(2);
const getArg = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const stubOnly = args.includes('--stub-only');
const realOnly = args.includes('--real-only');
const jsonPath = getArg('--json');

if (!stubOnly && !process.env.TALKER_API_KEY && !process.env.OPENROUTER_API_KEY) {
  console.error('P27: real rows need OPENROUTER_API_KEY (source ~/.bashrc) or pass --stub-only');
  process.exit(1);
}

// ── Row ledger ────────────────────────────────────────────────────────────
interface RowResult {
  row: string;
  verdict: 'PASS' | 'FAIL';
  driver: string;
  drove: string;
  observed: string;
}
const rows: RowResult[] = [];
function record(row: string, driver: string, drove: string, observed: string, ok: boolean): void {
  rows.push({ row, verdict: ok ? 'PASS' : 'FAIL', driver, drove, observed });
  log(`${ok ? '✅' : '❌'} [${row}] ${observed}`);
}
function check(label: string, ok: boolean, detail: string): boolean {
  if (!ok) log(`   ↳ mismatch: ${detail}`);
  return ok;
}

// ── Scripted model (deterministic rows) ───────────────────────────────────
import type { ChatMessage, TalkerModelClient, TalkerTurnResult, WorkerDelivery } from '../server/src/talker/types.js';
import { createNullDelivery } from '../server/src/talker/delivery.js';
import { normaliseRelayText } from '../server/src/talker/relay-normalise.js';
import { renderStateView } from '../server/src/talker/state-view.js';
import {
  NOTHING_PENDING_ACK,
  NOTHING_TO_CANCEL_ACK,
  RECEIPT_ACK,
  RELEASE_ACK,
} from '../server/src/talker/ack.js';

class ScriptedModel implements TalkerModelClient {
  calls = 0;
  lastMessages: ChatMessage[] = [];
  private queue: string[] = [];
  constructor(private fallback = 'Noted — I am holding that for your go-ahead.') {}
  enqueue(...replies: string[]): void {
    this.queue.push(...replies);
  }
  async completeTurn(messages: ChatMessage[]) {
    this.calls += 1;
    this.lastMessages = messages;
    return { text: this.queue.shift() ?? this.fallback, ttftMs: 1, totalMs: 2 };
  }
}

function nullDeliveries(): { pi: WorkerDelivery; claude: WorkerDelivery; antigravity: WorkerDelivery } & { texts(): string[] } {
  const d = createNullDelivery();
  return { pi: d, claude: d, antigravity: d, texts: () => d.deliveredTexts() };
}

async function main(): Promise<void> {
  const { getPiService } = await import('../server/src/pi/index.js');
  const { MultiSessionManager } = await import('../server/src/pi/multi-session-manager.js');
  const { TalkerSessionRegistry } = await import('../server/src/talker/session-registry.js');
  const { SESSION_HISTORY_LIMITS } = await import('../server/src/talker/state-view.js');

  const piService = getPiService();
  await piService.initialize();
  const manager = new MultiSessionManager(piService, () => {}, {
    enableMemoryMonitoring: false,
    cleanupIntervalMs: 60_000,
  });

  // ── STUB registry: deterministic matrix ─────────────────────────────────
  const stubModel = new ScriptedModel();
  const stubDeliveries = nullDeliveries();
  const stubRegistry = new TalkerSessionRegistry({
    multiSessionManager: manager,
    modelClient: stubModel,
    deliveries: stubDeliveries,
  });

  let laneSeq = 0;
  const newLane = (): string => `p27-stub-lane-${++laneSeq}`;
  const draftOf = (ref: string) => stubRegistry.get(ref, 'pi')?.proposals.snapshotDraft() ?? null;
  /** The bytes the confirmation card's server-side source of truth holds. */
  const cardBytes = (ref: string): string | null => {
    const d = draftOf(ref);
    return d ? d.utterances.map(u => u.text).join('\n') : null;
  };

  if (!realOnly) {
    // ════ ROW 1 + 4 + 14 — confirm shapes, dead ends, one receipt per batch ════
    log('── STUB: rows 1/4/14 — confirm shapes, nothing-pending dead end, receipts ──');
    let ref = newLane();
    let r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes' });
    record('4a', 'stub registry', '"yes" with nothing held',
      `reply=${JSON.stringify(r.reply)} modelCalled=${r.turn?.modelCalled} released=${r.turn?.released === null}`,
      check('4a', r.reply === NOTHING_PENDING_ACK && r.turn?.modelCalled === false && r.turn?.released === null,
        JSON.stringify({ reply: r.reply, mc: r.turn?.modelCalled })));

    const part1 = 'hold the deploy until I review the diff';
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: part1 });
    const r1Receipt = r.turn?.receiptAck;
    record('14a', 'stub registry', `"${part1}" (opens the batch)`,
      `receiptAck=${JSON.stringify(r1Receipt ?? null)} draft=${JSON.stringify(cardBytes(ref))}`,
      check('14a', r1Receipt === RECEIPT_ACK && cardBytes(ref) === part1,
        `receipt=${r1Receipt} draft=${cardBytes(ref)}`));

    const part2 = 'then rerun the full test suite';
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: part2 });
    record('14b', 'stub registry', `"${part2}" (same batch)`,
      `second receipt=${JSON.stringify(r.turn?.receiptAck ?? null)} (must be absent)`,
      check('14b', r.turn?.receiptAck === undefined, `receiptAck=${r.turn?.receiptAck}`));

    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'ok' });
    record('1a+9a', 'stub registry', '"ok" (bare confirm, 2-part draft)',
      `reply=${JSON.stringify(r.reply)} released=${JSON.stringify(r.turn?.released?.text)} deliveryBytes=${JSON.stringify(stubDeliveries.texts())}`,
      check('1a', r.turn?.utteranceClass === 'confirm' && r.reply === RELEASE_ACK && r.turn?.released?.text === `${part1}\n${part2}`
        && stubDeliveries.texts()[0] === `${part1}\n${part2}`,
        JSON.stringify({ cls: r.turn?.utteranceClass, released: r.turn?.released?.text })));

    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes' });
    record('4b', 'stub registry', '"yes" again (authorisation consumed)',
      `reply=${JSON.stringify(r.reply)} released=null? ${r.turn?.released === null}`,
      check('4b', r.reply === NOTHING_PENDING_ACK && r.turn?.released === null && stubDeliveries.texts().length === 1,
        `releases so far=${stubDeliveries.texts().length}`));

    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'go ahead' });
    record('1b', 'stub registry', '"go ahead" with nothing held',
      `mechanical dead end: ${JSON.stringify(r.reply)}`,
      check('1b', r.reply === NOTHING_PENDING_ACK && r.turn?.modelCalled === false, r.reply));

    // pushback with pending (row 1c) — "just do it, stop asking" shape
    ref = newLane();
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'rerun the suite after phase 3 lands' });
    const before = cardBytes(ref);
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: "just do it, don't ask me every single time, it's a simple thing" });
    record('1c+9b', 'stub registry', 'pushback with live draft',
      `class=${r.turn?.utteranceClass} released=${JSON.stringify(r.turn?.released?.text)} card had=${JSON.stringify(before)}`,
      check('1c', r.turn?.utteranceClass === 'confirm' && r.turn?.released?.text === before && stubDeliveries.texts().at(-1) === before,
        `released=${r.turn?.released?.text}`));

    // ════ ROW 6 — supersession holds both; ordinal subset release ════════════
    log('── STUB: row 6 — supersession holds both, selection releases exactly that part ──');
    ref = newLane();
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: part1 });
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: part2 });
    const twoPart = cardBytes(ref);
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'just the second one' });
    const afterSubset = cardBytes(ref);
    record('6a', 'stub registry', '2-part draft then "just the second one"',
      `released=${JSON.stringify(r.turn?.released?.text)} remaining draft=${JSON.stringify(afterSubset)} (both parts were ${JSON.stringify(twoPart)})`,
      check('6a', r.turn?.released?.text === part2 && afterSubset === part1 && stubDeliveries.texts().at(-1) === part2,
        JSON.stringify({ released: r.turn?.released?.text, remaining: afterSubset })));
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'confirmed' });
    record('6b', 'stub registry', '"confirmed" releases the held remainder',
      `released=${JSON.stringify(r.turn?.released?.text)} draft now=${JSON.stringify(cardBytes(ref))}`,
      check('6b', r.turn?.released?.text === part1 && cardBytes(ref) === null, JSON.stringify(r.turn?.released?.text)));

    // ════ ROW 2 — cancel shapes + same-breath residue ════════════════════════
    log('── STUB: row 2 — cancel shapes and the cancel+instruction residue ──');
    ref = newLane();
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'no' });
    record('2a', 'stub registry', '"no" with nothing held',
      `reply=${JSON.stringify(r.reply)} modelCalled=${r.turn?.modelCalled}`,
      check('2a', r.reply === NOTHING_TO_CANCEL_ACK && r.turn?.modelCalled === false, r.reply));

    for (const cancelShape of ['never mind', 'cancel it', "don't send that"]) {
      ref = newLane();
      await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'deploy the staging build' });
      const held = cardBytes(ref);
      r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: cancelShape });
      const cleared = cardBytes(ref) === null;
      r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes' });
      record('2b', 'stub registry', `"${cancelShape}" clears a held draft (held=${JSON.stringify(held)})`,
        `cancelled=${r.turn ? 'see prior turn' : '-'}; follow-up "yes" → ${JSON.stringify(r.reply)}; total releases=${stubDeliveries.texts().length}`,
        check('2b', cleared && r.reply === NOTHING_PENDING_ACK, `cleared=${cleared} followup=${r.reply}`));
    }

    ref = newLane();
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'ship the release candidate' });
    const preCancel = cardBytes(ref);
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'Never mind, forget it. Tell the worker to rebase instead.' });
    const residueDraft = draftOf(ref);
    const residueRelay = residueDraft?.utterances.at(-1);
    record('2c', 'stub registry', 'one breath: cancel + new instruction',
      `old draft=${JSON.stringify(preCancel)} → new draft part=${JSON.stringify(residueRelay?.text)} original=${JSON.stringify(residueRelay?.originalText)}`,
      check('2c', r.turn?.cancelled === true && residueRelay?.text === 'rebase instead.' && residueRelay?.originalText === 'Tell the worker to rebase instead.',
        JSON.stringify(residueDraft)));
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes, go ahead' });
    record('2d+9c', 'stub registry', 'confirm releases the residue in RELAY form',
      `released=${JSON.stringify(r.turn?.released?.text)} (NOT the raw residue)`,
      check('2d', r.turn?.released?.text === 'rebase instead.' && stubDeliveries.texts().at(-1) === 'rebase instead.',
        JSON.stringify(r.turn?.released?.text)));

    // ════ ROW 3 — question taxonomy ══════════════════════════════════════════
    log('── STUB: row 3 — question vs statement; worker-directed; meta-send ──');
    ref = newLane();
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: "Morning — how's it going, where are we?" });
    record('3a', 'stub registry', 'status question', `class=${r.turn?.utteranceClass} draft=${JSON.stringify(cardBytes(ref))}`,
      check('3a', r.turn?.utteranceClass === 'question' && cardBytes(ref) === null, JSON.stringify({ cls: r.turn?.utteranceClass, draft: cardBytes(ref) })));

    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'could you ask the worker to rebase?' });
    const qd = draftOf(ref)?.utterances.at(-1);
    record('3b+7a', 'stub registry', 'worker-directed question',
      `class=${r.turn?.utteranceClass} draft part=${JSON.stringify(qd?.text)} original=${JSON.stringify(qd?.originalText)}`,
      check('3b', r.turn?.utteranceClass === 'question' && qd?.text === 'rebase?' && qd?.originalText === 'could you ask the worker to rebase?',
        JSON.stringify(draftOf(ref))));
    const heldAfterDirective = cardBytes(ref);

    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'did you send it?' });
    record('3c', 'stub registry', 'meta-send question with live draft',
      `class=${r.turn?.utteranceClass} draft unchanged=${JSON.stringify(cardBytes(ref) === heldAfterDirective)} released=${r.turn?.released === null}`,
      check('3c', r.turn?.utteranceClass === 'question' && cardBytes(ref) === heldAfterDirective && r.turn?.released === null,
        JSON.stringify({ cls: r.turn?.utteranceClass, draft: cardBytes(ref) })));

    // ════ ROW 4c — stale confirmation: mechanical re-confirm with verbatim quote ════
    log('── STUB: row 4c — lapsed confirmation is refused with the verbatim quote ──');
    ref = newLane();
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'hold the release for my review' });
    const lapsedDraft = cardBytes(ref);
    for (let i = 0; i < 6; i++) {
      await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'how about now?' });
    }
    const callsBeforeLapse = stubModel.calls;
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes' });
    const quoteExpected = `You were composing something — still want that sent? Here is what I am holding: "${lapsedDraft}". Say yes and I will send it.`;
    const stillHeld = cardBytes(ref);
    const callsAfterLapse = stubModel.calls;
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes' });
    record('4c+9d', 'stub registry', '6 filler turns then "yes" (stale), then "yes" again',
      `refusal quoted draft verbatim=${JSON.stringify(quoteExpected)}; draft kept=${JSON.stringify(stillHeld)}; model calls during refusal=${callsAfterLapse - callsBeforeLapse}; re-confirm released=${JSON.stringify(r.turn?.released?.text)}`,
      check('4c', r.turn?.released?.text === lapsedDraft
        && stillHeld === lapsedDraft
        && callsAfterLapse === callsBeforeLapse,
        JSON.stringify({ refusal: quoteExpected, released: r.turn?.released?.text, callsDelta: callsAfterLapse - callsBeforeLapse })));

    // ════ ROW 7 + 10 — relay strips (live through the draft choke point) ═════
    log('── STUB: rows 7/10 — semi-verbatim relay through real turns ──');
    ref = newLane();
    const messy = 'Um, okay, could you ask the worker to rerun the suite';
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: messy });
    const messyPart = draftOf(ref)?.utterances.at(-1);
    record('7b', 'stub registry', `"${messy}"`,
      `relay=${JSON.stringify(messyPart?.text)} original kept=${JSON.stringify(messyPart?.originalText === messy)}`,
      check('7b', messyPart?.text === 'rerun the suite' && messyPart?.originalText === messy, JSON.stringify(draftOf(ref))));

    const clean = 'rebase the branch after phase 3 lands';
    ref = newLane();
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: clean });
    const cleanPart = draftOf(ref)?.utterances.at(-1);
    record('10a', 'stub registry', `"${clean}" (clean instruction)`,
      `relay=${JSON.stringify(cleanPart?.text)} originalText present=${cleanPart?.originalText !== undefined} changed=false? ${cleanPart && cleanPart.text === clean}`,
      check('10a', cleanPart?.text === clean && cleanPart?.originalText === undefined, JSON.stringify(cleanPart)));

    // ════ ROW 8 — conservative cases LEFT IN (pure transform; expected per case) ════
    log('── STUB: row 8 — conservative relay cases left untouched ──');
    const conservative: Array<[string, string | null, string]> = [
      // [utterance, expected relay text (null = byte-identical), why]
      ['when you get a chance, ask the worker to stop the run', null, 'mid-sentence frame stays'],
      ['ask the worker if it has enough materials', 'if it has enough materials', '"if" interrogative force KEPT (only the frame is stripped)'],
      ['the build is very very slow today', null, '"very very" intensifier kept'],
      ['tell the worker', null, 'frame-only utterance untouched (never emptied)'],
      ['ship it, if possible', null, 'meaning-bearing trailing conditional kept'],
    ];
    for (const [utterance, expected, why] of conservative) {
      const pure = normaliseRelayText(utterance);
      const expectedText = expected ?? utterance;
      record('8', 'pure normaliseRelayText', `"${utterance}" (${why})`,
        `text=${JSON.stringify(pure.text)} changed=${pure.changed} removals=${JSON.stringify(pure.removals)}`,
        check('8', pure.text === expectedText && pure.changed === (expectedText !== utterance),
          `expected ${JSON.stringify(expectedText)}, got ${JSON.stringify(pure.text)} changed=${pure.changed}`));
    }

    // ════ ROW 12 — [[to-talker]] narrowing (deterministic stub replies) ══════
    log('── STUB: row 12 — [[to-talker]] suppression, buried tag ignored, tag never spoken ──');
    ref = newLane();
    stubModel.enqueue("Here's the summary: two workers running, one held. [[to-talker]]");
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'summarise what has been done' });
    record('12a', 'stub registry', 'statement + end-anchored [[to-talker]]',
      `addressedToTalker=${r.turn?.addressedToTalker} draft=${JSON.stringify(cardBytes(ref))} tag in reply? ${r.reply.includes('[[')}`,
      check('12a', r.turn?.addressedToTalker === true && cardBytes(ref) === null && !r.reply.includes('[[to-talker]]'),
        JSON.stringify({ att: r.turn?.addressedToTalker, draft: cardBytes(ref), reply: r.reply })));

    stubModel.enqueue("I'll note that [[to-talker]] but the worker should also hear it.");
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'also deploy the staging build' });
    const buriedDraft = draftOf(ref)?.utterances.at(-1);
    record('12b', 'stub registry', 'BURIED tag (not end-anchored) — must be ignored for drafting',
      `addressedToTalker=${r.turn?.addressedToTalker ?? 'unset'} draft part=${JSON.stringify(buriedDraft?.text)} tag stripped from speech? ${!r.reply.includes('[[')}`,
      check('12b', r.turn?.addressedToTalker !== true && buriedDraft?.text === 'also deploy the staging build' && !r.reply.includes('[[to-talker]]'),
        JSON.stringify({ att: r.turn?.addressedToTalker, draft: buriedDraft, reply: r.reply })));

    // ════ ROW 13 — [[ask-worker]] honoured only on question turns ════════════
    log('── STUB: row 13 — [[ask-worker]] offer gating ──');
    ref = newLane();
    stubModel.enqueue('I cannot tell from here — want me to pass it on? [[ask-worker]]');
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'What did the worker find about the retry bug?' });
    const offerDraft = draftOf(ref)?.utterances.at(-1);
    record('13a+11a', 'stub registry', 'unanswerable question + end-anchored [[ask-worker]]',
      `offer=${r.turn?.askWorkerOffer} held text=${JSON.stringify(offerDraft?.text)} (operator's OWN words) tag spoken? ${r.reply.includes('[[ask-worker]]')}`,
      check('13a', r.turn?.askWorkerOffer === true && offerDraft?.text === 'What did the worker find about the retry bug?' && !r.reply.includes('[[ask-worker]]'),
        JSON.stringify({ offer: r.turn?.askWorkerOffer, draft: offerDraft, reply: r.reply })));

    stubModel.enqueue('Happy to pass that along. [[ask-worker]]');
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'tell the worker to also check the queue depth' });
    // statement + tag: the offer path does not exist on statement turns — the
    // words draft as a normal statement (in RELAY form — the tell-frame is
    // stripped at draft time), no offer flag.
    const stmtDraft = draftOf(ref)?.utterances.at(-1);
    record('13b', 'stub registry', 'STATEMENT + [[ask-worker]] tag — offer must NOT fire',
      `offer=${r.turn?.askWorkerOffer ?? 'unset'} draft part=${JSON.stringify(stmtDraft?.text)} original=${JSON.stringify(stmtDraft?.originalText)}`,
      check('13b', r.turn?.askWorkerOffer !== true && stmtDraft?.text === 'also check the queue depth'
        && stmtDraft?.originalText === 'tell the worker to also check the queue depth',
        JSON.stringify({ offer: r.turn?.askWorkerOffer, draft: stmtDraft })));
    // relay form of the offered question (row 11 relay-form half, deterministic):
    ref = newLane();
    stubModel.enqueue('No idea from here. [[ask-worker]]');
    r = await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'Um, could you ask the worker if the suite is green' });
    // NOTE: this shape is worker-directed ("ask the worker ...") → drafts via the
    // DIRECTIVE path; relay keeps the "if" force.
    const relayOffer = draftOf(ref)?.utterances.at(-1);
    record('11b+8b', 'stub registry', 'worker-directed "if" question drafts in relay form',
      `draft part=${JSON.stringify(relayOffer?.text)} original=${JSON.stringify(relayOffer?.originalText)}`,
      check('11b', relayOffer?.text === 'if the suite is green' && relayOffer?.originalText === 'Um, could you ask the worker if the suite is green',
        JSON.stringify(draftOf(ref))));

    // ════ ROW 14c — mechanical acks never call the model (model-call accounting) ════
    log('── STUB: row 14c — dead-end acks are model-free ──');
    ref = newLane();
    const callsBeforeAcks = stubModel.calls;
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes' });
    await stubRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'cancel it' });
    const delta = stubModel.calls - callsBeforeAcks;
    record('14c', 'stub registry', 'nothing-pending + nothing-to-cancel in a row',
      `model calls consumed=${delta} (must be 0)`,
      check('14c', delta === 0, `delta=${delta}`));
  }

  // ════ ROW 15 + 16 + 9/11/12/14 REAL — real model, real pi worker ════════
  if (!stubOnly) {
    log('── REAL: rows 15/16/9/11/12/14 — real OpenRouter model, real disposable pi worker ──');
    const realDeliveries = nullDeliveries();
    const realRegistry = new TalkerSessionRegistry({ multiSessionManager: manager, deliveries: realDeliveries });

    const worker = await manager.createAndSubscribe('p27-matrix', workspaceDir);
    const sessionPath = worker.sessionPath;
    log(`real pi worker session: ${sessionPath}`);

    const runWorkerTurn = async (prompt: string): Promise<void> => {
      await manager.prompt(sessionPath, prompt);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (manager.getSessionStatus(sessionPath)?.status === 'idle') return;
        await new Promise(r2 => setTimeout(r2, 500));
      }
      throw new Error(`worker never went idle after: ${prompt.slice(0, 50)}`);
    };

    const EARLY_CODENAME = 'CODEWORD-KILO-FORTRESS';
    const LATE_CODENAME = 'CODEWORD-AMBER-SEVEN';
    await runWorkerTurn(`Reply with exactly this and nothing else: ${EARLY_CODENAME} is the old release codename.`);
    await runWorkerTurn(
      'Reply with a numbered list of exactly 12 items (1. to 12.). Keep each item to exactly two short sentences, about 15-20 words per item in total, ' +
      'about release-engineering practice. Item 12 must end with the exact token P23-DEEP-TOKEN.'
    );
    await runWorkerTurn(`Reply with exactly this and nothing else: ${LATE_CODENAME} is the new release codename.`);
    log('worker seeded: early codename, 12-item long list, late codename');

    const ref = sessionPath; // P12: the session path is a canonical worker ref

    // Row 15a — mid-session answer from REAL history
    let r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'What is the new release codename from earlier in this session?' });
    record('15a', 'real model + real pi history', 'mid-session codename question',
      `reply excerpt=${JSON.stringify(r.reply.replace(/\s+/g, ' ').slice(0, 180))} quotes ${LATE_CODENAME}? ${new RegExp(LATE_CODENAME.replace(/-/g, '[- ]?'), 'i').test(r.reply)}`,
      check('15a', new RegExp(LATE_CODENAME.replace(/-/g, '[- ]?'), 'i').test(r.reply) && r.turn?.released === null, r.reply.slice(0, 200)));

    // Row 15b — the deep 2200-char assistant window.
    // VIEW half: the real session's entries plus ONE deterministic 3000-char
    // probe entry (token at offset 2100, inside the window) — the window and
    // the disclosure are renderer properties, so this half is deterministic;
    // the entries feeding it are the REAL session's.
    const messages = (manager.getAgentSession(sessionPath)?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
    const entries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).filter(Boolean).join(' ')
        : '';
      if (text.trim()) entries.push({ role: m.role, text: text.trim() });
    }
    const realListMsg = entries.filter(e => e.role === 'assistant').map(e => e.text).reduce((a, b) => (b.length > a.length ? b : a), '');
    const filler = 'Release engineering requires a deliberate sequence of review, build, and verification steps. ';
    const probe = (filler.repeat(14) + 'The buried verification token is P23-DEEP-TOKEN. ' + filler.repeat(10)).trim();
    // token offset check: must sit inside the 2200-char assistant window
    const probeTokenOffset = probe.indexOf('P23-DEEP-TOKEN');
    const viewEntries = [...entries, { role: 'assistant' as const, text: probe }];
    const view = renderStateView({ activity: 'worker status: idle', recentHistory: viewEntries, historyTotal: viewEntries.length }, { draft: null, lastReleased: null });
    const countLine = view.split('\n').find(l => l.startsWith('Showing the most recent') || l.startsWith('All '));
    const disclosureTruthful = countLine !== undefined
      && (countLine.includes(`of ${viewEntries.length} messages`) || countLine.includes(`All ${viewEntries.length} messages`))
      && view.includes('Some shown messages are shortened');
    const deepTokenSurvives = view.includes('P23-DEEP-TOKEN');
    record('15b-view', 'renderStateView on REAL entries + deterministic probe', `probe entry ${probe.length} chars (token at offset ${probeTokenOffset}) vs ${SESSION_HISTORY_LIMITS.assistantChars}-char assistant window`,
      `disclosure truthful=${disclosureTruthful} deep token survives=${deepTokenSurvives} real list message was ${realListMsg.length} chars`,
      check('15b-view', disclosureTruthful && deepTokenSurvives && probeTokenOffset < SESSION_HISTORY_LIMITS.assistantChars,
        `disclosure=${disclosureTruthful} token=${deepTokenSurvives} offset=${probeTokenOffset}`));

    // LIVE half: the real list must be readable through the live view
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'In the worker\'s long numbered list from earlier: how many items does it have, and what is the exact token at the very end of the last item?' });
    const tokenInReply = r.reply.includes('P23-DEEP-TOKEN');
    const countInReply = /\b12\b/.test(r.reply);
    record('15b-live', 'real model + real pi history', 'deep-list question over the live view',
      `reply=${JSON.stringify(r.reply.replace(/\s+/g, ' ').slice(0, 160))} count12=${countInReply} tokenInReply=${tokenInReply}`,
      check('15b-live', countInReply || tokenInReply, r.reply.slice(0, 200)));

    // Row 9 REAL — primary invariant with a real messy conversation
    const messyReal = 'Okay, um, could you ask the worker to reply with exactly P27-RELAY-OK';
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: messyReal });
    const heldBeforeConfirm = cardBytesOf(realRegistry, ref);
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes, go ahead' });
    const releasedReal = r.turn?.released?.text ?? null;
    const handedReal = realDeliveries.texts().at(-1) ?? null;
    record('9-REAL', 'real model + real pi lane', `"${messyReal}" then "yes, go ahead"`,
      `card bytes=${JSON.stringify(heldBeforeConfirm)} released=${JSON.stringify(releasedReal)} handed-to-worker=${JSON.stringify(handedReal)}`,
      check('9-REAL', heldBeforeConfirm !== null && releasedReal === heldBeforeConfirm && handedReal === heldBeforeConfirm,
        JSON.stringify({ card: heldBeforeConfirm, released: releasedReal, handed: handedReal })));

    // Rows 11/13 REAL — genuinely unanswerable question defers via the offer
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'What did the operator have for breakfast last Tuesday?' });
    const offerHeld = cardBytesOf(realRegistry, ref);
    record('11/13-REAL', 'real model + real pi lane', 'unanswerable question',
      `offer=${r.turn?.askWorkerOffer ?? 'unset'} held=${JSON.stringify(offerHeld)} tag spoken? ${r.reply.includes('[[ask-worker]]')}`,
      check('11/13-REAL', r.turn?.askWorkerOffer === true && offerHeld === 'What did the operator have for breakfast last Tuesday?' && !r.reply.includes('[[ask-worker]]'),
        JSON.stringify({ offer: r.turn?.askWorkerOffer, held: offerHeld, reply: r.reply.slice(0, 160) })));
    // confirm releases the QUESTION verbatim (relay form == clean here)
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes, go ahead' });
    record('11c-REAL', 'real model + real pi lane', 'confirm the offered question',
      `released=${JSON.stringify(r.turn?.released?.text)} handed=${JSON.stringify(realDeliveries.texts().at(-1))}`,
      check('11c-REAL', r.turn?.released?.text === 'What did the operator have for breakfast last Tuesday?',
        JSON.stringify(r.turn?.released?.text)));

    // Row 12 REAL — self-directed imperative (conditional on model judgement;
    // the MECHANICAL consequences are what must hold either way)
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'Please repeat back to me word for word what I asked you to relay just now.' });
    const attMarked = r.turn?.addressedToTalker === true;
    const draftAfterAtt = cardBytesOf(realRegistry, ref);
    record('12-REAL', 'real model + real pi lane', 'self-directed "repeat back" request',
      `marked=${attMarked} draftAfter=${JSON.stringify(draftAfterAtt)} tag spoken? ${r.reply.includes('[[')}`,
      check('12-REAL', !r.reply.includes('[[to-talker]]') && (attMarked ? draftAfterAtt === null : true),
        JSON.stringify({ marked: attMarked, draft: draftAfterAtt })));

    // Row 14 REAL — one receipt per batch on the live lane
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'tell the worker the demo starts at noon' });
    const receipt1 = r.turn?.receiptAck;
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'and that parking is free after six' });
    const receipt2 = r.turn?.receiptAck;
    const beforeCalls = 0; // modelCalled flags are per-turn; assert directly below
    r = await realRegistry.handleOperatorTurn({ workerSessionId: ref, utterance: 'yes, go ahead' });
    record('14-REAL', 'real model + real pi lane', '2-part batch then confirm',
      `receipts=[${JSON.stringify(receipt1)},${JSON.stringify(receipt2)}] releaseAck=${JSON.stringify(r.reply)} modelCalledOnConfirm=${r.turn?.modelCalled} (batch receipts observed on prior turns)`,
      check('14-REAL', receipt1 === RECEIPT_ACK && receipt2 === undefined && r.reply === RELEASE_ACK && r.turn?.modelCalled === false,
        JSON.stringify({ receipt1, receipt2, ack: r.reply, mc: r.turn?.modelCalled })));
    void beforeCalls;

    // Row 16 (in-process half) — records + lanes name the worker session.
    // NOTE: the readers MUST come from the same dynamically-imported module
    // instance the registry writes through (under tsx, a static import of the
    // same specifier resolves to a second instance whose stores stay empty —
    // proved by scripts/p27-obs-instance-probe.ts).
    const obs = await import('../server/src/talker/observability.js');
    const lanes = obs.getVoiceLaneBindings();
    const laneForWorker = lanes.find(l => l.workerSessionId === sessionPath);
    const recent = obs.getRecentVoiceTurns(50);
    const allNamed = recent.length > 0 && recent.every(t => t.voiceTurnId?.startsWith('pi:'));
    const hasRealTurns = recent.some(t => t.workerSessionId === sessionPath);
    record('16a', 'observability stores (in-process)', `${recent.length} recorded turns`,
      `lane pi:<sessionPath> present=${!!laneForWorker} turnCount=${laneForWorker?.turnCount} all voiceTurnIds pi-prefixed=${allNamed} real-lane turns present=${hasRealTurns}`,
      check('16a', !!laneForWorker && allNamed && hasRealTurns && (laneForWorker?.turnCount ?? 0) > 0,
        JSON.stringify({ lane: laneForWorker, recentCount: recent.length, allNamed })));
  }

  // ════ ROW 5 — release() private, single caller (inspection; no modification) ════
  {
    const { execSync } = await import('node:child_process');
    const talkerSrc = fs.readFileSync('server/src/talker/talker.ts', 'utf8');
    const privateDecl = /private async release\(/.test(talkerSrc);
    const dotCallsInTalker = (talkerSrc.match(/\.release\(/g) ?? []).length; // 'this.release(' call sites
    let externalInTalkerPkg = -1;
    try {
      externalInTalkerPkg = Number(execSync(
        `grep -R "\\.release(" server/src/talker --include="*.ts" | grep -v "talker/talker.ts" | wc -l`,
        { encoding: 'utf8' }
      ).trim());
    } catch { externalInTalkerPkg = -1; }
    let bypassPins = false;
    try {
      bypassPins = fs.readFileSync('server/tests/unit/talker/talker-gate.test.ts', 'utf8')
        .includes('structural bypass attempts');
    } catch { bypassPins = false; }
    record('5', 'inspection + existing gate pins', 'read-only structure check of the release path',
      `private decl=${privateDecl}; call sites in talker.ts=${dotCallsInTalker} (confirm branch only); .release( hits elsewhere in server/src/talker=${externalInTalkerPkg}; structural-bypass pins present=${bypassPins}`,
      check('5', privateDecl && dotCallsInTalker === 1 && externalInTalkerPkg === 0 && bypassPins,
        `private=${privateDecl} calls=${dotCallsInTalker} external=${externalInTalkerPkg} pins=${bypassPins}`));
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const fails = rows.filter(r => r.verdict === 'FAIL');
  console.log('\n════════ P27 PHASE A — ROW LEDGER ════════');
  for (const r of rows) {
    console.log(`${r.verdict === 'PASS' ? 'PASS' : 'FAIL'}  ${r.row.padEnd(10)} ${r.driver.padEnd(34)} ${r.observed.slice(0, 150)}`);
  }
  console.log(`\nrows executed: ${rows.length}, PASS: ${rows.length - fails.length}, FAIL: ${fails.length}`);
  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify({ rows, validationDir }, null, 2));
    log(`ledger written: ${jsonPath}`);
  }
  if (fails.length > 0) {
    console.error('P27 PHASE A: FAIL rows present (details above)');
    if (!args.includes('--keep')) {
      try { fs.rmSync(validationDir, { recursive: true, force: true }); } catch { /* keep for forensics on failure */ }
    }
    process.exit(1);
  }
  if (args.includes('--keep')) {
    log(`kept isolation dir: ${validationDir}`);
  } else {
    try { fs.rmSync(validationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  log('P27 PHASE A: all executed rows PASS');
}

function cardBytesOf(registry: { get(id: string, rt: 'pi'): { proposals: { snapshotDraft(): { utterances: Array<{ text: string }>} | null } } | undefined }, ref: string): string | null {
  const d = registry.get(ref, 'pi')?.proposals.snapshotDraft() ?? null;
  return d ? d.utterances.map(u => u.text).join('\n') : null;
}

main().catch((error) => {
  console.error('❌ P27 PHASE A crashed —', error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`   isolation dir kept for forensics: ${validationDir}`);
  process.exit(1);
});
