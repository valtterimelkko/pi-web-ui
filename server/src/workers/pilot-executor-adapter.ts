import type { NormalizedEvent } from '@pi-web-ui/shared';
import type { AdmissionController } from '../internal-api/admission-controller.js';
import { ErrorCode } from '../internal-api/error-codes.js';
import type { RunReceipt, SessionRuntime } from '../internal-api/types.js';
import type { RunReceiptManager } from '../internal-api/run-receipts/run-receipt-manager.js';
import { SessionRPCClient } from './session-rpc-client.js';
import type { SessionWorker } from './session-worker.js';
import type { WorkerAssignmentIdentity } from './worker-launcher.js';
import type { WorkerPool } from './worker-pool.js';

export interface PilotExecutorAdapterOptions {
  workerPool: WorkerPool;
  admission: AdmissionController;
  runReceipts: RunReceiptManager;
  executionInstanceId: string;
  quiescencePollMs?: number;
  quiescenceTimeoutMs?: number;
}

export type PilotExecutionMilestone = 'admitted' | 'assigned' | 'first-event' | 'terminal-evidence' | 'quiescent';

export interface PilotExecuteInput {
  sessionId: string;
  sessionPath: string;
  message: string;
  onEvent?: (event: NormalizedEvent) => void;
  onMilestone?: (milestone: PilotExecutionMilestone) => void;
  idempotencyKey?: string;
}

interface ActivePilotRun {
  runId: string;
  attemptEpoch: number;
  worker: SessionWorker;
  client: SessionRPCClient;
  terminalResolve: () => void;
}

/**
 * Internal Phase 6 adapter for server-selected heavy work. It deliberately is
 * not a public request schema: callers cannot choose executables, units,
 * cgroups, or raw resource limits.
 */
export class PilotExecutorAdapter {
  private readonly workerPool: WorkerPool;
  private readonly admission: AdmissionController;
  private readonly runReceipts: RunReceiptManager;
  private readonly executionInstanceId: string;
  private readonly quiescencePollMs: number;
  private readonly quiescenceTimeoutMs: number;
  private readonly activeBySession = new Map<string, ActivePilotRun>();
  private readonly reservedSessions = new Set<string>();
  private readonly epochBySession = new Map<string, number>();
  private readonly knownSessionPaths = new Map<string, string>();
  private readonly queueTails = new Map<string, Promise<void>>();
  private disposed = false;
  private fencedLateEvents = 0;

  constructor(options: PilotExecutorAdapterOptions) {
    this.workerPool = options.workerPool;
    this.admission = options.admission;
    this.runReceipts = options.runReceipts;
    this.executionInstanceId = options.executionInstanceId;
    this.quiescencePollMs = options.quiescencePollMs ?? 50;
    this.quiescenceTimeoutMs = options.quiescenceTimeoutMs ?? 2_000;
  }

  enqueue(input: PilotExecuteInput): Promise<RunReceipt> {
    const prior = this.queueTails.get(input.sessionId) ?? Promise.resolve();
    const run = prior
      .catch(() => undefined)
      .then(async () => {
        while (this.activeBySession.has(input.sessionId) || this.reservedSessions.has(input.sessionId)) {
          await delay(this.quiescencePollMs);
        }
        return this.execute(input);
      });
    const tail = run.then(() => undefined, () => undefined);
    this.queueTails.set(input.sessionId, tail);
    void tail.then(() => {
      if (this.queueTails.get(input.sessionId) === tail) this.queueTails.delete(input.sessionId);
    });
    return run;
  }

  execute(input: PilotExecuteInput): Promise<RunReceipt> {
    if (this.disposed) return Promise.reject(new Error('Pilot executor adapter is disposed'));
    if (this.activeBySession.has(input.sessionId) || this.reservedSessions.has(input.sessionId)) {
      return Promise.reject(new Error(`Pilot session already has an active or reserved owner: ${input.sessionId}`));
    }
    // This reservation is synchronous: two direct callers cannot both cross an
    // await before one authoritative owner exists.
    this.reservedSessions.add(input.sessionId);
    return this.executeReserved(input).finally(() => {
      if (!this.activeBySession.has(input.sessionId)) this.reservedSessions.delete(input.sessionId);
    });
  }

  private async executeReserved(input: PilotExecuteInput): Promise<RunReceipt> {
    const reservation = await this.runReceipts.beginRun({
      sessionId: input.sessionId,
      runtime: 'pi' satisfies SessionRuntime,
      executionInstanceId: this.executionInstanceId,
      model: 'worker-cgroup-conformance/v1',
      message: input.message,
      mode: 'prompt',
      dispatchMode: 'prompt',
      verbosity: 'full',
      detach: false,
      idempotencyKey: input.idempotencyKey,
    });
    if (reservation.kind !== 'created') return reservation.receipt;

    const runId = reservation.receipt.runId;
    let lease: { release: () => void };
    try {
      lease = await this.admission.acquire('pi', 'P2');
    } catch (error) {
      await this.runReceipts.rejectBeforeDispatch(runId, {
        status: 'cancelled',
        errorCode: ErrorCode.ADMISSION_CAPACITY_EXHAUSTED,
      });
      throw error;
    }
    this.runReceipts.attachLease(runId, lease);
    await this.runReceipts.markStarted(runId);
    input.onMilestone?.('admitted');

    const attemptEpoch = (this.epochBySession.get(input.sessionId) ?? 0) + 1;
    this.epochBySession.set(input.sessionId, attemptEpoch);
    const assignment: WorkerAssignmentIdentity = {
      sessionId: input.sessionId,
      sessionPath: input.sessionPath,
      runId,
      executionInstanceId: this.executionInstanceId,
      attemptEpoch,
      profile: 'heavy',
    };

    let client: SessionRPCClient | undefined;
    let worker: SessionWorker | undefined;
    let ownershipReleasable = false;
    let terminalResolve!: () => void;
    const terminalSeen = new Promise<void>((resolve) => { terminalResolve = resolve; });
    const eventWrites: Promise<void>[] = [];
    try {
      worker = await this.workerPool.getOrCreate(input.sessionPath, undefined, assignment);
      this.knownSessionPaths.set(input.sessionId, input.sessionPath);
      client = new SessionRPCClient(worker);
      this.activeBySession.set(input.sessionId, {
        runId, attemptEpoch, worker, client, terminalResolve,
      });
      input.onMilestone?.('assigned');
      let sawFirstEvent = false;
      client.subscribe((event) => {
        const active = this.activeBySession.get(input.sessionId);
        if (!active || active.runId !== runId || active.attemptEpoch !== attemptEpoch) return;
        const correlation = eventCorrelation(event);
        if (
          !correlation
          || correlation.runId !== runId
          || correlation.executionInstanceId !== this.executionInstanceId
          || correlation.attemptEpoch !== attemptEpoch
        ) {
          if (event.type === 'agent_end') this.fencedLateEvents += 1;
          return;
        }
        if (!sawFirstEvent) {
          sawFirstEvent = true;
          input.onMilestone?.('first-event');
        }
        eventWrites.push(this.runReceipts.observeEvent(runId, event));
        input.onEvent?.(event);
        if (event.type === 'agent_end' && !isSynthetic(event)) {
          input.onMilestone?.('terminal-evidence');
          terminalResolve();
        }
      });

      await client.prompt(input.message, undefined, { runId, executionInstanceId: this.executionInstanceId, attemptEpoch });
      await withTimeout(terminalSeen, this.quiescenceTimeoutMs, 'Pilot worker did not emit agent_end');
      await this.waitForActiveTurnQuiescence(worker);
      input.onMilestone?.('quiescent');
      await Promise.all(eventWrites);
      const completed = await this.runReceipts.finish(runId, {
        status: 'completed', cessationBasis: 'resource_quiescence',
      });
      if (!completed) throw new Error(`Run receipt disappeared: ${runId}`);
      if (completed.status === 'cancelled' || completed.status === 'failed') {
        await this.runReceipts.confirmRuntimeQuiescent(runId);
      }
      ownershipReleasable = true;
      return completed;
    } catch (error) {
      await Promise.allSettled(eventWrites);
      await this.runReceipts.finish(runId, { status: 'failed', errorCode: 'RUNTIME_ERROR' });
      if (worker) {
        await this.waitForActiveTurnQuiescence(worker);
      }
      await this.runReceipts.confirmRuntimeQuiescent(runId);
      ownershipReleasable = true;
      throw error;
    } finally {
      client?.dispose();
      const active = this.activeBySession.get(input.sessionId);
      if (ownershipReleasable && active?.runId === runId && active.attemptEpoch === attemptEpoch) {
        this.activeBySession.delete(input.sessionId);
      }
    }
  }

  async cancel(sessionId: string, _reason: string): Promise<RunReceipt | undefined> {
    const active = this.activeBySession.get(sessionId);
    if (!active) return undefined;
    // Persist terminal cancellation first; RunReceiptManager keeps the attached
    // admission lease as draining debt until isQuiescent() confirms the worker.
    const receipt = await this.runReceipts.cancelRun(active.runId);
    active.terminalResolve();
    await active.client.abort();
    return receipt;
  }

  isQuiescent(sessionId: string): boolean {
    // Positive cessation is persisted and released explicitly only after the
    // asynchronous resource snapshot in waitForActiveTurnQuiescence(). A
    // ready status alone is not sufficient while this adapter owns the run.
    return !this.activeBySession.has(sessionId) && !this.reservedSessions.has(sessionId);
  }

  get fencedLateEventCount(): number {
    return this.fencedLateEvents;
  }

  isActive(sessionId: string): boolean {
    return this.activeBySession.has(sessionId);
  }

  get activeRunCount(): number {
    const reservedOnly = [...this.reservedSessions].filter((sessionId) => !this.activeBySession.has(sessionId)).length;
    return this.activeBySession.size + reservedOnly;
  }

  getLifecycleCardinality(): {
    activeRuns: number;
    reservedSessions: number;
    queuedSessions: number;
    knownSessionPaths: number;
  } {
    return {
      activeRuns: this.activeBySession.size,
      reservedSessions: this.reservedSessions.size,
      queuedSessions: this.queueTails.size,
      knownSessionPaths: this.knownSessionPaths.size,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const sessionPath of new Set(this.knownSessionPaths.values())) {
      await this.workerPool.terminate(sessionPath);
    }
    this.activeBySession.clear();
    this.reservedSessions.clear();
    this.knownSessionPaths.clear();
    this.queueTails.clear();
  }

  private async waitForActiveTurnQuiescence(worker: SessionWorker): Promise<void> {
    const deadline = Date.now() + this.quiescenceTimeoutMs;
    while (Date.now() <= deadline) {
      if (worker.status === 'terminated' && worker.resourceLifecycle === 'released') return;
      if (worker.status === 'ready' || worker.status === 'idle') {
        const mainPid = worker.resourceIdentity?.mainPid;
        const snapshot = await worker.snapshotResource().catch(() => undefined);
        if (
          mainPid
          && snapshot?.populated
          && snapshot.memberPids.length === 1
          && snapshot.memberPids[0] === mainPid
        ) return;
      }
      await delay(this.quiescencePollMs);
    }
    throw new Error('Pilot worker active turn did not become resource-quiescent');
  }
}

function eventCorrelation(event: NormalizedEvent): { runId: string; executionInstanceId: string; attemptEpoch: number } | undefined {
  if (!event.data || typeof event.data !== 'object') return undefined;
  const candidate = (event.data as { pilotCorrelation?: unknown }).pilotCorrelation;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const correlation = candidate as Record<string, unknown>;
  if (
    typeof correlation.runId !== 'string'
    || typeof correlation.executionInstanceId !== 'string'
    || !Number.isSafeInteger(correlation.attemptEpoch)
  ) return undefined;
  return {
    runId: correlation.runId,
    executionInstanceId: correlation.executionInstanceId,
    attemptEpoch: correlation.attemptEpoch as number,
  };
}

function isSynthetic(event: NormalizedEvent): boolean {
  return !!event.data && typeof event.data === 'object' && (event.data as Record<string, unknown>).synthetic === true;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
