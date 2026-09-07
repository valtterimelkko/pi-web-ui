import { describe, expect, it, onTestFinished } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Real-boundary lifecycle regression for the disposable validation server.
 *
 * Defect (INTERNAL-API-CAPACITY-REVIEW-2026-09-07 §3): the launcher recorded a
 * fallback pid as the process group (its /proc read threw on a missing import),
 * so the stopper probed a group that never existed, reported the server "already
 * gone", deleted the record and exited 0 while the real listener stayed up. The
 * earlier synthetic stopper tests never invoked the real launcher, so the
 * mismatch was invisible.
 *
 * These tests exercise the ACTUAL launcher entry (spawned the way operators run
 * it) against the ACTUAL stopper, on fresh disposable directories, and assert
 * on the live listener and process groups — never on the wrapper exit code
 * alone. The harness independently owns every spawned group and cleans it up in
 * `finally`; it never relies on the code-under-test stopper for fixture safety.
 *
 * One lightweight disposable server at a time; no model calls; explicit
 * `--dir` under a private temp root so nothing outside it is written.
 */

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'scripts/validation-server.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('validation-server.ts not found upward of the test');
}

const REPO = findRepoRoot(import.meta.dirname);
const LAUNCHER = path.join(REPO, 'scripts/validation-server.ts');
const STOPPER = path.join(REPO, 'scripts/validation-server-stop.mjs');

/** Own pgid of the current (test-runner) process, so cleanup can never signal it. */
function ownPgid(): number {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
}

const MY_PGID = ownPgid();

interface Launch {
  handle: ChildProcess;
  dir: string;
  output: () => string;
}

/** Spawn the real launcher chain detached; the harness owns the whole group. */
function launchServer(dir: string, extraEnv: Record<string, string> = {}): Launch {
  // Strip the runner's own silencing flags: the spawned launcher is a real
  // operator-style boot and must log its readiness banner like one (the central
  // logger self-silences when VITEST is set — see server/vitest.config.ts).
  const childEnv = { ...process.env } as Record<string, string | undefined>;
  delete childEnv.VITEST;
  delete childEnv.VITEST_LOG;
  delete childEnv.NODE_OPTIONS;
  // Launch exactly the way operators do (package.json validate:server runs
  // `npx tsx scripts/validation-server.ts`): the npm/tsx wrapper chain shares
  // ONE process group — the innermost script is NOT the group leader. That is
  // precisely the chain shape where the old pid-as-pgid fallback produced a
  // false-success teardown, so the test boundary must not flatten it.
  const handle = spawn(
    'npx',
    ['tsx', LAUNCHER, '--dir', dir],
    {
      detached: true,
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...childEnv, ...extraEnv } as NodeJS.ProcessEnv,
    },
  );
  let collected = '';
  handle.stdout?.on('data', (chunk: Buffer) => { collected += chunk.toString(); });
  handle.stderr?.on('data', (chunk: Buffer) => { collected += chunk.toString(); });
  return { handle, dir, output: () => collected };
}

function recordPath(dir: string): string {
  return path.join(dir, 'server-process.json');
}

function tombstonePath(dir: string): string {
  return path.join(dir, 'server-process.stopped.json');
}

interface ServerRecord {
  identityVersion?: number;
  pid?: number;
  pgid?: number;
  pgidSource?: string;
  startTimeTicks?: number;
  port?: number;
  [key: string]: unknown;
}

function readRecord(dir: string): ServerRecord | undefined {
  try {
    return JSON.parse(readFileSync(recordPath(dir), 'utf8')) as ServerRecord;
  } catch {
    return undefined;
  }
}

/** Stat-aware liveness of a process group: zombies do not count. */
function groupAliveByPs(pgid: number): boolean {
  const probe = spawnSync('ps', ['-e', '-o', 'pgid=,stat='], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  return probe.stdout.split('\n').some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\w+)/);
    return match !== null && Number(match[1]) === pgid && !/^[ZX]/.test(match[2]);
  });
}

async function listenerAlive(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

/**
 * Wait until the disposable server is really listening: the Unix socket exists
 * and the server itself reported its bound port in the combined output.
 */
async function waitForReady(launch: Launch, timeoutMs = 120_000): Promise<number> {
  await waitFor(() => existsSync(path.join(launch.dir, 'internal-api.sock')), timeoutMs, 'internal-api.sock');
  await waitFor(() => /running on port (\d+)/.test(launch.output()), timeoutMs, 'server "running on port" banner');
  const port = Number(launch.output().match(/running on port (\d+)/)?.[1]);
  expect(Number.isInteger(port) && port > 0, `parsed a real bound port from output: ${launch.output().slice(-600)}`).toBe(true);
  await waitFor(async () => listenerAlive(port), 15_000, 'TCP listener to accept connections');
  return port;
}

/** Harness-owned bounded teardown of a spawned group. Never signals our own group. */
function killGroupBounded(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === MY_PGID) return;
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pgid, sig); } catch { /* ESRCH — already gone */ }
  };
  signal('SIGTERM');
  const termDeadline = Date.now() + 2000;
  while (groupAliveByPs(pgid) && Date.now() < termDeadline) {
    spawnSync('sleep', ['0.2']);
  }
  if (groupAliveByPs(pgid)) {
    signal('SIGKILL');
    const killDeadline = Date.now() + 2000;
    while (groupAliveByPs(pgid) && Date.now() < killDeadline) {
      spawnSync('sleep', ['0.1']);
    }
  }
}

/**
 * Independent fixture safety net: TERM/KILL the launcher group we spawned and
 * any group a live-format record still names, then remove the directory. This
 * deliberately does NOT go through the stopper under test.
 */
function harnessCleanup(launch: Launch): void {
  try {
    killGroupBounded(launch.handle.pid!);
    const record = readRecord(launch.dir);
    if (record && typeof record.pgid === 'number' && record.pgid !== launch.handle.pid) {
      killGroupBounded(record.pgid);
    }
  } finally {
    rmSync(launch.dir, { recursive: true, force: true });
  }
}

function runStopper(dir: string, timeoutMs = 10_000) {
  return spawnSync(process.execPath, [STOPPER, '--dir', dir, '--timeout-ms', String(timeoutMs)], { encoding: 'utf8' });
}

describe('validation-server lifecycle (real launcher → real stopper)', () => {
  it('stopper ends the real listener after the launcher records a verified dedicated group', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vslife-regression-'));
    const launch = launchServer(dir);
    let stopped = false;
    onTestFinished(() => { harnessCleanup(launch); });

    const port = await waitForReady(launch);
    expect(await listenerAlive(port), 'server is listening before teardown').toBe(true);

    const record = readRecord(dir);
    expect(record, 'launcher wrote a server-process.json record before readiness').toBeDefined();

    const stop = runStopper(dir);
    expect(
      stop.status,
      `stopper must succeed against a real running server; stdout=${stop.stdout} stderr=${stop.stderr}`,
    ).toBe(0);
    stopped = true;
    expect(stop.stdout, 'stopper must claim verified teardown, not "already gone", for a live server').toMatch(/terminated and verified gone/);

    // The core regression: a success exit must mean the LISTENER is really gone.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await listenerAlive(port), 'listener must be gone after a successful stop').toBe(false);

    // Identity contract: the record named a verified dedicated group whose
    // leader is the server itself — not a fallback pid guess.
    expect(record?.identityVersion, `record must carry identityVersion 1 (dedicated-group era); got ${JSON.stringify(record)}`).toBe(1);
    expect(record?.pgidSource, 'record must state its pgid was verified, not guessed').toBe('verified-dedicated-group-leader');
    expect(record?.pgid, 'record pgid must be the dedicated group of the recorded leader pid').toBe(record?.pid);
    expect(record?.pid, 'record pid must be a real process id (> 1)').toBeGreaterThan(1);

    expect(existsSync(recordPath(dir)), 'live record is removed after verified teardown').toBe(false);
    expect(existsSync(tombstonePath(dir)), 'a stop tombstone preserves the teardown evidence').toBe(true);
    expect(stopped, 'sanity').toBe(true);
  }, 180_000);

  it('survives three bounded launch→stop cycles including wrapper-forwarded cancel, a TERM-ignoring group member, and an idempotent repeat stop', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'vslife-cycles-'));
    onTestFinished(() => rmSync(tmpRoot, { recursive: true, force: true }));

    const cycleDirs = [1, 2, 3].map((n) => path.join(tmpRoot, `cycle-${n}`));

    // ── Cycle 1: launch → ready → stopper stop → everything verified gone ──
    {
      const launch = launchServer(cycleDirs[0]);
      onTestFinished(() => harnessCleanup(launch));
      const port = await waitForReady(launch);
      const record = readRecord(cycleDirs[0]);
      expect(record?.identityVersion).toBe(1);
      expect(record?.pgid).toBe(record?.pid);
      expect(groupAliveByPs(record!.pgid!), 'dedicated group is alive while the server runs').toBe(true);

      const stop = runStopper(cycleDirs[0]);
      expect(stop.status, `stopper stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await listenerAlive(port), 'cycle 1: listener gone after stop').toBe(false);
      expect(groupAliveByPs(record!.pgid!), 'cycle 1: owned group gone after stop').toBe(false);
      expect(existsSync(recordPath(cycleDirs[0])), 'cycle 1: live record removed').toBe(false);
      expect(existsSync(tombstonePath(cycleDirs[0])), 'cycle 1: tombstone written').toBe(true);
    }

    // ── Cycle 2: cancel path — SIGINT to the launcher wrapper must forward a
    // bounded teardown to the dedicated group and leave the listener gone. ──
    {
      const launch = launchServer(cycleDirs[1]);
      onTestFinished(() => harnessCleanup(launch));
      const port = await waitForReady(launch);
      const record = readRecord(cycleDirs[1]);
      expect(record?.pgid).toBe(record?.pid);

      launch.handle.kill('SIGINT');
      // A terminal Ctrl-C is delivered to the whole foreground process group
      // (npm/npx do not forward single-process signals), so cancel the same
      // way: SIGINT to the launcher chain's group. The server sits in its own
      // dedicated group and must die only via the wrapper's forwarded stop.
      process.kill(-launch.handle.pid!, 'SIGINT');
      // The truthful outcomes: the listener dies, the dedicated group drains,
      // the live record is replaced by a tombstone, and the chain exits.
      const cancelDeadline = Date.now() + 30_000;
      while (Date.now() < cancelDeadline && await listenerAlive(port)) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await listenerAlive(port), 'cycle 2: listener gone after wrapper-forwarded cancel').toBe(false);
      expect(groupAliveByPs(record!.pgid!), 'cycle 2: dedicated group gone after cancel').toBe(false);
      expect(existsSync(recordPath(cycleDirs[1])), 'cycle 2: live record removed after cancel').toBe(false);
      expect(existsSync(tombstonePath(cycleDirs[1])), 'cycle 2: tombstone preserves the forwarded stop').toBe(true);
      const chainExit = await Promise.race([
        new Promise<'exited'>((resolve) => {
          // The chain may already have exited while the truths above ran —
          // check state first, then subscribe (a late once('exit') never fires).
          if (launch.handle.exitCode !== null || launch.handle.signalCode !== null) {
            resolve('exited');
            return;
          }
          launch.handle.once('exit', () => resolve('exited'));
        }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
      ]);
      expect(chainExit, 'cycle 2: launcher chain must exit after the cancel (not hang)').toBe('exited');
    }

    // ── Cycle 3: a bounded TERM-ignoring member joins the dedicated group (via
    // the launcher's validation-only noise hook); the stopper must still verify
    // the WHOLE group gone (TERM then KILL escalation), and an immediate repeat
    // stop must truthfully report already-stopped instead of failing or
    // pretending to stop something. ──
    {
      const launch = launchServer(cycleDirs[2], { PI_WEB_UI_VALIDATION_TEST_NOISE: '1' });
      onTestFinished(() => harnessCleanup(launch));
      const port = await waitForReady(launch);
      const record = readRecord(cycleDirs[2]);
      expect(record?.pgid).toBe(record?.pid);

      const stop = runStopper(cycleDirs[2], 15_000);
      expect(stop.status, `stopper stdout=${stop.stdout} stderr=${stop.stderr}`).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await listenerAlive(port), 'cycle 3: listener gone despite TERM-ignoring member').toBe(false);
      expect(groupAliveByPs(record!.pgid!), 'cycle 3: whole owned group (incl. TERM-ignoring member) gone').toBe(false);

      // Idempotent repeat: a second stop against the stopped directory must
      // succeed truthfully from the preserved tombstone evidence.
      const repeat = runStopper(cycleDirs[2]);
      expect(repeat.status, `repeat stopper stdout=${repeat.stdout} stderr=${repeat.stderr}`).toBe(0);
      expect(repeat.stdout, 'repeat stop must report the recorded stop, not a fresh teardown').toMatch(/already stopped/);
    }
  }, 420_000);
});
