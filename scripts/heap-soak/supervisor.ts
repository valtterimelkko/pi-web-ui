#!/usr/bin/env npx tsx
/**
 * Supervisor process: runs as the `pi-web-ui-soak-supervisor-<run-id>`
 * transient systemd unit (Restart=on-failure). On every start (fresh or
 * restarted-after-kill) it:
 *   1. Loads run-state.json (written by the launcher before this unit started).
 *   2. Verifies the server unit is STILL the same running process
 *      (decideReattach) — it NEVER restarts the server itself.
 *   3. Runs the sampler loop and the driver loop concurrently until the
 *      schedule's totalMs elapses, persisting run-state continuously so a
 *      `systemctl kill` + systemd auto-restart resumes exactly where it left
 *      off (same CSV, same breaker states, same cycle count).
 */
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { InspectorClient } from './inspector.js';
import { getUnitStatus } from './systemd-units.js';
import { loadRunState, saveRunState } from './run-state-io.js';
import { appendLaneEvent, readLaneEvents } from './events-log.js';
import { appendSampleRow } from './csv-io.js';
import { notify } from './telegram.js';
import { takeSample, writeHeartbeat } from './sampler.js';
import { runWave, type DriverState } from './driver.js';
import { sweepOrphans } from './orphan-sweep.js';
import { pollZaiQuota } from './quota-poll.js';
import { decideReattach } from '../../server/src/live-validation/heap-soak/run-state.js';
import { HEAP_SAMPLE_CSV_HEADER, DEFAULT_WAVE_TARGET_CONFIG, type LaneEvent } from '../../server/src/live-validation/heap-soak/types.js';
import { LANE_DEFINITIONS, applyForcedBadLanes, enabledLanes } from '../../server/src/live-validation/heap-soak/lanes.js';
import { leastSquaresSlope, type SlopePoint } from '../../server/src/live-validation/heap-soak/slope.js';
import { DEFAULT_QUOTA_THRESHOLDS, effectiveBackboneTarget, nextQuotaState, nextStateOnPollFailure, type QuotaState, type ZaiQuotaReading } from '../../server/src/live-validation/heap-soak/zai-quota.js';
import { FULL_SCHEDULE, MICRO_SCHEDULE, checkpointOffsetsMs, isRunComplete, nextDueOffset, phaseAt, snapshotOffsetsMs, type ScheduleConfig } from '../../server/src/live-validation/heap-soak/phases.js';
import { buildReport, parseSampleCsv, renderReportMarkdown } from '../../server/src/live-validation/heap-soak/report.js';
import { snapshotComparisonSection } from './snapshot-diff.js';
import { runProductionWriteAudit } from './prod-audit-io.js';
import { boardWhoUnderRunDir } from './board-check.js';
import { buildAuditNeedles } from '../../server/src/live-validation/heap-soak/prod-audit.js';

/** Default poll cadence for the zai quota guard: every 10 min in the full run, every 30s in the compressed micro schedule. */
function quotaPollIntervalMs(mode: 'micro' | 'full'): number {
  const override = Number(process.env.HEAP_SOAK_QUOTA_POLL_INTERVAL_MS ?? '');
  if (Number.isFinite(override) && override > 0) return override;
  return mode === 'micro' ? 30_000 : 10 * 60_000;
}

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runStatePath = getFlag(argv, '--run-state');
  if (!runStatePath) throw new Error('supervisor requires --run-state <path>');

  const state = loadRunState(runStatePath);
  const schedule: ScheduleConfig = state.mode === 'micro' ? MICRO_SCHEDULE : FULL_SCHEDULE;
  const runStartMs = new Date(state.startedAt).getTime();

  // Reattach check — NEVER restart the server, only confirm it is still the
  // exact process this run-state was created for.
  const serverStatus = await getUnitStatus(state.server.unitName);
  const decision = decideReattach(state, { loadState: serverStatus.loadState, mainPid: serverStatus.mainPid });
  const log = (event: LaneEvent) => appendLaneEvent(state.eventsLogPath, event);
  const elapsedNow = () => Date.now() - runStartMs;

  if (decision.action !== 'reattach') {
    log({ ts: new Date().toISOString(), elapsedMs: elapsedNow(), lane: 'A', kind: 'anomaly', detail: `${decision.action}: ${decision.reason}` });
    await notify('blocked', 'disposable server unreachable', decision.reason);
    process.exitCode = 1;
    return;
  }
  console.error(`[supervisor] ${decision.reason}`);

  const client = new InternalApiClient({ socketPath: state.server.socketPath, tokenPath: state.server.tokenPath });
  const inspector = await InspectorClient.connect(state.server.inspectorPort);
  await inspector.enable();

  mkdirSync(path.dirname(state.csvPath), { recursive: true });
  mkdirSync(path.join(state.runDir, 'children'), { recursive: true });

  const lanes = applyForcedBadLanes(enabledLanes(LANE_DEFINITIONS));
  const driverState: DriverState = { breakers: new Map(Object.entries(state.laneBreakers) as [import('../../server/src/live-validation/heap-soak/types.js').LaneName, import('../../server/src/live-validation/heap-soak/types.js').CircuitBreakerState][]) };

  const checkpointOffsets = checkpointOffsetsMs(schedule);
  const snapshotOffsets = snapshotOffsetsMs(schedule);
  const firedCheckpoints = new Set(state.firedCheckpointOffsetsMs ?? []);
  const firedSnapshots = new Set(state.firedSnapshotOffsetsMs ?? []);
  let anomalyHeapPinged = false;
  let stopped = false;

  // zai quota guard (owner amendment 2026-09-26). State is persisted so a
  // supervisor restart resumes the same state rather than resetting to
  // 'normal' (which would silently un-throttle/un-pause across a kill).
  let quotaState: QuotaState = state.quotaState ?? 'normal';
  let quotaConsecutiveFailures = state.quotaConsecutiveFailures ?? 0;
  let lastQuotaPollAtMs = state.lastQuotaPollAtMs ?? 0;
  let lastQuotaReading: ZaiQuotaReading | undefined;

  const persist = () => {
    state.laneBreakers = Object.fromEntries(driverState.breakers) as typeof state.laneBreakers;
    state.firedCheckpointOffsetsMs = [...firedCheckpoints];
    state.firedSnapshotOffsetsMs = [...firedSnapshots];
    state.quotaState = quotaState;
    state.quotaConsecutiveFailures = quotaConsecutiveFailures;
    state.lastQuotaPollAtMs = lastQuotaPollAtMs;
    state.lastSampleAt = new Date().toISOString();
    saveRunState(runStatePath, state);
  };

  // Both loops (sampler timer + once-per-wave) call pollQuotaNow(); without
  // serialising them, two overlapping polls can each read the SAME `previous`
  // state, apply their own (different) reading, and race on the final write —
  // observed live: a poll landing on a 'paused'-triggering reading got
  // silently clobbered by a concurrent poll still computing from the stale
  // 'throttled' state, so the logged transition skipped straight
  // throttled -> normal instead of throttled -> paused -> normal. A single
  // in-flight guard makes every caller either run the poll or await the one
  // already running, never a second concurrent one.
  let quotaPollInFlight: Promise<void> | undefined;
  async function pollQuotaNow(): Promise<void> {
    if (quotaPollInFlight) return quotaPollInFlight;
    quotaPollInFlight = pollQuotaNowUnlocked().finally(() => { quotaPollInFlight = undefined; });
    return quotaPollInFlight;
  }

  /** Poll now, apply the hysteresis/failure state machine, ping ONCE per state change, persist. Never call directly — use pollQuotaNow(). */
  async function pollQuotaNowUnlocked(): Promise<void> {
    const previous = quotaState;
    try {
      const reading = await pollZaiQuota();
      lastQuotaReading = reading;
      quotaConsecutiveFailures = 0;
      quotaState = nextQuotaState(quotaState, reading, DEFAULT_QUOTA_THRESHOLDS, Date.now());
    } catch (error) {
      const result = nextStateOnPollFailure(quotaState, quotaConsecutiveFailures);
      quotaState = result.state;
      quotaConsecutiveFailures = result.consecutiveFailures;
      log({ ts: new Date().toISOString(), elapsedMs: elapsedNow(), lane: 'A', kind: 'anomaly', detail: `zai quota poll failed (${quotaConsecutiveFailures} consecutive): ${error instanceof Error ? error.message : String(error)}` });
    }
    lastQuotaPollAtMs = Date.now();
    if (quotaState !== previous) {
      log({ ts: new Date().toISOString(), elapsedMs: elapsedNow(), lane: 'A', kind: 'quota_state_change', detail: `${previous} -> ${quotaState}` });
      await notify(
        quotaState === 'paused' ? 'blocked' : 'milestone',
        `zai quota: ${previous} -> ${quotaState}`,
        lastQuotaReading ? `percentLeft=${lastQuotaReading.percentLeft ?? 'n/a'} peakActive=${lastQuotaReading.peakActive}` : 'poll failed 3x',
      );
    }
    persist();
  }

  async function samplerLoop(): Promise<void> {
    const sampleIntervalMs = state.mode === 'micro' ? 10_000 : 120_000;
    while (!stopped && !isRunComplete(elapsedNow(), schedule)) {
      const elapsedMs = elapsedNow();
      const phase = phaseAt(elapsedMs, schedule);
      if (Date.now() - lastQuotaPollAtMs >= quotaPollIntervalMs(state.mode)) {
        await pollQuotaNow();
      }
      try {
        const sample = await takeSample({ inspector, client, runStartMs, phase, diskCheckPath: state.runDir });
        sample.quotaState = quotaState;
        sample.quotaPercentLeft = lastQuotaReading?.percentLeft;
        sample.quotaPeakActive = lastQuotaReading?.peakActive;
        appendSampleRow(state.csvPath, HEAP_SAMPLE_CSV_HEADER, { ...sample });
        writeHeartbeat(path.join(state.runDir, 'sampler.heartbeat'));

        if (sample.freeDiskGB !== undefined && sample.freeDiskGB < 20) {
          log({ ts: new Date().toISOString(), elapsedMs, lane: 'A', kind: 'anomaly', detail: `free disk ${sample.freeDiskGB.toFixed(1)}GB < 20GB` });
        }
        const heapCapBytes = 4096 * 1024 * 1024;
        if (sample.heapUsedBytes > 0.7 * heapCapBytes) {
          if (!anomalyHeapPinged) {
            anomalyHeapPinged = true;
            await notify('blocked', 'post-GC heap > 70% of cap', `heapUsed=${(sample.heapUsedBytes / 1024 / 1024).toFixed(0)}MB at elapsed ${elapsedMs}ms`);
          }
        } else {
          anomalyHeapPinged = false;
        }
      } catch (error) {
        log({ ts: new Date().toISOString(), elapsedMs, lane: 'A', kind: 'anomaly', detail: `sample failed: ${error instanceof Error ? error.message : String(error)}` });
      }

      const dueCheckpoint = nextDueOffset(elapsedMs, checkpointOffsets, firedCheckpoints);
      if (dueCheckpoint !== undefined) {
        firedCheckpoints.add(dueCheckpoint);
        persist();
        const rows = parseSampleCsv(readFileSync(state.csvPath, 'utf8'));
        const points: SlopePoint[] = rows.map((r) => ({ tMs: r.elapsedMs, valueMB: r.heapUsedMB }));
        const slope = leastSquaresSlope(points);
        await notify('milestone', `checkpoint +${Math.round(dueCheckpoint / 3_600_000)}h (elapsed ${Math.round(elapsedMs / 60_000)}min)`,
          `post-GC slope so far: ${slope.slopeMBPerHour.toFixed(2)} MB/h over ${slope.sampleCount} samples. Lane breakers: ${JSON.stringify([...driverState.breakers.values()].map((b) => ({ lane: b.lane, open: b.open, ok: b.totalSuccesses, fail: b.totalFailures })))}`);
      }
      const dueSnapshot = nextDueOffset(elapsedMs, snapshotOffsets, firedSnapshots);
      if (dueSnapshot !== undefined) {
        firedSnapshots.add(dueSnapshot);
        persist();
        try {
          mkdirSync(path.join(state.runDir, 'snapshots'), { recursive: true });
          const snapshotPath = path.join(state.runDir, 'snapshots', `snapshot-${dueSnapshot}ms.heapsnapshot`);
          const result = await inspector.takeHeapSnapshot(snapshotPath);
          await notify('milestone', `heap snapshot at elapsed ${Math.round(elapsedMs / 60_000)}min`, `${result.chunkCount} chunks, ${result.bytesWritten} bytes -> ${snapshotPath}`);
        } catch (error) {
          log({ ts: new Date().toISOString(), elapsedMs, lane: 'A', kind: 'anomaly', detail: `snapshot failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }

      persist();
      await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
    }
  }

  async function driverLoop(): Promise<void> {
    while (!stopped && !isRunComplete(elapsedNow(), schedule)) {
      // "once before each wave", per the amendment — unconditional, regardless of the timer above.
      await pollQuotaNow();
      const effectiveTarget = effectiveBackboneTarget(DEFAULT_WAVE_TARGET_CONFIG.targetPerWave, quotaState);
      const waveResult = await runWave({
        client,
        runId: state.runId,
        childWorkspaceRoot: path.join(state.runDir, 'children'),
        lanes,
        waveTargetConfig: { ...DEFAULT_WAVE_TARGET_CONFIG, targetPerWave: effectiveTarget },
        logEvent: log,
        runStartMs,
        backbonePaused: quotaState === 'paused',
      }, driverState, schedule.waveMs);
      state.cycleCount += 1;
      persist();

      if (waveResult.anomaly) {
        log({ ts: new Date().toISOString(), elapsedMs: elapsedNow(), lane: 'A', kind: 'anomaly', detail: 'backbone lane down: wave target missed with zero backbone completions' });
        await notify('blocked', 'backbone lane down', `wave ${state.cycleCount}: completedByLane=${JSON.stringify(waveResult.completedByLane)}`);
      }

      // Orphan sweep once per cycle — the harness must never become the leak.
      const events = readLaneEvents(state.eventsLogPath);
      await sweepOrphans(client, events, log, elapsedNow);

      if (isRunComplete(elapsedNow(), schedule)) break;
      await new Promise((resolve) => setTimeout(resolve, schedule.idleMs));
    }
  }

  await Promise.all([samplerLoop(), driverLoop()]);
  stopped = true;
  persist();

  // Final report + done ping.
  const rows = parseSampleCsv(readFileSync(state.csvPath, 'utf8'));
  const events = readLaneEvents(state.eventsLogPath);
  const report = buildReport(rows, events, schedule, 'A');
  const snapshotSection = await snapshotComparisonSection(state.runDir);

  // Production-write / board-pollution audit at the run's end (owner
  // amendment 2026-09-26) — required "at the long run's end" in addition to
  // Gate 0/Gate 1.
  let auditSection = '## Production-write / board-pollution audit\n\nSkipped: no prodAuditMarkerPath in run-state.\n';
  if (state.prodAuditMarkerPath) {
    const allSessionIds = events.filter((e) => e.kind === 'child_created' && e.sessionId).map((e) => e.sessionId as string);
    const needles = buildAuditNeedles(state.runId, state.runDir, allSessionIds);
    const audit = await runProductionWriteAudit({ markerPath: state.prodAuditMarkerPath }, needles);
    const board = await boardWhoUnderRunDir(state.runDir);
    auditSection = [
      '## Production-write / board-pollution audit',
      '',
      audit.matches.length === 0
        ? `No leak: ${audit.changedFileCount} file(s) changed under the guarded production roots during the run; none referenced this run (${allSessionIds.length} session ids checked).`
        : `**LEAK DETECTED**: ${JSON.stringify(audit.matches)}`,
      board.ok ? `Board check: ${board.detail}` : `**BOARD POLLUTION**: ${board.detail}`,
    ].join('\n');
  }

  const markdown = `${renderReportMarkdown(report, state.runId)}\n\n${snapshotSection}\n\n${auditSection}`;
  writeFileSync(path.join(state.runDir, 'report.md'), markdown);
  writeFileSync(path.join(state.runDir, 'report.json'), JSON.stringify(report, null, 2));
  await notify('done', `run ${state.runId} complete`, `verdict=${report.verdict} trailingSlope=${report.trailingSlope.slopeMBPerHour.toFixed(2)}MB/h peakHeap=${report.peakHeapMB.toFixed(0)}MB`);

  inspector.close();
}

main().catch(async (error) => {
  console.error('[supervisor] Fatal:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  try { await notify('blocked', 'supervisor crashed', error instanceof Error ? error.message : String(error)); } catch { /* best-effort */ }
  process.exit(1);
});
