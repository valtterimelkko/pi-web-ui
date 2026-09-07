#!/usr/bin/env node
/**
 * Stop a disposable validation server by terminating its DEDICATED process group.
 *
 * Capacity review 2026-09-07 §3: the previous version trusted any record's
 * pgid. When the launcher had recorded a fallback pid (not a group leader),
 * this stopper probed a group that never existed, reported the server "already
 * gone", deleted the record and exited 0 while the real listener stayed up. A
 * missing record also exited 0.
 *
 * This stopper now acts only on a verified dedicated-group record written by
 * scripts/validation-server-child.mjs:
 *   - identityVersion 1 records name a pgid that equals the recorded leader
 *     pid and carry the leader's /proc starttime, so a stale record or a
 *     reused pid/group is detected BEFORE any signal is sent;
 *   - the stopper's own process group is never a target;
 *   - teardown is bounded: SIGTERM, a wait, SIGKILL, then verification via the
 *     process table — never wrapper exit alone;
 *   - every refusal exits non-zero and PRESERVES the record, so cleanup
 *     ability is never lost;
 *   - a preserved tombstone makes repeat stops truthfully idempotent;
 *   - no record and no tombstone is an explicit failure: unknown ownership is
 *     never reported as stopped, and processes are never matched by command
 *     line.
 *
 * usage: node scripts/validation-server-stop.mjs --dir /path/to/validation-dir [--timeout-ms 8000]
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function arg(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  // A missing value must not silently swallow the next flag.
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

const dir = arg('--dir');
if (!dir) {
  console.error('usage: node scripts/validation-server-stop.mjs --dir <validation-dir> [--timeout-ms N]');
  process.exit(2);
}
const timeoutMs = Number(arg('--timeout-ms') ?? '8000');

const recordPath = path.resolve(dir, 'server-process.json');
const tombstonePath = path.resolve(dir, 'server-process.stopped.json');

/** Overall field 22 (/proc starttime) and field 5 (pgrp), after "(comm)". */
function procFields(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pgrp: Number(fields[2]), startTimeTicks: Number(fields[19]) };
}

function ownProcessGroupId() {
  try {
    return procFields(process.pid).pgrp;
  } catch {
    // Fall back to the process table rather than guessing.
    const probe = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' });
    const parsed = Number(probe.stdout?.trim());
    return Number.isInteger(parsed) ? parsed : process.pid;
  }
}

const writeTombstone = (pid, pgid, outcome) => {
  try {
    const tombstone = {
      identityVersion: 1,
      pid,
      pgid,
      stoppedAt: new Date().toISOString(),
      outcome,
    };
    writeFileSync(tombstonePath, `${JSON.stringify(tombstone, null, 2)}\n`, { mode: 0o600 });
  } catch { /* best effort — the live record above is the primary evidence */ }
};

if (!existsSync(recordPath)) {
  if (existsSync(tombstonePath)) {
    let detail = '';
    try {
      const tombstone = JSON.parse(readFileSync(tombstonePath, 'utf8'));
      detail = ` (stopped at ${tombstone.stoppedAt}, outcome: ${tombstone.outcome})`;
    } catch { /* tombstone unreadable — still evidence a stop happened */ }
    console.log(`validation-server-stop: server already stopped${detail}.`);
    process.exit(0);
  }
  console.error(
    `validation-server-stop: no server-process.json in ${dir} and no stop tombstone — ` +
    'ownership of any listening process cannot be established, so this is NOT reported as stopped. ' +
    'If a server is still listening, identify it via its validation directory or port (never broad command-line matching).',
  );
  process.exit(1);
}

let record;
try {
  record = JSON.parse(readFileSync(recordPath, 'utf8'));
} catch (error) {
  console.error(`validation-server-stop: malformed server-process.json (preserved): ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Identity gate: only records written by the verified dedicated-group child
// entry are actionable. Old-format records (pid-as-pgid fallback era) must not
// be acted on — their pgid was a guess, which is exactly how teardown used to
// report false success.
if (record.identityVersion !== 1 || record.pgidSource !== 'verified-dedicated-group-leader') {
  console.error(
    'validation-server-stop: record predates verified dedicated-group identity (or is unrecognised) — refusing to act. ' +
    'Inspect the validation directory manually; remove the record only once no validation server is listening.',
  );
  process.exit(1);
}

const pid = Number(record.pid);
const pgid = Number(record.pgid);
const startTimeTicks = Number(record.startTimeTicks);
if (!Number.isInteger(pid) || !Number.isInteger(pgid) || pid <= 1 || pgid <= 1 || pid !== pgid || !Number.isInteger(startTimeTicks) || startTimeTicks <= 0) {
  console.error(`validation-server-stop: refusing to act on an unsafe process group identity in the record: ${JSON.stringify(record)}`);
  process.exit(1);
}

const myPgid = ownProcessGroupId();
if (pgid === myPgid || pid === process.pid) {
  console.error(`validation-server-stop: refusing to signal — the recorded group ${pgid} is this stopper's own process group.`);
  process.exit(1);
}

const groupAlive = () => {
  // kill(-pgid, 0) cannot distinguish a dead-but-unreaped (zombie) member from
  // a live one, and zombies persist until their parent reaps them — a killed
  // group would verify as alive. ps gives the process state directly.
  try {
    const probe = spawnSync('ps', ['-e', '-o', 'pgid=,stat='], { encoding: 'utf8' });
    if (probe.status === 0) {
      return probe.stdout.split('\n').some((line) => {
        const match = line.trim().match(/^(\d+)\s+(\w+)/);
        return match !== null && Number(match[1]) === pgid && !/^[ZX]/.test(match[2]);
      });
    }
  } catch { /* fall through to the signal probe */ }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
};

const killGroup = (signal) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // EPERM on a dying group is not fatal; verification decides.
    return true;
  }
};

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

if (!groupAlive()) {
  // Safe to declare only because the record named a verified dedicated group:
  // an empty group needs no signal, and the pid-reuse risk never materialises
  // because nothing is signalled.
  console.log(`validation-server-stop: process group ${pgid} (leader pid ${pid}) already gone.`);
  rmSync(recordPath, { force: true });
  writeTombstone(pid, pgid, 'already-gone');
  process.exit(0);
}

// The group is live: verify ownership through /proc before signalling, so a
// stale record or a reused pid/group can never redirect these signals.
try {
  const current = procFields(pid);
  if (current.pgrp !== pgid) {
    console.error(
      `validation-server-stop: recorded leader pid ${pid} no longer leads group ${pgid} ` +
      `(now ${current.pgrp}) — stale or reused record, refusing to signal. Record preserved.`,
    );
    process.exit(1);
  }
  if (current.startTimeTicks !== startTimeTicks) {
    console.error(
      `validation-server-stop: recorded leader pid ${pid} was reused since the record was written ` +
      '(starttime mismatch) — refusing to signal. Record preserved.',
    );
    process.exit(1);
  }
} catch {
  console.error(
    `validation-server-stop: recorded leader pid ${pid} is gone but group ${pgid} still has live members — ` +
    'a leaderless group cannot be verified as ours; investigate manually (do NOT broad-match processes). Record preserved.',
  );
  process.exit(1);
}

killGroup('SIGTERM');
const deadline = Date.now() + timeoutMs;
while (groupAlive() && Date.now() < deadline) {
  sleepSync(200);
}
if (groupAlive()) {
  killGroup('SIGKILL');
  const hardDeadline = Date.now() + 2000;
  while (groupAlive() && Date.now() < hardDeadline) {
    sleepSync(100);
  }
}
if (groupAlive()) {
  console.error(`validation-server-stop: process group ${pgid} still alive after SIGKILL — investigate manually (do NOT broad-match processes). Record preserved.`);
  process.exit(1);
}
console.log(`validation-server-stop: process group ${pgid} terminated and verified gone.`);
rmSync(recordPath, { force: true });
writeTombstone(pid, pgid, 'stopped-by-stopper');
process.exit(0);
