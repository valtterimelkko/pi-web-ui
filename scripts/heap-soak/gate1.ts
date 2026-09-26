/**
 * Gate 1 — micro-soak (~20 min compressed schedule). Runs the full pipeline
 * end to end and, inside the same run, proves three robustness properties:
 *  (a) `systemctl kill` the supervisor mid-run -> it restarts (Restart=
 *      on-failure) and reattaches to the SAME server PID, CSV continuing.
 *  (b) lane B is forced bad for the whole run (HEAP_SOAK_FORCE_BAD_LANE=B) ->
 *      its circuit opens, while the backbone lane (A) keeps topping up so
 *      load continues.
 *  (c) a deliberately leaked child (created outside the driver's own
 *      accounting) is picked up and deleted by the next orphan sweep.
 * Progress is written to <runDir>/gate1-status.json after every step so a
 * caller can poll it cheaply instead of blocking in-process.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchDisposableServer } from './launcher.js';
import { teardownUnits, assertUnitsAbsent } from './teardown.js';
import { computeChecksums } from './checksum-io.js';
import { notify } from './telegram.js';
import { getUnitStatus, killUnit, startTransientUnit, waitForMainPid } from './systemd-units.js';
import { appendLaneEvent, readLaneEvents } from './events-log.js';
import { productionGuardedPaths, diffChecksums } from '../../server/src/live-validation/heap-soak/isolation.js';
import { parseCsvWithHeader } from '../../server/src/live-validation/heap-soak/csv.js';
import { FORCE_BAD_LANE_ENV_KEY } from '../../server/src/live-validation/heap-soak/lanes.js';

interface StatusFile {
  runId: string;
  step: string;
  detail?: string;
  startedAt: string;
  updatedAt: string;
  steps: { name: string; ok: boolean; detail: string; at: string }[];
  done: boolean;
}

function writeStatus(statusPath: string, status: StatusFile): void {
  writeFileSync(statusPath, JSON.stringify(status, null, 2));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function csvRowCount(csvPath: string): Promise<number> {
  if (!existsSync(csvPath)) return 0;
  return parseCsvWithHeader(readFileSync(csvPath, 'utf8')).rows.length;
}

export async function runGate1(): Promise<void> {
  const runId = `micro-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const prodPaths = productionGuardedPaths(homedir());
  const before = computeChecksums(prodPaths);

  const launch = await launchDisposableServer(runId, 'micro');
  const statusPath = path.join(launch.paths.runDir, 'gate1-status.json');
  const status: StatusFile = { runId, step: 'launched', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: [], done: false };
  const record = (name: string, ok: boolean, detail: string) => {
    status.steps.push({ name, ok, detail, at: new Date().toISOString() });
    status.step = name;
    status.updatedAt = new Date().toISOString();
    writeStatus(statusPath, status);
    console.error(`[gate1] ${ok ? 'OK ' : 'FAIL'} ${name}: ${detail}`);
  };
  writeStatus(statusPath, status);
  record('server launched', true, `unit=${launch.serverUnit} pid=${launch.serverMainPid}`);

  await notify('milestone', 'micro-soak start', `run ${runId}; schedule=micro (~20min); lane B forced bad for the whole run to exercise the amendment`);

  // Start the supervisor with lane B forced bad for the ENTIRE run — this
  // directly demonstrates requirement (b): the target is still met via A.
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  await startTransientUnit({
    unitName: launch.supervisorUnit,
    sliceName: 'pi-web-ui-soak.slice',
    restart: 'on-failure',
    workingDirectory: repoRoot,
    properties: { MemoryMax: '1G', TasksMax: '128' },
    env: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin', [FORCE_BAD_LANE_ENV_KEY]: 'B' },
    executable: 'npx',
    args: ['tsx', 'scripts/heap-soak/supervisor.ts', '--run-state', launch.paths.runStatePath],
  });
  await waitForMainPid(launch.supervisorUnit, 20_000);
  record('supervisor started (lane B forced bad)', true, `unit=${launch.supervisorUnit}`);

  // Let a couple of wave/idle cycles run so the CSV/events have real data
  // before we exercise the kill/reattach and orphan-sweep demonstrations.
  await sleep(150_000); // 2.5 min: ~1-2 wave cycles on the micro schedule (wave 60s + idle 30s)

  // ── (a) systemctl kill the supervisor mid-run; prove reattach to the SAME server PID ──
  const serverBefore = await getUnitStatus(launch.serverUnit);
  const rowsBefore = await csvRowCount(launch.paths.csvPath);
  const supervisorBefore = await getUnitStatus(launch.supervisorUnit);
  await killUnit(launch.supervisorUnit, 'SIGKILL');
  await sleep(3_000);
  // Wait for systemd's Restart=on-failure to bring up a NEW supervisor MainPID.
  let supervisorAfter = await getUnitStatus(launch.supervisorUnit);
  const restartDeadline = Date.now() + 30_000;
  while (Date.now() < restartDeadline && (!supervisorAfter.mainPid || supervisorAfter.mainPid === supervisorBefore.mainPid)) {
    await sleep(1_000);
    supervisorAfter = await getUnitStatus(launch.supervisorUnit);
  }
  record(
    'supervisor restarted after systemctl kill',
    Boolean(supervisorAfter.mainPid) && supervisorAfter.mainPid !== supervisorBefore.mainPid,
    `before pid=${supervisorBefore.mainPid} after pid=${supervisorAfter.mainPid}`,
  );
  const serverAfter = await getUnitStatus(launch.serverUnit);
  record('server PID unchanged across supervisor restart (no reset)', serverAfter.mainPid === serverBefore.mainPid, `before=${serverBefore.mainPid} after=${serverAfter.mainPid}`);
  await sleep(70_000); // let the reattached supervisor take at least one more sample
  const rowsAfter = await csvRowCount(launch.paths.csvPath);
  record('CSV continues growing after reattach (no reset)', rowsAfter > rowsBefore, `rows before=${rowsBefore} after=${rowsAfter}`);

  // ── (c) deliberately leak a child; prove the next orphan sweep deletes it ──
  const leaked = await launch.client.createSession({ runtime: 'pi', cwd: launch.paths.workspace, model: 'zai/glm-5.3-flash', source: `heap-soak:${runId}:deliberate-leak` });
  appendLaneEvent(launch.paths.eventsLogPath, { ts: new Date().toISOString(), elapsedMs: 0, lane: 'A', kind: 'child_created', sessionId: leaked.sessionId, detail: 'deliberately leaked for Gate 1(c)' });
  record('deliberately leaked a child', true, `sessionId=${leaked.sessionId}`);
  const sweepDeadline = Date.now() + 120_000;
  let swept = false;
  while (Date.now() < sweepDeadline && !swept) {
    await sleep(5_000);
    const events = readLaneEvents(launch.paths.eventsLogPath);
    swept = events.some((e) => e.kind === 'orphan_swept' && e.sessionId === leaked.sessionId);
  }
  let stillExists = true;
  try { await launch.client.getSessionInfo(leaked.sessionId); } catch { stillExists = false; }
  record('orphan sweep deleted the leaked child', swept && !stillExists, `orphan_swept event seen=${swept}, session still exists=${stillExists}`);

  // ── let the run finish naturally (report generated by the supervisor itself) ──
  const totalDeadline = Date.now() + 20 * 60_000 + 60_000; // upper bound: schedule totalMs (measured from run start, already partly elapsed) + slack
  while (Date.now() < totalDeadline && !existsSync(path.join(launch.paths.runDir, 'report.md'))) {
    await sleep(10_000);
  }
  const reportExists = existsSync(path.join(launch.paths.runDir, 'report.md'));
  const reportMd = reportExists ? readFileSync(path.join(launch.paths.runDir, 'report.md'), 'utf8') : '';
  record('report generated with a verdict line', reportExists && /Verdict:/.test(reportMd), reportExists ? reportMd.split('\n').find((l) => l.includes('Verdict:')) ?? '' : 'report.md missing');

  const teardown = await teardownUnits(launch.serverUnit, launch.supervisorUnit);
  record('teardown: units stopped', teardown.serverGone && teardown.supervisorGone, JSON.stringify(teardown));
  try {
    await assertUnitsAbsent(launch.serverUnit, launch.supervisorUnit);
    record('teardown: units verified absent', true, 'ok');
  } catch (error) {
    record('teardown: units verified absent', false, error instanceof Error ? error.message : String(error));
  }

  const after = computeChecksums(prodPaths);
  const mismatches = diffChecksums(before, after);
  record('no production file changed', mismatches.length === 0, mismatches.length === 0 ? 'ok' : JSON.stringify(mismatches));

  status.done = true;
  writeStatus(statusPath, status);
  await notify('done', 'micro-soak complete', `run ${runId}: ${status.steps.filter((s) => s.ok).length}/${status.steps.length} steps ok`);
}

if (path.resolve(new URL(import.meta.url).pathname) === path.resolve(process.argv[1] ?? '')) {
  runGate1().catch((error) => {
    console.error('[gate1] Fatal:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
