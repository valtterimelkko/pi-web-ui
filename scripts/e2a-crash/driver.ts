/**
 * Arm orchestration for the E2a-6c crash-recovery harness.
 *
 * One export per phase so the CLI can run each as its own foreground command:
 * prepare → start-server → (smoke | kill-arm | drain-arm) → collect/analyse.
 * State lands under <run>/state/, raw samples under <run>/samples/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { resolveRunPaths, type RunPaths } from './paths.ts';
import { buildFixtures, buildFixture, armObjective, smokeObjective } from './fixture.ts';
import { buildCrashAgentDir } from './agent-dir.ts';
import { prepareServerEnv, startServerUnit, killServerUnit, stopServerUnits, assertPlacementRootIsolated, SMOKE_MODE, ARM_MODE, getUnitStatus, type StartedServer, type ServerMode } from './server.ts';
import {
  spawnGoalChild, registerObserverWatch, getChildStatus, getTranscript, startDrain, getDrainStatus,
  assertServedModel, snapshotChildToolProcesses, type OrchTarget, type ProcRecord,
} from './dispatch.ts';
import {
  parseTranscriptEvents, detectInFlightToolCall, diffTranscriptSnapshots, summariseDuplicates,
  summariseWatchLedger, diffProcessSnapshots, buildChildRow, totalsRows,
  type CrashEventRecord, type ChildOutcomeRow,
} from './analysis.ts';

const REPO_ROOT = '/root/.worktrees/orch-scaling/e2-a6c-pi-web-ui'; // lane-fixed: this harness runs from the E2a-6c execution worktree
const OWNER = 'orch-e2-0798cc10-E2a-6c';
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

/** git HEAD hash of a fixture repo (baseline commit for later commit counting). */
function gitHead(repoDir: string): string {
  return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// prepare / server lifecycle
// ---------------------------------------------------------------------------

export async function prepare(runId: string, fixtureCount: number): Promise<void> {
  const paths = resolveRunPaths(runId);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const agentDir = buildCrashAgentDir(paths.agentDir);
  const fixtures = buildFixtures(paths.fixturesRoot, fixtureCount);
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

export async function stopServerForRun(runId: string): Promise<void> {
  const paths = resolveRunPaths(runId);
  await stopServerUnits();
  const record = { stoppedAt: nowIso() };
  saveJson(statePath(paths, 'server-stopped.json'), record);
  console.log('server + anchor stopped');
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

async function sampleChildren(
  target: OrchTarget,
  children: Array<{ sessionId: string }>,
  sampleLog: Array<Record<string, unknown>>,
): Promise<{ samples: ChildSample[]; transcripts: Map<string, CrashEventRecord[]> }> {
  const samples: ChildSample[] = [];
  const transcripts = new Map<string, CrashEventRecord[]>();
  for (const child of children) {
    const status = await getChildStatus(target, child.sessionId);
    let events: CrashEventRecord[] = [];
    let count = 0;
    let inFlight = false;
    try {
      const transcript = await getTranscript(target.socketPath, target.tokenPath, child.sessionId);
      events = parseTranscriptEvents(transcript);
      count = events.length;
      inFlight = detectInFlightToolCall(events);
      transcripts.set(child.sessionId, events);
    } catch (err) {
      sampleLog.push({ t: nowIso(), childId: child.sessionId, transcriptError: err instanceof Error ? err.message : String(err) });
    }
    samples.push({
      t: nowIso(),
      childId: child.sessionId,
      busy: status.busy === true,
      inFlight,
      transcriptEventCount: count,
      goalState: status.goalState,
    });
  }
  return { samples, transcripts };
}

async function waitForChildrenReadyToInterrupt(
  target: OrchTarget,
  paths: RunPaths,
  armState: ArmState,
  sampleLog: Array<Record<string, unknown>>,
): Promise<{ transcripts: Map<string, CrashEventRecord[]>; condition: string }> {
  const startedAt = Date.now();
  let last: { transcripts: Map<string, CrashEventRecord[]>; allBusy: boolean; inFlightCount: number } | undefined;
  while (Date.now() - startedAt < MAX_WORK_WAIT_MS) {
    const { samples, transcripts } = await sampleChildren(target, armState.children, sampleLog);
    const allBusy = samples.every((s) => s.busy);
    const inFlightCount = samples.filter((s) => s.inFlight).length;
    last = { transcripts, allBusy, inFlightCount };
    logLine(paths, armState.arm, 'sample', { samples });
    const elapsed = Date.now() - startedAt;
    if (elapsed >= MIN_WORK_BEFORE_INTERRUPT_MS && allBusy && inFlightCount >= 2) {
      return { transcripts, condition: `all busy (${samples.filter((s) => s.busy).length}/${samples.length}), ${inFlightCount} with in-flight tool command, after ${Math.round(elapsed / 1000)}s` };
    }
    if (elapsed >= MIN_WORK_BEFORE_INTERRUPT_MS && elapsed >= 8 * 60_000 && samples.filter((s) => s.busy).length >= Math.max(2, samples.length - 1) && inFlightCount >= 2) {
      return { transcripts, condition: `relaxed: ${samples.filter((s) => s.busy).length}/${samples.length} busy, ${inFlightCount} in-flight, after ${Math.round(elapsed / 1000)}s` };
    }
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
  }
  throw new Error(`Children never reached the busy+in-flight interruption condition within ${MAX_WORK_WAIT_MS / 1000}s (last sample: ${JSON.stringify(last)})`);
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
  const finalTranscript = await getTranscript(target.socketPath, target.tokenPath, child.sessionId).catch(() => undefined);
  const finalEvents = parseTranscriptEvents(finalTranscript);
  writeFileSync(path.join(paths.samplesDir, `${armState.arm}-${child.label}-final-transcript.json`), JSON.stringify(finalTranscript ?? { error: 'unavailable' }));
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
  const progressLines = existsSync(path.join(child.repoDir, 'PROGRESS.log'))
    ? readFileSync(path.join(child.repoDir, 'PROGRESS.log'), 'utf8').split('\n').filter((l) => l.trim().length > 0)
    : [];
  const gitLog = execFileSync('git', ['-C', child.repoDir, 'log', '--format=%H|%s', `${child.baselineCommit}..HEAD`], { encoding: 'utf8' }).trim();
  const commits = gitLog.length > 0 ? gitLog.split('\n').map((line) => ({ hash: line.split('|')[0], subject: line.split('|').slice(1).join('|') })) : [];
  const buildRuns = [{ label: `final build-info: ${existsSync(path.join(child.repoDir, 'dist', 'build-info.json')) ? readFileSync(path.join(child.repoDir, 'dist', 'build-info.json'), 'utf8').slice(0, 120) : 'none'}` }];
  const duplicates = summariseDuplicates({ progressLines, commits, buildRuns });

  // Orphans: processes under the anchor cgroup at the end vs at the kill.
  const orphanSnap = loadJson<{ atKill: ProcRecord[]; afterKill: ProcRecord[] }>(statePath(paths, `${armState.arm}-orphans.json`));
  const anchorCg = (loadJson<StartedServer>(statePath(paths, 'server.json')) as StartedServer | undefined)?.anchorCgroup ?? '';
  const endSnap = snapshotChildToolProcesses(anchorCg);
  let orphans = { orphansAtKill: 0, orphanPids: [] as number[], gonePids: [] as number[] };
  if (orphanSnap) {
    const first = diffProcessSnapshots(orphanSnap.atKill, orphanSnap.afterKill, new Set());
    orphans = {
      orphansAtKill: first.orphansAtKill,
      orphanPids: first.orphanPids,
      gonePids: first.orphanPids.filter((pid) => !endSnap.some((p) => p.pid === pid)),
    };
  }

  // Final status/receipt state.
  const status = await getChildStatus(target, child.sessionId);
  const finalOutcome = status.goalState ?? 'unknown';

  return buildChildRow({
    childId: child.label,
    arm: armState.arm === 'smoke' ? 'smoke' : armState.arm === 'kill' ? 'kill' : 'drain-timeout',
    transcriptDiff: diff,
    secondsToWorking: (armState as ArmState & { secondsToWorking?: Map<string, number> }).secondsToWorking?.get(child.sessionId) ?? null,
    parentAction: (armState.parentActions ?? []).find((a) => a.childId === child.label)?.action ?? null,
    duplicates,
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
      const watchId = await registerObserverWatch(target, sessionId, `e2a-6c-${label}`);
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
      const t = await getTranscript(target.socketPath, target.tokenPath, child.sessionId).catch(() => undefined);
      preTranscripts.set(child.sessionId, parseTranscriptEvents(t));
    }
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
  const prepareRec = loadJson<{ fixtures: Array<{ name: string; repoDir: string; baselineCommit: string }> }>(statePath(paths, 'prepare.json'));
  if (!prepareRec || prepareRec.fixtures.length < childCount) throw new Error(`need ${childCount} prepared fixtures — run prepare first`);
  const armState: ArmState & { secondsToWorking: Map<string, number> } = {
    runId, arm: 'kill', startedAt: nowIso(), children: [], secondsToWorking: new Map(),
  };
  const rows: ChildOutcomeRow[] = [];
  const sampleLog: Array<Record<string, unknown>> = [];
  try {
    const fixtures = freshFixtures(paths, Array.from({ length: childCount }, (_, i) => `fixture-${i + 1}`));
    for (let i = 0; i < childCount; i += 1) {
      const fixture = fixtures[i];
      const label = `kill-c${i + 1}`;
      const sessionId = await spawnGoalChild(target, {
        repoDir: fixture.repoDir, objective: armObjective(fixture.repoDir, label), label, owner: OWNER,
        maxTurns: 25, budgetTokens: 20_000_000,
      });
      const watchId = await registerObserverWatch(target, sessionId, `e2a-6c-${label}`);
      armState.children.push({ sessionId, watchId, repoDir: fixture.repoDir, label, baselineCommit: fixture.baselineCommit });
      logLine(paths, 'kill', 'child-spawned', { label, sessionId, watchId });
    }

    // Work phase: wait until every child is mid-turn with tool commands running.
    const { transcripts, condition } = await waitForChildrenReadyToInterrupt(target, paths, armState, sampleLog);
    const anchorCg = (await getUnitStatus('e2a-6c-tools-anchor.service')).controlGroup ?? '';
    const procsAtKill = snapshotChildToolProcesses(anchorCg);
    armState.interruptAt = nowIso();
    armState.interruptCondition = condition;
    logLine(paths, 'kill', 'interrupt', { condition, procsAtKill: procsAtKill.length });

    // THE KILL.
    const kill = await killServerUnit();
    const procsAfterKill = snapshotChildToolProcesses(anchorCg);
    saveJson(statePath(paths, 'kill-orphans.json'), { atKill: procsAtKill, afterKill: procsAfterKill });
    logLine(paths, 'kill', 'killed', { method: kill.method, procsSurviving: procsAfterKill.length });

    // Restart (driver-controlled; production's unit would auto-restart via Restart=always — recorded).
    const restart = await restartServer(paths, ARM_MODE, kill.method);
    armState.serverRestart = { at: armState.interruptAt, readyAt: restart.readyAt, durationMs: restart.durationMs, method: kill.method };

    // Observe 10 minutes WITHOUT parent action.
    const observeStart = Date.now();
    const tRestart = Date.now();
    while (Date.now() - observeStart < OBSERVE_NO_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, armState.children, sampleLog);
      logLine(paths, 'kill', 'observe-no-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const pre = transcripts.get(child.sessionId) ?? [];
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const diff = diffTranscriptSnapshots(pre, now);
        const hasNewToolCall = now.slice(diff.retainedCount).some((e) => e.kind === 'toolCall');
        if (hasNewToolCall) {
          armState.secondsToWorking.set(child.sessionId, Math.round((Date.now() - tRestart) / 1000));
          logLine(paths, 'kill', 'child-working-again', { childId: child.label, seconds: armState.secondsToWorking.get(child.sessionId) });
        }
      }
      await new Promise((r) => setTimeout(r, OBSERVE_INTERVAL_MS));
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
      await piOrchPrompt(target, child.sessionId, action, armState);
      armState.parentActions.push({ at: nowIso(), childId: child.label, action, reason });
      logLine(paths, 'kill', 'parent-action', { childId: child.label, action, reason });
    }

    // Observe up to 20 more minutes with the parent action applied.
    const observeStart2 = Date.now();
    while (Date.now() - observeStart2 < OBSERVE_WITH_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, armState.children, sampleLog);
      logLine(paths, 'kill', 'observe-parent-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const pre = transcripts.get(child.sessionId) ?? [];
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const diff = diffTranscriptSnapshots(pre, now);
        const hasNewToolCall = now.slice(diff.retainedCount).some((e) => e.kind === 'toolCall');
        if (hasNewToolCall) {
          armState.secondsToWorking.set(child.sessionId, Math.round((Date.now() - tRestart) / 1000));
          logLine(paths, 'kill', 'child-working-again', { childId: child.label, seconds: armState.secondsToWorking.get(child.sessionId), afterParentAction: true });
        }
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
  const prepareRec = loadJson<{ fixtures: Array<{ name: string; repoDir: string; baselineCommit: string }> }>(statePath(paths, 'prepare.json'));
  if (!prepareRec || prepareRec.fixtures.length < childCount) throw new Error(`need ${childCount} prepared fixtures — run prepare first`);
  const armState: ArmState & { secondsToWorking: Map<string, number> } = {
    runId, arm: 'drain-timeout', startedAt: nowIso(), children: [], secondsToWorking: new Map(),
  };
  const rows: ChildOutcomeRow[] = [];
  const sampleLog: Array<Record<string, unknown>> = [];
  try {
    // The drain arm runs after the kill arm and REBUILDS its fixtures, so it
    // can reuse the same names (fixture-1..N) with clean side-effect state.
    const drainFixtures = freshFixtures(paths, Array.from({ length: childCount }, (_, i) => `fixture-${i + 1}`));
    for (let i = 0; i < childCount; i += 1) {
      const fixture = drainFixtures[i];
      const label = `drain-c${i + 1}`;
      const sessionId = await spawnGoalChild(target, {
        repoDir: fixture.repoDir, objective: armObjective(fixture.repoDir, label), label, owner: OWNER,
        maxTurns: 25, budgetTokens: 20_000_000,
      });
      const watchId = await registerObserverWatch(target, sessionId, `e2a-6c-${label}`);
      armState.children.push({ sessionId, watchId, repoDir: fixture.repoDir, label, baselineCommit: gitHead(fixture.repoDir) });
      logLine(paths, 'drain-timeout', 'child-spawned', { label, sessionId, watchId });
    }

    const { transcripts, condition } = await waitForChildrenReadyToInterrupt(target, paths, armState, sampleLog);
    const anchorCg = (await getUnitStatus('e2a-6c-tools-anchor.service')).controlGroup ?? '';
    const procsAtDrain = snapshotChildToolProcesses(anchorCg);
    armState.interruptAt = nowIso();
    armState.interruptCondition = condition;
    logLine(paths, 'drain-timeout', 'drain-start', { condition });

    // Drain with a SHORT timeout: it waits for busy turns, times out, and the
    // driver proceeds (the deploy-script choice) — cutting the turns off.
    await startDrain(target.socketPath, target.tokenPath, DRAIN_TIMEOUT_SECONDS, `e2a-6c drain-timeout arm ${runId}`);
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
    saveJson(statePath(paths, 'drain-orphans.json'), { atKill: procsAtDrain, afterKill: procsAfterStop });
    const restart = await restartServer(paths, ARM_MODE, 'drain timed out; graceful stop then start');
    armState.serverRestart = { at: armState.interruptAt, readyAt: restart.readyAt, durationMs: restart.durationMs };

    // Observe 10 minutes WITHOUT parent action.
    const tRestart = Date.now();
    const observeStart = Date.now();
    while (Date.now() - observeStart < OBSERVE_NO_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, armState.children, sampleLog);
      logLine(paths, 'drain-timeout', 'observe-no-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const pre = transcripts.get(child.sessionId) ?? [];
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const diff = diffTranscriptSnapshots(pre, now);
        const hasNewToolCall = now.slice(diff.retainedCount).some((e) => e.kind === 'toolCall');
        if (hasNewToolCall) {
          armState.secondsToWorking.set(child.sessionId, Math.round((Date.now() - tRestart) / 1000));
          logLine(paths, 'drain-timeout', 'child-working-again', { childId: child.label, seconds: armState.secondsToWorking.get(child.sessionId) });
        }
      }
      await new Promise((r) => setTimeout(r, OBSERVE_INTERVAL_MS));
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
      await piOrchPrompt(target, child.sessionId, action, armState);
      armState.parentActions.push({ at: nowIso(), childId: child.label, action, reason });
      logLine(paths, 'drain-timeout', 'parent-action', { childId: child.label, action, reason });
    }

    const observeStart2 = Date.now();
    while (Date.now() - observeStart2 < OBSERVE_WITH_PARENT_ACTION_MS) {
      const { samples, transcripts: nowTranscripts } = await sampleChildren(target, armState.children, sampleLog);
      logLine(paths, 'drain-timeout', 'observe-parent-action', { samples });
      for (const child of armState.children) {
        if (armState.secondsToWorking.has(child.sessionId)) continue;
        const pre = transcripts.get(child.sessionId) ?? [];
        const now = nowTranscripts.get(child.sessionId) ?? [];
        const diff = diffTranscriptSnapshots(pre, now);
        const hasNewToolCall = now.slice(diff.retainedCount).some((e) => e.kind === 'toolCall');
        if (hasNewToolCall) {
          armState.secondsToWorking.set(child.sessionId, Math.round((Date.now() - tRestart) / 1000));
          logLine(paths, 'drain-timeout', 'child-working-again', { childId: child.label, seconds: armState.secondsToWorking.get(child.sessionId), afterParentAction: true });
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
  lines.push(`| child | turns lost | tool results lost | edits lost | s to working | parent action | dup side effects | orphans | final goal | receipt | watch saw |`);
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results.rows) {
    lines.push(`| ${r.childId} | ${r.turnsLost} | ${r.toolResultsLost} | ${r.editsLost} | ${r.secondsToWorking ?? 'never'} | ${r.parentAction ?? 'none'} | ${r.duplicateSideEffects.totalDuplicateEvents} | ${r.orphans.orphansAtKill} | ${r.finalOutcome} | ${r.receiptState} | ${r.watch.firingKinds.join(',')}${r.watch.sawInterruptedByRestart ? ' +interruptedByRestart' : ''} |`);
  }
  lines.push('');
  lines.push(`Totals: ${JSON.stringify(results.totals)}`);
  writeFileSync(statePath(paths, `${arm}-table.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
