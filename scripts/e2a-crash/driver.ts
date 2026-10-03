/**
 * Arm orchestration for the E2a-6c crash-recovery harness.
 *
 * One export per phase so the CLI can run each as its own foreground command:
 * prepare → start-server → (smoke | kill-arm | drain-arm) → collect/analyse.
 * State lands under <run>/state/, raw samples under <run>/samples/.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveRunPaths, type RunPaths } from './paths.ts';
import { buildFixture, armObjective, smokeObjective } from './fixture.ts';
import { buildCrashAgentDir } from './agent-dir.ts';
import { prepareServerEnv, startServerUnit, killServerUnit, stopServerUnits, assertPlacementRootIsolated, assertPlacementEnabledInJournal, waitForSystemdAutoRestart, waitForServerReadyViaApi, journalRestartEvidence, SMOKE_MODE, ARM_MODE, getUnitStatus, type StartedServer, type ServerMode } from './server.ts';
import {
  spawnGoalChild, registerObserverWatch, getChildStatus, startDrain, getDrainStatus,
  assertServedModel, snapshotChildToolProcesses, getGoalProjection, type OrchTarget, type ProcRecord,
} from './dispatch.ts';
import { unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseRawSessionJsonl, detectInFlightToolCall, diffTranscriptSnapshots, firstWorkingAfterReadiness, classifyWindowEnd,
  summariseDuplicatesByStepId, buildOperationLedgerEntry, summariseWatchLedger, diffProcessSnapshots, buildChildRow, totalsRows,
  type CrashEventRecord, type ChildOutcomeRow,
} from './analysis.ts';
import { copyFileSync } from 'node:fs';

const REPO_ROOT = '/root/.worktrees/orch-scaling/k-pi-web-ui'; // lane-fixed: this harness runs from the wave K execution worktree
const OWNER = 'orch-0798cc10-waveK';
const MODEL_SELECTOR = 'zai/glm-5.3-flash';
const SAMPLE_INTERVAL_MS = 10_000;
const OBSERVE_INTERVAL_MS = 15_000;
const OBSERVE_NO_PARENT_ACTION_MS = 10 * 60_000;
const OBSERVE_WITH_PARENT_ACTION_MS = 20 * 60_000;
const MIN_WORK_BEFORE_INTERRUPT_MS = 4 * 60_000;
const MAX_WORK_WAIT_MS = 20 * 60_000;
const DRAIN_TIMEOUT_SECONDS = 45;

function nowIso(): string {
  return new Date().toISOString();
}

/** Rebuild fresh fixture repos for an arm (a re-used repo would count the previous run's side effects). */
function freshFixtures(paths: RunPaths, names: string[]): Array<{ name: string; repoDir: string; baselineCommit: string }> {
  return names.map((name) => {
    const f = buildFixture(paths.fixturesRoot, name);
    return { name: f.name, repoDir: f.repoDir, baselineCommit: gitHead(f.repoDir) };
  });
}

interface ArmState {
  runId: string;
  arm: 'smoke' | 'kill' | 'drain-timeout';
  startedAt: string;
  children: Array<{ sessionId: string; watchId: string; repoDir: string; label: string; baselineCommit: string }>;
  interruptAt?: string;
  interruptCondition?: string;
  interruptPartial?: string;
  inFlightAtKill?: Record<string, boolean>;
  serverRestart?: { at: string; readyAt: string; durationMs: number; method?: string };
  parentActions?: Array<{ at: string; childId: string; action: string; reason: string }>;
  finishedAt?: string;
}

function statePath(paths: RunPaths, name: string): string {
  return path.join(paths.stateDir, name);
}

function loadJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function saveJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function logLine(paths: RunPaths, arm: string, event: string, detail: Record<string, unknown>): void {
  appendFileSync(statePath(paths, `${arm}-timeline.jsonl`), `${JSON.stringify({ t: nowIso(), event, ...detail })}\n`);
}

interface CommitWithFiles { hash: string; subject: string; files: string[] }

/** Commits since a baseline, each mapped to the files it touched (tree evidence for step ids). */
function collectCommitsWithFiles(repoDir: string, baseline: string): CommitWithFiles[] {
  const out: CommitWithFiles[] = [];
  let current: CommitWithFiles | undefined;
  const log = execFileSync('git', ['-C', repoDir, 'log', '--format=%H|%s', '--name-only', `${baseline}..HEAD`], { encoding: 'utf8' });
  for (const line of log.split('\n')) {
    if (line.includes('|')) {
      const [hash, ...subj] = line.split('|');
      if (current) out.push(current);
      current = { hash, subject: subj.join('|'), files: [] };
    } else if (line.trim().length > 0 && current) {
      current.files.push(line.trim());
    }
  }
  if (current) out.push(current);
  return out;
}

function sha256Short(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** Append one harness-owned operation-ledger observation (child's cwd is never the source of truth). */
function appendOperationLedger(paths: RunPaths, arm: string, childId: string, repoDir: string, baseline: string): void {
  let commitsSeen: string[] = [];
  let buildInfoHash: string | undefined;
  try {
    commitsSeen = execFileSync('git', ['-C', repoDir, 'log', '--format=%H', `${baseline}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch { /* repo absent */ }
  try {
    buildInfoHash = sha256Short(readFileSync(path.join(repoDir, 'dist', 'build-info.json')));
  } catch { /* no build yet */ }
  const entry = buildOperationLedgerEntry(childId, Date.now(), { commitsSeen, buildInfoHash });
  appendFileSync(statePath(paths, `op-ledger-${arm}.jsonl`), `${JSON.stringify(entry)}\n`);
}

/** git HEAD hash of a fixture repo (baseline commit for later commit counting). */
function gitHead(repoDir: string): string {
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// prepare / server lifecycle
// ---------------------------------------------------------------------------

export async function prepare(runId: string, fixtureCount: number, firstFixtureNumber = 1): Promise<void> {
  const paths = resolveRunPaths(runId);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const agentDir = buildCrashAgentDir(paths.agentDir);
  const fixtures = Array.from({ length: fixtureCount }, (_, i) => buildFixture(paths.fixturesRoot, `fixture-${firstFixtureNumber + i}`));
  prepareServerEnv(paths, REPO_ROOT);
  const record = {
    runId,
    preparedAt: nowIso(),
    agentDir: { path: agentDir.agentDir, assertions: agentDir.assertions, extensionFiles: agentDir.extensionFileCount },
    fixtures: fixtures.map((f) => ({ name: f.name, repoDir: f.repoDir, baselineCommit: gitHead(f.repoDir) })),
  };
  saveJson(statePath(paths, 'prepare.json'), record);
  console.log(`prepared run ${runId}: ${fixtures.length} fixtures, agent dir with ${agentDir.extensionFileCount} extension files`);
}

export async function startServerForRun(runId: string, modeName: 'smoke' | 'arm'): Promise<StartedServer> {
  const paths = resolveRunPaths(runId);
  const mode: ServerMode = modeName === 'smoke' ? SMOKE_MODE : ARM_MODE;
  const started = await startServerUnit(REPO_ROOT, paths, mode);
  const target: OrchTarget = { socketPath: started.socketPath, tokenPath: started.tokenPath, parentSession: '' };
  await assertServedModel(started.socketPath, started.tokenPath, 'pi', MODEL_SELECTOR);
  void target;
  const record = { ...started, assertedModel: MODEL_SELECTOR, mode: modeName, startedAt: nowIso() };
  saveJson(statePath(paths, 'server.json'), record);
  console.log(`server up: unit=${started.unit} pid=${started.mainPid} port=${started.httpPort} anchorCg=${started.anchorCgroup} mode=${modeName}`);
  return started;
}

/**
 * 09-correction Phase-1 placement smoke: ZERO model children, STRESS-GATE
 * smoke allowance (server MemoryMax=2G, RuntimeMaxSec=300), no stress lock.
 * Proves the anchor's numeric limits make placement ENABLE — no
 * '[Placement] DISABLED' journal line after boot — and that the resolved
 * placement root is ours, then stops and disposes.
 */
export async function runPlacementSmoke(runId: string): Promise<void> {
  const paths = resolveRunPaths(runId);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  await prepare(runId, 0); // agent dir + env file, ZERO fixture repos
  const started = await startServerUnit(REPO_ROOT, paths, SMOKE_MODE);
  try {
    await new Promise((r) => setTimeout(r, 8_000)); // startup sweep + placement resolution
    const placement = await assertPlacementEnabledInJournal(started.launchedAt);
    const anchorCg = await assertPlacementRootIsolated();
    const record = {
      at: started.launchedAt,
      mode: 'zero-child placement smoke (server MemoryMax=2G, RuntimeMaxSec=300)',
      anchorCgroup: anchorCg,
      placementEnabled: true,
      verifiedLine: placement.verifiedLine,
      placementJournalLines: placement.placementLines,
    };
    saveJson(statePath(paths, 'placement-smoke.json'), record);
    console.log(`PLACEMENT SMOKE OK: ${placement.verifiedLine.slice(0, 140)}`);
  } finally {
    await stopServerForRun(runId);
  }
}

export async function stopServerForRun(runId: string): Promise<void> {
  const paths = resolveRunPaths(runId);
  await stopServerUnits();
  // 09-correction item 5: dispose the disposable secrets and the internal API
  // token whenever the server stops — never leave them on a stopped run.
  for (const secret of [paths.serverEnvFile, path.join(paths.validationDir, 'internal-api-token')]) {
    try { unlinkSync(secret); } catch { /* already absent */ }
  }
  const record = { stoppedAt: nowIso(), secretsDisposed: true };
  saveJson(statePath(paths, 'server-stopped.json'), record);
  console.log('server + anchor stopped; secrets disposed');
}

// ---------------------------------------------------------------------------
// shared arm machinery
// ---------------------------------------------------------------------------

interface ChildSample {
  t: string;
  childId: string;
  busy: boolean;
  inFlight: boolean;
  transcriptEventCount: number;
  goalState?: string;
}

/** Locate a child's raw session JSONL under the validation dir (written on first turn). */
function findSessionFile(paths: RunPaths, sessionId: string): string | undefined {
  const dir = path.join(paths.validationDir, 'pi-sessions');
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir)) {
    if (f.endsWith(`${sessionId}.jsonl`)) return path.join(dir, f);
  }
  return undefined;
}

/** Read + parse a child's raw session JSONL (empty when absent — first turn not yet written). */
function readRawSession(paths: RunPaths, sessionId: string): { events: CrashEventRecord[]; file?: string } {
  const file = findSessionFile(paths, sessionId);
  if (!file) return { events: [] };
  try {
    return { events: parseRawSessionJsonl(readFileSync(file, 'utf8').split('\n')), file };
  } catch {
    return { events: [], file };
  }
}

async function sampleChildren(
  target: OrchTarget,
  paths: RunPaths,
  children: Array<{ sessionId: string }>,
): Promise<{ samples: ChildSample[]; transcripts: Map<string, CrashEventRecord[]> }> {
  const samples: ChildSample[] = [];
  const transcripts = new Map<string, CrashEventRecord[]>();
  for (const child of children) {
    const status = await getChildStatus(target, child.sessionId);
    const { events } = readRawSession(paths, child.sessionId);
    transcripts.set(child.sessionId, events);
    samples.push({
      t: nowIso(),
      childId: child.sessionId,
      busy: status.busy === true,
      inFlight: detectInFlightToolCall(events),
      transcriptEventCount: events.length,
      goalState: status.goalState,
    });
  }
  return { samples, transcripts };
}

async function waitForChildrenReadyToInterrupt(
  target: OrchTarget,
  paths: RunPaths,
  armState: ArmState,
  anchorCg: string,
): Promise<{ transcripts: Map<string, CrashEventRecord[]>; condition: string; inFlightAtKill: Record<string, boolean>; partial?: string }> {
  const startedAt = Date.now();
  let allBusySince: number | null = null;
  const wasBusy = new Set<string>();
  let sawPlacedToolProcess = false;
  let last: { allBusy: boolean; inFlightCount: number } | undefined;
  while (Date.now() - startedAt < MAX_WORK_WAIT_MS) {
    const { samples, transcripts } = await sampleChildren(target, paths, armState.children);
    const allBusy = samples.every((s) => s.busy);
    const inFlightCount = samples.filter((s) => s.inFlight).length;
    last = { allBusy, inFlightCount };
    // 09-correction item 2: at least one child tool process must actually run
    // under OUR anchor during the work phase, else placement is not real.
    if (!sawPlacedToolProcess && snapshotChildToolProcesses(anchorCg).length > 0) {
      sawPlacedToolProcess = true;
      logLine(paths, armState.arm, 'placed-tool-process-observed', { anchorCg });
    }
    // Harness-owned operation ledger (09 item 3): commits + build hash per sample.
    for (const child of armState.children) {
      appendOperationLedger(paths, armState.arm, child.label, child.repoDir, child.baselineCommit);
    }
    logLine(paths, armState.arm, 'sample', { samples });
    for (const s of samples) {
      if (s.busy) wasBusy.add(s.childId);
    }
    allBusySince = allBusy ? (allBusySince ?? Date.now()) : null;
    const elapsed = Date.now() - startedAt;
    const inFlightAtKill = Object.fromEntries(samples.map((s) => [s.childId, s.inFlight]));

    if (!sawPlacedToolProcess && startedAt + MIN_WORK_BEFORE_INTERRUPT_MS < Date.now()) {
      throw new Error(`ABORT: no child tool process observed under the anchor cgroup ${anchorCg} by the earliest interrupt time — placement is not real (09-correction item 2)`);
    }

    // 04-parent-note rule C: a child FINISHED before the kill — do not wait;
    // interrupt now and record the run as partial.
    const finishedEarly = samples.filter((s) => !s.busy && wasBusy.has(s.childId) && (s.goalState === 'achieved' || s.goalState === 'failed' || s.goalState === 'paused'));
    if (finishedEarly.length > 0 && elapsed >= MIN_WORK_BEFORE_INTERRUPT_MS) {
      return {
        transcripts,
        condition: `child finished before kill: ${finishedEarly.map((s) => `${s.childId}=${s.goalState}`).join(', ')} after ${Math.round(elapsed / 1000)}s`,
        inFlightAtKill,
        partial: `${finishedEarly.length} child(ren) reached a terminal goal state before the interruption`,
      };
    }

    // Rule A: the designed condition — everyone mid-turn, ≥2 with a tool command in flight.
    if (elapsed >= MIN_WORK_BEFORE_INTERRUPT_MS && allBusy && inFlightCount >= 2) {
      return {
        transcripts,
        condition: `all busy (${samples.filter((s) => s.busy).length}/${samples.length}), ${inFlightCount} with in-flight tool command, after ${Math.round(elapsed / 1000)}s`,
        inFlightAtKill,
      };
    }

    // Rule B (04-parent-note): all busy for ≥120 s but in-flight never showed —
    // kill anyway and record inFlightAtKill (do not wait out the clock blind).
    if (elapsed >= MIN_WORK_BEFORE_INTERRUPT_MS && allBusySince !== null && Date.now() - allBusySince >= 120_000 && inFlightCount < 2) {
      return {
        transcripts,
        condition: `all busy for ${Math.round((Date.now() - allBusySince) / 1000)}s with no in-flight signal — killing anyway per robustness rule`,
        inFlightAtKill,
        partial: 'in-flight tool detection did not fire before the kill',
      };
    }

    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
  }
  if (!sawPlacedToolProcess) {
    throw new Error(`ABORT: no child tool process was ever observed under the anchor cgroup ${anchorCg} — placement is not real (09-correction item 2)`);
  }
  throw new Error(`Children never reached any interruption condition within ${MAX_WORK_WAIT_MS / 1000}s (last sample: ${JSON.stringify(last)})`);
}

async function restartServer(paths: RunPaths, mode: ServerMode, method?: string): Promise<{ readyAt: string; durationMs: number }> {
  const t0 = Date.now();
  const started = await startServerUnit(REPO_ROOT, paths, mode);
  const durationMs = Date.now() - t0;
  logLine(paths, 'arm', 'server-restarted', { mainPid: started.mainPid, method, durationMs });
  return { readyAt: nowIso(), durationMs };
}

async function collectChildEvidence(
  target: OrchTarget,
  paths: RunPaths,
  armState: ArmState,
  child: { sessionId: string; watchId: string; repoDir: string; label: string; baselineCommit: string },
  preInterruptTranscript: CrashEventRecord[],
): Promise<ChildOutcomeRow> {
  mkdirSync(paths.samplesDir, { recursive: true });
  // Raw session file is the authoritative evidence; archive a verbatim copy.
  const { events: finalEvents, file: rawFile } = readRawSession(paths, child.sessionId);
  if (rawFile) copyFileSync(rawFile, path.join(paths.samplesDir, `${armState.arm}-${child.label}-final-session.jsonl`));
  const diff = diffTranscriptSnapshots(preInterruptTranscript, finalEvents);

  // Watch ledger (the parent's pure-observer watch). The server names ledger
  // files after the SESSION id (the watch id is 'watch-<sessionId>'), so try
  // both spellings.
  const watchesDir = path.join(paths.validationDir, 'watches');
  let ledger: unknown;
  for (const candidate of [child.sessionId, child.watchId, child.watchId.replace(/^watch-/, '')]) {
    const file = path.join(watchesDir, `${candidate}.json`);
    if (existsSync(file)) {
      ledger = loadJson<unknown>(file);
      break;
    }
  }
  const watch = summariseWatchLedger(ledger);

  // Side effects in the fixture repo.
  const gitLog = execFileSync('git', ['-C', child.repoDir, 'log', '--format=%H|%s', `${child.baselineCommit}..HEAD`], { encoding: 'utf8' }).trim();
  const commits = gitLog.length > 0 ? gitLog.split('\n').map((line) => ({ hash: line.split('|')[0], subject: line.split('|').slice(1).join('|') })) : [];
  // 09-correction item 3: duplicates per normalised step id from evidence the
  // harness owns (commits mapped by files touched + the append-only ledger).
  const commitFiles = collectCommitsWithFiles(child.repoDir, child.baselineCommit);
  const ledgerLines = existsSync(statePath(paths, `op-ledger-${armState.arm}.jsonl`))
    ? readFileSync(statePath(paths, `op-ledger-${armState.arm}.jsonl`), 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l))
    : [];
  const duplicates = summariseDuplicatesByStepId(commitFiles, ledgerLines, ['slugify', 'initials', 'maskEmail', 'build']);
  void commits;

  // Orphans: processes under the anchor cgroup at the end vs at the kill.
  // 09-correction item 2: MISSING orphan evidence is an error, never a zero.
  const orphanFile = statePath(paths, `${armState.arm}-orphans.json`);
  if (!existsSync(orphanFile)) {
    throw new Error(`ABORT: orphan evidence missing at ${orphanFile} — refusing to report a silent zero (09-correction item 2)`);
  }
  const orphanSnap = loadJson<{ atKill: ProcRecord[]; afterKill: ProcRecord[] }>(orphanFile);
  if (!orphanSnap) throw new Error(`Orphan evidence at ${orphanFile} is unparsable`);
  const anchorCg = (loadJson<StartedServer>(statePath(paths, 'server.json')) as StartedServer | undefined)?.anchorCgroup ?? '';
  const endSnap = snapshotChildToolProcesses(anchorCg);
  const first = diffProcessSnapshots(orphanSnap.atKill, orphanSnap.afterKill, new Set());
  const orphans = {
    orphansAtKill: first.orphansAtKill,
    orphanPids: first.orphanPids,
    gonePids: first.orphanPids.filter((pid) => !endSnap.some((p) => p.pid === pid)),
  };

  // Final status/receipt state.
  const status = await getChildStatus(target, child.sessionId);
  const finalOutcome = status.goalState ?? 'unknown';
  const workedAfterReadiness = (armState as ArmState & { workedAfterReadiness?: Map<string, boolean> }).workedAfterReadiness?.get(child.sessionId) === true;
  // 13 item 1: silent stall comes from the WINDOW-BOUNDARY snapshot (taken
  // before any parent prompt): goal running + idle + no qualifying work in
  // the window. Not a collection-time guess.
  const boundary = (armState as ArmState & { windowEnd?: Array<{ childId: string; label: string; silentStall: boolean }> }).windowEnd?.find((w) => w.childId === child.sessionId);
  const silentStall = boundary?.silentStall ?? false;
  // 13 item 2: prompt-to-first-child-event delay from the final session file
  // (assistant/toolCall events only, measured from the child's own prompt).
  const promptAtMs = (armState as ArmState & { promptAtMs?: Map<string, number> }).promptAtMs?.get(child.sessionId);
  let promptToWorkSeconds: number | null = null;
  if (promptAtMs !== undefined) {
    const pr = firstWorkingAfterReadiness(finalEvents, promptAtMs);
    if (pr.firstEventAtMs !== null) promptToWorkSeconds = Math.round((pr.firstEventAtMs - promptAtMs) / 100) / 10;
  }

  return buildChildRow({
    childId: child.label,
    arm: armState.arm === 'smoke' ? 'smoke' : armState.arm === 'kill' ? 'kill' : 'drain-timeout',
    transcriptDiff: diff,
    secondsToWorking: (armState as ArmState & { secondsToWorking?: Map<string, number> }).secondsToWorking?.get(child.sessionId) ?? null,
    promptToWorkSeconds,
    workedAfterReadiness,
    silentStall,
    parentAction: (armState.parentActions ?? []).find((a) => a.childId === child.label)?.action ?? null,
    duplicateByStep: duplicates,
    orphans,
    finalOutcome,
    receiptState: status.lastRunState ?? 'none',
    watch,
  });
}

async function finishArm(
  target: OrchTarget,
  paths: RunPaths,
  armState: ArmState,
  preInterruptTranscripts: Map<string, CrashEventRecord[]>,
  rowsOut: ChildOutcomeRow[],
): Promise<void> {
  for (const child of armState.children) {
    const pre = preInterruptTranscripts.get(child.sessionId) ?? [];
    const row = await collectChildEvidence(target, paths, armState, child, pre);
    rowsOut.push(row);
  }
  const totals = totalsRows(rowsOut);
  saveJson(statePath(paths, `${armState.arm}-results.json`), { arm: armState.arm, armState, rows: rowsOut, totals, finishedAt: nowIso() });
  armState.finishedAt = nowIso();
  console.log(`arm ${armState.arm} results: ${JSON.stringify(totals)}`);
}

// ---------------------------------------------------------------------------
// the arms
// ---------------------------------------------------------------------------

export async function runSmoke(runId: string): Promise<void> {
  const paths = resolveRunPaths(runId);
  const server = loadJson<StartedServer>(statePath(paths, 'server.json'));
  if (!server) throw new Error('server.json missing — run start-server first');
  const target: OrchTarget = { socketPath: server.socketPath, tokenPath: server.tokenPath, parentSession: process.env.PI_ORCH_PARENT ?? '' };
  const prepareRec = loadJson<{ fixtures: Array<{ name: string; repoDir: string; baselineCommit: string }> }>(statePath(paths, 'prepare.json'));
  if (!prepareRec || prepareRec.fixtures.length < 2) throw new Error('prepare.json missing or has <2 fixtures — run prepare first');
  const armState: ArmState & { secondsToWorking: Map<string, number> } = {
    runId, arm: 'smoke', startedAt: nowIso(), children: [], secondsToWorking: new Map(),
  };
  const rows: ChildOutcomeRow[] = [];
  try {
    // ≤2 children, tiny objective, no interruption (STRESS-GATE smoke allowance).
    // Fresh fixtures: a re-used repo would count the previous run's side effects.
    const smokeFixtures = freshFixtures(paths, ['fixture-1', 'fixture-2']);
    for (let i = 0; i < smokeFixtures.length; i += 1) {
      const fixture = smokeFixtures[i];
      const label = `smoke-c${i + 1}`;
      const sessionId = await spawnGoalChild(target, {
        repoDir: fixture.repoDir,
        objective: smokeObjective(fixture.repoDir, label),
        label,
        owner: OWNER,
        maxTurns: 8,
        budgetTokens: 2_000_000,
      });
      const watchId = await registerObserverWatch(target, sessionId, `k-K-${label}`);
      armState.children.push({ sessionId, watchId, repoDir: fixture.repoDir, label, baselineCommit: fixture.baselineCommit });
      logLine(paths, 'smoke', 'child-spawned', { label, sessionId, watchId });
    }
    // Wait until both settle (watch-ledger goal_end) or 3 min cap — no interruption in smoke.
    // (Smoke unit runs under RuntimeMaxSec=300 — STRESS-GATE; the whole smoke must fit.)
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      let allSettled = true;
      for (const child of armState.children) {
        const ledger = loadJson<Record<string, unknown>>(path.join(paths.validationDir, 'watches', `${child.watchId}.json`));
        const summary = summariseWatchLedger(ledger);
        if (!summary.sawGoalEnd) allSettled = false;
      }
      if (allSettled) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const preTranscripts = new Map<string, CrashEventRecord[]>();
    for (const child of armState.children) {
      preTranscripts.set(child.sessionId, readRawSession(paths, child.sessionId).events);
    }
    // Smoke has no interruption: write the orphan snapshot honestly (both sides
    // identical) so the collection-time assertion holds without a silent zero.
    const anchorCgSmoke = (await getUnitStatus('k-K-arm-tools-anchor.service')).controlGroup ?? '';
    const smokeSnap = snapshotChildToolProcesses(anchorCgSmoke);
    saveJson(statePath(paths, 'smoke-orphans.json'), { atKill: smokeSnap, afterKill: smokeSnap });
    await finishArm(target, paths, armState, preTranscripts, rows);
  } finally {
    saveJson(statePath(paths, 'smoke-arm-state.json'), { ...armState, secondsToWorking: Object.fromEntries(armState.secondsToWorking) });
  }
}

export async function runKillArm(runId: string, childCount: number): Promise<void> {
  const paths = resolveRunPaths(runId);
  const server = loadJson<StartedServer>(statePath(paths, 'server.json'));
  if (!server) throw new Error('server.json missing — run start-server first');
  const target: OrchTarget = { socketPath: server.socketPath, tokenPath: server.tokenPath, parentSession: process.env.PI_ORCH_PARENT ?? '' };
  await assertPlacementRootIsolated();
  const placement = await assertPlacementEnabledInJournal(server.launchedAt).catch((err) => { throw err; });
  saveJson(statePath(paths, 'kill-placement-evidence.json'), placement);
  const prepareRec = loadJson<{ fixtures: Array<{ name: string; repoDir: string; baselineCommit: string }> }>(statePath(paths, 'prepare.json'));
  if (!prepareRec || prepareRec.fixtures.length < childCount) throw new Error(`need ${childCount} prepared fixtures — run prepare first`);
  const armState: ArmState & { secondsToWorking: Map<string, number>; workedAfterReadiness: Map<string, boolean>; windowEnd: Array<{ childId: string; label: string; goalState: string; busy: boolean; qualifyingWork: boolean; silentStall: boolean }>; promptAtMs: Map<string, number> } = {
    runId, arm: 'kill', startedAt: nowIso(), children: [], secondsToWorking: new Map(), workedAfterReadiness: new Map(), windowEnd: [], promptAtMs: new Map(),
  };
  const rows: ChildOutcomeRow[] = [];
  try {
    const fixtures = freshFixtures(paths, Array.from({ length: childCount }, (_, i) => `fixture-${i + 1}`));
    for (let i = 0; i < childCount; i += 1) {
      const fixture = fixtures[i];
      const label = `kill-c${i + 1}`;
      const sessionId = await spawnGoalChild(target, {
        repoDir: fixture.repoDir, objective: armObjective(fixture.repoDir, label), label, owner: OWNER,
        maxTurns: 25, budgetTokens: 20_000_000,
      });
      const watchId = await registerObserverWatch(target, sessionId, `k-K-${label}`);
      armState.children.push({ sessionId, watchId, repoDir: fixture.repoDir, label, baselineCommit: fixture.baselineCommit });
      logLine(paths, 'kill', 'child-spawned', { label, sessionId, watchId });
    }

    // Work phase: wait until every child is mid-turn with tool commands running.
    const anchorCgPre = (await getUnitStatus('k-K-arm-tools-anchor.service')).controlGroup ?? '';
    const { transcripts, condition, inFlightAtKill, partial } = await waitForChildrenReadyToInterrupt(target, paths, armState, anchorCgPre);
    const anchorCg = (await getUnitStatus('k-K-arm-tools-anchor.service')).controlGroup ?? '';
    const procsAtKill = snapshotChildToolProcesses(anchorCg);
    armState.interruptAt = nowIso();
    armState.interruptCondition = condition;
    armState.interruptPartial = partial;
    armState.inFlightAtKill = inFlightAtKill;
    logLine(paths, 'kill', 'interrupt', { condition, partial, inFlightAtKill, procsAtKill: procsAtKill.length });

    // THE KILL.
    const kill = await killServerUnit();
    const procsAfterKill = snapshotChildToolProcesses(anchorCg);
    saveJson(statePath(paths, 'kill-orphans.json'), { atKill: procsAtKill, afterKill: procsAfterKill });
    logLine(paths, 'kill', 'killed', { method: kill.method, procsSurviving: procsAfterKill.length });

    // 01-answer Q3: mirror production — systemd auto-restarts the killed unit
    // (Restart=always, RestartSec=10s, TimeoutStopSec=30s); the driver must not
    // start it by hand in the kill arm.
    const beforeKill = await getUnitStatus('k-K-arm-server.service');
    const auto = await waitForSystemdAutoRestart(beforeKill.mainPid ?? 0, 120_000);
    const ready = await waitForServerReadyViaApi(server.socketPath, server.tokenPath, 90_000);
    const journal = await journalRestartEvidence(armState.interruptAt);
    const tRestart = Date.parse(ready.readyAt);
    armState.serverRestart = {
      at: armState.interruptAt,
      readyAt: ready.readyAt,
      durationMs: tRestart - Date.parse(armState.interruptAt),
      method: `${kill.method}; systemd auto-restart (Restart=always, RestartSec=10s): unit active again after ${auto.durationMs} ms, new pid ${auto.newMainPid}`,
    };
    saveJson(statePath(paths, 'kill-restart-evidence.json'), { killAt: armState.interruptAt, auto, ready, journal });
    logLine(paths, 'kill', 'server-restarted', { auto, ready, journalLines: journal.length });

    // Observe 10 minutes WITHOUT parent action — gated on API readiness (09
    // item 1); 13 item 1: only the child's OWN work (assistant message or tool
    // call after readiness) counts, the window boundary is snapshotted BEFORE
    // any parent prompt, and the harness operation ledger keeps sampling.
    const observeStart = Date.now();
    const killWindowWork = new Map<string, boolean>();
    while (Date.now() - observeStart < OBSERVE_NO_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, paths, armState.children);
      logLine(paths, 'kill', 'observe-no-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const r = firstWorkingAfterReadiness(now, tRestart);
        if (r.working) {
          const secs = Math.max(0, Math.round(((r.firstEventAtMs ?? tRestart) - tRestart) / 1000));
          armState.secondsToWorking.set(child.sessionId, secs);
          armState.workedAfterReadiness.set(child.sessionId, true);
          killWindowWork.set(child.sessionId, true);
          logLine(paths, 'kill', 'child-working-again', { childId: child.label, seconds: secs, measuredFrom: 'first post-readiness child event' });
        }
      }
      for (const child of armState.children) {
        appendOperationLedger(paths, 'kill', child.label, child.repoDir, child.baselineCommit);
      }
      await new Promise((r) => setTimeout(r, OBSERVE_INTERVAL_MS));
    }
    // 13 item 1: boundary snapshot (goal/busy/qualifying work) BEFORE prompts.
    for (const child of armState.children) {
      const st = await getChildStatus(target, child.sessionId);
      const goalState = st.goalState ?? 'unknown';
      const busy = st.busy === true;
      const qualifyingWork = killWindowWork.get(child.sessionId) === true;
      const silentStall = classifyWindowEnd(goalState, busy, qualifyingWork);
      // Wave K: capture the full projection (pausedReason/interruption evidence).
      const projection = await getGoalProjection(target, child.sessionId).catch(() => ({}));
      armState.windowEnd.push({ childId: child.sessionId, label: child.label, goalState, busy, qualifyingWork, silentStall });
      logLine(paths, 'kill', 'window-end-snapshot', { childId: child.label, goalState, busy, qualifyingWork, silentStall, projection });
    }

    // Parent action for children still not working (the skills' prescribed action).
    armState.parentActions = [];
    for (const child of armState.children) {
      if (armState.secondsToWorking.has(child.sessionId)) continue;
      const status = await getChildStatus(target, child.sessionId);
      let action: string;
      let reason: string;
      if (status.goalState === 'paused' || status.goalState === 'running' || status.goalState === 'wrapping_up') {
        action = 'follow-up-prompt';
        reason = `goal state '${status.goalState}' — a follow-up prompt re-enters the existing goal (skills: prompt, don't re-arm)`;
      } else {
        action = 'goal-rearm';
        reason = `goal state '${status.goalState ?? 'none'}' — the goal is gone from the projection; re-arm with the same objective`;
      }
      const promptAtMs = Date.now();
      armState.promptAtMs.set(child.sessionId, promptAtMs);
      await piOrchPrompt(target, child.sessionId, action, armState);
      armState.parentActions.push({ at: nowIso(), childId: child.label, action, reason });
      logLine(paths, 'kill', 'parent-action', { childId: child.label, action, reason, promptAtMs });
    }

    // Observe up to 20 more minutes with the parent action applied.
    // 13 item 1: post-action work is measured from each child's OWN prompt
    // timestamp — assistant/toolCall events only, no polling-time fallback.
    const observeStart2 = Date.now();
    while (Date.now() - observeStart2 < OBSERVE_WITH_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, paths, armState.children);
      logLine(paths, 'kill', 'observe-parent-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const promptAtMs = armState.promptAtMs.get(child.sessionId);
        if (promptAtMs === undefined) continue;
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const r = firstWorkingAfterReadiness(now, promptAtMs);
        if (r.working && r.firstEventAtMs !== null) {
          const secs = Math.max(0, Math.round((r.firstEventAtMs - promptAtMs) / 1000));
          armState.secondsToWorking.set(child.sessionId, secs);
          armState.workedAfterReadiness.set(child.sessionId, true);
          logLine(paths, 'kill', 'child-working-again', { childId: child.label, seconds: secs, afterParentAction: true, measuredFrom: 'first child event after own prompt' });
        }
      }
      for (const child of armState.children) {
        appendOperationLedger(paths, 'kill', child.label, child.repoDir, child.baselineCommit);
      }
      const allDone = armState.children.every((c) => armState.secondsToWorking.has(c.sessionId));
      if (allDone && Date.now() - observeStart2 > 2 * 60_000) break;
      await new Promise((r) => setTimeout(r, OBSERVE_INTERVAL_MS));
    }

    await finishArm(target, paths, armState, transcripts, rows);
  } finally {
    saveJson(statePath(paths, 'kill-arm-state.json'), { ...armState, secondsToWorking: Object.fromEntries(armState.secondsToWorking) });
  }
}

export async function runDrainArm(runId: string, childCount: number): Promise<void> {
  const paths = resolveRunPaths(runId);
  const server = loadJson<StartedServer>(statePath(paths, 'server.json'));
  if (!server) throw new Error('server.json missing — run start-server first');
  const target: OrchTarget = { socketPath: server.socketPath, tokenPath: server.tokenPath, parentSession: process.env.PI_ORCH_PARENT ?? '' };
  await assertPlacementRootIsolated();
  const placement = await assertPlacementEnabledInJournal(server.launchedAt).catch((err) => { throw err; });
  saveJson(statePath(paths, 'drain-placement-evidence.json'), placement);
  const prepareRec = loadJson<{ fixtures: Array<{ name: string; repoDir: string; baselineCommit: string }> }>(statePath(paths, 'prepare.json'));
  if (!prepareRec || prepareRec.fixtures.length < childCount) throw new Error(`need ${childCount} prepared fixtures — run prepare first`);
  const armState: ArmState & { secondsToWorking: Map<string, number>; workedAfterReadiness: Map<string, boolean>; windowEnd: Array<{ childId: string; label: string; goalState: string; busy: boolean; qualifyingWork: boolean; silentStall: boolean }>; promptAtMs: Map<string, number> } = {
    runId, arm: 'drain-timeout', startedAt: nowIso(), children: [], secondsToWorking: new Map(), workedAfterReadiness: new Map(), windowEnd: [], promptAtMs: new Map(),
  };
  const rows: ChildOutcomeRow[] = [];
  try {
    // The drain arm runs after the kill arm and REBUILDS its fixtures, so it
    // can reuse the same names (fixture-1..N) with clean side-effect state.
    const drainFixtures = freshFixtures(paths, Array.from({ length: childCount }, (_, i) => `fixture-${i + 5}`));
    for (let i = 0; i < childCount; i += 1) {
      const fixture = drainFixtures[i];
      const label = `drain-c${i + 1}`;
      const sessionId = await spawnGoalChild(target, {
        repoDir: fixture.repoDir, objective: armObjective(fixture.repoDir, label), label, owner: OWNER,
        maxTurns: 25, budgetTokens: 20_000_000,
      });
      const watchId = await registerObserverWatch(target, sessionId, `k-K-${label}`);
      armState.children.push({ sessionId, watchId, repoDir: fixture.repoDir, label, baselineCommit: gitHead(fixture.repoDir) });
      logLine(paths, 'drain-timeout', 'child-spawned', { label, sessionId, watchId });
    }

    const anchorCgPre = (await getUnitStatus('k-K-arm-tools-anchor.service')).controlGroup ?? '';
    const { transcripts, condition, inFlightAtKill, partial } = await waitForChildrenReadyToInterrupt(target, paths, armState, anchorCgPre);
    const anchorCg = (await getUnitStatus('k-K-arm-tools-anchor.service')).controlGroup ?? '';
    const procsAtDrain = snapshotChildToolProcesses(anchorCg);
    armState.interruptAt = nowIso();
    armState.interruptCondition = condition;
    armState.interruptPartial = partial;
    armState.inFlightAtKill = inFlightAtKill;
    logLine(paths, 'drain-timeout', 'drain-start', { condition, partial, inFlightAtKill });

    // Drain with a SHORT timeout: it waits for busy turns, times out, and the
    // driver proceeds (the deploy-script choice) — cutting the turns off.
    await startDrain(target.socketPath, target.tokenPath, DRAIN_TIMEOUT_SECONDS, `k-K drain-timeout arm ${runId}`);
    let drainTimedOut = false;
    const drainDeadline = Date.now() + (DRAIN_TIMEOUT_SECONDS + 30) * 1000;
    while (Date.now() < drainDeadline) {
      const status = await getDrainStatus(target.socketPath, target.tokenPath).catch(() => undefined);
      const state = typeof status === 'object' && status !== null ? (status as Record<string, unknown>).state : undefined;
      logLine(paths, 'drain-timeout', 'drain-status', { state: String(state) });
      if (state === 'timed_out') {
        drainTimedOut = true;
        break;
      }
      if (state === 'settled') {
        logLine(paths, 'drain-timeout', 'drain-settled-early', {});
        break;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    logLine(paths, 'drain-timeout', 'drain-phase-done', { drainTimedOut });

    // Proceed: graceful stop (SIGTERM → the server's own teardown), then start.
    await stopServerUnits();
    const procsAfterStop = snapshotChildToolProcesses(anchorCg);
    saveJson(statePath(paths, `${armState.arm}-orphans.json`), { atKill: procsAtDrain, afterKill: procsAfterStop });
    const restart = await restartServer(paths, ARM_MODE, 'drain timed out; graceful stop then start');
    armState.serverRestart = { at: armState.interruptAt, readyAt: restart.readyAt, durationMs: restart.durationMs };

    // Observe 10 minutes WITHOUT parent action — gated on API readiness (09
    // item 1); 13 item 1: child's own work only, boundary snapshot before prompts.
    const tRestart = Date.parse(restart.readyAt);
    const observeStart = Date.now();
    const drainWindowWork = new Map<string, boolean>();
    while (Date.now() - observeStart < OBSERVE_NO_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, paths, armState.children);
      logLine(paths, 'drain-timeout', 'observe-no-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const now = nowTranscripts.get(child.sessionId) ?? [];
        // 13 item 1: only the child's OWN work (assistant/toolCall) after readiness.
        const r = firstWorkingAfterReadiness(now, tRestart);
        if (r.working) {
          const secs = Math.max(0, Math.round(((r.firstEventAtMs ?? tRestart) - tRestart) / 1000));
          armState.secondsToWorking.set(child.sessionId, secs);
          armState.workedAfterReadiness.set(child.sessionId, true);
          drainWindowWork.set(child.sessionId, true);
          logLine(paths, 'drain-timeout', 'child-working-again', { childId: child.label, seconds: secs, measuredFrom: 'first post-readiness child event' });
        }
      }
      for (const child of armState.children) {
        appendOperationLedger(paths, 'drain-timeout', child.label, child.repoDir, child.baselineCommit);
      }
      await new Promise((r) => setTimeout(r, OBSERVE_INTERVAL_MS));
    }
    // 13 item 1: boundary snapshot (goal/busy/qualifying work) BEFORE prompts.
    for (const child of armState.children) {
      const st = await getChildStatus(target, child.sessionId);
      const goalState = st.goalState ?? 'unknown';
      const busy = st.busy === true;
      const qualifyingWork = drainWindowWork.get(child.sessionId) === true;
      const silentStall = classifyWindowEnd(goalState, busy, qualifyingWork);
      // Wave K: capture the full projection (pausedReason/interruption evidence).
      const projection = await getGoalProjection(target, child.sessionId).catch(() => ({}));
      armState.windowEnd.push({ childId: child.sessionId, label: child.label, goalState, busy, qualifyingWork, silentStall });
      logLine(paths, 'drain-timeout', 'window-end-snapshot', { childId: child.label, goalState, busy, qualifyingWork, silentStall, projection });
    }

    // Parent action for stuck children.
    armState.parentActions = [];
    for (const child of armState.children) {
      if (armState.secondsToWorking.has(child.sessionId)) continue;
      const status = await getChildStatus(target, child.sessionId);
      let action: string;
      let reason: string;
      if (status.goalState === 'paused' || status.goalState === 'running' || status.goalState === 'wrapping_up') {
        action = 'follow-up-prompt';
        reason = `goal state '${status.goalState}' — a follow-up prompt re-enters the existing goal`;
      } else {
        action = 'goal-rearm';
        reason = `goal state '${status.goalState ?? 'none'}' — goal gone from the projection; re-arm`;
      }
      const promptAtMs = Date.now();
      armState.promptAtMs.set(child.sessionId, promptAtMs);
      await piOrchPrompt(target, child.sessionId, action, armState);
      armState.parentActions.push({ at: nowIso(), childId: child.label, action, reason });
      logLine(paths, 'drain-timeout', 'parent-action', { childId: child.label, action, reason, promptAtMs });
    }

    // 13 item 1: post-action work is measured from each child's OWN prompt
    // timestamp — assistant/toolCall events only, no polling-time fallback.
    const observeStart2 = Date.now();
    while (Date.now() - observeStart2 < OBSERVE_WITH_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, paths, armState.children);
      logLine(paths, 'drain-timeout', 'observe-parent-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const promptAtMs = armState.promptAtMs.get(child.sessionId);
        if (promptAtMs === undefined) continue;
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const r = firstWorkingAfterReadiness(now, promptAtMs);
        if (r.working && r.firstEventAtMs !== null) {
          const secs = Math.max(0, Math.round((r.firstEventAtMs - promptAtMs) / 1000));
          armState.secondsToWorking.set(child.sessionId, secs);
          armState.workedAfterReadiness.set(child.sessionId, true);
          logLine(paths, 'drain-timeout', 'child-working-again', { childId: child.label, seconds: secs, afterParentAction: true, measuredFrom: 'first child event after own prompt' });
        }
      }
      const allDone = armState.children.every((c) => armState.secondsToWorking.has(c.sessionId));
      if (allDone && Date.now() - observeStart2 > 2 * 60_000) break;
      await new Promise((r) => setTimeout(r, OBSERVE_INTERVAL_MS));
    }

    await finishArm(target, paths, armState, transcripts, rows);
  } finally {
    saveJson(statePath(paths, 'drain-arm-state.json'), { ...armState, secondsToWorking: Object.fromEntries(armState.secondsToWorking) });
  }
}

/** Apply the chosen parent action through pi-orch. */
async function piOrchPrompt(target: OrchTarget, sessionId: string, action: string, armState: ArmState): Promise<void> {
  const { execFile: ef } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(ef);
  if (action === 'follow-up-prompt') {
    await run('/root/pi-orch/bin/pi-orch', [
      'prompt', sessionId,
      '--message', 'Your run was interrupted by a server restart. Continue working toward your goal objective from where you left off.',
      '--mode', 'follow_up',
      '--socket', target.socketPath,
      '--token-path', target.tokenPath,
      '--parent-session', target.parentSession,
    ], { timeout: 60_000 });
  } else {
    const armRec = loadJson<{ children: Array<{ sessionId: string; label: string; repoDir: string }> }>(statePath(resolveRunPaths(armState.runId), `${armState.arm}-arm-state.json`));
    void armRec;
    // Re-arm the goal with the same objective (we pass the objective text we hold).
    const child = armState.children.find((c) => c.sessionId === sessionId);
    const objective = child ? armObjective(child.repoDir, child.label) : 'Continue your objective.';
    await run('/root/pi-orch/bin/pi-orch', [
      'goal', sessionId, 'start',
      '--goal-objective', objective,
      '--goal-max-turns', '25',
      '--goal-budget-tokens', '20000000',
      '--socket', target.socketPath,
      '--token-path', target.tokenPath,
      '--parent-session', target.parentSession,
    ], { timeout: 60_000 });
  }
}

/** Collect from disk and rebuild the per-child tables (analyse subcommand). */
export function analyseArm(runId: string, arm: string): void {
  const paths = resolveRunPaths(runId);
  const resultsFile = statePath(paths, `${arm}-results.json`);
  const results = loadJson<{ rows: ChildOutcomeRow[]; totals: Record<string, number> }>(resultsFile);
  if (!results) throw new Error(`no results at ${resultsFile}`);
  const lines: string[] = [];
  lines.push(`| child | recorded event loss | s to working (no-action window) | s prompt→first child event | parent action | dup commits by step | builds seen | silent stall (window end) | orphans | final goal (collection) | receipt | watch saw |`);
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results.rows) {
    const stepDups = Object.entries(r.duplicateByStep.byStepId).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(',') || 'none';
    lines.push(`| ${r.childId} | ${r.turnsLost} | ${r.secondsToWorking ?? 'none'} | ${r.promptToWorkSeconds ?? 'none'} | ${r.parentAction ?? 'none'} | ${stepDups} | ${r.duplicateByStep.buildRuns} | ${r.silentStall ? 'YES' : 'no'} | ${r.orphans.orphansAtKill} | ${r.finalOutcome} | ${r.receiptState} | ${r.watch.firingKinds.join(',')} |`);
  }
  lines.push('');
  lines.push(`Totals: ${JSON.stringify(results.totals)}`);
  writeFileSync(statePath(paths, `${arm}-table.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
