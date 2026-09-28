/**
 * End-of-run drain and end-snapshot retention verdict.
 *
 * Introduced by the B0.1 correction 02 (2026-09-28) because the end snapshot
 * was taken while a wave's stragglers were still live, and hardened by the
 * independent-review correction 03:
 *
 *  - **Pending creates** (03 item 1): `createSession()` is awaited before a
 *    session id exists, so a session creation dispatched just before the window
 *    closed was invisible to the drain. `evaluateDrain` now treats an unresolved
 *    creation as not-drained.
 *  - **Transient DELETE failures** (03 item 2): only a confirmed not-found
 *    terminalises a child (see `classifyDeleteError` in `orphans.ts`); anything
 *    else keeps it open, so the drain counts it as live.
 *  - **The known slot must be proven** (03 item 3): the bounded
 *    `backgroundStatusCtx` slot is excluded only when the snapshot's retainer
 *    analysis actually shows an `AgentSession` retained through that chain
 *    (`countKnownSlotRetentions`); otherwise the instance is unclassified
 *    retained.
 *  - **The verdict is only for the real end snapshot** (03 item 4): when the
 *    analysed snapshot is a fallback (the end snapshot failed/corrupt), no
 *    verdict is given.
 *  - **An incomplete drain yields no verdict** (03 items 1/2): if the drain hit
 *    its bound or creates were still pending, the counts are reported but the
 *    "retained deleted children" number is withheld rather than guessed.
 */

export interface DrainInput {
  /** Session ids whose `runChild` call is still executing (DriverState.inFlight). */
  inFlight: ReadonlySet<string>;
  /** Created-without-terminal-delete session ids (computeOpenSessionIds over the events log). */
  openSessionIds: readonly string[];
  /** Session-creation requests dispatched but not yet resolved (their session ids are unknown). */
  pendingCreateCount?: number;
}

export interface DrainStatus {
  drained: boolean;
  inFlightCount: number;
  openCount: number;
  /** Unresolved session creations at the observation. */
  pendingCreateCount: number;
  /** Union of in-flight and open ids, in a stable order (in-flight first). Session ids are unknown while a create is pending. */
  liveChildren: string[];
}

export function evaluateDrain(input: DrainInput): DrainStatus {
  const liveChildren = [...input.inFlight];
  for (const id of input.openSessionIds) {
    if (!liveChildren.includes(id)) liveChildren.push(id);
  }
  const pendingCreateCount = Math.max(0, input.pendingCreateCount ?? 0);
  return {
    drained: liveChildren.length === 0 && pendingCreateCount === 0,
    inFlightCount: input.inFlight.size,
    openCount: input.openSessionIds.length,
    pendingCreateCount,
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
 * Known, accepted, bounded retention that is NOT a leaked deleted child: the
 * `subagent` extension's single last-context slot (`backgroundStatusCtx`, one
 * `AgentSession`), accepted at the 2026-09-28 interim review. `chainMarker` is
 * the retainer-chain substring that proves the instance is held by this slot.
 */
export interface KnownBoundedSlot {
  name: string;
  chainMarker: string;
  instances: number;
}

export const KNOWN_BOUNDED_RETAINED_SLOTS: readonly KnownBoundedSlot[] = [
  { name: 'subagent extension `backgroundStatusCtx` (single last-context slot, accepted 2026-09-28)', chainMarker: 'backgroundStatusCtx', instances: 1 },
];

/**
 * How many instances the retainer analysis actually shows held by a known
 * bounded slot. Never excludes more than the slot declares. Nothing is
 * excluded when the chain is absent (correction 03 item 3).
 */
export function countKnownSlotRetentions(chains: readonly { instances: number; chain: string }[]): number {
  const declared = KNOWN_BOUNDED_RETAINED_SLOTS.reduce((sum, slot) => sum + slot.instances, 0);
  const matched = chains
    .filter((group) => KNOWN_BOUNDED_RETAINED_SLOTS.some((slot) => group.chain.includes(slot.chainMarker)))
    .reduce((sum, group) => sum + group.instances, 0);
  return Math.min(declared, matched);
}

export interface RetentionVerdictInput {
  /** `AgentSession` instances in the analysed snapshot. */
  agentSessionCount: number;
  /** Whether the analysed snapshot is exactly the recorded end snapshot (correction 03 item 4). */
  analysisIsEndSnapshot: boolean;
  analysedSnapshotName?: string;
  expectedEndSnapshotName?: string;
  /** Live children recorded at the moment of the snapshot; undefined for runs that predate the drain correction. */
  liveChildrenAtSnapshot?: number;
  /** Unresolved session creations at the moment of the snapshot. */
  pendingCreatesAtSnapshot?: number;
  /**
   * Correction 04: live sessions still registered on the server under this
   * run's children cwd that the harness has no record of (an untracked orphan
   * from a lost supervisor). They are LIVE, not retained-deleted.
   */
  untrackedServerSessions?: number;
  /** Correction 04: raw count of the server's sessions registered under this run's children cwd at the snapshot. */
  serverChildrenSessionCount?: number;
  /**
   * Correction 05: whether the server session list was available at the
   * snapshot. `false` means the server-side counts are UNKNOWN, and no verdict
   * may be given (a transient list failure must never read as zero).
   */
  serverSessionsListOk?: boolean;
  serverSessionsListError?: string;
  /** Whether the pre-snapshot drain completed. */
  drainDrained?: boolean;
  /** Instances verified as held by a known bounded slot in THIS snapshot. */
  verifiedKnownSlotInstances: number;
}

export interface RetentionVerdict {
  agentSessionCount: number;
  liveChildrenAtSnapshot?: number;
  pendingCreatesAtSnapshot: number;
  untrackedServerSessions: number;
  serverChildrenSessionCount?: number;
  /** Harness-known live plus untracked server-side sessions. */
  liveOnServerAtSnapshot?: number;
  verifiedKnownSlotInstances: number;
  /** AgentSessions beyond the live-on-server sessions and the verified bounded slots; undefined when no verdict can be given. */
  retainedDeletedChildren?: number;
  /** Why no verdict can be given, when `retainedDeletedChildren` is undefined. */
  notComputedReason?: string;
}

export function computeRetainedDeletedChildren(input: RetentionVerdictInput): RetentionVerdict {
  const pendingCreatesAtSnapshot = Math.max(0, input.pendingCreatesAtSnapshot ?? 0);
  const untrackedServerSessions = Math.max(0, input.untrackedServerSessions ?? 0);
  const verifiedKnownSlotInstances = Math.max(0, input.verifiedKnownSlotInstances);
  const base = {
    agentSessionCount: input.agentSessionCount,
    ...(input.liveChildrenAtSnapshot !== undefined ? { liveChildrenAtSnapshot: input.liveChildrenAtSnapshot } : {}),
    pendingCreatesAtSnapshot,
    untrackedServerSessions,
    ...(input.serverChildrenSessionCount !== undefined ? { serverChildrenSessionCount: input.serverChildrenSessionCount } : {}),
    ...(input.liveChildrenAtSnapshot !== undefined
      ? { liveOnServerAtSnapshot: input.liveChildrenAtSnapshot + untrackedServerSessions }
      : {}),
    verifiedKnownSlotInstances,
  };

  if (!input.analysisIsEndSnapshot) {
    return { ...base, notComputedReason: 'the analysed snapshot is not the recorded end snapshot (it failed or was unparseable), so the end-snapshot retention question cannot be answered' };
  }
  if (input.liveChildrenAtSnapshot === undefined) {
    return { ...base, notComputedReason: 'the live-child count at the snapshot was not recorded (run predates the drain correction)' };
  }
  if (input.serverSessionsListOk === false) {
    return { ...base, notComputedReason: `the server session list was unavailable at the snapshot${input.serverSessionsListError ? ` (${input.serverSessionsListError})` : ''}, so the server-side counts are unknown and retained deleted children cannot be computed` };
  }
  if (input.drainDrained === false || pendingCreatesAtSnapshot > 0) {
    return { ...base, notComputedReason: `the pre-snapshot drain was incomplete (${input.liveChildrenAtSnapshot} live children, ${pendingCreatesAtSnapshot} pending creates) — retained deleted children cannot be separated from still-live ones` };
  }
  return { ...base, retainedDeletedChildren: Math.max(0, input.agentSessionCount - (input.liveChildrenAtSnapshot + untrackedServerSessions) - verifiedKnownSlotInstances) };
}

/** The report.md lines stating the end-snapshot retention verdict. */
export function renderRetentionVerdict(input: RetentionVerdictInput): string[] {
  const verdict = computeRetainedDeletedChildren(input);
  const lines = ['### End-snapshot retention vs live children', ''];

  if (!input.analysisIsEndSnapshot) {
    lines.push(`The analysed snapshot (\`${input.analysedSnapshotName ?? 'unknown'}\`) is not the recorded end snapshot (\`${input.expectedEndSnapshotName ?? 'not recorded'}\`) — the end snapshot is unavailable or unparseable, so **no retention verdict is given**.`);
    return lines;
  }

  lines.push(`- AgentSession instances in the end snapshot: ${verdict.agentSessionCount}`);
  for (const slot of KNOWN_BOUNDED_RETAINED_SLOTS) {
    lines.push(`- Known bounded retained slot: ${slot.instances} declared (${slot.name}); verified in this snapshot: ${verdict.verifiedKnownSlotInstances}`);
  }
  lines.push(`- Live children at the moment of the snapshot (in-flight + created-without-terminal-delete): ${verdict.liveChildrenAtSnapshot}`);
  if (input.serverSessionsListOk === false) {
    lines.push(`- Server-side session counts: UNKNOWN — the server session list was unavailable at the snapshot${input.serverSessionsListError ? ` (${input.serverSessionsListError})` : ''}`);
  } else {
    lines.push(`- Untracked server-side sessions under this run's children cwd: ${verdict.untrackedServerSessions}`);
    if (verdict.serverChildrenSessionCount !== undefined) {
      lines.push(`- Sessions still registered on the server under this run's children cwd: ${verdict.serverChildrenSessionCount}`);
    }
    lines.push(`- Live on the server (harness-known live + untracked): ${verdict.liveOnServerAtSnapshot}`);
  }
  if (verdict.pendingCreatesAtSnapshot > 0) {
    lines.push(`- Pending child creations at the moment of the snapshot (session id not yet known): ${verdict.pendingCreatesAtSnapshot}`);
  }
  if (verdict.retainedDeletedChildren === undefined) {
    lines.push(`- **Retained deleted children: not computed** — ${verdict.notComputedReason}`);
  } else {
    lines.push(`- **Retained deleted children: ${verdict.retainedDeletedChildren}**`);
  }
  return lines;
}
