#!/usr/bin/env node
/**
 * Stop a disposable validation server by terminating its whole process group.
 *
 * Defect 12 (Part 3 open defects): at closure the disposable validation server
 * was reported stopped, but terminating only the npm parent left the server's
 * subprocesses orphaned in their process group on a supervised host. The full
 * group then had to be terminated by hand and stale scratch files removed.
 *
 * This stopper reads the server-process.json record the validation-server
 * wrapper writes into its directory and terminates THAT known pid's process
 * group: SIGTERM, a bounded wait, then SIGKILL, then verification. It never
 * matches processes by command line (a recorded production boundary violation
 * during Experiment A) and never touches anything outside the recorded group.
 *
 * usage: node scripts/validation-server-stop.mjs --dir /path/to/validation-dir [--timeout-ms 8000]
 */
import { readFileSync, rmSync, existsSync } from 'node:fs';
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
if (!existsSync(recordPath)) {
  console.error(`validation-server-stop: no server-process.json in ${dir} — nothing recorded to stop.`);
  process.exit(0);
}

let record;
try {
  record = JSON.parse(readFileSync(recordPath, 'utf8'));
} catch (error) {
  console.error(`validation-server-stop: malformed server-process.json: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const pgid = Number(record.pgid);
if (!Number.isInteger(pgid) || pgid <= 1) {
  console.error(`validation-server-stop: refusing to act on non-integer or unsafe process group id: ${record.pgid}`);
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

if (!groupAlive()) {
  console.log(`validation-server-stop: process group ${pgid} already gone.`);
  rmSync(recordPath, { force: true });
  process.exit(0);
}

killGroup('SIGTERM');
const deadline = Date.now() + timeoutMs;
while (groupAlive() && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (groupAlive()) {
  killGroup('SIGKILL');
  const hardDeadline = Date.now() + 2000;
  while (groupAlive() && Date.now() < hardDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (groupAlive()) {
  console.error(`validation-server-stop: process group ${pgid} still alive after SIGKILL — investigate manually (do NOT broad-match processes).`);
  process.exit(1);
}
console.log(`validation-server-stop: process group ${pgid} terminated and verified gone.`);
rmSync(recordPath, { force: true });
process.exit(0);
