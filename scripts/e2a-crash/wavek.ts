/**
 * Wave K live-proof additions for the crash-recovery harness.
 *
 * second-fault arm: one fresh goal child is interrupted, auto-continued by the
 * server (no parent prompt), then interrupted AGAIN while working on the same
 * goal — the second transient must be VISIBLE (goal_state paused/interrupted,
 * cause second_transient) and must NOT auto-continue.
 *
 * summary: extracts the wave K recovery numbers for an arm from the arm state,
 * results and watch ledgers the ordinary driver wrote.
 */
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveRunPaths, type RunPaths } from './paths.ts';
import { buildFixture, armObjective } from './fixture.ts';
import { killServerUnit, waitForSystemdAutoRestart, waitForServerReadyViaApi, getUnitStatus, type StartedServer } from './server.ts';
import { assertPlacementRootIsolated } from './server.ts';
import { spawnGoalChild, registerObserverWatch, getChildStatus, getGoalProjection, snapshotChildToolProcesses, assertServedModel, type OrchTarget } from './dispatch.ts';
import { parseRawSessionJsonl, detectInFlightToolCall, firstWorkingAfterReadiness, summariseWatchLedger, type CrashEventRecord } from './analysis.ts';

const OWNER = 'orch-0798cc10-waveK';
const MODEL_SELECTOR = 'zai/glm-5.3-flash';
const SAMPLE_INTERVAL_MS = 10_000;
const MIN_WORK_BEFORE_KILL_MS = 3 * 60_000;
const MAX_WORK_WAIT_MS = 15 * 60_000;
const OBSERVE_MS = 10 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
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

function readRawSession(paths: RunPaths, sessionId: string): { events: CrashEventRecord[]; file?: string } {
  const dir = path.join(paths.validationDir, 'pi-sessions');
  if (!existsSync(dir)) return { events: [] };
  for (const f of readdirSafe(dir)) {
    if (f.endsWith(`${sessionId}.jsonl`)) {
      try {
        return { events: parseRawSessionJsonl(readFileSync(path.join(dir, f), 'utf8').split('\n')), file: path.join(dir, f) };
      } catch {
        return { events: [], file: path.join(dir, f) };
      }
    }
  }
  return { events: [] };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function waitUntilWorking(target: OrchTarget, paths: RunPaths, arm: string, child: { sessionId: string; label: string }, sinceMs: number, deadlineMs: number): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() < deadlineMs) {
    const { events } = readRawSession(paths, child.sessionId);
    const r = firstWorkingAfterReadiness(events, sinceMs);
    const busySample = await getChildStatus(target, child.sessionId).catch(() => ({ busy: false }));
    if (r.working || busySample.busy === true) {
      const secs = Math.max(0, Math.round(((r.firstEventAtMs ?? Date.now()) - sinceMs) / 1000));
      logLine(paths, arm, 'child-working-again', { childId: child.label, seconds: secs, measuredFrom: 'first post-readiness child event' });
      return secs;
    }
    if (Date.now() - startedAt >= SAMPLE_INTERVAL_MS) {
      logLine(paths, arm, 'observe', { childId: child.label, busy: busySample.busy === true, events: events.length, inFlight: detectInFlightToolCall(events) });
    }
    await new Promise((r2) => setTimeout(r2, SAMPLE_INTERVAL_MS));
  }
  return null;
}

export interface SecondFaultResult {
  arm: 'second-fault';
  childId: string;
  sessionId: string;
  firstContinue: { secondsToWorking: number | null } | 'none';
  secondFault: {
    at: string;
    workedAgainAfterSecondRestart: boolean;
    projection: Record<string, unknown>;
    status: string;
    pausedReason?: string;
    cause?: string;
    continueCount?: number;
  };
  watch: { sawGoalState: boolean; sawGoalEnd: boolean; firingKinds: string[] };
  finishedAt: string;
}

/**
 * Run the second-fault arm against an already-running disposable server
 * (start-server first). One fresh child; kill #1 mid-work; after the FIRST
 * auto-continue is observed working again, kill #2; after the second restart
 * the child must NOT work again (no second continue) and its projection must
 * read paused/interrupted with cause second_transient.
 */
export async function runSecondFaultArm(runId: string): Promise<SecondFaultResult> {
  const paths = resolveRunPaths(runId);
  const server = loadJson<StartedServer>(statePath(paths, 'server.json'));
  if (!server) throw new Error('server.json missing — run start-server first');
  const target: OrchTarget = { socketPath: server.socketPath, tokenPath: server.tokenPath, parentSession: process.env.PI_ORCH_PARENT ?? '' };
  await assertPlacementRootIsolated();
  await assertServedModel(target.socketPath, target.tokenPath, 'pi', MODEL_SELECTOR);

  const fixture = buildFixture(paths.fixturesRoot, 'fixture-9');
  const label = 'sf-c1';
  const sessionId = await spawnGoalChild(target, {
    repoDir: fixture.repoDir, objective: armObjective(fixture.repoDir, label), label, owner: OWNER,
    maxTurns: 25, budgetTokens: 20_000_000,
  });
  const watchId = await registerObserverWatch(target, sessionId, `k-K-${label}`);
  logLine(paths, 'second-fault', 'child-spawned', { label, sessionId, watchId });

  // Work phase: wait until mid-turn with an in-flight tool command.
  const workDeadline = Date.now() + MAX_WORK_WAIT_MS;
  let ready = false;
  while (Date.now() < workDeadline) {
    const { events } = readRawSession(paths, sessionId);
    const inFlight = detectInFlightToolCall(events);
    const st = await getChildStatus(target, sessionId).catch(() => ({ busy: false }));
    if (events.length > 0 && Date.now() - workDeadline + MAX_WORK_WAIT_MS >= MIN_WORK_BEFORE_KILL_MS && inFlight && st.busy === true) {
      ready = true;
      break;
    }
    logLine(paths, 'second-fault', 'work-sample', { events: events.length, inFlight, busy: st.busy === true });
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
  }
  if (!ready) throw new Error('second-fault: child never reached an in-flight tool command before kill #1');

  // KILL #1 → systemd auto-restart → the sweep must auto-continue the child.
  const anchorCg = (await getUnitStatus('k-K-arm-tools-anchor.service')).controlGroup ?? '';
  const procsAtKill = snapshotChildToolProcesses(anchorCg);
  const killAt = nowIso();
  await killServerUnit();
  saveJson(statePath(paths, 'second-fault-kill1-orphans.json'), { atKill: procsAtKill });
  const beforeKill = await getUnitStatus('k-K-arm-server.service');
  const auto1 = await waitForSystemdAutoRestart(beforeKill.mainPid ?? 0, 120_000);
  const ready1 = await waitForServerReadyViaApi(server.socketPath, server.tokenPath, 90_000);
  const tRestart1 = Date.parse(ready1.readyAt);
  logLine(paths, 'second-fault', 'restart-1', { killAt, auto1: auto1.durationMs });

  const secondsToWorking = await waitUntilWorking(target, paths, 'second-fault', { sessionId, label }, tRestart1, tRestart1 + OBSERVE_MS);
  if (secondsToWorking === null) {
    // No auto-continue happened; the second fault cannot run. Record honestly.
    const projection = await getGoalProjection(target, sessionId).catch(() => ({}));
    const result: SecondFaultResult = {
      arm: 'second-fault', childId: label, sessionId,
      firstContinue: 'none',
      secondFault: { at: nowIso(), workedAgainAfterSecondRestart: false, projection, status: String(projection.status ?? 'unknown') },
      watch: summariseSecondFaultWatch(paths, watchId),
      finishedAt: nowIso(),
    };
    saveJson(statePath(paths, 'second-fault-results.json'), result);
    throw new Error('second-fault: the first transient did NOT auto-continue (no work after restart #1) — precondition for the second fault failed');
  }

  // Wait until mid-work again (busy) then KILL #2 — the second transient on the SAME goal.
  const busyDeadline = Date.now() + 5 * 60_000;
  while (Date.now() < busyDeadline) {
    const st = await getChildStatus(target, sessionId).catch(() => ({ busy: false }));
    if (st.busy === true) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const killAt2 = nowIso();
  await killServerUnit();
  const beforeKill2 = await getUnitStatus('k-K-arm-server.service');
  const auto2 = await waitForSystemdAutoRestart(beforeKill2.mainPid ?? 0, 120_000);
  const ready2 = await waitForServerReadyViaApi(server.socketPath, server.tokenPath, 90_000);
  const tRestart2 = Date.parse(ready2.readyAt);
  logLine(paths, 'second-fault', 'restart-2', { killAt: killAt2, auto2: auto2.durationMs });

  // Observe: the child must NOT work again (no second continue).
  const observeStart = Date.now();
  let workedAgain = false;
  while (Date.now() - observeStart < OBSERVE_MS) {
    const { events } = readRawSession(paths, sessionId);
    const r = firstWorkingAfterReadiness(events, tRestart2);
    const st = await getChildStatus(target, sessionId).catch(() => ({ busy: false }));
    if (r.working && (r.firstEventAtMs ?? 0) > tRestart2 + 5_000) {
      workedAgain = true;
      logLine(paths, 'second-fault', 'UNEXPECTED-work-after-second-restart', { firstEventAtMs: r.firstEventAtMs });
      break;
    }
    if (st.busy === true) {
      workedAgain = true;
      logLine(paths, 'second-fault', 'UNEXPECTED-busy-after-second-restart', {});
      break;
    }
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
  }

  const projection = await getGoalProjection(target, sessionId).catch(() => ({}));
  const status = String(projection.status ?? 'unknown');
  const pausedReason = typeof projection.pausedReason === 'string' ? projection.pausedReason : undefined;
  const interruption = (projection.interruption ?? {}) as Record<string, unknown>;
  const result: SecondFaultResult = {
    arm: 'second-fault',
    childId: label,
    sessionId,
    firstContinue: { secondsToWorking },
    secondFault: {
      at: killAt2,
      workedAgainAfterSecondRestart: workedAgain,
      projection,
      status,
      pausedReason,
      cause: typeof interruption.cause === 'string' ? interruption.cause : undefined,
      continueCount: typeof interruption.continueCount === 'number' ? interruption.continueCount : undefined,
    },
    watch: summariseSecondFaultWatch(paths, watchId),
    finishedAt: nowIso(),
  };
  // Archive the raw session + the marker file as evidence.
  const { events, file } = readRawSession(paths, sessionId);
  void events;
  if (file) {
    mkdirSync(paths.samplesDir, { recursive: true });
    copyFileSync(file, path.join(paths.samplesDir, `second-fault-${label}-final-session.jsonl`));
  }
  const markerDir = path.join(paths.validationDir, 'goal-continue', 'markers');
  for (const f of readdirSafe(markerDir)) {
    if (f.startsWith(`${sessionId}.`)) {
      copyFileSync(path.join(markerDir, f), path.join(paths.samplesDir, `second-fault-marker-${f}`));
    }
  }
  saveJson(statePath(paths, 'second-fault-results.json'), result);
  const pass = !workedAgain && status === 'paused' && pausedReason === 'interrupted' && result.secondFault.cause === 'second_transient';
  console.log(`SECOND-FAULT ${pass ? 'PASS' : 'FAIL'}: workedAgain=${workedAgain} status=${status} pausedReason=${pausedReason ?? 'none'} cause=${result.secondFault.cause ?? 'none'} continueCount=${result.secondFault.continueCount ?? 'n/a'}`);
  return result;
}

function summariseSecondFaultWatch(paths: RunPaths, watchId: string): { sawGoalState: boolean; sawGoalEnd: boolean; firingKinds: string[] } {
  for (const candidate of [watchId, watchId.replace(/^watch-/, '')]) {
    const file = statePath(paths, `../server/watches/${candidate}.json`);
    const resolved = path.resolve(paths.validationDir, 'watches', `${candidate}.json`);
    const ledger = loadJson<unknown>(existsSync(resolved) ? resolved : file);
    if (ledger) {
      const summary = summariseWatchLedger(ledger);
      return { sawGoalState: summary.firingKinds.includes('goal_state'), sawGoalEnd: summary.sawGoalEnd, firingKinds: summary.firingKinds };
    }
  }
  return { sawGoalState: false, sawGoalEnd: false, firingKinds: [] };
}
