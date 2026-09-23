/**
 * The soak defect (SOAK-10MIN-standard/attempt-02) as mount/kernel-level unit
 * repros.
 *
 * The real run: a transport drop, then a capture-mode lane restart — the
 * client sends `voice_session_stop` and a fresh `voice_session_start` with the
 * SAME laneId and attachmentGeneration. The provider session revived and
 * transcribed every post-revive operator utterance (partials visible on the
 * wire), but the server-side kernel emitted ZERO operator utterance /
 * classification events after the revive, so the spoken confirm never
 * released the pending proposal `prop-1`.
 *
 * Root cause this suite pins: the service finalises operator utterances ONLY
 * on the provider session's own turn boundary (`turnComplete` /
 * `interrupted`). After a same-lane restart the revived provider session's
 * turn boundary is not guaranteed to arrive (the recorded run: it never
 * did), so every post-revive utterance stayed an unflushed partial and the
 * kernel pipeline — bound to finals only — went silent. The host, however,
 * holds its own deterministic utterance boundary: the client's local VAD
 * `speech_end`, the very boundary the manual-VAD provider profile is driven
 * by. Finalisation must re-bind to that host boundary so the kernel pipeline
 * survives a same-lane restart.
 *
 * These suites drive the REAL `VoiceSessionService` (scripted bridge, no
 * provider) through the REAL `VoiceLiveMount` and replay the recorded shape:
 *
 *   start → operator utterance #1 (partial → turn boundary → final) →
 *   relay_to_worker → proposal prop-1 → read-back reported →
 *   stop(operator_stop) + fresh start, same lane identity (capture-mode
 *   restart) → post-revive talker partial + interrupted (as recorded) →
 *   operator confirm partial → activity end →
 *
 * The gate is NOT widened: the same classification, the same release
 * predicate (presented proposal + confirm class + authorised kernel.confirm)
 * apply before and after the restart.
 */

import { describe, expect, it } from 'vitest';

import { VoiceSessionService } from '../../../src/voice/voice-session.js';
import { VoiceLiveMount } from '../../../src/websocket/voice-live-mount.js';
import type {
  GeminiLiveBridgeCallbacks,
  VoiceBridgeLike,
  VoiceClock,
} from '../../../src/voice/types.js';
import type { DeliveryOutcome, WorkerDelivery } from '../../../src/talker/types.js';
import { OperationalMetrics } from '../../../src/observability/operational-metrics.js';

const LANE = 'lane-restart-1';
const GENERATION = 0;
const WORKER = 'worker-restart-1';

/** A scripted provider bridge: the test drives its callbacks directly. */
class ScriptedBridge implements VoiceBridgeLike {
  static instances: ScriptedBridge[] = [];
  readonly callbacks: GeminiLiveBridgeCallbacks;
  readonly resumptionHandle: string | null;
  readonly activity: string[] = [];
  closed = false;
  connectCalls = 0;

  constructor(
    options: { callbacks: GeminiLiveBridgeCallbacks; resumptionHandle?: string | null } & Record<string, unknown>
  ) {
    this.callbacks = options.callbacks;
    this.resumptionHandle = options.resumptionHandle ?? null;
    ScriptedBridge.instances.push(this);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    // The real bridge announces `live` once the provider setup completes.
    this.callbacks.onState?.('live');
  }

  sendAudio(_pcm: Buffer): boolean {
    return true;
  }

  sendContextText(_text: string): boolean {
    return true;
  }

  activityStart(): void {
    this.activity.push('start');
  }

  activityEnd(): void {
    this.activity.push('end');
  }

  close(): void {
    this.closed = true;
  }

  // ── Scripting helpers (provider-shaped events) ────────────────────────────

  operatorDelta(text: string, atMs: number): void {
    this.callbacks.onInputTranscription?.(text, atMs);
  }

  talkerDelta(text: string, atMs: number): void {
    this.callbacks.onOutputTranscription?.(text, atMs);
  }

  turnComplete(atMs: number): void {
    this.callbacks.onTurnComplete?.(atMs);
  }

  interrupted(atMs: number): void {
    this.callbacks.onInterrupted?.(atMs);
  }
}

interface Sent {
  type: string;
  [key: string]: unknown;
}

function makeDelivery(outcome: DeliveryOutcome = { outcome: 'delivered', mechanism: 'prompt' }): WorkerDelivery & {
  calls: Array<{ workerSessionId: string; text: string }>;
} {
  const calls: Array<{ workerSessionId: string; text: string }> = [];
  return {
    calls,
    describe: () => 'test delivery',
    async deliver({ workerSessionId, text }) {
      calls.push({ workerSessionId, text });
      return outcome;
    },
  };
}

/** Build the real service + mount harness with a shared controllable clock. */
function createHarness() {
  ScriptedBridge.instances = [];
  let now = 1_000;
  const clock: VoiceClock = () => now;
  const evidence: Array<Record<string, unknown>> = [];
  const sent: Sent[] = [];
  const delivery = makeDelivery();
  const context = {
    send: (message: unknown) => sent.push(message as Sent),
  };

  const service = new VoiceSessionService({
    clock,
    metrics: new OperationalMetrics(),
    bridgeFactory: (options) => new ScriptedBridge(options as never),
  });
  const mount = new VoiceLiveMount({
    delivery,
    isWorkerBusy: async () => false,
    now: clock,
    evidence: (event) => evidence.push(event),
    service,
    engine: 'gemini-live',
  });

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const advance = (ms: number) => {
    now += ms;
  };
  const lastBridge = (): ScriptedBridge => ScriptedBridge.instances[ScriptedBridge.instances.length - 1];
  const events = (name: string) => evidence.filter((event) => event.event === name);

  async function start(captureMode: 'open-mic' | 'push-to-talk' = 'open-mic'): Promise<void> {
    const code = await mount.route(
      'client-1',
      context,
      {
        type: 'voice_session_start',
        version: 1,
        laneId: LANE,
        attachmentGeneration: GENERATION,
        workerSessionId: WORKER,
        captureMode,
        readingLevel: 'verbatim',
      } as never
    );
    expect(code).toBeNull();
  }

  async function stop(reason: 'operator_stop' = 'operator_stop'): Promise<void> {
    const code = await mount.route('client-1', context, {
      type: 'voice_session_stop',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      reason,
    } as never);
    expect(code).toBeNull();
  }

  async function activity(state: 'speech_start' | 'speech_end'): Promise<void> {
    const code = await mount.route('client-1', context, {
      type: 'voice_activity_state',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      state,
      atMs: now,
    } as never);
    expect(code).toBeNull();
  }

  async function reportPresentation(proposalId: string): Promise<void> {
    const code = await mount.route('client-1', context, {
      type: 'proposal_presentation',
      version: 1,
      laneId: LANE,
      attachmentGeneration: GENERATION,
      proposalId,
      presentedVariant: 'tidied',
      completed: true,
    } as never);
    expect(code).toBeNull();
  }

  return {
    mount,
    service,
    delivery,
    evidence,
    sent,
    flush,
    advance,
    lastBridge,
    events,
    now: () => now,
    start,
    stop,
    activity,
    reportPresentation,
  };
}

/** The shared journey up to (and including) the capture-mode restart. */
async function journeyUntilRestarted(harness: ReturnType<typeof createHarness>): Promise<string> {
  // ── Before the restart: the first journey works end to end ───────────────
  await harness.start('open-mic');
  expect(ScriptedBridge.instances).toHaveLength(1);
  const bridge1 = harness.lastBridge();

  // The operator's first utterance: provider partials, then the turn
  // boundary finalises them (the pre-restart finalisation path).
  harness.advance(200);
  bridge1.operatorDelta('Relay to worker I want to find out about Podpoint.', harness.now());
  bridge1.turnComplete(harness.now());
  await harness.flush();
  expect(harness.events('operator_utterance')).toHaveLength(1);

  // The model relays; the worker is idle so a live proposal is created.
  const toolResponse = (await harness.mount.handleToolRequest({
    laneId: LANE,
    name: 'relay_to_worker',
    args: { text: 'I want to find out about Podpoint.' },
    atMs: harness.now(),
  })) as Record<string, unknown>;
  expect(toolResponse).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });
  const created = harness.events('proposal_created');
  expect(created).toHaveLength(1);
  const proposalId = created[0].proposalId as string;

  // The card is presented (read-back completed), as recorded in the run.
  await harness.reportPresentation(proposalId);
  expect(harness.events('presentation_reported')).toHaveLength(1);

  // ── The capture-mode restart: stop + fresh start, same lane identity ──────
  await harness.stop('operator_stop');
  await harness.start('push-to-talk');

  // The revived provider session is the SECOND bridge; the old one is closed,
  // the lane is live again, and the kernel keeps the pending proposal.
  expect(ScriptedBridge.instances).toHaveLength(2);
  const bridge2 = harness.lastBridge();
  expect(bridge2).not.toBe(bridge1);
  expect(bridge1.closed).toBe(true);
  expect(harness.service.getState(LANE)?.state).toBe('live');
  expect(harness.mount.kernel.proposals.live(LANE)?.id).toBe(proposalId);

  // The talker's in-flight reply lands after the revive (as recorded: a
  // talker partial, then the provider reports the playback interrupted —
  // which finalises the talker partial).
  harness.advance(300);
  bridge2.talkerDelta(' what to change.', harness.now());
  bridge2.interrupted(harness.now());
  await harness.flush();
  expect(harness.events('talker_reply')).toHaveLength(1);

  // Past the talker echo window, as in the run.
  harness.advance(1_500);
  return proposalId;
}

describe('voice live mount — same-lane capture-mode restart (the soak re-bind seam)', () => {
  it('re-binds finalisation to the host activity boundary when the revived provider never completes the turn (RED: the soak shape)', async () => {
    const harness = createHarness();
    const proposalId = await journeyUntilRestarted(harness);
    const bridge2 = harness.lastBridge();

    // The operator speaks the confirm. The revived provider transcribes it
    // (partial) — and, exactly as recorded in the soak, NEVER delivers its
    // turn boundary afterwards. The client's local VAD still reports the
    // utterance end; the host marker reaches the revived bridge.
    await harness.activity('speech_start');
    bridge2.operatorDelta('Yes, send it.', harness.now());
    await harness.activity('speech_end');
    expect(bridge2.activity).toEqual(['start', 'end']);
    await harness.flush();

    // THE SEAM: the kernel pipeline must have classified the post-restart
    // utterance, and the spoken confirm must have released the preserved
    // proposal to the worker — without any provider turn boundary.
    const utterances = harness.events('operator_utterance');
    expect(utterances.length).toBe(2);
    expect(utterances[1]).toMatchObject({ utteranceClass: 'confirm' });

    expect(harness.delivery.calls).toHaveLength(1);
    expect(harness.delivery.calls[0]).toEqual({
      workerSessionId: WORKER,
      text: 'I want to find out about Podpoint.',
    });
    expect(harness.events('confirm_authorised').length).toBe(1);

    const resolved = harness.sent.filter((message) => message.type === 'proposal_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ proposalId, outcome: 'released' });

    await harness.mount.dispose();
  });

  it('still finalises on the revived provider boundary, exactly once, when it does arrive', async () => {
    const harness = createHarness();
    const proposalId = await journeyUntilRestarted(harness);
    const bridge2 = harness.lastBridge();

    // The recorded shape: the operator speaks, the host boundary ends the
    // utterance, and the provider's turn boundary arrives afterwards.
    await harness.activity('speech_start');
    bridge2.operatorDelta('Yes, send it.', harness.now());
    await harness.activity('speech_end');
    bridge2.turnComplete(harness.now());
    await harness.flush();

    // The host boundary released the proposal; the provider's late boundary
    // must NOT re-classify it (no duplicate utterance, no second delivery).
    const utterances = harness.events('operator_utterance');
    expect(utterances.length).toBe(2);
    expect(utterances[1]).toMatchObject({ utteranceClass: 'confirm' });
    expect(harness.delivery.calls).toHaveLength(1);
    expect(harness.mount.kernel.proposals.live(LANE)).toBeNull();

    const resolved = harness.sent.filter((message) => message.type === 'proposal_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ proposalId, outcome: 'released' });

    await harness.mount.dispose();
  });

  it('an ordinary stop with no restart still detaches as before and classifies nothing on its own', async () => {
    const harness = createHarness();
    await harness.start('open-mic');
    const bridge1 = harness.lastBridge();

    // An utterance in flight when the operator stops: the provider has
    // emitted partials but no turn boundary yet.
    harness.advance(200);
    bridge1.operatorDelta('I think our real problem is the deploy time.', harness.now());

    // The ordinary stop. It closes the provider session and detaches the
    // lane; it is not an utterance boundary and must not classify anything.
    await harness.stop('operator_stop');
    await harness.flush();
    expect(harness.events('operator_utterance')).toHaveLength(0);
    expect(harness.delivery.calls).toHaveLength(0);
    expect(harness.service.getState(LANE)?.state).toBe('stopped');

    // The socket-side detach (client disconnect) behaves as before too.
    await harness.mount.detachClient('client-1');
    await harness.flush();
    expect(harness.events('lane_detached')).toHaveLength(1);

    await harness.mount.dispose();
  });

  it('a fresh lane that never restarts is unaffected: one boundary, one final, no duplicates', async () => {
    const harness = createHarness();
    await harness.start('open-mic');
    const bridge = harness.lastBridge();

    // Normal operation: the host boundary and the provider boundary both
    // fire for the same utterance — exactly one final reaches the kernel.
    harness.advance(200);
    await harness.activity('speech_start');
    bridge.operatorDelta('Relay to worker please find out about Podpoint.', harness.now());
    await harness.activity('speech_end');
    bridge.turnComplete(harness.now());
    await harness.flush();

    const utterances = harness.events('operator_utterance');
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toMatchObject({ utteranceClass: 'statement' });
    expect(harness.delivery.calls).toHaveLength(0);

    // The relay still binds the (single) recorded utterance.
    const toolResponse = (await harness.mount.handleToolRequest({
      laneId: LANE,
      name: 'relay_to_worker',
      args: { text: 'find out about Podpoint.' },
      atMs: harness.now(),
    })) as Record<string, unknown>;
    expect(toolResponse).toMatchObject({ ok: true, status: 'awaiting_operator_approval' });

    await harness.mount.dispose();
  });
});
