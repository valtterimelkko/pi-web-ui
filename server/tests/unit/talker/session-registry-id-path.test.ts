/**
 * P12 — id/path wiring regression: a confirmed relay must reach the pi worker
 * whichever identifier the caller supplies (session id OR session path).
 *
 * The defect (P9 browser E2E, docs/plans/VOICE-MODE-BROWSER-E2E-RESULTS.md §4):
 * the UI sends the session ID the server itself issued in `session_created`,
 * while the pi delivery adapter hands that value straight to the
 * MultiSessionManager, which keys sessions by session PATH. For pi sessions
 * id ≠ path, so every UI-driven release was refused with
 * `Session <id> does not exist`. The fail-closed refusal was correct; the
 * wiring was not.
 *
 * What is pinned here:
 *   1. RED/GREEN defect proof — release with workerSessionId = session ID
 *      delivers to the worker under the manager's own key (the path).
 *   2. Path pin — release with workerSessionId = session PATH delivers exactly
 *      as before (the pre-existing relay validations must not regress).
 *   3. One talker session per worker regardless of identifier — registry.get()
 *      must resolve BOTH forms to the same session, so the transport's
 *      post-turn phase read (connection.ts reads with the raw wire value)
 *      cannot split from the talker state.
 *   4. Unresolved references still fail closed, loudly — resolution must never
 *      guess, and a refusal must stay a refusal.
 */
import { describe, it, expect } from 'vitest';
import { TalkerSessionRegistry } from '../../../src/talker/session-registry.js';
import { createPiDelivery, createNullDelivery } from '../../../src/talker/delivery.js';
import type { DefaultDeliveries } from '../../../src/talker/delivery.js';
import type { TalkerModelClient, ModelTurnResult } from '../../../src/talker/types.js';

const INSTRUCTION = 'tell the worker to rerun the test suite after the migration lands';
// P25 (semi-verbatim relay, docs/VOICE-ORCHESTRATOR-FEASIBILITY.md §3.2
// rule 3): the draft and the release carry the operator's words MINUS the
// channel — a commission frame like 'tell the worker to ...' is how the
// operator addresses the relay, not part of the instruction. EXPECTATION
// constants below hold the relay form; spoken-input call sites keep the raw
// utterance (the harness normalises at draft time, before approval).
const RELAYED_INSTRUCTION = 'rerun the test suite after the migration lands';
const CONFIRM = 'yes, send that';

/** A session id of the exact shape the server issues in `session_created`. */
const SESSION_ID = '9f1c0f2e-5a41-4e8b-9c3d-7b2a1d0e4f5a';
/** The manager's canonical key for that session (pi sessions: the path). */
const SESSION_PATH = `/tmp/p12-workdir/pi-sessions/2026-09-13T18-00-00-000Z_${SESSION_ID}.jsonl`;

/**
 * Faithful double of the REAL MultiSessionManager contract: sessions are keyed
 * by session PATH; prompt/steer throw the production refusal for anything that
 * is not an active session's path; resolveSessionRef is the manager's own
 * id→path index (the P12 resolution helper, mirrored here so this suite pins
 * the registry against the manager's contract, not against a loose fake).
 */
function pathKeyedManager() {
  const prompted: Array<{ ref: string; text: string }> = [];
  const steered: Array<{ ref: string; text: string }> = [];
  const manager = {
    prompt(ref: string, text: string): Promise<void> {
      if (ref !== SESSION_PATH) return Promise.reject(new Error(`Session ${ref} does not exist`));
      prompted.push({ ref, text });
      return Promise.resolve();
    },
    steer(ref: string, text: string): Promise<void> {
      if (ref !== SESSION_PATH) return Promise.reject(new Error(`Session ${ref} does not exist`));
      steered.push({ ref, text });
      return Promise.resolve();
    },
    getSessionStatus(ref: string) {
      // Path-keyed lookup, exactly like MultiSessionManager.getSessionStatus.
      if (ref !== SESSION_PATH) return undefined;
      return {
        sessionPath: SESSION_PATH,
        sessionId: SESSION_ID,
        status: 'idle' as const,
        lastActivity: new Date(),
        messageCount: 0,
        currentStep: 0,
        subscriberCount: 1,
        pinned: false,
      };
    },
    getAgentSession(ref: string) {
      return ref === SESSION_PATH ? { messages: [] } : undefined;
    },
    resolveSessionRef(ref: string): string | undefined {
      if (ref === SESSION_PATH) return ref;
      if (ref === SESSION_ID) return SESSION_PATH;
      return undefined;
    },
  };
  return { manager, prompted, steered };
}

function stubModel(): TalkerModelClient {
  return {
    async completeTurn(): Promise<ModelTurnResult> {
      return { text: 'Understood — shall I send that to the worker?', ttftMs: 12, totalMs: 40 };
    },
  };
}

function makeRegistry() {
  const { manager, prompted, steered } = pathKeyedManager();
  // The pi adapter is wired EXACTLY like production createDefaultDeliveries:
  // the same three manager calls, same order, no resolution of its own.
  const deliveries: DefaultDeliveries = {
    pi: createPiDelivery({
      isBusy: (ref) => manager.getSessionStatus(ref)?.status === 'busy' || manager.getSessionStatus(ref)?.status === 'streaming',
      steer: (ref, text) => manager.steer(ref, text),
      prompt: (ref, text) => manager.prompt(ref, text),
    }),
    claude: createNullDelivery(),
    antigravity: createNullDelivery(),
  };
  const registry = new TalkerSessionRegistry({
    multiSessionManager: manager as never,
    deliveries,
    modelClient: stubModel(),
    modelEnv: {},
  });
  return { registry, prompted, steered };
}

describe('P12: a confirmed relay reaches the pi worker whichever identifier the caller supplies', () => {
  it('RED/GREEN defect proof: release with workerSessionId = session ID delivers under the manager key (the path)', async () => {
    const { registry, prompted } = makeRegistry();

    const proposal = await registry.handleOperatorTurn({ workerSessionId: SESSION_ID, utterance: INSTRUCTION });
    expect(proposal.turn?.released ?? null).toBeNull(); // instruction proposes; nothing is sent

    const confirmation = await registry.handleOperatorTurn({ workerSessionId: SESSION_ID, utterance: CONFIRM });
    const delivery = confirmation.turn?.released?.delivery;
    expect(
      delivery?.outcome,
      `expected delivered, got ${delivery?.outcome}${delivery && 'reason' in delivery ? ` (${delivery.reason})` : ''}`,
    ).toBe('delivered');
    expect(confirmation.turn?.released?.text).toBe(RELAYED_INSTRUCTION); // verbatim, byte-for-byte
    expect(prompted).toEqual([{ ref: SESSION_PATH, text: RELAYED_INSTRUCTION }]); // under the manager's OWN key
  });

  it('path pin: release with workerSessionId = session PATH delivers exactly as before', async () => {
    const { registry, prompted } = makeRegistry();

    await registry.handleOperatorTurn({ workerSessionId: SESSION_PATH, utterance: INSTRUCTION });
    const confirmation = await registry.handleOperatorTurn({ workerSessionId: SESSION_PATH, utterance: CONFIRM });
    const delivery = confirmation.turn?.released?.delivery;
    expect(
      delivery?.outcome,
      `expected delivered, got ${delivery?.outcome}${delivery && 'reason' in delivery ? ` (${delivery.reason})` : ''}`,
    ).toBe('delivered');
    expect(confirmation.turn?.released?.text).toBe(RELAYED_INSTRUCTION);
    expect(prompted).toEqual([{ ref: SESSION_PATH, text: RELAYED_INSTRUCTION }]);
  });

  it('one talker session per worker regardless of identifier (id and path resolve to the same session)', async () => {
    const { registry } = makeRegistry();

    await registry.handleOperatorTurn({ workerSessionId: SESSION_ID, utterance: INSTRUCTION });
    // The transport's post-turn phase read uses the RAW wire value; the
    // registry must resolve both forms to the SAME talker session or the
    // proposed phase splits from the pending proposal.
    expect(registry.get(SESSION_ID)).toBeDefined();
    expect(registry.get(SESSION_PATH)).toBe(registry.get(SESSION_ID));
    expect(registry.has(SESSION_PATH)).toBe(true);
  });

  it('an unresolvable reference still fails closed, loudly — resolution never guesses', async () => {
    const { registry, prompted, steered } = makeRegistry();

    await registry.handleOperatorTurn({ workerSessionId: 'no-such-session', utterance: INSTRUCTION });
    const confirmation = await registry.handleOperatorTurn({ workerSessionId: 'no-such-session', utterance: CONFIRM });
    const delivery = confirmation.turn?.released?.delivery;
    expect(delivery?.outcome).toBe('refused');
    expect(delivery && 'reason' in delivery ? delivery.reason : '').toMatch(/does not exist/);
    expect(prompted).toEqual([]);
    expect(steered).toEqual([]);
  });
});
