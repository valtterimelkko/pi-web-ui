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
  /** Entry timestamp (epoch ms) from the raw session — gates post-restart work. */
  timestamp?: number;
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
  /** 09 item 7: recorded transcript-event loss — NOT semantic/model turns, NOT unflushed generation. */
  turnsLost: number;
  /** Of which tool results. */
  toolResultsLost: number;
  /** Of which edit-kind events (edit/write tool calls). */
  editsLost: number;
  /** Events that appeared after recovery at/after the divergence point. */
  newAfterRecovery: number;
  /** Seconds from API readiness until the first NEW (timestamp-gated) tool call; null if none. */
  secondsToWorking: number | null;
  /** 13 item 2: seconds from the child's OWN parent prompt to its first assistant/tool event; null if none observed. */
  promptToWorkSeconds: number | null;
  /** At least one new tool call/turn with a timestamp after readiness. */
  workedAfterReadiness: boolean;
  /** Goal running but idle with no post-readiness work — a silent stall (09 item 1). */
  silentStall: boolean;
  parentActionNeeded: boolean;
  parentAction: string | null;
  duplicateByStep: DuplicateByStepReport;
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
  silentStalls: number;
  duplicateCommits: number;
  buildRuns: number;
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
 * Parse a child's RAW session JSONL (the on-disk pi session file under the
 * validation dir's pi-sessions/) into comparable records. This is the arm's
 * primary evidence source: the Internal API transcript endpoint is a
 * screen-like 10-item summary (visible_recent, user/assistant kinds only) and
 * cannot show tool calls or their results.
 *
 * Message entries become: 'user' (one), 'assistant' (one per message with
 * text/thinking), 'toolCall' (one per toolCall content item, with toolName and
 * id), 'toolResult' (one per toolResult message, with toolCallId). Session
 * header/model-change/custom entries are not comparable events.
 */
export function parseRawSessionJsonl(lines: string[]): CrashEventRecord[] {
  const out: CrashEventRecord[] = [];
  let assistantTextPending = false;
  let assistantTextPendingTs: number | undefined;
  const flushAssistant = () => {
    if (assistantTextPending) {
      out.push({ index: out.length, kind: 'assistant', label: `assistant#${out.length}`, timestamp: assistantTextPendingTs });
      assistantTextPending = false;
      assistantTextPendingTs = undefined;
    }
  };
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // junk line
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (typeof message !== 'object' || message === null) continue;
    const m = message as Record<string, unknown>;
    const role = typeof m.role === 'string' ? m.role : '';
    const ts = typeof m.timestamp === 'number' ? m.timestamp : undefined;
    if (role === 'toolResult') {
      flushAssistant();
      const callId = typeof m.toolCallId === 'string' ? m.toolCallId : undefined;
      const toolName = typeof m.toolName === 'string' ? m.toolName : undefined;
      out.push({ index: out.length, kind: 'toolResult', toolName, callId, label: `toolResult:${toolName ?? 'unknown'}:${callId ?? 'noid'}`, timestamp: ts });
      continue;
    }
    const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
    if (role === 'user') {
      flushAssistant();
      out.push({ index: out.length, kind: 'user', label: `user#${out.length}`, timestamp: ts });
      continue;
    }
    if (role === 'assistant') {
      for (const item of content) {
        if (typeof item === 'object' && item !== null && item.type === 'toolCall') {
          flushAssistant();
          const callId = typeof item.id === 'string' ? item.id : undefined;
          const toolName = typeof item.name === 'string' ? item.name : undefined;
          out.push({ index: out.length, kind: 'toolCall', toolName, callId, label: `toolCall:${toolName ?? 'unknown'}:${callId ?? 'noid'}`, timestamp: ts });
        } else if (typeof item === 'object' && item !== null && (item.type === 'text' || item.type === 'thinking')) {
          assistantTextPending = true;
          assistantTextPendingTs = ts;
        }
      }
    }
  }
  flushAssistant();
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

/**
 * 13-final-correction item 1: is the child doing its OWN work after a
 * reference point (API readiness for the no-action window; the parent prompt
 * for the post-action window)? Qualifying events are the child's own output:
 * an ASSISTANT message or a TOOL CALL with a timestamp strictly after
 * `refMs`. User, system and tool-result records never count (the follow-up
 * prompt itself lands as a user record), and there is NO polling-time
 * fallback: no qualifying event means not working.
 */
export function firstWorkingAfterReadiness(
  events: CrashEventRecord[],
  refMs: number,
): { working: boolean; firstEventAtMs: number | null } {
  let firstEventAtMs: number | null = null;
  for (const e of events) {
    if (e.timestamp === undefined || e.timestamp <= refMs) continue;
    if (e.kind !== 'assistant' && e.kind !== 'toolCall') continue;
    if (firstEventAtMs === null || e.timestamp < firstEventAtMs) firstEventAtMs = e.timestamp;
  }
  return { working: firstEventAtMs !== null, firstEventAtMs };
}

/**
 * 13-final-correction item 1: classification at the END of the no-action
 * window, snapshotted BEFORE any parent prompt. A goal that still reads
 * `running` while the session is idle and produced no qualifying event in the
 * window is a SILENT STALL — running-but-idle, invisible to monitoring.
 */
export function classifyWindowEnd(goalState: string | undefined, busy: boolean, qualifyingWork: boolean): boolean {
  return goalState === 'running' && !busy && !qualifyingWork;
}

/** One harness-owned observation for the append-only operation ledger (09 item 3). */
export interface OperationLedgerObservation {
  commitsSeen?: string[];
  buildInfoHash?: string;
}

/** Build one ledger line's payload: written by the HARNESS, outside the child's cwd. */
export function buildOperationLedgerEntry(
  childId: string,
  atMs: number,
  observation: OperationLedgerObservation,
): { childId: string; atMs: number; commitsSeen: string[]; buildInfoHash?: string } {
  return {
    childId,
    atMs,
    commitsSeen: observation.commitsSeen ?? [],
    ...(observation.buildInfoHash !== undefined ? { buildInfoHash: observation.buildInfoHash } : {}),
  };
}

export interface DuplicateByStepReport {
  /** Per normalised step id (slugify/initials/maskEmail/build): re-executions beyond the first. */
  byStepId: Record<string, number>;
  totalDuplicateCommits: number;
  /** Distinct build-info hashes observed across the harness ledger. */
  buildRuns: number;
  /** Effect classes this measure cannot see — reported as unmeasured, never as 0. */
  unmeasuredClasses: string[];
}

const STEP_FILE_MAP: Array<{ step: string; files: string[] }> = [
  { step: 'slugify', files: ['test/slug.test.ts', 'src/lib/slug.ts'] },
  { step: 'initials', files: ['test/initials.test.ts', 'src/lib/initials.ts'] },
  { step: 'maskEmail', files: ['test/mask-email.test.ts', 'src/lib/mask-email.ts'] },
];

function stepOfCommit(files: string[]): string | null {
  for (const { step, files: stepFiles } of STEP_FILE_MAP) {
    if (stepFiles.some((f) => files.includes(f))) return step;
  }
  return null;
}

/**
 * 09-correction item 3: duplicates per normalised step id. Commits map to
 * steps by FILES TOUCHED (tree evidence, not subject strings); a step with
 * more than one commit was executed more than once. Build re-runs come from
 * the harness-owned ledger (distinct build-info hashes per child). Classes the
 * measure cannot see (child-writable progress text) are listed as unmeasured.
 */
export function summariseDuplicatesByStepId(
  commits: Array<CommitRecord & { files: string[] }>,
  ledger: Array<ReturnType<typeof buildOperationLedgerEntry>>,
  stepIds: string[],
): DuplicateByStepReport {
  const byStepId: Record<string, number> = {};
  for (const step of stepIds) byStepId[step] = 0;
  let totalDuplicateCommits = 0;
  const commitsPerStep: Record<string, number> = {};
  for (const c of commits) {
    const step = stepOfCommit(c.files ?? []);
    if (step === null || !(step in byStepId)) continue;
    commitsPerStep[step] = (commitsPerStep[step] ?? 0) + 1;
  }
  for (const [step, n] of Object.entries(commitsPerStep)) {
    byStepId[step] = Math.max(0, n - 1);
    totalDuplicateCommits += Math.max(0, n - 1);
  }
  const buildHashes = new Set(ledger.map((l) => l.buildInfoHash).filter((h): h is string => h !== undefined));
  return {
    byStepId,
    totalDuplicateCommits,
    buildRuns: buildHashes.size,
    unmeasuredClasses: ['progress-log-lines', 'uncommitted-file-writes'],
  };
}

/**
 * Client request timeout for `POST /api/v1/drain`: the endpoint BLOCKS until
 * its verdict (settled, or timed_out after `timeoutSeconds` — docs/INTERNAL-API.md,
 * Drain-then-restart), so the client must wait LONGER than the server's drain
 * timeout. (08-parent-note: a 30 s client timeout against a 45 s drain killed
 * the request 15 s before the verdict.)
 */
export function drainRequestTimeoutMs(timeoutSeconds: number): number {
  return (timeoutSeconds + 30) * 1000;
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
  promptToWorkSeconds: number | null;
  workedAfterReadiness: boolean;
  silentStall: boolean;
  parentAction: string | null;
  duplicateByStep: DuplicateByStepReport;
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
    promptToWorkSeconds: input.promptToWorkSeconds,
    workedAfterReadiness: input.workedAfterReadiness,
    silentStall: input.silentStall,
    parentActionNeeded: input.parentAction !== null,
    parentAction: input.parentAction,
    duplicateByStep: input.duplicateByStep,
    orphans: input.orphans,
    finalOutcome: input.finalOutcome,
    receiptState: input.receiptState,
    watch: input.watch,
  };
}

/**
 * Reconciling totals across the per-child rows. Orphan snapshots are taken
 * ANCHOR-WIDE (one snapshot per sample covers every child's placed processes),
 * so per-child rows repeat the same pids — the total is the size of the UNION
 * of distinct orphan pids, never the sum of rows (09 re-run correctness).
 */
export function totalsRows(rows: ChildOutcomeRow[]): TotalsRow {
  const distinctOrphanPids = new Set(rows.flatMap((r) => r.orphans.orphanPids));
  return {
    children: rows.length,
    turnsLost: rows.reduce((a, r) => a + r.turnsLost, 0),
    neededParentAction: rows.filter((r) => r.parentActionNeeded).length,
    workedWithoutParentAction: rows.filter((r) => !r.parentActionNeeded && r.workedAfterReadiness).length,
    silentStalls: rows.filter((r) => r.silentStall).length,
    duplicateCommits: rows.reduce((a, r) => a + r.duplicateByStep.totalDuplicateCommits, 0),
    buildRuns: rows.reduce((a, r) => Math.max(a, r.duplicateByStep.buildRuns), 0),
    orphanProcesses: distinctOrphanPids.size,
    goalAchieved: rows.filter((r) => r.finalOutcome === 'goal_achieved').length,
    stuckOrFailed: rows.filter((r) => r.finalOutcome === 'stuck' || r.finalOutcome === 'failed').length,
  };
}
