/**
 * Arm-A answer synthesis: did the B2 event-loop-lag gate latch during the
 * parent's fan-out, how long, and did it refuse the parent's own children?
 */
import { summariseA2, type A2WindowSummary } from './a2.ts';
import { computeLatchWindows, isLatchedAt, type LatchConfig } from './latch.ts';
import type { A2Sample, CapacitySample, CreateRecord, LatchWindow } from './types.ts';

export interface ArmAAnswer {
  gateLatched: boolean;
  windows: LatchWindow[];
  refused: CreateRecord[];
  refusedByReason: Record<string, number>;
  latchRefusedOwnChildren: number;
  eventuallySucceeded: number;
  documentedBehaviour: boolean;
  a2: A2WindowSummary;
  notes: string[];
}

const REFUSAL_EXIT = 10;

function refusalReason(c: CreateRecord): string {
  return c.reason ?? c.errorCode ?? `exit-${c.exitCode ?? 'null'}`;
}

export function analyseArmA(input: {
  creates: CreateRecord[];
  a2: A2Sample[];
  capacity: CapacitySample[];
  window: { fromMs: number; toMs: number };
  cfg: LatchConfig;
}): ArmAAnswer {
  const notes: string[] = [];
  const readings = input.a2
    .filter((s) => s.atMs >= input.window.fromMs && s.atMs <= input.window.toMs)
    .map((s) => ({ atMs: s.atMs, p99Ms: s.lagP99Ms }));
  const windows = computeLatchWindows(readings, input.cfg);
  // Every non-ok create is a refusal candidate; classification below decides
  // whether it was the lag gate, another server refuser, or a client-side cap
  // (pi-orch exit 25 = route limit). Unexpected shapes must surface, not vanish.
  const refused = input.creates.filter((c) => !c.ok);

  const refusedByReason: Record<string, number> = {};
  for (const r of refused) {
    const reason = refusalReason(r);
    refusedByReason[reason] = (refusedByReason[reason] ?? 0) + 1;
  }

  const latchRefused = refused.filter((r) => isLatchedAt(windows, r.endedAtMs));
  const outside = refused.length - latchRefused.length;
  if (outside > 0) {
    notes.push(`${outside} refusal(s) fell outside every latch window (a different refuser, or the client-side route/session cap) — not attributed to the lag gate`);
  }

  const eventuallySucceeded = input.creates.filter((c) => c.ok && c.retried === 'derived-yes').length;

  // Documented shape: pressure refusals are 503 ADMISSION_CAPACITY_EXHAUSTED
  // with reason + Retry-After (B2), and pi-orch honours the wait until its
  // bounded budget is spent (exit 10).
  const documentedBehaviour = refused.every((r) => r.exitCode === REFUSAL_EXIT || r.retryAfterSeconds !== undefined);

  const lagCapacitySamples = input.capacity.filter((s) => s.lagPressure === true);
  if (lagCapacitySamples.length > 0) {
    notes.push(`/capacity reported lagPressure=true in ${lagCapacitySamples.length} sample(s)`);
  }

  return {
    gateLatched: windows.length > 0,
    windows,
    refused,
    refusedByReason,
    latchRefusedOwnChildren: latchRefused.length,
    eventuallySucceeded,
    documentedBehaviour,
    a2: summariseA2(input.a2, input.window.fromMs, input.window.toMs),
    notes,
  };
}
