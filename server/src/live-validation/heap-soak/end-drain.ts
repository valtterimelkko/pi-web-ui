/**
 * End-of-run drain and end-snapshot retention verdict (B0.1 correction,
 * 2026-09-28).
 *
 * The B0.1 end snapshot was taken as soon as the window closed, while a wave's
 * stragglers were still mid-lifecycle: the parent's verification of
 * `micro-1790628570363-71157eb2` showed the snapshot file finishing at
 * 21:09:49 while children were still being prompted/deleted until 21:09:58,
 * and five live children at the snapshot's mtime — exactly the report's
 * "AgentSession: 5 instance(s)". That makes the plan's key criterion ("the
 * retainer summary shows no deleted child retained") unanswerable, because the
 * snapshot shows live children, not retention.
 *
 * The fix: drain (wait until nothing is in flight and every created child has
 * a terminal delete), bounded by a timeout; run one final orphan sweep; then
 * take the snapshot; and state the retention verdict next to the recorded live
 * count. This module is the pure part.
 *
 * A "live child" is any session id that is either still tracked by an
 * in-flight `runChild` or created without a terminal `child_deleted`/
 * `orphan_swept` event yet. Everything else the snapshot holds as an
 * `AgentSession` is a *retained deleted child*, except for the one known
 * bounded extension slot accepted at the 2026-09-28 interim review.
 */

export interface DrainInput {
  /** Session ids whose `runChild` call is still executing (DriverState.inFlight). */
  inFlight: ReadonlySet<string>;
  /** Created-without-terminal-delete session ids (computeOpenSessionIds over the events log). */
  openSessionIds: readonly string[];
}

export interface DrainStatus {
  drained: boolean;
  inFlightCount: number;
  openCount: number;
  /** Union of in-flight and open ids, in a stable order (in-flight first). */
  liveChildren: string[];
}

export function evaluateDrain(input: DrainInput): DrainStatus {
  const liveChildren = [...input.inFlight];
  for (const id of input.openSessionIds) {
    if (!liveChildren.includes(id)) liveChildren.push(id);
  }
  return {
    drained: liveChildren.length === 0,
    inFlightCount: input.inFlight.size,
    openCount: input.openSessionIds.length,
    liveChildren,
  };
}

/**
 * How long to wait for the load to drain before the end snapshot: at least one
 * wave (a wave's stragglers resolve within their own deadline) and at least two
 * minutes. Bounded — the drain never blocks the run's finalisation for ever.
 */
export function endDrainTimeoutMs(schedule: { waveMs: number }): number {
  return Math.max(schedule.waveMs, 120_000);
}

/**
 * Known, accepted, bounded retention that is NOT a leaked deleted child. The
 * interim review (2026-09-28) accepted the `subagent` extension's single
 * last-context slot (`backgroundStatusCtx`, one `AgentSession`). Named in the
 * report rather than subtracted silently.
 */
export const KNOWN_BOUNDED_RETAINED_SLOTS: readonly { name: string; instances: number }[] = [
  { name: 'subagent extension `backgroundStatusCtx` (single last-context slot, accepted 2026-09-28)', instances: 1 },
];

export interface RetentionVerdictInput {
  /** `AgentSession` instances in the end snapshot (0 when the snapshot holds none). */
  agentSessionCount: number;
  /** Live children recorded at the moment of the snapshot; undefined for runs that predate this correction. */
  liveChildrenAtSnapshot?: number;
}

export interface RetentionVerdict {
  agentSessionCount: number;
  liveChildrenAtSnapshot?: number;
  knownBoundedSlots: number;
  /** AgentSessions beyond the live children and the known bounded slots; undefined when the live count is unknown. */
  retainedDeletedChildren?: number;
}

export function computeRetainedDeletedChildren(input: RetentionVerdictInput): RetentionVerdict {
  const knownBoundedSlots = KNOWN_BOUNDED_RETAINED_SLOTS.reduce((sum, slot) => sum + slot.instances, 0);
  if (input.liveChildrenAtSnapshot === undefined) {
    return { agentSessionCount: input.agentSessionCount, knownBoundedSlots };
  }
  return {
    agentSessionCount: input.agentSessionCount,
    liveChildrenAtSnapshot: input.liveChildrenAtSnapshot,
    knownBoundedSlots,
    retainedDeletedChildren: Math.max(0, input.agentSessionCount - input.liveChildrenAtSnapshot - knownBoundedSlots),
  };
}

/** The report.md lines stating the end-snapshot retention verdict. */
export function renderRetentionVerdict(input: RetentionVerdictInput): string[] {
  const verdict = computeRetainedDeletedChildren(input);
  const lines = [
    '### End-snapshot retention vs live children',
    '',
    `- AgentSession instances in the end snapshot: ${verdict.agentSessionCount}`,
    ...KNOWN_BOUNDED_RETAINED_SLOTS.map((slot) => `- Known bounded retained slot: ${slot.instances} (${slot.name})`),
  ];
  if (verdict.retainedDeletedChildren === undefined) {
    lines.push('- Live children at the moment of the snapshot: not recorded (run predates the B0.1 drain correction).');
    lines.push('- **Retained deleted children: not computed**');
  } else {
    lines.push(`- Live children at the moment of the snapshot (in-flight + created-without-terminal-delete): ${verdict.liveChildrenAtSnapshot}`);
    lines.push(`- **Retained deleted children: ${verdict.retainedDeletedChildren}**`);
  }
  return lines;
}
