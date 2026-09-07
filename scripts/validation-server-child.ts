/**
 * Dedicated-process-group child entry for the disposable validation server.
 *
 * Capacity review 2026-09-07 §3: the previous launcher imported the server
 * in-process and recorded a fallback `process.pid` as the process group (its
 * /proc read threw on a missing import and the error was swallowed). Under the
 * real npm/tsx chain that pid is NOT a group leader, so the stopper probed a
 * group that never existed, reported "already gone", deleted the record and
 * exited 0 while the real listener stayed up.
 *
 * This entry is spawned DETACHED by scripts/validation-server.ts, which makes
 * it the leader of a brand-new process group (pgid == pid). It refuses to run
 * otherwise — there is deliberately no fallback identity: teardown may only
 * ever target a group this server verifiably owns and leads.
 *
 * Verification happens through /proc before anything is recorded:
 *   - pgrp must equal this pid (dedicated group leader);
 *   - the record carries the leader's /proc starttime so the stopper can
 *     detect a stale record whose pid was later reused.
 *
 * Validation-only hooks (never set by operator flows):
 *   PI_WEB_UI_VALIDATION_TEST_NOISE=1 spawns one bounded SIGTERM-ignoring
 *     member inside the dedicated group so lifecycle tests can prove the
 *     stopper's KILL escalation. Its lifetime is capped by
 *     PI_WEB_UI_VALIDATION_TEST_NOISE_TTL_MS (default 600000 ms; accepted
 *     range 1000–3600000, invalid values fall back to the default) so it can
 *     never linger indefinitely.
 *   PI_WEB_UI_VALIDATION_CHILD_EXIT_AFTER_RECORD=1 exits immediately after
 *     the identity record is written, so exit-handler semantics can be tested
 *     against a real child without booting the server.
 *
 * Env contract (set by the wrapper):
 *   PI_WEB_UI_VALIDATION_SERVER_CHILD = '1' — re-entry guard
 *   PI_WEB_UI_VALIDATION_RECORD_DIR   — validation directory for the records
 *   PI_WEB_UI_VALIDATION_BOUND_PORT   — the reserved primary port (record only)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

function fail(message: string, code = 2): never {
  console.error(`[validation-server-child] ${message}`);
  process.exit(code);
}

function blockingWait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Live non-zombie members of our group, excluding this process itself. */
function liveGroupMembersExcludingSelf(pgid: number): number[] {
  try {
    const probe = spawnSync('ps', ['-e', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' });
    if (probe.status !== 0) return [];
    const members: number[] = [];
    for (const line of probe.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\w+)$/);
      if (match === null) continue;
      const memberPid = Number(match[1]);
      const memberPgid = Number(match[2]);
      if (memberPgid === pgid && memberPid !== process.pid && !/^[ZX]/.test(match[3])) {
        members.push(memberPid);
      }
    }
    return members;
  } catch {
    return [];
  }
}

const recordDir = process.env.PI_WEB_UI_VALIDATION_RECORD_DIR;
if (process.env.PI_WEB_UI_VALIDATION_SERVER_CHILD !== '1') {
  fail('must be spawned by scripts/validation-server.ts (re-entry guard), not run directly.');
}
if (!recordDir || !existsSync(recordDir)) {
  fail('PI_WEB_UI_VALIDATION_RECORD_DIR must point at the existing validation directory.');
}
const boundPort = Number(process.env.PI_WEB_UI_VALIDATION_BOUND_PORT);
if (!Number.isInteger(boundPort) || boundPort <= 0) {
  fail('PI_WEB_UI_VALIDATION_BOUND_PORT must be the reserved validation port.');
}

// Linux: after the "(comm)" field, the remaining fields start at overall field
// 3 (state). pgrp is overall field 5 => index 2; starttime is overall field
// 22 => index 19 of the post-comm array.
let pgrp = -1;
let startTimeTicks = -1;
try {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  pgrp = Number(fields[2]);
  startTimeTicks = Number(fields[19]);
} catch (error) {
  fail(`cannot read /proc identity: ${error instanceof Error ? error.message : String(error)}`, 3);
}
if (!Number.isInteger(pgrp) || pgrp !== process.pid) {
  fail(
    `refusing to serve from an inherited process group (pid=${process.pid}, pgrp=${pgrp}): ` +
    'the launcher must spawn this entry detached so teardown owns a dedicated, verifiable group.',
    3,
  );
}

const liveRecordPath = path.join(recordDir, 'server-process.json');
const tombstonePath = path.join(recordDir, 'server-process.stopped.json');

const record = {
  identityVersion: 1,
  pid: process.pid,
  pgid: pgrp,
  pgidSource: 'verified-dedicated-group-leader',
  startTimeTicks,
  startedAt: new Date().toISOString(),
  port: boundPort,
  validationDir: recordDir,
};
writeFileSync(liveRecordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

process.once('exit', () => {
  // A process exit proves nothing about group/descendant quiescence (a
  // SIGTERM-ignoring helper or a slow esbuild service can outlive the leader).
  // Only a verified-quiet group may exchange the live record for a stop
  // tombstone; an uncertain exit PRESERVES the identity record so recovery and
  // ownership investigation remain possible, and never mints a success file.
  let remaining = liveGroupMembersExcludingSelf(pgrp);
  for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt += 1) {
    // Bounded grace for fast-dying members (e.g. esbuild services); sync waits
    // only — this runs inside the exit handler.
    blockingWait(300);
    remaining = liveGroupMembersExcludingSelf(pgrp);
  }
  if (remaining.length === 0) {
    try {
      rmSync(liveRecordPath, { force: true });
    } catch { /* best effort */ }
    try {
      const tombstone = {
        identityVersion: 1,
        pid: record.pid,
        pgid: record.pgid,
        stoppedAt: new Date().toISOString(),
        outcome: 'server-process-exit',
      };
      writeFileSync(tombstonePath, `${JSON.stringify(tombstone, null, 2)}\n`, { mode: 0o600 });
    } catch { /* best effort */ }
    return;
  }
  console.error(
    `[validation-server-child] exiting with live group members remaining ` +
    `(pids ${remaining.join(', ')}) — live record and identity PRESERVED at ${liveRecordPath} ` +
    'for recovery; no stop tombstone written (stop outcome unverified).',
  );
});

// Validation-only bounded-lifetime noise member (see header): ignores SIGTERM
// so lifecycle tests can prove KILL escalation, and hard-exits after its TTL
// so it can never linger indefinitely. The TTL is a validation-only knob with
// a documented safe range; invalid values fall back to the default cap.
let noiseSpawned: Promise<void> = Promise.resolve();
if (process.env.PI_WEB_UI_VALIDATION_TEST_NOISE === '1') {
  const rawTtl = Number(process.env.PI_WEB_UI_VALIDATION_TEST_NOISE_TTL_MS);
  const noiseTtlMs = Number.isInteger(rawTtl) && rawTtl >= 1000 && rawTtl <= 3_600_000 ? rawTtl : 600_000;
  const noise = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 500); setTimeout(() => process.exit(0), ${noiseTtlMs}).unref();`],
    { stdio: 'ignore' },
  );
  noise.unref();
  noiseSpawned = new Promise<void>((resolve) => {
    noise.once('spawn', () => resolve());
    // Fallback: never block the validation hook on a lost spawn event.
    const fallback = setTimeout(() => resolve(), 2000);
    fallback.unref();
  });
}

// Validation-only hook: exit immediately after the record is written, so the
// exit-handler semantics (evidence preservation vs tombstone) can be tested
// against a real child process without booting the whole server. The exit is
// deferred until the noise helper has actually spawned (spawn() is async on
// the event loop) plus one scheduler beat, so the descendant is established
// in the process table before the exit handler probes it.
if (process.env.PI_WEB_UI_VALIDATION_CHILD_EXIT_AFTER_RECORD === '1') {
  console.error('[validation-server-child] validation hook: exiting after record write.');
  // A real, REFERENCED timer: the event loop must stay alive and keep running
  // until this fires, so the pending helper spawn completes its fork and is
  // visible in the process table before this process exits.
  const hookExit = setTimeout(() => process.exit(0), 150);
} else {
  // Load the real server in-process, exactly like the previous single-process
  // launcher did. The wrapper's flags never reach this argv, so the server
  // sees a clean command line. (No top-level await: tsx transpiles
  // scripts/*.ts as CJS.)
  import('../server/src/index.js').catch((error) => {
    console.error('[validation-server-child] server boot failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}

