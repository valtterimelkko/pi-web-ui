import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AdmissionController } from '../internal-api/admission-controller.js';
import type { RunReceipt } from '../internal-api/types.js';
import { PilotSessionWebSocketAdapter } from '../websocket/pilot-session-websocket.js';
import { RunReceiptManager } from '../internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../internal-api/run-receipts/run-receipt-store.js';
import { PilotExecutorAdapter } from '../workers/pilot-executor-adapter.js';
import {
  PlainWorkerLauncher,
  TransientSystemdWorkerLauncher,
  type SystemdWorkerResourceIdentity,
  type WorkerLauncher,
} from '../workers/worker-launcher.js';
import { WorkerPool } from '../workers/worker-pool.js';

export const PHASE6_FIXTURE_ID = 'worker-cgroup-conformance/v1' as const;

export const PHASE6_FROZEN_SETTINGS = Object.freeze({
  maxWorkers: 2,
  idleTimeoutMs: 60_000,
  commandTimeoutMs: 2_000,
  readinessFallbackMs: 250,
  maxActiveTurns: 2,
  interactiveReserve: 1,
  controlReserve: 1,
  retryAfterSeconds: 1,
  turnIdleTimeoutMs: 2_000,
  turnMaxMs: 10_000,
  drainTimeoutMs: 2_000,
  drainPollMs: 50,
  maxOldSpaceSize: 128,
  workerMemoryHigh: '128M',
  workerMemoryMax: '384M',
  workerMemorySwapMax: '0',
  workerTasksMax: 64,
  workerCpuWeight: 100,
  workerTimeoutStopSec: '10s',
  controllerMemoryHigh: '768M',
  controllerMemoryMax: '1G',
  controllerMemorySwapMax: '0',
  controllerTasksMax: 256,
  sampleIntervalMs: 100,
  quiescencePollMs: 50,
  warmupTurns: 2,
  measuredWarmTurns: 30,
  coldSamples: 5,
  adversarialRepeats: 3,
  churnCycles: 20,
});

export interface Phase6WorkerModeInput {
  mode: 'plain' | 'contained';
  nonce: string;
  runDir: string;
  fixtureExecutable: string;
}

export interface Phase6TurnTiming {
  totalMs: number;
  dispatchToAdmissionMs?: number;
  admissionToFirstEventMs?: number;
  firstEventToTerminalEvidenceMs?: number;
  terminalEvidenceToQuiescenceMs?: number;
}

export interface Phase6FinalCardinality {
  workers: number;
  activeRuns: number;
  admissionTurns: number;
  creatingWorkers: number;
  terminatingWorkers: number;
  workerTerminationObservers: number;
  cleanupTimers: number;
  reservedSessions: number;
  queuedSessions: number;
  knownSessionPaths: number;
  drainingReceipts: number;
  quarantinedReceipts: number;
}

export interface Phase6WorkerModeResult {
  mode: 'plain' | 'contained';
  warmupTurns: number;
  measuredWarmTurns: number[];
  coldSamples: number[];
  timingBreakdown: { measuredWarm: Phase6TurnTiming[]; cold: Phase6TurnTiming[] };
  resourceEvidence: Array<{ sessionId: string; phase: 'interval' | 'final'; identity: unknown; snapshot: unknown }>;
  p1ProbeLatenciesMs: number[];
  p1ProbeEvidence: Array<{ kind: 'health' | 'evidence' | 'cancel'; latencyMs: number; observed: unknown }>;
  completedReceipts: number;
  eventCounts: Record<string, number>;
  finalCardinality: Phase6FinalCardinality;
}

export async function runPhase6WorkerMode(input: Phase6WorkerModeInput): Promise<Phase6WorkerModeResult> {
  const modeDir = path.join(input.runDir, input.mode);
  const receiptDir = path.join(modeDir, 'receipts');
  const sessionDir = path.join(modeDir, 'sessions');
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await fs.chmod(receiptDir, 0o700);
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const launcher: WorkerLauncher = input.mode === 'contained'
    ? new TransientSystemdWorkerLauncher({ nonce: input.nonce })
    : new PlainWorkerLauncher({ allowHeavyBaseline: true });
  const pool = new WorkerPool({
    maxWorkers: PHASE6_FROZEN_SETTINGS.maxWorkers,
    idleTimeoutMs: PHASE6_FROZEN_SETTINGS.idleTimeoutMs,
    maxOldSpaceSize: PHASE6_FROZEN_SETTINGS.maxOldSpaceSize,
    piPath: input.fixtureExecutable,
    workerLauncher: launcher,
    commandTimeoutMs: PHASE6_FROZEN_SETTINGS.commandTimeoutMs,
    readinessFallbackMs: PHASE6_FROZEN_SETTINGS.readinessFallbackMs,
  });
  const admission = new AdmissionController({
    maxActiveTurns: PHASE6_FROZEN_SETTINGS.maxActiveTurns,
    interactiveReserve: PHASE6_FROZEN_SETTINGS.interactiveReserve,
    controlReserve: PHASE6_FROZEN_SETTINGS.controlReserve,
    minimumHeadroomBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    retryAfterSeconds: PHASE6_FROZEN_SETTINGS.retryAfterSeconds,
    memory: () => ({ currentBytes: 1, limitBytes: Number.MAX_SAFE_INTEGER }),
    readPids: () => ({ current: 1, max: Number.MAX_SAFE_INTEGER, source: 'service' }),
    host: () => ({ memAvailableBytes: Number.MAX_SAFE_INTEGER, source: 'host' }),
    readMemoryEvents: () => ({ high: 0, oom: 0, oomKill: 0, source: 'service' }),
  });
  let adapter: PilotExecutorAdapter | undefined;
  const receipts = new RunReceiptManager({
    store: new RunReceiptStore(receiptDir),
    turnIdleTimeoutMs: PHASE6_FROZEN_SETTINGS.turnIdleTimeoutMs,
    turnMaxMs: PHASE6_FROZEN_SETTINGS.turnMaxMs,
    drainTimeoutMs: PHASE6_FROZEN_SETTINGS.drainTimeoutMs,
    drainPollMs: PHASE6_FROZEN_SETTINGS.drainPollMs,
    isRuntimeQuiescent: async (sessionId) => adapter?.isQuiescent(sessionId) ?? false,
  });
  await receipts.init();
  adapter = new PilotExecutorAdapter({
    workerPool: pool,
    admission,
    runReceipts: receipts,
    executionInstanceId: `phase6-${input.mode}-${PHASE6_FIXTURE_ID}`,
    quiescencePollMs: PHASE6_FROZEN_SETTINGS.quiescencePollMs,
    quiescenceTimeoutMs: PHASE6_FROZEN_SETTINGS.drainTimeoutMs,
  });

  const eventCounts: Record<string, number> = {};
  const measuredWarmTurns: number[] = [];
  const coldSamples: number[] = [];
  const measuredWarmTiming: Phase6TurnTiming[] = [];
  const coldTiming: Phase6TurnTiming[] = [];
  const resourceEvidence: Array<{ sessionId: string; phase: 'interval' | 'final'; identity: unknown; snapshot: unknown }> = [];
  let completedReceipts = 0;
  const p1ProbeLatenciesMs: number[] = [];
  const p1ProbeEvidence: Phase6WorkerModeResult['p1ProbeEvidence'] = [];
  const onEvent = (event: { type: string }) => {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
  };
  const runNormal = async (sessionId: string, sessionPath: string): Promise<Phase6TurnTiming> => {
    const start = performance.now();
    const marks: Partial<Record<'admitted' | 'assigned' | 'first-event' | 'terminal-evidence' | 'quiescent', number>> = {};
    let resourceWrites = Promise.resolve();
    const sampleResource = (phase: 'interval' | 'final') => {
      const worker = pool.get(sessionPath);
      if (!worker) return;
      resourceWrites = resourceWrites.then(async () => {
        const snapshot = await worker.snapshotResource();
        if (worker.resourceIdentity && snapshot) {
          resourceEvidence.push({ sessionId, phase, identity: worker.resourceIdentity, snapshot });
        }
      }).catch(() => undefined);
    };
    const sampler = setInterval(() => sampleResource('interval'), PHASE6_FROZEN_SETTINGS.sampleIntervalMs);
    sampler.unref?.();
    const receipt = await adapter!.execute({
      sessionId,
      sessionPath,
      message: 'normal-turn',
      onEvent,
      onMilestone: (milestone) => { marks[milestone] = performance.now(); },
    }).finally(() => clearInterval(sampler));
    if (receipt.status !== 'completed') throw new Error(`normal-turn receipt was ${receipt.status}`);
    completedReceipts += 1;
    sampleResource('final');
    await resourceWrites;
    const end = performance.now();
    return {
      totalMs: end - start,
      dispatchToAdmissionMs: marks.admitted === undefined ? undefined : marks.admitted - start,
      admissionToFirstEventMs: marks.admitted === undefined || marks['first-event'] === undefined ? undefined : marks['first-event'] - marks.admitted,
      firstEventToTerminalEvidenceMs: marks['first-event'] === undefined || marks['terminal-evidence'] === undefined ? undefined : marks['terminal-evidence'] - marks['first-event'],
      terminalEvidenceToQuiescenceMs: marks['terminal-evidence'] === undefined || marks.quiescent === undefined ? undefined : marks.quiescent - marks['terminal-evidence'],
    };
  };

  try {
    const warmSessionId = `${input.mode}-warm`;
    const warmSessionPath = path.join(sessionDir, `${warmSessionId}.jsonl`);
    for (let index = 0; index < PHASE6_FROZEN_SETTINGS.warmupTurns; index += 1) {
      await runNormal(warmSessionId, warmSessionPath);
    }
    for (let index = 0; index < PHASE6_FROZEN_SETTINGS.measuredWarmTurns; index += 1) {
      const timing = await runNormal(warmSessionId, warmSessionPath);
      measuredWarmTiming.push(timing);
      measuredWarmTurns.push(timing.totalMs);
    }
    for (let index = 0; index < PHASE6_FROZEN_SETTINGS.coldSamples; index += 1) {
      const sessionId = `${input.mode}-cold-${index}`;
      const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
      const timing = await runNormal(sessionId, sessionPath);
      coldTiming.push(timing);
      coldSamples.push(timing.totalMs);
      await pool.terminate(sessionPath);
    }

    const loadSessionId = `${input.mode}-p1-under-load`;
    const loadSessionPath = path.join(sessionDir, `${loadSessionId}.jsonl`);
    const load = adapter.execute({ sessionId: loadSessionId, sessionPath: loadSessionPath, message: 'cancel-drain' });
    void load.catch(() => undefined);
    const loadDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
    while (!adapter.isActive(loadSessionId) && Date.now() <= loadDeadline) await delay(10);
    if (!adapter.isActive(loadSessionId)) throw new Error(`${input.mode} P1 baseline load did not become active`);
    await delay(250);
    p1ProbeEvidence.push(...await runP1ControlProbes({
      admission, receipts, adapter, sessionId: loadSessionId,
    }));
    p1ProbeLatenciesMs.push(...p1ProbeEvidence.map((probe) => probe.latencyMs));
    await adapter.cancel(loadSessionId, 'phase6-mode-p1-probes-complete');
    await load;
    await pool.terminate(loadSessionPath);
  } finally {
    await adapter.dispose();
    await pool.shutdownAll();
    await receipts.shutdown();
  }

  return {
    mode: input.mode,
    warmupTurns: PHASE6_FROZEN_SETTINGS.warmupTurns,
    measuredWarmTurns,
    coldSamples,
    timingBreakdown: { measuredWarm: measuredWarmTiming, cold: coldTiming },
    resourceEvidence,
    p1ProbeLatenciesMs,
    p1ProbeEvidence,
    completedReceipts,
    eventCounts,
    finalCardinality: captureFinalCardinality(pool, adapter, admission, receipts),
  };
}

export function assertPhase6ModeComparison(
  plain: Phase6WorkerModeResult,
  contained: Phase6WorkerModeResult,
): void {
  if (plain.measuredWarmTurns.length !== PHASE6_FROZEN_SETTINGS.measuredWarmTurns
    || contained.measuredWarmTurns.length !== PHASE6_FROZEN_SETTINGS.measuredWarmTurns) {
    throw new Error('Mode comparison is missing frozen measured warm samples');
  }
  const plainMeanMs = mean(plain.measuredWarmTurns);
  const containedMeanMs = mean(contained.measuredWarmTurns);
  const plainUsefulAttemptsPerHour = 3_600_000 / plainMeanMs;
  const containedUsefulAttemptsPerHour = 3_600_000 / containedMeanMs;
  if (containedUsefulAttemptsPerHour < plainUsefulAttemptsPerHour * 0.9) {
    throw new Error(`Contained useful throughput regressed over 10%: plain=${plainUsefulAttemptsPerHour.toFixed(2)}/h contained=${containedUsefulAttemptsPerHour.toFixed(2)}/h`);
  }
  if (
    plain.p1ProbeLatenciesMs.length !== 10
    || contained.p1ProbeLatenciesMs.length !== 10
    || !hasCompleteP1ProbeMatrix(plain.p1ProbeEvidence)
    || !hasCompleteP1ProbeMatrix(contained.p1ProbeEvidence)
  ) {
    throw new Error('Mode comparison is missing frozen P1 health/evidence/cancel probes');
  }
  const plainP1P95 = percentile95(plain.p1ProbeLatenciesMs);
  const containedP1P95 = percentile95(contained.p1ProbeLatenciesMs);
  const measuredRegressionCeiling = Math.max(1, plainP1P95 * 1.2);
  if (containedP1P95 > 28.8 || containedP1P95 > measuredRegressionCeiling) {
    throw new Error(`Contained P1 latency regressed: plain p95=${plainP1P95.toFixed(3)}ms contained p95=${containedP1P95.toFixed(3)}ms`);
  }
  if (plain.completedReceipts !== contained.completedReceipts) {
    throw new Error('Mode receipt parity diverged');
  }
  if (contained.resourceEvidence.length < contained.completedReceipts) {
    throw new Error('Contained resource identity evidence does not cover every completed receipt');
  }
  for (const evidence of contained.resourceEvidence) {
    const identity = evidence.identity as {
      kind?: string; mainPid?: number; launcherPid?: number; unitName?: string;
      sliceName?: string; cgroupPath?: string; observedProperties?: Record<string, string>;
    };
    const snapshot = evidence.snapshot as { memberPids?: number[] };
    const expectedProperties: Record<string, string> = {
      MemoryHigh: '134217728', MemoryMax: '402653184', MemorySwapMax: '0',
      TasksMax: '64', CPUWeight: '100', KillMode: 'control-group',
      TimeoutStopUSec: '10s', CPUQuotaPerSecUSec: 'infinity',
    };
    if (
      identity.kind !== 'systemd-transient'
      || !identity.mainPid
      || identity.mainPid === identity.launcherPid
      || !identity.sliceName?.startsWith('pi-web-ui-phase6-')
      || !identity.unitName?.startsWith(identity.sliceName.replace(/\.slice$/, '-worker-'))
      || !identity.cgroupPath?.includes(`/${identity.sliceName}/`)
      || !identity.cgroupPath.endsWith(`/${identity.unitName}`)
      || !snapshot.memberPids?.includes(identity.mainPid)
      || Object.entries(expectedProperties).some(([key, value]) => identity.observedProperties?.[key] !== value)
    ) {
      throw new Error('Contained resource identity or frozen property observation is invalid');
    }
  }
  const eventTypes = new Set([...Object.keys(plain.eventCounts), ...Object.keys(contained.eventCounts)]);
  for (const eventType of eventTypes) {
    if ((plain.eventCounts[eventType] ?? 0) !== (contained.eventCounts[eventType] ?? 0)) {
      throw new Error(`Mode event parity diverged for ${eventType}`);
    }
  }
  for (const [label, cardinality] of [
    ['plain', plain.finalCardinality], ['contained', contained.finalCardinality],
  ] as const) {
    if (Object.values(cardinality).some((value) => value !== 0)) {
      throw new Error(`${label} final cardinality was not zero: ${JSON.stringify(cardinality)}`);
    }
  }
}

export function phase6OwnedSliceName(nonce: string): string {
  if (!/^[a-z0-9]{6,32}$/.test(nonce)) {
    throw new Error('Phase 6 cleanup nonce must be 6-32 lowercase alphanumeric characters');
  }
  return `pi-web-ui-phase6-${nonce}.slice`;
}

export interface Phase6AdversarialResult {
  repetitions: Record<string, Array<Record<string, unknown>>>;
  churn: { cycles: number; finalCardinality: Phase6FinalCardinality };
  p1ProbeLatenciesMs: number[];
  p1ProbeEvidence: Array<{ kind: 'health' | 'evidence' | 'cancel'; latencyMs: number; observed: unknown }>;
}

export async function runPhase6Adversarial(input: Omit<Phase6WorkerModeInput, 'mode'>): Promise<Phase6AdversarialResult> {
  const modeDir = path.join(input.runDir, 'adversarial');
  const receiptDir = path.join(modeDir, 'receipts');
  const sessionDir = path.join(modeDir, 'sessions');
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const pool = new WorkerPool({
    maxWorkers: PHASE6_FROZEN_SETTINGS.maxWorkers,
    idleTimeoutMs: PHASE6_FROZEN_SETTINGS.idleTimeoutMs,
    maxOldSpaceSize: PHASE6_FROZEN_SETTINGS.maxOldSpaceSize,
    piPath: input.fixtureExecutable,
    workerLauncher: new TransientSystemdWorkerLauncher({ nonce: input.nonce }),
    commandTimeoutMs: PHASE6_FROZEN_SETTINGS.commandTimeoutMs,
    readinessFallbackMs: PHASE6_FROZEN_SETTINGS.readinessFallbackMs,
  });
  const admission = new AdmissionController({
    maxActiveTurns: PHASE6_FROZEN_SETTINGS.maxActiveTurns,
    interactiveReserve: PHASE6_FROZEN_SETTINGS.interactiveReserve,
    controlReserve: PHASE6_FROZEN_SETTINGS.controlReserve,
    minimumHeadroomBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    retryAfterSeconds: PHASE6_FROZEN_SETTINGS.retryAfterSeconds,
    memory: () => ({ currentBytes: 1, limitBytes: Number.MAX_SAFE_INTEGER }),
    readPids: () => ({ current: 1, max: Number.MAX_SAFE_INTEGER, source: 'service' }),
    host: () => ({ memAvailableBytes: Number.MAX_SAFE_INTEGER, source: 'host' }),
    readMemoryEvents: () => ({ high: 0, oom: 0, oomKill: 0, source: 'service' }),
  });
  let adapter: PilotExecutorAdapter | undefined;
  const receipts = new RunReceiptManager({
    store: new RunReceiptStore(receiptDir),
    turnIdleTimeoutMs: PHASE6_FROZEN_SETTINGS.turnIdleTimeoutMs,
    turnMaxMs: PHASE6_FROZEN_SETTINGS.turnMaxMs,
    drainTimeoutMs: PHASE6_FROZEN_SETTINGS.drainTimeoutMs,
    drainPollMs: PHASE6_FROZEN_SETTINGS.drainPollMs,
    isRuntimeQuiescent: async (sessionId) => adapter?.isQuiescent(sessionId) ?? false,
  });
  await receipts.init();
  adapter = new PilotExecutorAdapter({
    workerPool: pool,
    admission,
    runReceipts: receipts,
    executionInstanceId: `phase6-contained-${PHASE6_FIXTURE_ID}`,
    quiescencePollMs: PHASE6_FROZEN_SETTINGS.quiescencePollMs,
    quiescenceTimeoutMs: PHASE6_FROZEN_SETTINGS.drainTimeoutMs,
  });

  const repetitions: Record<string, Array<Record<string, unknown>>> = {};
  const p1ProbeLatenciesMs: number[] = [];
  const p1ProbeEvidence: Phase6AdversarialResult['p1ProbeEvidence'] = [];
  const executeSampled = async (
    scenario: string,
    sessionId: string,
    cancelAtMs?: number,
    onEvent?: (event: { type: string; sessionId?: string; timestamp: number; data: unknown }) => void,
  ) => {
    const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
    const samples: unknown[] = [];
    let sampleWrites = Promise.resolve();
    const timer = setInterval(() => {
      const worker = pool.get(sessionPath);
      if (!worker) return;
      sampleWrites = sampleWrites.then(async () => {
        const snapshot = await worker.snapshotResource();
        if (snapshot) samples.push({ identity: worker.resourceIdentity, snapshot });
      }).catch(() => undefined);
    }, PHASE6_FROZEN_SETTINGS.sampleIntervalMs);
    timer.unref?.();
    const startedAt = performance.now();
    const execution = adapter!.execute({ sessionId, sessionPath, message: scenario, onEvent });
    // Cancellation is intentionally delayed; attach a handler immediately so a
    // pre-delay admission/spawn failure cannot become an unhandled rejection.
    void execution.catch(() => undefined);
    let receiptStatus: string | undefined;
    let error: string | undefined;
    try {
      if (cancelAtMs !== undefined) {
        const activeDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
        while (!adapter!.isActive(sessionId) && Date.now() <= activeDeadline) await delay(10);
        if (!adapter!.isActive(sessionId)) throw new Error(`scenario ${scenario} never reached active turn`);
        await delay(cancelAtMs);
        await adapter!.cancel(sessionId, 'phase6-adversarial-cancel');
      }
      const receipt = await execution;
      receiptStatus = receipt.status;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      await execution.catch(() => undefined);
      receiptStatus = receipts.listBySession(sessionId).at(-1)?.status;
    } finally {
      clearInterval(timer);
      await sampleWrites;
    }
    const worker = pool.get(sessionPath);
    const finalSnapshot = await worker?.snapshotResource().catch(() => undefined);
    const resourceIdentity = worker?.resourceIdentity;
    await pool.terminate(sessionPath);
    const cleanupDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
    while (admission.snapshot().activeTurns !== 0 && Date.now() <= cleanupDeadline) await delay(10);
    return {
      scenario,
      durationMs: performance.now() - startedAt,
      receiptStatus,
      ...(error ? { error } : {}),
      resourceIdentity,
      samples,
      finalSnapshot,
      admissionAfter: admission.snapshot().activeTurns,
    };
  };

  try {
    for (const scenario of ['bounded-fanout', 'memory-high', 'pid-pressure'] as const) {
      repetitions[scenario] = [];
      for (let index = 0; index < PHASE6_FROZEN_SETTINGS.adversarialRepeats; index += 1) {
        repetitions[scenario].push(await executeSampled(scenario, `${scenario}-${index}`));
      }
    }
    repetitions['cancel-drain'] = [];
    for (let index = 0; index < PHASE6_FROZEN_SETTINGS.adversarialRepeats; index += 1) {
      repetitions['cancel-drain'].push(await executeSampled('cancel-drain', `cancel-drain-${index}`, 250));
    }
    repetitions['intentional-crash'] = [];
    const siblingPath = path.join(sessionDir, 'crash-sibling.jsonl');
    // Establish the sibling through the same adapter authority so its warm
    // worker-generation identity and subsequent turn epoch cannot diverge.
    await adapter.execute({ sessionId: 'crash-sibling', sessionPath: siblingPath, message: 'normal-turn' });
    for (let index = 0; index < PHASE6_FROZEN_SETTINGS.adversarialRepeats; index += 1) {
      repetitions['intentional-crash'].push(await executeSampled('intentional-crash', `intentional-crash-${index}`));
    }
    repetitions['sibling-after-crash'] = [await adapter.execute({
      sessionId: 'crash-sibling', sessionPath: siblingPath, message: 'normal-turn',
    }).then((receipt) => ({ receiptStatus: receipt.status, identity: pool.get(siblingPath)?.resourceIdentity }))];
    await pool.terminate(siblingPath);

    // Crash the target, then twenty same-session requests must converge on one
    // replacement worker before a preserved-session normal turn succeeds.
    repetitions.rehydrate = [await executeSampled('intentional-crash', 'rehydrate')];
    const rehydratePath = path.join(sessionDir, 'rehydrate.jsonl');
    const rehydrateAssignment = {
      sessionId: 'rehydrate', sessionPath: rehydratePath, runId: randomUUID(),
      executionInstanceId: `phase6-contained-${PHASE6_FIXTURE_ID}`, attemptEpoch: 1, profile: 'heavy' as const,
    };
    const rehydrated = await Promise.all(Array.from({ length: 20 }, () =>
      pool.getOrCreate(rehydratePath, undefined, rehydrateAssignment)));
    repetitions.rehydrate.push({ uniqueWorkers: new Set(rehydrated).size, identity: rehydrated[0]?.resourceIdentity });
    await pool.terminate(rehydratePath);
    repetitions.rehydrate.push(await executeSampled('normal-turn', 'rehydrate'));

    // A same-session follow-up queues behind the active cancellation and must
    // acquire admission only after the first owner drains.
    const followSessionId = 'queued-follow-up';
    const followSessionPath = path.join(sessionDir, `${followSessionId}.jsonl`);
    const followEvents: string[] = [];
    let maxFollowAdmission = 0;
    const admissionSampler = setInterval(() => {
      maxFollowAdmission = Math.max(maxFollowAdmission, admission.snapshot().activeTurns);
    }, 5);
    let firstFollowReceipt: RunReceipt;
    let queuedFollowReceipt: RunReceipt;
    try {
      const firstFollowRun = adapter.execute({
        sessionId: followSessionId,
        sessionPath: followSessionPath,
        message: 'cancel-drain',
        onEvent: (event) => followEvents.push(`first:${event.type}`),
      });
      void firstFollowRun.catch(() => undefined);
      const followActiveDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
      while (!adapter.isActive(followSessionId) && Date.now() <= followActiveDeadline) await delay(10);
      const queuedFollowRun = adapter.enqueue({
        sessionId: followSessionId,
        sessionPath: followSessionPath,
        message: 'normal-turn',
        onEvent: (event) => followEvents.push(`second:${event.type}`),
      });
      await delay(250);
      await adapter.cancel(followSessionId, 'phase6-queued-follow-up-cancel');
      firstFollowReceipt = await firstFollowRun;
      queuedFollowReceipt = await queuedFollowRun;
    } finally {
      clearInterval(admissionSampler);
    }
    repetitions['queued-follow-up'] = [{
      firstStatus: firstFollowReceipt.status,
      secondStatus: queuedFollowReceipt.status,
      maxAdmissionTurns: maxFollowAdmission,
      events: followEvents,
      receiptOrder: receipts.listBySession(followSessionId).map((receipt) => receipt.status),
    }];
    await pool.terminate(followSessionPath);

    // Three turns projected through the real broker into WebSocket-shaped and
    // notification-capture subscribers must remain exactly once and identical.
    repetitions['ws-parity'] = [];
    for (let index = 0; index < 3; index += 1) {
      const sessionId = `ws-parity-${index}`;
      const wsEvents: string[] = [];
      let notificationAgentEnds = 0;
      const bridge = new PilotSessionWebSocketAdapter({
        executor: adapter,
        clientId: `phase6-client-${index}`,
        send: (_clientId, message) => {
          const envelope = message as { type?: string; event?: { type?: string } };
          if (envelope.type === 'session_event' && envelope.event?.type) wsEvents.push(envelope.event.type);
        },
        notificationSink: (event) => { if (event.type === 'agent_end') notificationAgentEnds += 1; },
      });
      const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
      const startedAt = performance.now();
      const receipt = await bridge.prompt({ sessionId, sessionPath, message: 'normal-turn' });
      repetitions['ws-parity'].push({
        scenario: 'normal-turn',
        durationMs: performance.now() - startedAt,
        receiptStatus: receipt.status,
        wsEvents,
        notificationAgentEnds,
        remainingSubscribers: bridge.activeProjectionCount,
      });
      await pool.terminate(sessionPath);
    }

    // Frozen late-event timing: old terminal 500 ms after cancellation and 50
    // ms after the new epoch starts. It must not reach receipt/broker/notify.
    const lateSessionId = 'late-event-fence';
    const lateSessionPath = path.join(sessionDir, `${lateSessionId}.jsonl`);
    const oldRun = adapter.execute({ sessionId: lateSessionId, sessionPath: lateSessionPath, message: 'cancel-drain-late' });
    void oldRun.catch(() => undefined);
    const oldActiveDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
    while (!adapter.isActive(lateSessionId) && Date.now() <= oldActiveDeadline) await delay(10);
    await delay(250);
    await adapter.cancel(lateSessionId, 'phase6-late-event-cancel');
    await oldRun.catch(() => undefined);
    const fencedBeforeNewEpoch = adapter.fencedLateEventCount;
    await delay(450);
    const projectedEvents: string[] = [];
    let notificationAgentEnds = 0;
    const lateBridge = new PilotSessionWebSocketAdapter({
      executor: adapter,
      clientId: 'phase6-late-client',
      send: (_clientId, message) => {
        const envelope = message as { type?: string; event?: { type?: string } };
        if (envelope.type === 'session_event' && envelope.event?.type) projectedEvents.push(envelope.event.type);
      },
      notificationSink: (event) => { if (event.type === 'agent_end') notificationAgentEnds += 1; },
    });
    const newReceipt = await lateBridge.prompt({
      sessionId: lateSessionId,
      sessionPath: lateSessionPath,
      message: 'normal-turn',
    });
    repetitions['late-event-fence'] = [{
      fencedDelta: adapter.fencedLateEventCount - fencedBeforeNewEpoch,
      newReceiptStatus: newReceipt.status,
      terminalObservationCount: newReceipt.liveness?.terminalObservations?.length ?? 0,
      projectedEvents,
      notificationAgentEnds,
      remainingSubscribers: lateBridge.activeProjectionCount,
    }];
    await pool.terminate(lateSessionPath);

    // P1 control probes while one heavy P2 hold is active.
    const loadSession = 'p1-under-load';
    const loadPath = path.join(sessionDir, `${loadSession}.jsonl`);
    const load = adapter.execute({ sessionId: loadSession, sessionPath: loadPath, message: 'cancel-drain' });
    void load.catch(() => undefined);
    const loadActiveDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
    while (!adapter.isActive(loadSession) && Date.now() <= loadActiveDeadline) await delay(10);
    if (!adapter.isActive(loadSession)) throw new Error('p1-under-load did not reach active turn');
    await delay(250);
    p1ProbeEvidence.push(...await runP1ControlProbes({
      admission, receipts, adapter, sessionId: loadSession,
    }));
    p1ProbeLatenciesMs.push(...p1ProbeEvidence.map((probe) => probe.latencyMs));
    await adapter.cancel(loadSession, 'phase6-p1-probe-complete');
    await load.catch(() => undefined);
    await pool.terminate(loadPath);
    const loadCleanupDeadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
    while (admission.snapshot().activeTurns !== 0 && Date.now() <= loadCleanupDeadline) await delay(10);

    for (let index = 0; index < PHASE6_FROZEN_SETTINGS.churnCycles; index += 1) {
      const sessionId = `churn-${index}`;
      await executeSampled(index % 2 === 0 ? 'normal-turn' : 'cancel-drain', sessionId, index % 2 === 0 ? undefined : 250);
      await pool.terminate(path.join(sessionDir, `${sessionId}.jsonl`));
      const cardinality = { workers: pool.getStats().total, activeRuns: adapter.activeRunCount, admissionTurns: admission.snapshot().activeTurns };
      if (cardinality.workers !== 0 || cardinality.activeRuns !== 0 || cardinality.admissionTurns !== 0) {
        throw new Error(`churn cardinality drift at cycle ${index}: ${JSON.stringify(cardinality)}`);
      }
    }
  } finally {
    await adapter.dispose();
    await pool.shutdownAll();
    await receipts.shutdown();
  }

  const result: Phase6AdversarialResult = {
    repetitions,
    churn: {
      cycles: PHASE6_FROZEN_SETTINGS.churnCycles,
      finalCardinality: captureFinalCardinality(pool, adapter, admission, receipts),
    },
    p1ProbeLatenciesMs,
    p1ProbeEvidence,
  };
  // Persist bounded raw evidence before acceptance so a failed assertion keeps
  // the exact samples needed for systematic diagnosis.
  await fs.writeFile(path.join(modeDir, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  assertPhase6AdversarialResult(result);
  return result;
}

export interface Phase6RestartManifest {
  fixture: typeof PHASE6_FIXTURE_ID;
  nonce: string;
  sessionId: string;
  sessionPath: string;
  runId: string;
  workerIdentity: SystemdWorkerResourceIdentity;
}

export async function runPhase6RestartOldController(
  input: Omit<Phase6WorkerModeInput, 'mode'>,
): Promise<never> {
  const restartDir = path.join(input.runDir, 'restart');
  const receiptDir = path.join(restartDir, 'receipts');
  const sessionDir = path.join(restartDir, 'sessions');
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const pool = new WorkerPool({
    maxWorkers: PHASE6_FROZEN_SETTINGS.maxWorkers,
    idleTimeoutMs: PHASE6_FROZEN_SETTINGS.idleTimeoutMs,
    maxOldSpaceSize: PHASE6_FROZEN_SETTINGS.maxOldSpaceSize,
    piPath: input.fixtureExecutable,
    workerLauncher: new TransientSystemdWorkerLauncher({ nonce: input.nonce }),
    commandTimeoutMs: PHASE6_FROZEN_SETTINGS.commandTimeoutMs,
    readinessFallbackMs: PHASE6_FROZEN_SETTINGS.readinessFallbackMs,
  });
  const admission = createPhase6FixtureAdmission();
  let adapter: PilotExecutorAdapter | undefined;
  const receipts = new RunReceiptManager({
    store: new RunReceiptStore(receiptDir),
    turnIdleTimeoutMs: PHASE6_FROZEN_SETTINGS.turnIdleTimeoutMs,
    turnMaxMs: PHASE6_FROZEN_SETTINGS.turnMaxMs,
    drainTimeoutMs: PHASE6_FROZEN_SETTINGS.drainTimeoutMs,
    drainPollMs: PHASE6_FROZEN_SETTINGS.drainPollMs,
    isRuntimeQuiescent: async (sessionId) => adapter?.isQuiescent(sessionId) ?? false,
  });
  await receipts.init();
  adapter = new PilotExecutorAdapter({
    workerPool: pool,
    admission,
    runReceipts: receipts,
    executionInstanceId: `phase6-restart-old-${PHASE6_FIXTURE_ID}`,
    quiescencePollMs: PHASE6_FROZEN_SETTINGS.quiescencePollMs,
    quiescenceTimeoutMs: PHASE6_FROZEN_SETTINGS.drainTimeoutMs,
  });
  const sessionId = 'restart-unknown';
  const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
  const execution = adapter.execute({ sessionId, sessionPath, message: 'restart-unknown' });
  void execution.catch(() => undefined);
  const deadline = Date.now() + PHASE6_FROZEN_SETTINGS.drainTimeoutMs;
  while (!adapter.isActive(sessionId) && Date.now() <= deadline) await delay(10);
  const worker = pool.get(sessionPath);
  const identity = worker?.resourceIdentity;
  const receipt = receipts.listBySession(sessionId).at(-1);
  if (!adapter.isActive(sessionId) || identity?.kind !== 'systemd-transient' || !receipt) {
    throw new Error('Restart-old controller did not establish an active contained assignment');
  }
  const manifest: Phase6RestartManifest = {
    fixture: PHASE6_FIXTURE_ID,
    nonce: input.nonce,
    sessionId,
    sessionPath,
    runId: receipt.runId,
    workerIdentity: identity,
  };
  await fs.writeFile(path.join(restartDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(restartDir, 'ready'), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return await new Promise<never>(() => undefined);
}

export async function runPhase6RestartRecovery(
  input: Omit<Phase6WorkerModeInput, 'mode'>,
): Promise<Phase6RestartResult> {
  const restartDir = path.join(input.runDir, 'restart');
  const manifest = JSON.parse(await fs.readFile(path.join(restartDir, 'manifest.json'), 'utf8')) as Phase6RestartManifest;
  if (manifest.fixture !== PHASE6_FIXTURE_ID || manifest.nonce !== input.nonce) {
    throw new Error('Restart recovery manifest identity mismatch');
  }
  const receipts = new RunReceiptManager({ store: new RunReceiptStore(path.join(restartDir, 'receipts')) });
  await receipts.init();
  try {
    const receipt = receipts.get(manifest.runId);
    const launcher = new TransientSystemdWorkerLauncher({ nonce: input.nonce });
    const reconciled = await launcher.reconcile(manifest.workerIdentity);
    const result: Phase6RestartResult = {
      receiptStatus: receipt?.status ?? 'missing',
      errorCode: receipt?.errorCode,
      workerStopped: reconciled.workerStopped,
      cgroupEmpty: reconciled.cgroupEmpty,
      unitCollected: reconciled.unitCollected,
      runId: manifest.runId,
      workerIdentity: manifest.workerIdentity,
    };
    assertPhase6RestartResult(result);
    await fs.writeFile(path.join(restartDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  } finally {
    await receipts.shutdown();
  }
}

function createPhase6FixtureAdmission(): AdmissionController {
  return new AdmissionController({
    maxActiveTurns: PHASE6_FROZEN_SETTINGS.maxActiveTurns,
    interactiveReserve: PHASE6_FROZEN_SETTINGS.interactiveReserve,
    controlReserve: PHASE6_FROZEN_SETTINGS.controlReserve,
    minimumHeadroomBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    retryAfterSeconds: PHASE6_FROZEN_SETTINGS.retryAfterSeconds,
    memory: () => ({ currentBytes: 1, limitBytes: Number.MAX_SAFE_INTEGER }),
    readPids: () => ({ current: 1, max: Number.MAX_SAFE_INTEGER, source: 'service' }),
    host: () => ({ memAvailableBytes: Number.MAX_SAFE_INTEGER, source: 'host' }),
    readMemoryEvents: () => ({ high: 0, oom: 0, oomKill: 0, source: 'service' }),
  });
}

export function assertPhase6AdversarialResult(result: Phase6AdversarialResult): void {
  const requiredScenarios = ['bounded-fanout', 'memory-high', 'pid-pressure', 'cancel-drain', 'intentional-crash'];
  for (const scenario of requiredScenarios) {
    if ((result.repetitions[scenario]?.length ?? 0) !== PHASE6_FROZEN_SETTINGS.adversarialRepeats) {
      throw new Error(`${scenario} did not run ${PHASE6_FROZEN_SETTINGS.adversarialRepeats} times`);
    }
  }

  const fanoutRuns = result.repetitions['bounded-fanout'];
  const fanoutCounts = fanoutRuns.flatMap((run) => (Array.isArray(run.samples) ? run.samples : []))
    .map((sample) => ((sample as { snapshot?: { memberPids?: number[] } }).snapshot?.memberPids ?? []).length);
  if (fanoutRuns.some((run) => run.receiptStatus !== 'completed') || !fanoutCounts.includes(5) || fanoutCounts.some((count) => count > 5)) {
    throw new Error('Fan-out containment failed: expected one worker plus at most four helpers and completed receipts');
  }

  const memoryRuns = result.repetitions['memory-high'];
  const sawMemorySignal = memoryRuns.every((run) => {
    if (typeof run.error === 'string' && /bounded allocation failure/i.test(run.error)) return true;
    const samples = Array.isArray(run.samples) ? run.samples : [];
    return samples.some((sample) => (((sample as { snapshot?: { memoryEvents?: { high?: number } } }).snapshot?.memoryEvents?.high ?? 0) > 0));
  });
  if (!sawMemorySignal) throw new Error('Memory pressure containment signal was absent');

  const pidRuns = result.repetitions['pid-pressure'] ?? [];
  const sawPidSignal = pidRuns.length === PHASE6_FROZEN_SETTINGS.adversarialRepeats && pidRuns.every((run) => {
    if (typeof run.error === 'string' && /EAGAIN|pid pressure|spawn failure/i.test(run.error)) return true;
    const samples = Array.isArray(run.samples) ? run.samples as Array<Record<string, unknown>> : [];
    return samples.some((sample) => {
      const snapshot = sample.snapshot as { pidsEvents?: { max?: number } } | undefined;
      return (snapshot?.pidsEvents?.max ?? 0) > 0;
    });
  });
  if (!sawPidSignal) throw new Error('PID-pressure containment signal was absent (no pids.events max delta or bounded EAGAIN)');

  const cancelRuns = result.repetitions['cancel-drain'];
  if (cancelRuns.some((run) => !['cancelled', 'failed'].includes(String(run.receiptStatus)))) {
    throw new Error('Cancel-drain produced a false successful receipt');
  }
  const drainDurations = cancelRuns.map((run) => Number(run.durationMs)).filter(Number.isFinite);
  if (drainDurations.some((duration) => duration > 10_000)) throw new Error('Cancel-drain exceeded the 10 second drain SLO');

  const crashRuns = result.repetitions['intentional-crash'];
  if (crashRuns.some((run) => run.receiptStatus !== 'failed' || !/42/.test(String(run.error)))) {
    throw new Error('Intentional crash did not remain target-scoped failed evidence with exit 42');
  }

  const siblingAfterCrash = result.repetitions['sibling-after-crash']?.[0];
  if (siblingAfterCrash?.receiptStatus !== 'completed') {
    throw new Error('Intentional crash damaged the independent sibling worker');
  }

  const rehydrate = result.repetitions.rehydrate ?? [];
  if (
    rehydrate[0]?.receiptStatus !== 'failed'
    || !/42/.test(String(rehydrate[0]?.error))
    || Number(rehydrate[1]?.uniqueWorkers) !== 1
    || rehydrate[2]?.receiptStatus !== 'completed'
  ) {
    throw new Error('Rehydrate single-flight failed or its crashed-session recovery turn did not complete');
  }

  const queuedFollowUp = result.repetitions['queued-follow-up']?.[0];
  const queuedEvents = Array.isArray(queuedFollowUp?.events) ? queuedFollowUp.events : [];
  if (
    queuedFollowUp?.firstStatus !== 'cancelled'
    || queuedFollowUp?.secondStatus !== 'completed'
    || Number(queuedFollowUp?.maxAdmissionTurns) !== 1
    || queuedEvents.filter((event) => event === 'second:agent_end').length !== 1
  ) {
    throw new Error('Queued follow-up ownership, admission, or event ordering failed');
  }

  const wsParity = result.repetitions['ws-parity'] ?? [];
  if (wsParity.length !== 3 || wsParity.some((run) => {
    const events = Array.isArray(run.wsEvents) ? run.wsEvents : [];
    return run.receiptStatus !== 'completed'
      || events.filter((event) => event === 'agent_end').length !== 1
      || Number(run.notificationAgentEnds) !== 1
      || Number(run.remainingSubscribers) !== 0;
  })) {
    throw new Error('WebSocket parity or notification exactly-once capture failed');
  }

  const lateFence = result.repetitions['late-event-fence']?.[0];
  const lateEvents = Array.isArray(lateFence?.projectedEvents) ? lateFence.projectedEvents : [];
  if (
    Number(lateFence?.fencedDelta) !== 1
    || lateFence?.newReceiptStatus !== 'completed'
    || Number(lateFence?.terminalObservationCount) !== 1
    || lateEvents.filter((event) => event === 'agent_end').length !== 1
    || Number(lateFence?.notificationAgentEnds) !== 1
    || Number(lateFence?.remainingSubscribers) !== 0
  ) {
    throw new Error('Late-event fence allowed stale terminal evidence to affect the new epoch');
  }

  if (result.p1ProbeLatenciesMs.length !== 10 || !hasCompleteP1ProbeMatrix(result.p1ProbeEvidence)) {
    throw new Error('P1 health/evidence/cancel probe matrix did not match frozen setting');
  }
  const sortedP1 = [...result.p1ProbeLatenciesMs].sort((a, b) => a - b);
  const p1P95 = sortedP1[Math.ceil(sortedP1.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  // Frozen Phase 4/5 P1 baseline is 24 ms; §6.7 allows at most +20% and 2 s,
  // therefore 28.8 ms is the stricter bound.
  if (p1P95 > 28.8) throw new Error(`P1 latency SLO breached: p95=${p1P95.toFixed(3)}ms`);
  const cardinality = result.churn.finalCardinality;
  if (Object.values(cardinality).some((value) => value !== 0)) {
    throw new Error(`Final churn cardinality was not zero: ${JSON.stringify(cardinality)}`);
  }
}

function captureFinalCardinality(
  pool: WorkerPool,
  adapter: PilotExecutorAdapter,
  admission: AdmissionController,
  receipts: RunReceiptManager,
): Phase6FinalCardinality {
  const worker = pool.getLifecycleCardinality();
  const pilot = adapter.getLifecycleCardinality();
  return {
    workers: worker.workers,
    activeRuns: pilot.activeRuns,
    admissionTurns: admission.snapshot().activeTurns,
    creatingWorkers: worker.creating,
    terminatingWorkers: worker.terminating,
    workerTerminationObservers: worker.terminationObservers,
    cleanupTimers: worker.cleanupTimers,
    reservedSessions: pilot.reservedSessions,
    queuedSessions: pilot.queuedSessions,
    knownSessionPaths: pilot.knownSessionPaths,
    drainingReceipts: receipts.getDrainingCount(),
    quarantinedReceipts: receipts.getQuarantinedCount(),
  };
}

async function runP1ControlProbes(input: {
  admission: AdmissionController;
  receipts: RunReceiptManager;
  adapter: PilotExecutorAdapter;
  sessionId: string;
}): Promise<Phase6WorkerModeResult['p1ProbeEvidence']> {
  const evidence: Phase6WorkerModeResult['p1ProbeEvidence'] = [];
  for (let index = 0; index < 10; index += 1) {
    const kind = index === 9 ? 'cancel' : index % 2 === 0 ? 'health' : 'evidence';
    const startedAt = performance.now();
    const lease = await input.admission.acquire('pi', 'P1');
    let observed: unknown;
    try {
      if (kind === 'health') {
        const snapshot = input.admission.snapshot();
        observed = { activeTurns: snapshot.activeTurns, refusalReason: snapshot.reason };
      } else if (kind === 'evidence') {
        observed = input.receipts.listBySession(input.sessionId).map((receipt) => ({
          runId: receipt.runId, status: receipt.status,
        }));
      } else {
        const receipt = await input.adapter.cancel(input.sessionId, 'phase6-p1-cancel-probe');
        observed = receipt ? { runId: receipt.runId, status: receipt.status } : { status: 'not-active' };
      }
    } finally {
      lease.release();
    }
    evidence.push({ kind, latencyMs: performance.now() - startedAt, observed });
    await delay(100);
  }
  return evidence;
}

function hasCompleteP1ProbeMatrix(
  evidence: Array<{ kind: 'health' | 'evidence' | 'cancel' }>,
): boolean {
  return evidence.length === 10
    && evidence.filter((probe) => probe.kind === 'health').length === 5
    && evidence.filter((probe) => probe.kind === 'evidence').length === 4
    && evidence.filter((probe) => probe.kind === 'cancel').length === 1;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

function mean(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Phase6RestartResult {
  receiptStatus: string;
  errorCode?: string;
  workerStopped: boolean;
  cgroupEmpty: boolean;
  unitCollected: boolean;
  runId?: string;
  workerIdentity?: unknown;
}

export function assertPhase6RestartResult(result: Phase6RestartResult): void {
  if (result.receiptStatus !== 'interrupted' || result.errorCode !== 'SERVER_RESTART') {
    throw new Error('Restart recovery did not persist interrupted/SERVER_RESTART evidence');
  }
  if (!result.workerStopped || !result.cgroupEmpty) {
    throw new Error('Restart recovery did not stop and empty the exact old worker boundary');
  }
  if (!result.unitCollected) {
    throw new Error('Restart recovery did not verify the old worker unit was collected');
  }
}

export interface Phase6ControlSnapshot {
  observedAt: string;
  cgroupPath: string;
  memoryCurrentBytes: number;
  pidsCurrent: number;
  memoryEvents: Record<string, number>;
  pidsEvents: Record<string, number>;
}

type Phase6ReadFile = (file: string) => Promise<string>;

export async function snapshotPhase6CurrentCgroup(
  readFile: Phase6ReadFile = async (file) => fs.readFile(file, 'utf8'),
): Promise<Phase6ControlSnapshot> {
  const membership = await readFile('/proc/self/cgroup');
  const cgroupPath = membership.split(/\r?\n/).find((line) => line.startsWith('0::/'))?.slice(3);
  if (!cgroupPath) throw new Error('Disposable Phase 6 controller is not in an observable cgroup-v2 path');
  const base = `/sys/fs/cgroup${cgroupPath}`;
  const [memoryCurrent, pidsCurrent, memoryEvents, pidsEvents] = await Promise.all([
    readFile(`${base}/memory.current`), readFile(`${base}/pids.current`),
    readFile(`${base}/memory.events`), readFile(`${base}/pids.events`),
  ]);
  return {
    observedAt: new Date().toISOString(),
    cgroupPath,
    memoryCurrentBytes: Number(memoryCurrent.trim()),
    pidsCurrent: Number(pidsCurrent.trim()),
    memoryEvents: parsePhase6Counters(memoryEvents),
    pidsEvents: parsePhase6Counters(pidsEvents),
  };
}

export function assertPhase6ControlDelta(before: Phase6ControlSnapshot, after: Phase6ControlSnapshot): void {
  if (before.cgroupPath !== after.cgroupPath) throw new Error('Phase 6 control cgroup identity changed during validation');
  for (const counter of ['high', 'max', 'oom', 'oom_kill']) {
    const delta = (after.memoryEvents[counter] ?? 0) - (before.memoryEvents[counter] ?? 0);
    if (delta !== 0) throw new Error(`Phase 6 control memory ${counter} delta was ${delta}`);
  }
  const pidsDelta = (after.pidsEvents.max ?? 0) - (before.pidsEvents.max ?? 0);
  if (pidsDelta !== 0) throw new Error(`Phase 6 control pids max delta was ${pidsDelta}`);
}

function parsePhase6Counters(input: string): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const line of input.split(/\r?\n/)) {
    const [key, raw] = line.trim().split(/\s+/, 2);
    const value = Number(raw);
    if (key && Number.isSafeInteger(value) && value >= 0) counters[key] = value;
  }
  return counters;
}

export interface Phase6ControllerArgsInput {
  nonce: string;
  nodePath: string;
  tsxCliPath: string;
  scriptPath: string;
  runDir: string;
  repoRoot: string;
}

export function buildPhase6ControllerArgs(input: Phase6ControllerArgsInput): string[] {
  const sliceName = phase6OwnedSliceName(input.nonce);
  return [
    '--quiet',
    `--unit=pi-web-ui-phase6-${input.nonce}-controller.service`,
    `--working-directory=${input.repoRoot}`,
    `--slice=${sliceName}`,
    '--service-type=exec',
    '--pipe',
    '--wait',
    '--collect',
    `--property=MemoryHigh=${PHASE6_FROZEN_SETTINGS.controllerMemoryHigh}`,
    `--property=MemoryMax=${PHASE6_FROZEN_SETTINGS.controllerMemoryMax}`,
    `--property=MemorySwapMax=${PHASE6_FROZEN_SETTINGS.controllerMemorySwapMax}`,
    `--property=TasksMax=${PHASE6_FROZEN_SETTINGS.controllerTasksMax}`,
    '--property=KillMode=control-group',
    '--',
    input.nodePath,
    input.tsxCliPath,
    input.scriptPath,
    '--controller',
    '--nonce', input.nonce,
    '--dir', input.runDir,
  ];
}
