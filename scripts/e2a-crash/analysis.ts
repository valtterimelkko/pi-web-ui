/**
 * E2a-6c crash-recovery harness — pure parsing and counting logic.
 *
 * No I/O in this module: every function takes plain data and returns plain
 * data, so the counting rules behind the report's numbers are testable and
 * auditable (COMMON-BRIEF-e2.md: every number needs a source).
 *
 * Semantics are chosen to be honest under uncertainty:
 * - "turns of work lost" uses order-sensitive common-prefix comparison of the
 *   transcript snapshots taken before the crash and after recovery; events
 *   after the divergence point in the BEFORE snapshot are "lost" (they were
 *   recorded, then vanished or were rewritten), and events after the
 *   divergence point in the AFTER snapshot are "new" (recovery re-did them).
 *   A re-done event therefore counts as BOTH lost and new — which is exactly
 *   what "work done twice" means.
 */

export interface CrashEventRecord {
  /** Zero-based position in its snapshot. */
  index: number;
  /** Coarse event kind used for per-kind loss counts. */
  kind: string;
  /** Tool name when the event belongs to a tool call/result. */
  toolName?: string;
  /** Tool-call correlation id when present (toolCall ↔ toolResult matching). */
  callId?: string;
  /** Stable-ish identity string for examples (kind + id/toolName). */
  label: string;
}

export interface TranscriptDiff {
  lostCount: number;
  lostKinds: Record<string, number>;
  retainedCount: number;
  newCount: number;
  newKinds: Record<string, number>;
  lostExamples: string[];
  /** The lost tool-call records themselves (capped at 50) — lets callers count per-tool losses. */
  lostToolCalls: CrashEventRecord[];
}

export interface CommitRecord {
  hash: string;
  subject: string;
}

export interface DuplicateInputs {
  progressLines: string[];
  commits: CommitRecord[];
  buildRuns: Array<{ label: string }>;
}

export interface DuplicateReport {
  duplicateProgressLines: number;
  duplicateProgressExamples: string[];
  duplicateCommitSubjects: number;
  duplicateCommitExamples: string[];
  buildRunCount: number;
  totalDuplicateEvents: number;
}

export interface WatchLedgerSummary {
  firingCount: number;
  sawGoalEnd: boolean;
  sawAgentEnd: boolean;
  sawInterruptedByRestart: boolean;
  firingKinds: string[];
}

export interface ProcessRecord {
  pid: number;
  cmd: string;
  owner?: string;
}

export interface OrphanReport {
  orphansAtKill: number;
  orphanPids: number[];
  gonePids: number[];
}

export type ArmName = 'smoke' | 'kill' | 'drain-timeout';

export interface ChildOutcomeRow {
  childId: string;
  arm: ArmName;
  /** Events recorded pre-crash that vanished or were rewritten (see module doc). */
  turnsLost: number;
  /** Of which tool results. */
  toolResultsLost: number;
  /** Of which edit-kind events (edit/write tool calls). */
  editsLost: number;
  /** Events that appeared after recovery at/after the divergence point. */
  newAfterRecovery: number;
  /** Seconds from the crash/restart until the child's first NEW tool call; null if it never worked again. */
  secondsToWorking: number | null;
  parentActionNeeded: boolean;
  parentAction: string | null;
  duplicateSideEffects: DuplicateReport;
  orphans: OrphanReport;
  finalOutcome: string;
  receiptState: string;
  watch: WatchLedgerSummary;
}

export interface TotalsRow {
  children: number;
  turnsLost: number;
  neededParentAction: number;
  workedWithoutParentAction: number;
  duplicateSideEffectEvents: number;
  orphanProcesses: number;
  goalAchieved: number;
  stuckOrFailed: number;
}

const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'read', 'multiedit', 'writefile']);

function eventKindOf(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) return 'unknown';
  const rec = raw as Record<string, unknown>;
  const type = typeof rec.type === 'string' ? rec.type : undefined;
  if (type) return type;
  // Internal API normalised events sometimes nest under `event.type`.
  const event = rec.event;
  if (typeof event === 'object' && event !== null) {
    const inner = (event as Record<string, unknown>).type;
    if (typeof inner === 'string') return inner;
  }
  return 'unknown';
}

/** Parse an Internal-API transcript payload (or any {events:[...]}-shaped object) into comparable records. */
export function parseTranscriptEvents(payload: unknown): CrashEventRecord[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const events = (payload as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const out: CrashEventRecord[] = [];
  events.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) return;
    const rec = raw as Record<string, unknown>;
    const kind = eventKindOf(raw);
    const message = rec.message;
    const role =
      typeof message === 'object' && message !== null && typeof (message as Record<string, unknown>).role === 'string'
        ? ((message as Record<string, unknown>).role as string)
        : undefined;
    const toolName =
      typeof rec.toolName === 'string'
        ? rec.toolName
        : typeof rec.tool === 'string'
          ? rec.tool
          : undefined;
    const callId =
      typeof rec.id === 'string' || typeof rec.id === 'number'
        ? String(rec.id)
        : typeof rec.callId === 'string'
          ? rec.callId
          : undefined;
    const label = [kind, role, toolName, callId].filter(Boolean).join(':');
    out.push({ index, kind, toolName, callId, label });
  });
  return out;
}

/**
 * True when the LAST comparable event is a tool call whose result has not
 * been recorded yet — i.e. a tool command is plausibly in flight right now.
 */
export function detectInFlightToolCall(events: CrashEventRecord[]): boolean {
  if (events.length === 0) return false;
  const last = events[events.length - 1];
  if (last.kind !== 'toolCall' && last.kind !== 'tool_call' && last.kind !== 'toolcall') return false;
  const matched = events.some(
    (e) =>
      (e.kind === 'toolResult' || e.kind === 'tool_result' || e.kind === 'toolresult') &&
      e.callId !== undefined &&
      e.callId === last.callId,
  );
  return !matched;
}

/** Common-prefix diff between the pre-crash and post-recovery transcript snapshots. */
export function diffTranscriptSnapshots(before: CrashEventRecord[], after: CrashEventRecord[]): TranscriptDiff {
  let p = 0;
  const limit = Math.min(before.length, after.length);
  while (p < limit && before[p].label === after[p].label) p += 1;
  const lost = before.slice(p);
  const fresh = after.slice(p);
  const lostKinds: Record<string, number> = {};
  const newKinds: Record<string, number> = {};
  for (const e of lost) lostKinds[e.kind] = (lostKinds[e.kind] ?? 0) + 1;
  for (const e of fresh) newKinds[e.kind] = (newKinds[e.kind] ?? 0) + 1;
  return {
    lostCount: lost.length,
    lostKinds,
    retainedCount: p,
    newCount: fresh.length,
    newKinds,
    lostExamples: lost.slice(0, 5).map((e) => e.label),
    lostToolCalls: lost.filter((e) => e.kind === 'toolCall').slice(0, 50),
  };
}

function duplicatesOf(values: string[]): { count: number; examples: string[] } {
  const seen = new Map<string, number>();
  for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1);
  const examples: string[] = [];
  let count = 0;
  for (const [value, n] of seen) {
    if (n > 1) {
      count += 1;
      if (examples.length < 5) examples.push(value);
    }
  }
  return { count, examples };
}

/** Count side effects that were done twice (repeated log lines, repeated commit subjects, re-run builds). */
export function summariseDuplicates(inputs: DuplicateInputs): DuplicateReport {
  const progress = duplicatesOf(inputs.progressLines.map((l) => l.trim()).filter((l) => l.length > 0));
  const commits = duplicatesOf(inputs.commits.map((c) => c.subject.trim()).filter((s) => s.length > 0));
  const total = progress.count + commits.count;
  return {
    duplicateProgressLines: progress.count,
    duplicateProgressExamples: progress.examples,
    duplicateCommitSubjects: commits.count,
    duplicateCommitExamples: commits.examples,
    buildRunCount: inputs.buildRuns.length,
    totalDuplicateEvents: total,
  };
}

/**
 * Summarise one watch-ledger record (the parent's pure-observer watch):
 * what fired, and whether the restart interruption was visible in it.
 */
export function summariseWatchLedger(ledger: unknown): WatchLedgerSummary {
  const summary: WatchLedgerSummary = {
    firingCount: 0,
    sawGoalEnd: false,
    sawAgentEnd: false,
    sawInterruptedByRestart: false,
    firingKinds: [],
  };
  if (typeof ledger !== 'object' || ledger === null) return summary;
  const rec = ledger as Record<string, unknown>;
  const firings = Array.isArray(rec.firings) ? rec.firings : [];
  summary.firingCount = firings.length;
  const kinds: string[] = [];
  for (const firing of firings) {
    let kind = 'unknown';
    let interrupted = false;
    if (typeof firing === 'object' && firing !== null) {
      const f = firing as Record<string, unknown>;
      const candidate = f.eventType ?? f.type ?? f.condition;
      if (typeof candidate === 'string') kind = candidate;
      const data = f.data;
      if (typeof data === 'object' && data !== null && (data as Record<string, unknown>).interruptedByRestart === true) {
        interrupted = true;
      }
      if (typeof f.interruptedByRestart === 'boolean' && f.interruptedByRestart) interrupted = true;
    }
    kinds.push(kind);
    if (kind === 'goal_end') summary.sawGoalEnd = true;
    if (kind === 'agent_end') summary.sawAgentEnd = true;
    if (interrupted) summary.sawInterruptedByRestart = true;
  }
  // Belt: the flag can also appear nested anywhere in the firings payload.
  if (!summary.sawInterruptedByRestart && JSON.stringify(firings).includes('interruptedByRestart":true')) {
    summary.sawInterruptedByRestart = true;
  }
  summary.firingKinds = kinds;
  return summary;
}

/**
 * Diff two process snapshots around the kill. `serverPids` are processes
 * legitimately belonging to the server itself (they die with it and are not
 * orphans). Everything else present in both `before` and `after` snapshots
 * that is not a server process outlived the kill — an orphaned tool process.
 */
export function diffProcessSnapshots(
  before: ProcessRecord[],
  after: ProcessRecord[],
  serverPids: Set<number>,
): OrphanReport & { gonePids: number[] } {
  const beforeChildren = new Map(before.filter((r) => !serverPids.has(r.pid)).map((r) => [r.pid, r]));
  const afterPids = new Set(after.map((r) => r.pid));
  const orphans = [...beforeChildren.values()].filter((r) => afterPids.has(r.pid));
  const gonePids = [...beforeChildren.keys()].filter((pid) => !afterPids.has(pid));
  return {
    orphansAtKill: orphans.length,
    orphanPids: orphans.map((r) => r.pid),
    gonePids,
  };
}

/** Build one per-child outcome row from the collected per-child evidence. */
export function buildChildRow(input: {
  childId: string;
  arm: ArmName;
  transcriptDiff: TranscriptDiff;
  secondsToWorking: number | null;
  parentAction: string | null;
  duplicates: DuplicateReport;
  orphans: OrphanReport;
  finalOutcome: string;
  receiptState: string;
  watch: WatchLedgerSummary;
}): ChildOutcomeRow {
  const editsLost = (input.transcriptDiff.lostToolCalls ?? []).filter((e) =>
    e.toolName !== undefined && EDIT_TOOL_NAMES.has(e.toolName.toLowerCase()),
  ).length;
  const toolResultsLost = input.transcriptDiff.lostKinds['toolResult'] ?? input.transcriptDiff.lostKinds['tool_result'] ?? 0;
  return {
    childId: input.childId,
    arm: input.arm,
    turnsLost: input.transcriptDiff.lostCount,
    toolResultsLost,
    editsLost,
    newAfterRecovery: input.transcriptDiff.newCount,
    secondsToWorking: input.secondsToWorking,
    parentActionNeeded: input.parentAction !== null,
    parentAction: input.parentAction,
    duplicateSideEffects: input.duplicates,
    orphans: input.orphans,
    finalOutcome: input.finalOutcome,
    receiptState: input.receiptState,
    watch: input.watch,
  };
}

/** Reconciling totals across the per-child rows (the parts must sum to these). */
export function totalsRows(rows: ChildOutcomeRow[]): TotalsRow {
  return {
    children: rows.length,
    turnsLost: rows.reduce((a, r) => a + r.turnsLost, 0),
    neededParentAction: rows.filter((r) => r.parentActionNeeded).length,
    workedWithoutParentAction: rows.filter((r) => !r.parentActionNeeded && r.secondsToWorking !== null).length,
    duplicateSideEffectEvents: rows.reduce((a, r) => a + r.duplicateSideEffects.totalDuplicateEvents, 0),
    orphanProcesses: rows.reduce((a, r) => a + r.orphans.orphansAtKill, 0),
    goalAchieved: rows.filter((r) => r.finalOutcome === 'goal_achieved').length,
    stuckOrFailed: rows.filter((r) => r.finalOutcome === 'stuck' || r.finalOutcome === 'failed').length,
  };
}
