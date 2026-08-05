import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWorker } from '../../../src/workers/session-worker.js';
import type { RPCEvent } from '../../../src/workers/types.js';
import type { WorkerPool } from '../../../src/workers/worker-pool.js';
import { PilotExecutorAdapter } from '../../../src/workers/pilot-executor-adapter.js';
import { AdmissionController } from '../../../src/internal-api/admission-controller.js';
import { RunReceiptManager } from '../../../src/internal-api/run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from '../../../src/internal-api/run-receipts/run-receipt-store.js';

function safeAdmission(): AdmissionController {
  return new AdmissionController({
    maxActiveTurns: 2,
    interactiveReserve: 1,
    controlReserve: 1,
    minimumHeadroomBytes: 1,
    reservedBytesPerTurn: 1,
    reservedPidsPerTurn: 1,
    hostMinimumHeadroomBytes: 1,
    retryAfterSeconds: 1,
    memory: () => ({ currentBytes: 1, limitBytes: 1_000_000 }),
    readPids: () => ({ current: 1, max: 256, source: 'service_cgroup' }),
    host: () => ({ memAvailableBytes: 1_000_000 }),
    readMemoryEvents: () => ({ high: 0, max: 0, oom: 0, oom_kill: 0 }),
  });
}

function controlledWorker(options: { agentEndOnRelease?: boolean } = {}) {
  const subscribers = new Set<(event: RPCEvent) => void>();
  let status = 'ready';
  let releaseTurn!: () => void;
  let resourceMembers = [2001];
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const worker = {
    sessionPath: '/tmp/phase6-session.jsonl',
    pid: 2001,
    get status() { return status; },
    get lastActivity() { return Date.now(); },
    get spawnedAt() { return Date.now(); },
    resourceIdentity: { kind: 'plain', mainPid: 2001, launcherPid: 2001 },
    subscribe(handler: (event: RPCEvent) => void) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    async sendCommand(command: { type: string; pilotCorrelation?: { runId: string; executionInstanceId: string; attemptEpoch: number } }) {
      if (command.type !== 'prompt') return;
      const correlated = <T extends RPCEvent>(event: T): T => ({ ...event, pilotCorrelation: command.pilotCorrelation });
      status = 'streaming';
      for (const handler of subscribers) handler(correlated({ type: 'streaming_started' }));
      if (!options.agentEndOnRelease) {
        for (const handler of subscribers) handler(correlated({ type: 'message_end', id: 'assistant' }));
        for (const handler of subscribers) handler(correlated({ type: 'agent_end' }));
      }
      await turnGate;
      status = 'ready';
      if (options.agentEndOnRelease) {
        for (const handler of subscribers) handler(correlated({ type: 'message_end', id: 'assistant' }));
        for (const handler of subscribers) handler(correlated({ type: 'agent_end' }));
      }
      for (const handler of subscribers) handler(correlated({ type: 'streaming_ended' }));
    },
    snapshotResource: vi.fn(async () => ({
      observedAt: new Date().toISOString(), populated: resourceMembers.length > 0, memberPids: [...resourceMembers],
    })),
    onTerminated: vi.fn(() => () => {}),
    terminate: vi.fn(async () => { status = 'terminated'; }),
  } as unknown as SessionWorker;
  return { worker, releaseTurn, setResourceMembers: (members: number[]) => { resourceMembers = members; } };
}

describe('PilotExecutorAdapter', () => {
  let dir: string;
  let receipts: RunReceiptManager;
  let adapterRef: PilotExecutorAdapter | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase6-pilot-adapter-'));
    receipts = new RunReceiptManager({
      store: new RunReceiptStore(dir),
      idFactory: (() => {
        let id = 0;
        return () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
      })(),
      turnIdleTimeoutMs: 2_000,
      turnMaxMs: 10_000,
      drainTimeoutMs: 2_000,
      drainPollMs: 50,
      isRuntimeQuiescent: async (sessionId) => adapterRef?.isQuiescent(sessionId) ?? false,
    });
    await receipts.init();
  });

  afterEach(async () => {
    await receipts.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('terminalises a reserved receipt when final admission is refused before worker assignment', async () => {
    const admission = safeAdmission();
    const blocker = await admission.acquire('pi', 'P2');
    const pool = { getOrCreate: vi.fn() } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool, admission, runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1', quiescencePollMs: 5, quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    await expect(adapter.execute({
      sessionId: 'session-1', sessionPath: '/tmp/phase6-session.jsonl', message: 'normal-turn',
    })).rejects.toMatchObject({ reason: 'global_limit' });

    expect(receipts.get('00000000-0000-4000-8000-000000000001')).toMatchObject({
      status: 'cancelled', errorCode: 'ADMISSION_CAPACITY_EXHAUSTED',
    });
    expect(pool.getOrCreate).not.toHaveBeenCalled();
    blocker.release();
    await adapter.dispose();
  });

  it('treats agent_end as evidence and releases admission only after active-turn quiescence', async () => {
    const admission = safeAdmission();
    const controlled = controlledWorker();
    const pool = {
      getOrCreate: vi.fn(async () => controlled.worker),
      terminate: vi.fn(async () => controlled.worker.terminate()),
    } as unknown as WorkerPool;
    const events: string[] = [];
    const milestones: string[] = [];
    const adapter = new PilotExecutorAdapter({
      workerPool: pool,
      admission,
      runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1',
      quiescencePollMs: 5,
      quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    const executing = adapter.execute({
      sessionId: 'session-1',
      sessionPath: '/tmp/phase6-session.jsonl',
      message: 'normal-turn',
      onEvent: (event) => events.push(event.type),
      onMilestone: (milestone) => milestones.push(milestone),
    });
    await vi.waitFor(() => expect(receipts.get('00000000-0000-4000-8000-000000000001')?.agentEndAt).toBeDefined());

    expect(receipts.get('00000000-0000-4000-8000-000000000001')?.status).toBe('started');
    expect(admission.snapshot().activeTurns).toBe(1);
    expect(events).toContain('agent_end');

    controlled.releaseTurn();
    const receipt = await executing;
    expect(receipt.status).toBe('completed');
    expect(receipt.liveness?.cessation).toMatchObject({ state: 'confirmed', basis: 'resource_quiescence' });
    expect(admission.snapshot().activeTurns).toBe(0);
    expect(milestones).toEqual(['admitted', 'assigned', 'first-event', 'terminal-evidence', 'quiescent']);
    await adapter.dispose();
  });

  it('retains admission after active-turn status is ready until the worker cgroup has no descendants', async () => {
    const admission = safeAdmission();
    const controlled = controlledWorker();
    controlled.setResourceMembers([2001, 2002]);
    const pool = {
      getOrCreate: vi.fn(async () => controlled.worker),
      terminate: vi.fn(async () => controlled.worker.terminate()),
    } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool, admission, runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1', quiescencePollMs: 5, quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    let settled = false;
    const executing = adapter.execute({
      sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'normal-turn',
    }).finally(() => { settled = true; });
    await vi.waitFor(() => expect(receipts.get('00000000-0000-4000-8000-000000000001')?.agentEndAt).toBeDefined());
    controlled.releaseTurn();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(admission.snapshot().activeTurns).toBe(1);

    controlled.setResourceMembers([2001]);
    await expect(executing).resolves.toMatchObject({ status: 'completed' });
    expect(admission.snapshot().activeTurns).toBe(0);
    await adapter.dispose();
  });

  it('fences a late old-epoch agent_end from a newer run on the same warm worker', async () => {
    const admission = safeAdmission();
    const currentSubscribers = new Set<(event: RPCEvent) => void>();
    const archivedSubscribers: Array<(event: RPCEvent) => void> = [];
    const releases: Array<() => void> = [];
    const correlations: Array<{ runId: string; executionInstanceId: string; attemptEpoch: number }> = [];
    let status = 'ready';
    const worker = {
      sessionPath: '/tmp/phase6-session.jsonl', pid: 2002,
      resourceIdentity: { kind: 'plain', mainPid: 2002, launcherPid: 2002 },
      get status() { return status; }, get lastActivity() { return Date.now(); }, get spawnedAt() { return Date.now(); },
      subscribe(handler: (event: RPCEvent) => void) {
        currentSubscribers.add(handler);
        archivedSubscribers.push(handler);
        return () => currentSubscribers.delete(handler);
      },
      async sendCommand(command: { type: string; pilotCorrelation?: { runId: string; executionInstanceId: string; attemptEpoch: number } }) {
        if (command.type !== 'prompt' || !command.pilotCorrelation) return;
        correlations.push(command.pilotCorrelation);
        status = 'streaming';
        currentSubscribers.forEach((handler) => handler({ type: 'streaming_started', pilotCorrelation: command.pilotCorrelation }));
        await new Promise<void>((resolve) => releases.push(resolve));
        status = 'ready';
        currentSubscribers.forEach((handler) => handler({ type: 'streaming_ended', pilotCorrelation: command.pilotCorrelation }));
      },
      snapshotResource: vi.fn(async () => ({ observedAt: new Date().toISOString(), populated: true, memberPids: [2002] })),
      onTerminated: vi.fn(() => () => {}), terminate: vi.fn(async () => { status = 'terminated'; }),
    } as unknown as SessionWorker;
    const pool = { getOrCreate: vi.fn(async () => worker), terminate: vi.fn(async () => worker.terminate()) } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool, admission, runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1', quiescencePollMs: 5, quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    const first = adapter.execute({ sessionId: 'session-1', sessionPath: worker.sessionPath, message: 'normal-turn' });
    await vi.waitFor(() => expect(correlations).toHaveLength(1));
    archivedSubscribers[0]({ type: 'message_end', id: 'assistant-1', pilotCorrelation: correlations[0] });
    archivedSubscribers[0]({ type: 'agent_end', pilotCorrelation: correlations[0] });
    releases.shift()?.();
    await expect(first).resolves.toMatchObject({ status: 'completed' });

    const second = adapter.execute({ sessionId: 'session-1', sessionPath: worker.sessionPath, message: 'normal-turn' });
    await vi.waitFor(() => expect(correlations).toHaveLength(2));
    // Even after the current run's own message boundary, an explicitly old
    // epoch terminal remains evidence-only.
    archivedSubscribers[1]({ type: 'message_end', id: 'assistant-2', pilotCorrelation: correlations[1] });
    archivedSubscribers[1]({ type: 'agent_end', pilotCorrelation: correlations[0] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(adapter.fencedLateEventCount).toBe(1);
    expect(receipts.get('00000000-0000-4000-8000-000000000002')).toMatchObject({ status: 'started' });
    expect(receipts.get('00000000-0000-4000-8000-000000000002')?.agentEndAt).toBeUndefined();
    expect(admission.snapshot().activeTurns).toBe(1);

    archivedSubscribers[1]({ type: 'agent_end', pilotCorrelation: correlations[1] });
    releases.shift()?.();
    await expect(second).resolves.toMatchObject({ status: 'completed' });
    await adapter.dispose();
  });

  it('reserves same-session ownership before the first await so direct executes cannot race', async () => {
    const admission = safeAdmission();
    const controlled = controlledWorker();
    const pool = { getOrCreate: vi.fn(async () => controlled.worker), terminate: vi.fn() } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool, admission, runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1', quiescencePollMs: 5, quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    const first = adapter.execute({ sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'first' });
    await expect(adapter.execute({
      sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'racing-second',
    })).rejects.toThrow(/active owner|reserved/i);
    await vi.waitFor(() => expect(receipts.listBySession('session-1')).toHaveLength(1));
    controlled.releaseTurn();
    await first;
    await adapter.dispose();
  });

  it('queues a same-session follow-up behind the active owner without overlapping admission', async () => {
    const admission = safeAdmission();
    const controlled = controlledWorker();
    const pool = {
      getOrCreate: vi.fn(async () => controlled.worker),
      terminate: vi.fn(async () => controlled.worker.terminate()),
    } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool, admission, runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1', quiescencePollMs: 5, quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    const first = adapter.execute({ sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'first' });
    await vi.waitFor(() => expect(controlled.worker.status).toBe('streaming'));
    const followUp = adapter.enqueue({ sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'follow-up' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(receipts.listBySession('session-1')).toHaveLength(1);
    expect(admission.snapshot().activeTurns).toBe(1);

    controlled.releaseTurn();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
    await expect(followUp).resolves.toMatchObject({ status: 'completed' });
    expect(receipts.listBySession('session-1')).toHaveLength(2);
    expect(admission.snapshot().activeTurns).toBe(0);
    await adapter.dispose();
  });

  it('releases a cancelled run drain lease synchronously after worker quiescence before dequeuing a follow-up', async () => {
    const admission = safeAdmission();
    const controlled = controlledWorker({ agentEndOnRelease: true });
    const pool = {
      getOrCreate: vi.fn(async () => controlled.worker),
      terminate: vi.fn(async () => controlled.worker.terminate()),
    } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool, admission, runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1', quiescencePollMs: 5, quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    const first = adapter.execute({ sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'first' });
    await vi.waitFor(() => expect(controlled.worker.status).toBe('streaming'));
    const followUp = adapter.enqueue({ sessionId: 'session-1', sessionPath: controlled.worker.sessionPath, message: 'follow-up' });
    await adapter.cancel('session-1', 'test-cancel');
    controlled.releaseTurn();

    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    await expect(followUp).resolves.toMatchObject({ status: 'completed' });
    expect(receipts.listBySession('session-1').map((receipt) => receipt.status)).toEqual(['cancelled', 'completed']);
    expect(admission.snapshot().activeTurns).toBe(0);
    await adapter.dispose();
  });

  it('terminalises cancellation but holds admission until the worker turn drains', async () => {
    const admission = safeAdmission();
    const controlled = controlledWorker({ agentEndOnRelease: true });
    const pool = {
      getOrCreate: vi.fn(async () => controlled.worker),
      terminate: vi.fn(async () => controlled.worker.terminate()),
    } as unknown as WorkerPool;
    const adapter = new PilotExecutorAdapter({
      workerPool: pool,
      admission,
      runReceipts: receipts,
      executionInstanceId: 'phase6-worker-cgroup-v1',
      quiescencePollMs: 5,
      quiescenceTimeoutMs: 200,
    });
    adapterRef = adapter;

    const executing = adapter.execute({
      sessionId: 'session-1', sessionPath: '/tmp/phase6-session.jsonl', message: 'cancel-drain',
    });
    await vi.waitFor(() => expect(controlled.worker.status).toBe('streaming'));
    expect(adapter.isActive('session-1')).toBe(true);

    await adapter.cancel('session-1', 'phase6-test-cancel');
    expect(receipts.get('00000000-0000-4000-8000-000000000001')?.status).toBe('cancelled');
    expect(admission.snapshot().activeTurns).toBe(1);

    controlled.releaseTurn();
    await expect(executing).resolves.toMatchObject({ status: 'cancelled' });
    await vi.waitFor(() => expect(admission.snapshot().activeTurns).toBe(0));
    await adapter.dispose();
  });
});
