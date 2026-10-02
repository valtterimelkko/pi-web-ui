import { describe, expect, it } from 'vitest';
import { AdmissionController, type HeapReading } from '../../../src/internal-api/admission-controller.js';
import type { ResolvedHostPressure } from '../../../src/internal-api/host-pressure.js';

/**
 * Correction 02 (J3, parent 0798cc10 / Luna review round 1): the A2 sampler's
 * admission source must be side-effect free. `snapshot()` evaluates pressure —
 * `evaluateHeap()` sets/clears `heapLatched` and the cgroup/PID/host readers
 * run synchronously — so sampling it every A2 reading changed admission's
 * hysteresis and added event-loop I/O. The A2 source is now the read-only
 * `activeCounts()` (parent-approved scope extension, this method only).
 */

function heapController(reading: { usedBytes: number }) {
  const state = { usedBytes: reading.usedBytes };
  const readers = { memory: 0, readPids: 0, host: 0, readMemoryEvents: 0, heap: 0 };
  const controller = new AdmissionController({
    maxActiveTurns: 8,
    interactiveReserve: 1,
    heapPressureFraction: 0.75,
    heapRecoveryFraction: 0.65,
    reservedHeapBytesPerTurn: 1, // projected == reading + 1 (0 is rejected as falsy); fractions still exact enough
    minimumHeadroomBytes: 100,
    reservedBytesPerTurn: 1,
    hostMinimumHeadroomBytes: 100,
    heap: () => {
      readers.heap += 1;
      return { usedBytes: state.usedBytes, limitBytes: 1000 } satisfies HeapReading;
    },
    memory: () => {
      readers.memory += 1;
      return { currentBytes: 100, limitBytes: 10_000 };
    },
    readPids: () => {
      readers.readPids += 1;
      return { current: 10, max: 10_000, source: 'service' as const };
    },
    host: () => {
      readers.host += 1;
      return { memAvailableBytes: 10_000, source: 'host' } satisfies ResolvedHostPressure;
    },
    readMemoryEvents: () => {
      readers.readMemoryEvents += 1;
      return undefined;
    },
  });
  return { controller, state, readers };
}

describe('AdmissionController.activeCounts (correction 02: side-effect-free A2 source)', () => {
  it('a P2 acquire at 70% heap stays admitted with A2 sampling interleaved (Luna reproduction)', async () => {
    const { controller, state } = heapController({ usedBytes: 700 });
    // No sampling: 70% is below the 75% pressure mark — admitted.
    const lease = await controller.acquire('pi', 'P2');
    lease.release();

    // A2 samples (via the read-only source) while the heap spikes to 90%, then
    // settles back to 70%. The spike must NOT latch admission's heap gate.
    state.usedBytes = 900;
    controller.activeCounts();
    controller.activeCounts();
    state.usedBytes = 700;
    const second = await controller.acquire('pi', 'P2');
    second.release();
  });

  it('calling activeCounts() performs zero reader calls and leaves the heap latch untouched', async () => {
    const { controller, state, readers } = heapController({ usedBytes: 700 });
    for (let i = 0; i < 50; i += 1) {
      controller.activeCounts();
    }
    expect(readers).toEqual({ memory: 0, readPids: 0, host: 0, readMemoryEvents: 0, heap: 0 });

    // The behavioural core: even a 90% reading through the read-only source
    // must not latch the gate — the next acquire at 70% is admitted.
    state.usedBytes = 900;
    controller.activeCounts();
    state.usedBytes = 700;
    const lease = await controller.acquire('pi', 'P2');
    lease.release();
  });

  it('returns copies of the in-memory counters (mutating the result cannot move admission)', async () => {
    const { controller } = heapController({ usedBytes: 700 });
    const counts = controller.activeCounts();
    counts.activeTurns = 99;
    counts.classes.P2.active = 99;
    counts.runtimes.pi.activeTurns = 99;
    const fresh = controller.activeCounts();
    expect(fresh.activeTurns).toBe(0);
    expect(fresh.classes.P2.active).toBe(0);
    expect(fresh.runtimes.pi.activeTurns).toBe(0);
  });

  it('reflects live permits per class and per runtime', async () => {
    const { controller } = heapController({ usedBytes: 700 });
    const lease = await controller.acquire('pi', 'P2');
    const counts = controller.activeCounts();
    expect(counts).toMatchObject({
      activeTurns: 1,
      classes: { P2: { active: 1 } },
      runtimes: { pi: { activeTurns: 1 } },
    });
    lease.release();
    expect(controller.activeCounts().activeTurns).toBe(0);
  });

  it('characterisation: snapshot() DOES move the heap latch — why the A2 source must not be snapshot()', async () => {
    const { controller, state } = heapController({ usedBytes: 700 });
    state.usedBytes = 900;
    controller.snapshot(); // what the A2 wiring wrongly did before correction 02
    state.usedBytes = 700;
    await expect(controller.acquire('pi', 'P2')).rejects.toMatchObject({ reason: 'heap_pressure' });
  });
});
