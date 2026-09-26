/**
 * Gate 0 — preflight. See scripts/heap-soak/README.md for the checklist this
 * mirrors. Every check is real (live systemd unit, live CDP inspector, live
 * Internal API socket) — nothing here is mocked.
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { launchDisposableServer } from './launcher.js';
import { teardownUnits, assertUnitsAbsent, deleteRunDir } from './teardown.js';
import { computeChecksums } from './checksum-io.js';
import { getFreeDiskGB } from './disk-io.js';
import { notify } from './telegram.js';
import { InspectorClient, assertInspectorLoopbackOnly } from './inspector.js';
import { runChildWithDeadline } from './driver.js';
import { productionGuardedPaths, diffChecksums } from '../../server/src/live-validation/heap-soak/isolation.js';
import { hasEnoughFreeDisk } from '../../server/src/live-validation/heap-soak/disk.js';
import { parseHeapSnapshotSummary } from '../../server/src/live-validation/heap-soak/snapshot-parse.js';
import { LANE_DEFINITIONS, enabledLanes } from '../../server/src/live-validation/heap-soak/lanes.js';
import { DEFAULT_WAVE_TARGET_CONFIG } from '../../server/src/live-validation/heap-soak/types.js';
import path from 'node:path';

export interface Gate0Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

export interface Gate0Result {
  runId: string;
  checks: Gate0Check[];
  passed: boolean; // all `required` checks ok
}

export async function runGate0(): Promise<Gate0Result> {
  const runId = `preflight-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const checks: Gate0Check[] = [];
  const record = (name: string, ok: boolean, detail: string, required = true) => checks.push({ name, ok, detail, required });

  const prodPaths = productionGuardedPaths(homedir());
  const before = computeChecksums(prodPaths);

  let launch: Awaited<ReturnType<typeof launchDisposableServer>> | undefined;
  try {
    // Isolation assertions happen inside launchDisposableServer(); if it
    // throws, that itself is the isolation-check failure.
    launch = await launchDisposableServer(runId, 'micro'); // reuse the micro schedule's totalMs for the run-state window; preflight doesn't run the schedule
    record('isolation: run dir + agent dir outside production paths', true, `runDir=${launch.paths.runDir}`);
    record('disposable server boots under systemd-run', true, `unit=${launch.serverUnit} pid=${launch.serverMainPid}`);

    const loopback = await assertInspectorLoopbackOnly(launch.inspectorPort).then((addr) => ({ ok: true, addr })).catch((e) => ({ ok: false, addr: String(e) }));
    record('inspector reachable on 127.0.0.1 only', loopback.ok, loopback.addr);

    const inspector = await InspectorClient.connect(launch.inspectorPort);
    await inspector.enable();
    try {
      await inspector.collectGarbage();
      const mem = await inspector.readMemoryUsage();
      record('forced GC works + post-GC reading', Number.isFinite(mem.heapUsed) && mem.heapUsed > 0, `heapUsed=${mem.heapUsed} bytes`);

      const snapshotPath = path.join(launch.paths.runDir, 'preflight.heapsnapshot');
      const snap = await inspector.takeHeapSnapshot(snapshotPath);
      const parsed = parseHeapSnapshotSummary(readFileSync(snapshotPath, 'utf8'));
      record('small heap snapshot writes and parses', parsed.nodeCount > 0, `chunks=${snap.chunkCount} bytes=${snap.bytesWritten} nodeCount=${parsed.nodeCount}`);
    } finally {
      inspector.close();
    }

    const freeGB = await getFreeDiskGB(launch.paths.runDir);
    record('disk check', hasEnoughFreeDisk(freeGB), `${freeGB.toFixed(1)}GB free`);

    const ping = await notify('milestone', 'preflight', `run ${runId}`);
    record('telegram test ping accepted', ping.ok, ping.stdout.trim() || ping.stderr.trim() || '(no output captured)');

    // Lane end-to-end checks. Lane A (backbone) is REQUIRED; B/C are best-effort.
    const lanes = enabledLanes(LANE_DEFINITIONS);
    for (const lane of lanes) {
      const result = await runChildWithDeadline(
        {
          client: launch.client,
          runId,
          childWorkspaceRoot: launch.paths.childWorkspaceRoot,
          lanes,
          waveTargetConfig: DEFAULT_WAVE_TARGET_CONFIG,
          logEvent: () => {},
          runStartMs: Date.now(),
        },
        lane,
        lane.modelIds[0],
        DEFAULT_WAVE_TARGET_CONFIG.childTurnDeadlineMs,
      );
      const label = `lane ${lane.name} (${lane.label}) end-to-end child`;
      if (lane.isBackbone) {
        record(label, result.success, result.success ? `sessionId=${result.sessionId}` : `FAILED: ${result.reason ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}`, true);
      } else {
        record(label, true /* never fails the gate */, result.success ? 'pass' : `best-effort ${result.timedOut ? 'SLOW/timeout' : 'FAIL'}: ${result.reason ?? 'unknown'} (does not fail Gate 0)`, false);
      }
    }
    for (const lane of LANE_DEFINITIONS.filter((l) => !l.enabled)) {
      record(`lane ${lane.name} disabled`, true, lane.disabledReason ?? 'disabled', false);
    }
  } finally {
    if (launch) {
      const teardown = await teardownUnits(launch.serverUnit, launch.supervisorUnit);
      record('teardown: server unit gone', teardown.serverGone, launch.serverUnit);
      record('teardown: supervisor unit gone', teardown.supervisorGone, launch.supervisorUnit);
      try {
        await assertUnitsAbsent(launch.serverUnit, launch.supervisorUnit);
        record('teardown: units verified absent', true, 'ok');
      } catch (error) {
        record('teardown: units verified absent', false, error instanceof Error ? error.message : String(error));
      }
      deleteRunDir(launch.paths.runDir);
    }
  }

  const after = computeChecksums(prodPaths);
  const mismatches = diffChecksums(before, after);
  record('no production file changed (checksum before/after)', mismatches.length === 0, mismatches.length === 0 ? 'ok' : JSON.stringify(mismatches));

  const passed = checks.filter((c) => c.required).every((c) => c.ok);
  return { runId, checks, passed };
}
