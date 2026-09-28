import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSampleCsv, buildReport, renderReportMarkdown, type BuildReportOptions } from '../../server/src/live-validation/heap-soak/report.js';
import { resolveReportedRunOutcome } from '../../server/src/live-validation/heap-soak/server-death.js';
import { readLaneEvents } from './events-log.js';
import { loadRunState } from './run-state-io.js';
import { getUnitStatus } from './systemd-units.js';
import { getUnitExitStatus, getUnitJournalTail } from './liveness-io.js';
import { DEFAULT_FULL_RUN_HOURS, MICRO_SCHEDULE, fullScheduleForHours } from '../../server/src/live-validation/heap-soak/phases.js';
import type { RunState } from '../../server/src/live-validation/heap-soak/run-state.js';
import { runDir } from './paths.js';
import { snapshotComparisonSection } from './snapshot-diff.js';

/**
 * `report` command: works on any prefix of the CSV, so a partial/in-progress
 * run is still usable. Reads samples.csv + events.jsonl from a run directory
 * and prints the markdown report (also writing report.md/report.json there).
 *
 * B0 correction: a NONTERMINAL run whose server is gone is a server death,
 * never `complete`. Before this, a supervisor that died during its systemd
 * restart window left the run nonterminal and a later `report` defaulted it to
 * a full-schedule `complete`. A run that recorded `complete` stays complete
 * even after its transient unit has been stopped or collected.
 *
 * B0.1 defect 5: a bounded (`--hours`) full run is reported against its own
 * recorded window, not the 24 h default.
 */
export async function runAnalyze(runId: string, mode: 'micro' | 'full' = 'full'): Promise<string> {
  const dir = runDir(runId);
  const csvPath = path.join(dir, 'samples.csv');
  const eventsPath = path.join(dir, 'events.jsonl');
  if (!existsSync(csvPath)) throw new Error(`No samples.csv found for run ${runId} at ${csvPath}`);
  const rows = parseSampleCsv(readFileSync(csvPath, 'utf8'));
  const events = readLaneEvents(eventsPath);

  let state: RunState | undefined;
  try {
    state = loadRunState(path.join(dir, 'run-state.json'));
  } catch { /* no/invalid run-state.json: a partial report without terminal state is still valid */ }

  const schedule = mode === 'micro' ? MICRO_SCHEDULE : fullScheduleForHours(state?.windowHours ?? DEFAULT_FULL_RUN_HOURS);
  let options: BuildReportOptions = {
    ...(state?.windowHours !== undefined ? { windowHours: state.windowHours } : {}),
    ...(state?.build ? { build: state.build } : {}),
  };

  if (state) {
    const serverStatus = await getUnitStatus(state.server.unitName);
    // Only gather terminal evidence when the outcome could need it (a
    // nonterminal run, or one whose death was persisted without evidence).
    const alreadyResolved = (state.terminalState === 'server_died' && state.serverDeath) || state.terminalState === 'complete';
    const [exit, journal] = alreadyResolved
      ? [{ activeState: serverStatus.activeState, subState: serverStatus.subState, result: undefined, execMainStatus: undefined }, [] as string[]]
      : await Promise.all([getUnitExitStatus(state.server.unitName), getUnitJournalTail(state.server.unitName, 40)]);
    const exitStatus = [exit.result, exit.execMainStatus && `exec-status=${exit.execMainStatus}`].filter(Boolean).join('/') || undefined;
    const elapsedMs = state.lastGoodSampleElapsedMs ?? Math.max(0, Date.now() - new Date(state.startedAt).getTime());
    const outcome = resolveReportedRunOutcome(
      state,
      { loadState: serverStatus.loadState, activeState: serverStatus.activeState, mainPid: serverStatus.mainPid },
      {
        reason: `server unit ${state.server.unitName} is not running (LoadState=${serverStatus.loadState})`,
        detectedAt: new Date().toISOString(),
        elapsedMs,
        activeState: serverStatus.activeState,
        exitStatus,
        journalLines: journal.slice(-40),
      },
    );
    options = {
      ...options,
      terminalState: outcome.terminalState,
      ...(outcome.serverDeath ? { serverDeath: outcome.serverDeath } : {}),
      ...(outcome.coveredWindowMs !== undefined ? { coveredWindowMs: outcome.coveredWindowMs } : {}),
      ...(state.extensionsOverlays && state.extensionsOverlays.length > 0 ? { extensionsOverlays: state.extensionsOverlays } : {}),
      ...(state.serverStoppedAt !== undefined || state.teardownAnomaly !== undefined
        ? {
            teardown: {
              serverUnit: state.server.unitName,
              ...(state.serverStoppedAt !== undefined ? { stoppedAt: state.serverStoppedAt } : {}),
              ...(state.serverStopVerifiedGone !== undefined ? { verifiedGone: state.serverStopVerifiedGone } : {}),
              ...(state.serverStopAttempts !== undefined ? { attempts: state.serverStopAttempts } : {}),
              ...(state.teardownAnomaly !== undefined ? { anomaly: state.teardownAnomaly } : {}),
            },
          }
        : {}),
    };
  }

  const report = buildReport(rows, events, schedule, 'A', options);
  const snapshotSection = await snapshotComparisonSection(dir, {
    ...(state?.endSnapshotPath !== undefined ? { expectedEndSnapshotPath: state.endSnapshotPath } : {}),
    ...(state?.liveChildrenAtEndSnapshot !== undefined ? { liveChildrenAtSnapshot: state.liveChildrenAtEndSnapshot } : {}),
    ...(state?.pendingCreatesAtEndSnapshot !== undefined ? { pendingCreatesAtSnapshot: state.pendingCreatesAtEndSnapshot } : {}),
    ...(state?.endSnapshotDrain !== undefined ? { drainDrained: state.endSnapshotDrain.drained } : {}),
  });
  const markdown = `${renderReportMarkdown(report, runId)}\n\n${snapshotSection}`;
  writeFileSync(path.join(dir, 'report.md'), markdown);
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return markdown;
}
