/**
 * Phase L3 — the differential replay of the talker policy extraction.
 *
 * Two independent comparisons run over one scripted corpus:
 *
 *   1. GOLDEN REPLAY (pre-refactor truth). The corpus is replayed through the
 *      live TalkerSession and compared, turn by turn and byte for byte, with
 *      `fixtures/talker-policy-core.golden.json` — captured from the
 *      PRE-EXTRACTION TalkerSession (master ea5b25b) before
 *      server/src/talker/policy-core.ts existed. Any decision, reply, release,
 *      delivery call, draft mutation, receipt or projection that the
 *      extraction changed shows up here as a diff. The fixture is regenerated
 *      ONLY deliberately, with:
 *
 *          TALKER_POLICY_CAPTURE=1 npx vitest run \
 *            server/tests/unit/talker/talker-policy-core.differential.test.ts
 *
 *   2. PURE-CORE DIFFERENTIAL (delegation fidelity). The same corpus is driven
 *      a second time through a small interpreter that uses ONLY
 *      policy-core.ts (decideOperatorTurn / decideAfterModelReply /
 *      policyStateView) plus the existing stores, with its own model and
 *      delivery doubles. The session's decision-level trace and the pure
 *      core's must be identical — decisions, release bytes, delivery calls,
 *      receipts, markers, draft and verbatim-log state after every turn.
 *      This proves the extracted core reproduces the behaviour the session
 *      had before it delegated, and that it can drive turns standalone.
 *
 * The corpus deliberately covers every branch the gate can take: fresh and
 * lapsed releases, partial selections and ambiguous ones, D-card identity
 * (matching / stale / re-typed), the original-variant gate, dead ends,
 * cancels with and without residue, meta / worker-directed / status
 * questions, the [[ask-worker]] offer, the [[to-talker]] suppression, receipt
 * batching, model failure, and every delivery outcome.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TalkerSession } from '../../../src/talker/talker.js';
import { PendingProposalStore, UtteranceLog } from '../../../src/talker/pending-proposal.js';
import { ackForOutcome, describeOutcome, MODEL_FAILURE_REPLY, NOTHING_PENDING_ACK, receiptAckFor } from '../../../src/talker/ack.js';
import { ASK_WORKER_MARKER } from '../../../src/talker/ask-worker.js';
import {
  decideAfterModelReply,
  decideOperatorTurn,
  isMechanicalDecision,
  policyStateView,
} from '../../../src/talker/policy-core.js';
import type { DeliveryOutcome, ModelTurnResult, TalkerModelClient, WorkerStateSnapshot } from '../../../src/talker/types.js';
import type { ReleaseVariant } from '../../../src/talker/pending-proposal.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures', 'talker-policy-core.golden.json');
const CAPTURE = process.env.TALKER_POLICY_CAPTURE === '1';

const SNAPSHOT: WorkerStateSnapshot = {
  elapsedLabel: '14m',
  activity: 'supervising two workers',
  recentEvents: ['watching worker 1'],
  children: ['worker 1: running, 22m'],
  pendingItems: ['phase 3 held for the operator'],
  lastAssistantText: 'Both are running.',
};

const DEFAULT_REPLY = 'Understood — shall I send that to the worker?';
const TO_TALKER = '[[to-talker]]';
const OFFER_REPLY = `I can't tell from what I hold — shall I ask the worker? ${ASK_WORKER_MARKER}`;
const INSTRUCTION = 'tell the worker to hold phase 3 until my review';
const ADDENDUM = 'and also make it use staging credentials, not production';
const S5_T4 =
  "Never mind, forget it. Back to the caching thing — tell it to leave caching alone entirely, we're dropping that work.";
const SPOKEN =
  "Okay, ask the worker if it has enough materials to start developing the first week's materials, if it has enough resources for that.";

// ── Corpus ─────────────────────────────────────────────────────────────────

interface ScenarioTurn {
  utterance: string;
  operatorFocus?: boolean;
  releaseVariant?: ReleaseVariant;
  /** Echo the identity captured after the given (1-based) scenario turn. */
  proposalRef?: { afterTurn: number };
  modelReply?: string;
  modelThrows?: boolean;
  delivery?: DeliveryOutcome;
}

interface Scenario {
  name: string;
  maxPendingAgeTurns?: number;
  turns: ScenarioTurn[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'release-single',
    turns: [{ utterance: INSTRUCTION }, { utterance: 'yes, go ahead' }],
  },
  {
    name: 'release-multi-part',
    turns: [{ utterance: INSTRUCTION }, { utterance: ADDENDUM }, { utterance: 'yes, send that' }],
  },
  {
    name: 'release-selection-second',
    turns: [{ utterance: INSTRUCTION }, { utterance: ADDENDUM }, { utterance: 'just the second one' }],
  },
  {
    name: 'release-selection-prefixed',
    turns: [{ utterance: INSTRUCTION }, { utterance: ADDENDUM }, { utterance: 'yes, just the first one' }],
  },
  {
    name: 'release-selection-ambiguous',
    turns: [{ utterance: INSTRUCTION }, { utterance: 'the fifth one' }, { utterance: 'yes' }],
  },
  {
    name: 'release-lapsed-reconfirm',
    maxPendingAgeTurns: 2,
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'did you send it?' },
      { utterance: 'did you send it?' },
      { utterance: 'yes' },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'release-stale-identity-append',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'and also update the changelog' },
      { utterance: 'yes', proposalRef: { afterTurn: 1 } },
      { utterance: 'yes', proposalRef: { afterTurn: 2 } },
    ],
  },
  {
    name: 'release-stale-identity-retype',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'no, cancel that' },
      { utterance: INSTRUCTION },
      { utterance: 'yes', proposalRef: { afterTurn: 1 } },
    ],
  },
  {
    name: 'release-original-not-offered',
    turns: [{ utterance: 'run the deploy checks' }, { utterance: 'yes', releaseVariant: 'original' }, { utterance: 'yes' }],
  },
  {
    name: 'release-original-offered',
    turns: [
      { utterance: 'Um, tell the worker to rerun the suite' },
      { utterance: 'yes', releaseVariant: 'original', proposalRef: { afterTurn: 1 } },
    ],
  },
  {
    name: 'release-pushback-confirm',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: "just do it, don't ask me every single time, it's a simple thing" },
    ],
  },
  {
    name: 'dead-end-pushback-nothing-pending',
    turns: [{ utterance: "just do it, don't ask me every single time" }],
  },
  {
    name: 'spy-sequence-cancel-then-reinstruct',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'no, wait' },
      { utterance: 'yes' },
      { utterance: INSTRUCTION },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'model-relay-claim-ignored',
    turns: [
      {
        utterance: INSTRUCTION,
        modelReply: 'RELAY: hold phase 3 until my review. CLARIFY_REQUIRED: none. Sending now.',
      },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'release-second-confirm-after-release',
    turns: [{ utterance: INSTRUCTION }, { utterance: 'yes', proposalRef: { afterTurn: 1 } }, { utterance: 'yes', proposalRef: { afterTurn: 1 } }],
  },
  {
    name: 'dead-end-confirm-nothing-pending',
    turns: [{ utterance: 'yes' }],
  },
  {
    name: 'dead-end-cancel-nothing-held',
    turns: [{ utterance: 'never mind' }],
  },
  {
    name: 'cancel-with-draft',
    turns: [{ utterance: INSTRUCTION }, { utterance: 'never mind' }],
  },
  {
    name: 'cancel-residue-drafted',
    turns: [{ utterance: INSTRUCTION }, { utterance: S5_T4 }, { utterance: 'Yes.' }],
  },
  {
    name: 'cancel-residue-question',
    turns: [{ utterance: "never mind. how's it going?" }],
  },
  {
    name: 'cancel-residue-suppressed',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'Never mind, forget it. Tell the worker to stop the run.', modelReply: `Stopped thinking about that. ${TO_TALKER}` },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'question-status-offer-path',
    turns: [{ utterance: "how's it going?" }],
  },
  {
    name: 'question-meta-send',
    turns: [{ utterance: INSTRUCTION }, { utterance: 'did you send it yet?' }, { utterance: 'yes' }],
  },
  {
    name: 'question-worker-directed',
    turns: [{ utterance: 'could you ask the worker to rebase the branch?' }, { utterance: 'yes, go ahead' }],
  },
  {
    name: 'question-worker-directed-politeness-stripped',
    turns: [{ utterance: 'could you ask the worker to rebase onto main please?', modelReply: 'Noted.' }],
  },
  {
    name: 'offer-honoured',
    turns: [
      { utterance: 'what did the worker find about the retry bug in the March refactor?', modelReply: OFFER_REPLY },
      { utterance: 'yes, send that' },
    ],
  },
  {
    name: 'offer-not-honoured',
    turns: [
      { utterance: 'what did the worker find about the retry bug in the March refactor?', modelReply: 'All quiet — still on step three.' },
      { utterance: 'yes, go ahead' },
    ],
  },
  {
    name: 'offer-while-draft-held',
    turns: [{ utterance: INSTRUCTION, modelReply: 'Noted.' }, { utterance: 'what did the worker find in March?', modelReply: OFFER_REPLY }, { utterance: 'yes' }],
  },
  {
    name: 'to-talker-suppressed',
    turns: [
      { utterance: 'summarise what has been done in this session', modelReply: `Sure — you asked it to run phase 1, and the parser is done. ${TO_TALKER}` },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'to-talker-not-marked',
    turns: [
      { utterance: 'summarise what has been done in this session', modelReply: 'Sure — here is the summary.' },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'marker-mid-reply-not-honoured',
    turns: [
      { utterance: 'summarise what has been done in this session', modelReply: `${TO_TALKER} Sure — here is the summary.` },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'receipt-one-per-batch',
    turns: [{ utterance: 'tell the worker to rebase onto main' }, { utterance: 'also tell it to rerun the flaky suite' }, { utterance: 'and keep the docs phase for later' }],
  },
  {
    name: 'receipt-rearmed-after-release',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'yes, go ahead' },
      { utterance: 'also tell the worker to rerun the flaky suite' },
    ],
  },
  {
    name: 'model-failure',
    turns: [{ utterance: INSTRUCTION, modelThrows: true }],
  },
  {
    name: 'delivery-queued',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'yes', delivery: { outcome: 'queued', mechanism: 'follow_up', disclosure: 'will arrive after this turn' } },
    ],
  },
  {
    name: 'delivery-refused',
    turns: [
      { utterance: INSTRUCTION },
      { utterance: 'yes', delivery: { outcome: 'refused', reason: 'worker unreachable' } },
    ],
  },
  {
    name: 'focus-is-projection-only',
    turns: [
      { utterance: "what is the worker doing?", operatorFocus: true, modelReply: 'Still running.' },
      { utterance: 'and now?', modelReply: 'Same.' },
    ],
  },
  {
    name: 'p25-commission-frame',
    turns: [{ utterance: SPOKEN, modelReply: 'Shall I send that?' }, { utterance: 'yes' }],
  },
  {
    name: 'p25-cancel-residue-frame',
    turns: [
      { utterance: 'never mind — um, tell the worker to rebase the branch', modelReply: 'Noted.' },
      { utterance: 'yes' },
    ],
  },
  {
    name: 'short-conversation',
    turns: [
      { utterance: 'status note 0', modelReply: 'Noted.' },
      { utterance: 'status note 1', modelReply: 'Noted.' },
      { utterance: 'status note 2', modelReply: 'Noted.' },
      { utterance: 'status note 3', modelReply: 'Noted.' },
      { utterance: 'status note 4', modelReply: 'Noted.' },
      { utterance: 'status note 5', modelReply: 'Noted.' },
      { utterance: INSTRUCTION, modelReply: 'Shall I send that?' },
      { utterance: 'yes' },
    ],
  },
];

// ── Trace shapes ───────────────────────────────────────────────────────────

interface DraftAfter {
  texts: string[];
  ids: number[];
  ageTurns: number;
  needsReConfirmation: boolean;
  version: number | null;
}

interface TraceTurn {
  index: number;
  utterance: string;
  operatorFocus: boolean | null;
  releaseVariant: ReleaseVariant | null;
  proposalRef: string | null;
  reply: string;
  utteranceClass: string;
  releasedText: string | null;
  releasedUtteranceId: number | null;
  deliveryOutcome: string | null;
  cancelled: boolean;
  modelCalled: boolean;
  latency: { ttftMs: number | null; totalMs: number } | null;
  error: string | null;
  receiptAck: string | null;
  askWorkerOffer: boolean;
  addressedToTalker: boolean;
  deliveredThisTurn: string[];
  draftAfter: DraftAfter | null;
  identityAfter: { version: number; hash: string } | null;
  lastReleased: string | null;
  utteranceLog: Array<{ id: number; text: string; acknowledged: boolean }>;
  /** Session-only context (the pure-core replay compares decisions, not these). */
  projection: string | null;
  historyLength: number | null;
  historyTail: { role: string; content: string; kind: string } | null;
}

/** The fields the pure-core replay must reproduce byte for byte. */
function decisionFields(turn: TraceTurn): Omit<TraceTurn, 'projection' | 'historyLength' | 'historyTail'> {
  // The session-only context (projection, history) is compared by the golden
  // replay, not by the core-vs-session decision differential.
  const projected: Partial<TraceTurn> = { ...turn };
  delete projected.projection;
  delete projected.historyLength;
  delete projected.historyTail;
  return projected as Omit<TraceTurn, 'projection' | 'historyLength' | 'historyTail'>;
}

type ResolvedOpts = {
  opts: { operatorFocus?: boolean; releaseVariant?: ReleaseVariant; proposalRef?: { version: number; hash: string } };
  refRendered: string | null;
};

function resolveOpts(scenario: Scenario, step: ScenarioTurn, identities: Array<{ version: number; hash: string } | null>): ResolvedOpts {
  const opts: ResolvedOpts['opts'] = {};
  if (step.operatorFocus !== undefined) opts.operatorFocus = step.operatorFocus;
  if (step.releaseVariant !== undefined) opts.releaseVariant = step.releaseVariant;
  let refRendered: string | null = null;
  if (step.proposalRef) {
    const identity = identities[step.proposalRef.afterTurn];
    if (!identity) {
      throw new Error(`${scenario.name}: no identity captured after turn ${step.proposalRef.afterTurn}`);
    }
    opts.proposalRef = identity;
    refRendered = `${identity.version}:${identity.hash}`;
  }
  return { opts, refRendered };
}

// ── Runner 1: the live TalkerSession ───────────────────────────────────────

async function runSession(scenario: Scenario): Promise<TraceTurn[]> {
  const traces: TraceTurn[] = [];
  const identities: Array<{ version: number; hash: string } | null> = [];
  const delivered: string[] = [];
  let currentStep = 0;
  let modelCallsThisTurn = 0;
  let projectionThisTurn: string | null = null;

  const model: TalkerModelClient = {
    async completeTurn(messages): Promise<ModelTurnResult> {
      modelCallsThisTurn += 1;
      projectionThisTurn = messages[messages.length - 1]?.content ?? null;
      const step = scenario.turns[currentStep];
      if (step?.modelThrows) throw new Error('provider 502');
      return { text: step?.modelReply ?? DEFAULT_REPLY, ttftMs: 12, totalMs: 40 };
    },
  };

  const delivery = {
    describe: () => 'differential scripted delivery',
    async deliver({ text }: { workerSessionId: string; text: string }): Promise<DeliveryOutcome> {
      delivered.push(text);
      return scenario.turns[currentStep]?.delivery ?? { outcome: 'delivered', mechanism: 'prompt' };
    },
  };

  const session = new TalkerSession({
    model,
    delivery,
    workerSessionId: 'worker-differential',
    snapshotProvider: () => SNAPSHOT,
    ...(scenario.maxPendingAgeTurns !== undefined ? { config: { maxPendingAgeTurns: scenario.maxPendingAgeTurns } } : {}),
  });

  for (let i = 0; i < scenario.turns.length; i++) {
    const step = scenario.turns[i];
    currentStep = i;
    modelCallsThisTurn = 0;
    projectionThisTurn = null;
    const deliveriesBefore = delivered.length;
    const { opts, refRendered } = resolveOpts(scenario, step, identities);

    const result = await session.handleOperatorTurn(step.utterance, opts);

    const draft = session.proposals.snapshotDraft();
    const identity = session.proposals.describeCurrentProposal();
    const history = session.history.entries();
    const historyTail = history[history.length - 1] ?? null;
    traces.push({
      index: i + 1,
      utterance: step.utterance,
      operatorFocus: step.operatorFocus ?? null,
      releaseVariant: step.releaseVariant ?? null,
      proposalRef: refRendered,
      reply: result.reply,
      utteranceClass: result.utteranceClass,
      releasedText: result.released?.text ?? null,
      releasedUtteranceId: result.released?.utteranceId ?? null,
      deliveryOutcome: result.released ? describeOutcome(result.released.delivery) : null,
      cancelled: result.cancelled,
      modelCalled: result.modelCalled,
      latency: result.latency ? { ttftMs: result.latency.ttftMs, totalMs: result.latency.totalMs } : null,
      error: result.error ?? null,
      receiptAck: result.receiptAck ?? null,
      askWorkerOffer: result.askWorkerOffer === true,
      addressedToTalker: result.addressedToTalker === true,
      deliveredThisTurn: delivered.slice(deliveriesBefore),
      draftAfter: draft
        ? {
            texts: draft.utterances.map(u => u.text),
            ids: draft.utterances.map(u => u.id),
            ageTurns: draft.ageTurns,
            needsReConfirmation: draft.needsReConfirmation,
            version: identity?.version ?? null,
          }
        : null,
      identityAfter: identity ? { version: identity.version, hash: identity.hash } : null,
      lastReleased: session.proposals.lastReleased?.text ?? null,
      utteranceLog: session.utteranceLog.recent(100).map(r => ({ id: r.id, text: r.text, acknowledged: r.acknowledged })),
      projection: modelCallsThisTurn > 0 ? projectionThisTurn : null,
      historyLength: history.length,
      historyTail: historyTail ? { role: historyTail.role, content: historyTail.content, kind: historyTail.kind } : null,
    });
    identities[i + 1] = identity ? { version: identity.version, hash: identity.hash } : null;
  }
  return traces;
}

// ── Runner 2: the pure policy core, driving its own stores ─────────────────

async function runPureCoreReplay(scenario: Scenario): Promise<TraceTurn[]> {
  const store = new PendingProposalStore(
    scenario.maxPendingAgeTurns !== undefined ? { maxPendingAgeTurns: scenario.maxPendingAgeTurns } : {}
  );
  const log = new UtteranceLog();
  const traces: TraceTurn[] = [];
  const identities: Array<{ version: number; hash: string } | null> = [];
  const delivered: string[] = [];

  for (let i = 0; i < scenario.turns.length; i++) {
    const step = scenario.turns[i];
    const turn = i + 1;
    const deliveriesBefore = delivered.length;
    const { opts, refRendered } = resolveOpts(scenario, step, identities);

    store.tickTurn(turn);
    const record = log.record(step.utterance, turn);
    const state = policyStateView(store, turn);
    const decision = decideOperatorTurn(state, {
      utterance: step.utterance,
      ...(opts.releaseVariant !== undefined ? { releaseVariant: opts.releaseVariant } : {}),
      ...(opts.proposalRef !== undefined ? { proposalRef: opts.proposalRef } : {}),
    });

    let reply: string;
    let releasedText: string | null = null;
    let releasedUtteranceId: number | null = null;
    let deliveryOutcome: string | null = null;
    let cancelled = false;
    let modelCalled = false;
    let latency: TraceTurn['latency'] = null;
    let error: string | null = null;
    let receiptAck: string | null = null;
    let askWorkerOffer = false;
    let addressedToTalker = false;

    if (isMechanicalDecision(decision)) {
      reply = decision.reply;
      cancelled = false;
      if (decision.kind === 'refuse-lapsed') store.markResurfaced(turn);
    } else if (decision.kind === 'release') {
      const taken = store.takeForRelease(turn, decision.selection ?? undefined, decision.variant);
      if (!taken) throw new Error(`${scenario.name}: a release decision the store could not honour`);
      const deliveredOutcome: DeliveryOutcome =
        step.delivery ?? { outcome: 'delivered', mechanism: 'prompt' };
      delivered.push(taken.text);
      store.recordReleased({
        utteranceId: taken.utteranceId,
        text: taken.text,
        outcome: describeOutcome(deliveredOutcome),
        turn,
      });
      reply = ackForOutcome(deliveredOutcome);
      releasedText = taken.text;
      releasedUtteranceId = taken.utteranceId;
      deliveryOutcome = describeOutcome(deliveredOutcome);
    } else {
      const plan = decision.plan;
      cancelled = plan.cancelled;
      let draftRecordId = record.id;
      if (decision.kind === 'cancel') {
        store.cancel('operator cancelled', turn);
        if (plan.cancelResidue?.draftable) {
          draftRecordId = log.record(plan.cancelResidue.text, turn).id;
        }
      } else if (plan.path === 'worker-directed') {
        store.appendToDraft(record.id, step.utterance, turn);
      }

      let rawReply: string;
      if (step.modelThrows) {
        rawReply = MODEL_FAILURE_REPLY;
        error = 'provider 502';
      } else {
        rawReply = step.modelReply ?? DEFAULT_REPLY;
        latency = { ttftMs: 12, totalMs: 40 };
      }
      modelCalled = error === null;

      const post = decideAfterModelReply(decision, rawReply);
      if (post.append) store.appendToDraft(draftRecordId, post.append.text, turn);
      reply = post.reply;
      askWorkerOffer = post.askWorkerOffer;
      addressedToTalker = post.addressedToTalker;
      if (post.opensBatch) receiptAck = receiptAckFor(log.takeReceipt() ?? 0);
    }

    const draft = store.snapshotDraft();
    const identity = store.describeCurrentProposal();
    traces.push({
      index: turn,
      utterance: step.utterance,
      operatorFocus: step.operatorFocus ?? null,
      releaseVariant: step.releaseVariant ?? null,
      proposalRef: refRendered,
      reply,
      utteranceClass: decision.utteranceClass,
      releasedText,
      releasedUtteranceId,
      deliveryOutcome,
      cancelled,
      modelCalled,
      latency,
      error,
      receiptAck,
      askWorkerOffer,
      addressedToTalker,
      deliveredThisTurn: delivered.slice(deliveriesBefore),
      draftAfter: draft
        ? {
            texts: draft.utterances.map(u => u.text),
            ids: draft.utterances.map(u => u.id),
            ageTurns: draft.ageTurns,
            needsReConfirmation: draft.needsReConfirmation,
            version: identity?.version ?? null,
          }
        : null,
      identityAfter: identity ? { version: identity.version, hash: identity.hash } : null,
      lastReleased: store.lastReleased?.text ?? null,
      utteranceLog: log.recent(100).map(r => ({ id: r.id, text: r.text, acknowledged: r.acknowledged })),
      projection: null,
      historyLength: null,
      historyTail: null,
    });
    identities[turn] = identity ? { version: identity.version, hash: identity.hash } : null;
  }
  return traces;
}

// ── The differential harness ───────────────────────────────────────────────

interface GoldenFile {
  schema: string;
  note: string;
  capturedFrom: string;
  scenarios: Record<string, TraceTurn[]>;
}

function readGolden(): GoldenFile | null {
  if (!existsSync(FIXTURE_PATH)) return null;
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenFile;
}

const sessionTraces = new Map<string, TraceTurn[]>();
const replayTraces = new Map<string, TraceTurn[]>();
/** The golden to compare against: the committed fixture, or (capture runs) the just-captured object. */
let golden: GoldenFile | null = readGolden();

beforeAll(async () => {
  for (const scenario of SCENARIOS) {
    sessionTraces.set(scenario.name, await runSession(scenario));
    replayTraces.set(scenario.name, await runPureCoreReplay(scenario));
  }
  if (CAPTURE) {
    golden = {
      schema: 'talker-policy-core.differential.golden/v1',
      note: 'Generated by TALKER_POLICY_CAPTURE=1. This is the pre-extraction TalkerSession behaviour; do not regenerate casually.',
      capturedFrom: 'master ea5b25b, server/src/talker/talker.ts before policy-core.ts was wired in',
      scenarios: Object.fromEntries(SCENARIOS.map(s => [s.name, sessionTraces.get(s.name)!])),
    };
    mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(golden, null, 2)}\n`);
  }
}, 30_000);

describe('differential replay: the extracted session is byte-identical to the pre-extraction golden', () => {
  it('the golden fixture exists and was captured from the pre-extraction implementation', () => {
    expect(golden).not.toBeNull();
    expect(golden!.schema).toBe('talker-policy-core.differential.golden/v1');
    expect(Object.keys(golden!.scenarios).sort()).toEqual(SCENARIOS.map(s => s.name).sort());
    if (!CAPTURE) expect(golden!.capturedFrom).toContain('before policy-core.ts');
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.name}`, () => {
      expect(golden).not.toBeNull();
      const actual = JSON.parse(JSON.stringify(sessionTraces.get(scenario.name)));
      expect(actual).toEqual(golden!.scenarios[scenario.name]);
    });
  }
});

describe('pure-core differential: policy-core alone reproduces the session decisions and delivery calls', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}`, () => {
      const session = sessionTraces.get(scenario.name) ?? [];
      const replay = replayTraces.get(scenario.name) ?? [];
      expect(replay.map(decisionFields)).toEqual(session.map(decisionFields));
    });
  }
});

// ── Purity pins on the core itself ─────────────────────────────────────────

describe('the core is pure: no model calls, no I/O, no mutation', () => {
  it('decideOperatorTurn is synchronous and returns a flat, named decision (never a promise)', () => {
    const state = { turn: 1, draft: null };
    const decision = decideOperatorTurn(state, { utterance: 'yes' });
    expect(decision).not.toBeInstanceOf(Promise);
    expect(decision).toEqual({
      turn: 1,
      utterance: 'yes',
      utteranceClass: 'confirm',
      kind: 'nothing-pending',
      reply: NOTHING_PENDING_ACK,
    });
    expect(isMechanicalDecision(decision)).toBe(true);
  });

  it('the store form of the call returns the same decision as the data form, with the gate kinds named', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, INSTRUCTION, 1);
    const data = decideOperatorTurn(policyStateView(store, 2), { utterance: 'yes' });
    const storeForm = decideOperatorTurn({ utterance: 'yes', turn: 2, proposals: store });
    expect(storeForm).toEqual(data);
    expect(storeForm.kind).toBe('release');
    expect(storeForm.kind === 'release' && storeForm.variant).toBe('tidied');

    // The D-card opts ride through the store form too: a clean draft has no
    // original to offer, so the same yes against 'original' is refused.
    const cleanStore = new PendingProposalStore();
    cleanStore.appendToDraft(5, 'run the deploy checks', 1);
    const original = decideOperatorTurn({
      utterance: 'yes',
      turn: 2,
      proposals: cleanStore,
      opts: { releaseVariant: 'original' },
    });
    expect(original.kind).toBe('refuse-original-not-offered');
  });

  it('decideOperatorTurn runs against deeply frozen state and mutates nothing', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(1, INSTRUCTION, 1);
    const state = policyStateView(store, 2);
    const frozenState = deepFreeze(structuredClone(state));
    const before = JSON.stringify(state);
    const decision = decideOperatorTurn(frozenState, {
      utterance: 'yes',
      proposalRef: state.draft?.identity ?? undefined,
    });
    expect(decision.kind).toBe('release');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('decideAfterModelReply is synchronous, requires a spoken decision, and strips both markers', () => {
    const state = { turn: 1, draft: null };
    const decision = decideOperatorTurn(state, { utterance: 'summarise the session' });
    expect(decision.kind).toBe('conversational');
    const post = decideAfterModelReply(decision, `Summary. ${TO_TALKER}`);
    expect(post).not.toBeInstanceOf(Promise);
    expect(post.reply).toBe('Summary.');
    expect(post.addressedToTalker).toBe(true);
    expect(post.append).toBeNull();
    expect(post.opensBatch).toBe(false);

    const question = decideOperatorTurn(state, { utterance: 'what did the worker find in March?' });
    const offered = decideAfterModelReply(question, `I cannot tell. ${ASK_WORKER_MARKER}`);
    expect(offered.reply).toBe('I cannot tell.');
    expect(offered.askWorkerOffer).toBe(true);
    expect(offered.append).toEqual({ text: 'what did the worker find in March?', source: 'offer' });
    expect(offered.opensBatch).toBe(true);

    expect(() => decideAfterModelReply(decideOperatorTurn(state, { utterance: 'yes' }), 'x')).toThrow(/spoken decision/);
  });

  it('the same state and input always produce the same decision (deterministic)', () => {
    const store = new PendingProposalStore();
    store.appendToDraft(7, INSTRUCTION, 1);
    const state = policyStateView(store, 3);
    const a = decideOperatorTurn(state, { utterance: 'yes' });
    const b = decideOperatorTurn(state, { utterance: 'yes' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
