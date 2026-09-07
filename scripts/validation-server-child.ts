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
 * Validation-only hook: PI_WEB_UI_VALIDATION_TEST_NOISE=1 spawns one bounded
 * SIGTERM-ignoring member inside the dedicated group so lifecycle tests can
 * prove the stopper's KILL escalation against the real chain. It holds no
 * ports, is never set by operator flows, and dies with the group.
 *
 * Env contract (set by the wrapper):
 *   PI_WEB_UI_VALIDATION_SERVER_CHILD = '1' — re-entry guard
 *   PI_WEB_UI_VALIDATION_RECORD_DIR   — validation directory for the records
 *   PI_WEB_UI_VALIDATION_BOUND_PORT   — the reserved primary port (record only)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

function fail(message: string, code = 2): never {
  console.error(`[validation-server-child] ${message}`);
  process.exit(code);
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
});

if (process.env.PI_WEB_UI_VALIDATION_TEST_NOISE === '1') {
  const noise = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 500);"],
    { stdio: 'ignore' },
  );
  noise.unref();
}

// The wrapper resolved ports, state paths and isolation env; this process is
// the verified dedicated group leader and owns the identity record. Load the
// real server in-process, exactly like the previous single-process launcher
// did. The wrapper's flags never reach this argv, so the server sees a clean
// command line. (No top-level await: tsx transpiles scripts/*.ts as CJS.)
import('../server/src/index.js').catch((error) => {
  console.error('[validation-server-child] server boot failed:', error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
