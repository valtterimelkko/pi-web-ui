import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PHASE6_FIXTURE_ID,
  PHASE6_FROZEN_SETTINGS,
  buildPhase6ControllerArgs,
  runPhase6WorkerMode,
  phase6OwnedSliceName,
  assertPhase6AdversarialResult,
  assertPhase6RestartResult,
  assertPhase6ModeComparison,
  snapshotPhase6CurrentCgroup,
  assertPhase6ControlDelta,
} from '../../../src/live-validation/worker-cgroup-conformance.js';

function zeroFinalCardinality() {
  return {
    workers: 0, activeRuns: 0, admissionTurns: 0, creatingWorkers: 0,
    terminatingWorkers: 0, workerTerminationObservers: 0, cleanupTimers: 0, reservedSessions: 0,
    queuedSessions: 0, knownSessionPaths: 0, drainingReceipts: 0, quarantinedReceipts: 0,
  };
}

function validP1ProbeEvidence() {
  return [
    ...Array.from({ length: 5 }, () => ({ kind: 'health' as const, latencyMs: 1, observed: {} })),
    ...Array.from({ length: 4 }, () => ({ kind: 'evidence' as const, latencyMs: 1, observed: [] })),
    { kind: 'cancel' as const, latencyMs: 1, observed: { status: 'cancelled' } },
  ];
}

function validAdversarialResult() {
  const sample = (overrides: Record<string, unknown> = {}) => ({
    receiptStatus: 'completed', admissionAfter: 0,
    samples: [{ snapshot: { memberPids: [1], memoryEvents: { high: 0 }, pidsEvents: { max: 0 } } }],
    ...overrides,
  });
  return {
    repetitions: {
      'bounded-fanout': Array.from({ length: 3 }, () => sample({ samples: [{ snapshot: { memberPids: [1, 2, 3, 4, 5] } }] })),
      'memory-high': Array.from({ length: 3 }, () => sample({ samples: [{ snapshot: { memoryEvents: { high: 1 } } }] })),
      'pid-pressure': Array.from({ length: 3 }, () => sample({ receiptStatus: 'failed', error: '7 EAGAIN spawn failures' })),
      'cancel-drain': Array.from({ length: 3 }, () => sample({ receiptStatus: 'cancelled', durationMs: 500 })),
      'intentional-crash': Array.from({ length: 3 }, () => sample({ receiptStatus: 'failed', error: 'exited code=42' })),
      rehydrate: [sample({ receiptStatus: 'failed', error: 'exited code=42' }), { uniqueWorkers: 1 }, sample()],
      'sibling-after-crash': [sample()],
      'queued-follow-up': [{
        firstStatus: 'cancelled', secondStatus: 'completed', maxAdmissionTurns: 1,
        events: ['first:agent_start', 'second:agent_start', 'second:message_end', 'second:agent_end'],
        receiptOrder: ['cancelled', 'completed'],
      }],
      'ws-parity': Array.from({ length: 3 }, () => ({
        receiptStatus: 'completed', wsEvents: ['agent_start', 'message_end', 'agent_end'],
        notificationAgentEnds: 1, remainingSubscribers: 0,
      })),
      'late-event-fence': [{
        fencedDelta: 1, newReceiptStatus: 'completed', terminalObservationCount: 1,
        projectedEvents: ['agent_start', 'message_end', 'agent_end'], notificationAgentEnds: 1,
        remainingSubscribers: 0,
      }],
    },
    churn: { cycles: 20, finalCardinality: zeroFinalCardinality() },
    p1ProbeLatenciesMs: Array(10).fill(1),
    p1ProbeEvidence: validP1ProbeEvidence(),
  };
}

describe('worker-cgroup-conformance/v1 frozen harness contract', () => {
  it('keeps the owner-approved sampling, receipt, worker, and controller settings exact', () => {
    expect(PHASE6_FIXTURE_ID).toBe('worker-cgroup-conformance/v1');
    expect(PHASE6_FROZEN_SETTINGS).toEqual(expect.objectContaining({
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
      sampleIntervalMs: 100,
      warmupTurns: 2,
      measuredWarmTurns: 30,
      coldSamples: 5,
      adversarialRepeats: 3,
      churnCycles: 20,
    }));
  });

  it('derives only the exact nonce-owned slice name used for cleanup', () => {
    expect(phase6OwnedSliceName('abc123')).toBe('pi-web-ui-phase6-abc123.slice');
    expect(() => phase6OwnedSliceName('../pi-web-ui')).toThrow(/nonce/i);
  });

  it('fails closed when the PID-pressure scenario has neither a cgroup max event nor bounded EAGAIN evidence', () => {
    const result = validAdversarialResult();
    result.repetitions['pid-pressure'] = Array.from({ length: 3 }, () => ({
      receiptStatus: 'failed', admissionAfter: 0, error: 'unknown frozen scenario',
      samples: [{ snapshot: { memberPids: [1], memoryEvents: { high: 0 }, pidsEvents: { max: 0 } } }],
    }));
    expect(() => assertPhase6AdversarialResult(result)).toThrow(/PID-pressure containment signal/i);
  });

  it('fails closed on missing memory pressure, fan-out escape, false cancel success, duplicate rehydrate, or P1 SLO breach', () => {
    const cases: Array<[string, (result: ReturnType<typeof validAdversarialResult>) => void]> = [
      ['memory', (result) => { result.repetitions['memory-high'][0].samples = [{ snapshot: { memoryEvents: { high: 0 } } }]; }],
      ['fan-out', (result) => { result.repetitions['bounded-fanout'][0].samples = [{ snapshot: { memberPids: [1, 2, 3, 4, 5, 6] } }]; }],
      ['cancel', (result) => { result.repetitions['cancel-drain'][0].receiptStatus = 'completed'; }],
      ['rehydrate', (result) => { result.repetitions.rehydrate[1].uniqueWorkers = 2; }],
      ['P1', (result) => { result.p1ProbeLatenciesMs[9] = 2_001; }],
      ['WebSocket', (result) => { result.repetitions['ws-parity'][0].notificationAgentEnds = 2; }],
      ['late-event', (result) => { result.repetitions['late-event-fence'][0].fencedDelta = 0; }],
    ];
    for (const [label, mutate] of cases) {
      const result = validAdversarialResult();
      mutate(result);
      expect(() => assertPhase6AdversarialResult(result)).toThrow(new RegExp(label, 'i'));
    }
    expect(() => assertPhase6AdversarialResult(validAdversarialResult())).not.toThrow();
  });

  it('fails closed when contained useful throughput regresses over 10% or event parity diverges', () => {
    const mode = (name: 'plain' | 'contained', duration: number) => ({
      mode: name,
      warmupTurns: 2,
      measuredWarmTurns: Array(30).fill(duration),
      coldSamples: Array(5).fill(duration),
      timingBreakdown: { measuredWarm: [], cold: [] },
      resourceEvidence: Array.from({ length: 37 }, () => name === 'plain'
        ? { identity: { kind: 'plain', mainPid: 1, launcherPid: 1 }, snapshot: { memberPids: [1] } }
        : {
            identity: {
              kind: 'systemd-transient', mainPid: 2, launcherPid: 1,
              sliceName: 'pi-web-ui-phase6-abc123.slice', unitName: 'pi-web-ui-phase6-abc123-worker-deadbeef.service',
              cgroupPath: '/x/pi-web-ui-phase6-abc123.slice/pi-web-ui-phase6-abc123-worker-deadbeef.service',
              observedProperties: {
                MemoryHigh: '134217728', MemoryMax: '402653184', MemorySwapMax: '0',
                TasksMax: '64', CPUWeight: '100', KillMode: 'control-group',
                TimeoutStopUSec: '10s', CPUQuotaPerSecUSec: 'infinity',
              },
            },
            snapshot: { memberPids: [2] },
          }),
      p1ProbeLatenciesMs: Array(10).fill(1),
      p1ProbeEvidence: validP1ProbeEvidence(),
      completedReceipts: 37,
      eventCounts: { agent_end: 37, message_end: 37 },
      finalCardinality: zeroFinalCardinality(),
    });
    expect(() => assertPhase6ModeComparison(mode('plain', 100), mode('contained', 105))).not.toThrow();
    expect(() => assertPhase6ModeComparison(mode('plain', 100), mode('contained', 112))).toThrow(/throughput/i);
    const divergent = mode('contained', 105);
    divergent.eventCounts.agent_end = 36;
    expect(() => assertPhase6ModeComparison(mode('plain', 100), divergent)).toThrow(/event parity/i);
    const slowControl = mode('contained', 105);
    slowControl.p1ProbeLatenciesMs[9] = 30;
    expect(() => assertPhase6ModeComparison(mode('plain', 100), slowControl)).toThrow(/P1 latency/i);
    const uncontained = mode('contained', 105);
    (uncontained.resourceEvidence[0].identity as { kind: string }).kind = 'plain';
    expect(() => assertPhase6ModeComparison(mode('plain', 100), uncontained)).toThrow(/resource identity/i);
  });

  it('requires restart recovery to persist SERVER_RESTART and empty the exact old worker boundary', () => {
    expect(() => assertPhase6RestartResult({
      receiptStatus: 'completed', errorCode: undefined, workerStopped: true, cgroupEmpty: true, unitCollected: true,
    })).toThrow(/SERVER_RESTART/i);
    expect(() => assertPhase6RestartResult({
      receiptStatus: 'interrupted', errorCode: 'SERVER_RESTART', workerStopped: false, cgroupEmpty: false, unitCollected: false,
    })).toThrow(/worker boundary/i);
    expect(() => assertPhase6RestartResult({
      receiptStatus: 'interrupted', errorCode: 'SERVER_RESTART', workerStopped: true, cgroupEmpty: true, unitCollected: false,
    })).toThrow(/collected/i);
    expect(() => assertPhase6RestartResult({
      receiptStatus: 'interrupted', errorCode: 'SERVER_RESTART', workerStopped: true, cgroupEmpty: true, unitCollected: true,
    })).not.toThrow();
  });

  it('samples the controller cgroup separately and fails on any pressure-event delta', async () => {
    const readFile = async (file: string) => {
      if (file === '/proc/self/cgroup') return '0::/phase6-controller.service\n';
      if (file.endsWith('/memory.current')) return '1234\n';
      if (file.endsWith('/pids.current')) return '7\n';
      if (file.endsWith('/memory.events')) return 'low 0\nhigh 1\nmax 0\noom 0\noom_kill 0\n';
      if (file.endsWith('/pids.events')) return 'max 0\n';
      throw new Error(`unexpected read ${file}`);
    };
    const before = await snapshotPhase6CurrentCgroup(readFile);
    expect(before).toMatchObject({ cgroupPath: '/phase6-controller.service', memoryCurrentBytes: 1234, pidsCurrent: 7 });
    expect(() => assertPhase6ControlDelta(before, { ...before, memoryEvents: { ...before.memoryEvents, high: 2 } })).toThrow(/control.*high/i);
    expect(() => assertPhase6ControlDelta(before, { ...before, pidsEvents: { max: 1 } })).toThrow(/control.*pids/i);
    expect(() => assertPhase6ControlDelta(before, before)).not.toThrow();
  });

  it('builds a nonce-scoped controller service with the frozen independent control budget', () => {
    const args = buildPhase6ControllerArgs({
      nonce: 'abc123',
      nodePath: '/usr/bin/node',
      tsxCliPath: '/repo/node_modules/tsx/dist/cli.mjs',
      scriptPath: '/repo/scripts/validate-worker-cgroup-conformance.ts',
      runDir: '/tmp/phase6-run',
      repoRoot: '/repo',
    });

    expect(args).toEqual(expect.arrayContaining([
      '--unit=pi-web-ui-phase6-abc123-controller.service',
      '--working-directory=/repo',
      '--slice=pi-web-ui-phase6-abc123.slice',
      '--property=MemoryHigh=768M',
      '--property=MemoryMax=1G',
      '--property=MemorySwapMax=0',
      '--property=TasksMax=256',
      '--property=KillMode=control-group',
      '--pipe', '--wait', '--collect',
      '--', '/usr/bin/node', '/repo/node_modules/tsx/dist/cli.mjs',
      '/repo/scripts/validate-worker-cgroup-conformance.ts', '--controller',
      '--nonce', 'abc123', '--dir', '/tmp/phase6-run',
    ]));
  });

  it('runs the exact plain-spawn baseline samples through real worker RPC, receipts, and admission', async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase6-harness-unit-'));
    try {
      const result = await runPhase6WorkerMode({
        mode: 'plain',
        nonce: 'unit123',
        runDir,
        fixtureExecutable: fileURLToPath(new URL('../../../../scripts/fixtures/phase6-worker-fixture.mjs', import.meta.url)),
      });

      expect(result.mode).toBe('plain');
      expect(result.warmupTurns).toBe(2);
      expect(result.measuredWarmTurns).toHaveLength(30);
      expect(result.coldSamples).toHaveLength(5);
      expect(result.completedReceipts).toBe(37);
      expect(result.p1ProbeLatenciesMs).toHaveLength(10);
      expect(result.p1ProbeEvidence.map((probe) => probe.kind)).toEqual(expect.arrayContaining(['health', 'evidence', 'cancel']));
      expect(result.timingBreakdown.measuredWarm).toHaveLength(30);
      expect(result.timingBreakdown.measuredWarm[0]).toEqual(expect.objectContaining({
        dispatchToAdmissionMs: expect.any(Number),
        admissionToFirstEventMs: expect.any(Number),
        terminalEvidenceToQuiescenceMs: expect.any(Number),
      }));
      expect(result.eventCounts.agent_end).toBe(37);
      expect(result.finalCardinality).toEqual(zeroFinalCardinality());
    } finally {
      await fs.rm(runDir, { recursive: true, force: true });
    }
  }, 20_000);
});
