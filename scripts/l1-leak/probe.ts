/**
 * L1 reproduction probe — drives the production leak shapes against a real
 * GLM goal child on the disposable k-l1 server and records /capacity against
 * the non-terminal receipts over time.
 *
 * Shapes (from the 2026-10-03 production evidence, brief L1):
 *   W  watch-wake follow_up into a busy, silent goal turn  (own admission lease)
 *   A  abort of a busy session                             (cancelSession → drain)
 *   S  detached steer into the busy turn                   (joined, lease-less — control)
 *   Q  detached queued follow_up via the prompt path       (lease-less — control)
 *
 * Usage:
 *   node --import tsx scripts/l1-leak/probe.ts --run-id l1-r1 [--wedge-seconds 420]
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveRunPaths } from './paths.ts';

const execFile = promisify(execFileCb);
const PI_ORCH_BIN = '/root/pi-orch/bin/pi-orch';

const WEDGE_SECONDS = Number(process.argv[process.argv.indexOf('--wedge-seconds') + 1] ?? 420) || 420;
const SAMPLE_INTERVAL_MS = 5_000;
const SETTLE_MS = 3 * 60_000;

interface OrchTarget { socketPath: string; tokenPath: string }

function internalApiRequest<T>(socketPath: string, tokenPath: string, method: string, apiPath: string, body?: unknown, timeoutMs = 15_000): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath,
      path: `/api/v1${apiPath}`,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        authorization: `Bearer ${readFileSync(tokenPath, 'utf8').trim()}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = undefined;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json: json as T });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${apiPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function piOrch(args: string[], timeoutMs = 180_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout } = await execFile(PI_ORCH_BIN, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}

interface RunReceiptLite { runId: string; status: string; mode?: string; dispatchMode?: string; errorCode?: string | null }

interface CapacityLite {
  activeTurns?: number;
  quarantinedRuns?: number;
  stalledRuns?: number;
  draining?: unknown;
  reason?: string | null;
  available?: boolean;
}

async function sample(target: OrchTarget, sessionId: string): Promise<{ capacity: CapacityLite; nonTerminal: RunReceiptLite[]; receipts: RunReceiptLite[] }> {
  const cap = await internalApiRequest<CapacityLite>(target.socketPath, target.tokenPath, 'GET', '/capacity');
  const ev = await internalApiRequest<{ runReceipts?: RunReceiptLite[] }>(target.socketPath, target.tokenPath, 'GET', `/sessions/${sessionId}/evidence?expand=runs&limit=100`, undefined, 20_000);
  const receipts = ev.json?.runReceipts ?? [];
  return {
    capacity: cap.json,
    receipts,
    nonTerminal: receipts.filter((r) => ['accepted', 'queued', 'started'].includes(r.status)),
  };
}

async function waitUntilSustainedBusy(target: OrchTarget, sessionId: string, timeoutMs: number, requiredSamples = 9): Promise<boolean> {
  // The goal-template turn right after spawn is busy for only a few seconds;
  // the objective's silent wedge command is busy for minutes. Require
  // consecutive busy samples so the shapes fire inside the WEDGE turn.
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const { json } = await internalApiRequest<{ busy?: boolean; status?: string }>(target.socketPath, target.tokenPath, 'GET', `/sessions/${sessionId}/info`).catch(() => ({ status: 0, json: {} as { busy?: boolean } }));
    consecutive = json.busy ? consecutive + 1 : 0;
    if (consecutive >= requiredSamples) return true;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return false;
}

async function main(): Promise<void> {
  const runIdFlag = process.argv.indexOf('--run-id');
  const runId = runIdFlag > 0 ? process.argv[runIdFlag + 1] : 'l1-r1';
  const serverRunIdFlag = process.argv.indexOf('--server-run-id');
  const serverRunId = serverRunIdFlag > 0 ? process.argv[serverRunIdFlag + 1] : runId;
  const paths = resolveRunPaths(runId);
  mkdirSync(paths.evidenceDir, { recursive: true, mode: 0o700 });
  const serverPaths = resolveRunPaths(serverRunId);
  const socketPath = path.join(serverPaths.validationDir, 'internal-api.sock');
  const tokenPath = path.join(serverPaths.validationDir, 'internal-api-token');
  const target: OrchTarget = { socketPath, tokenPath };
  const timelinePath = path.join(paths.evidenceDir, 'timeline.jsonl');
  const eventsPath = path.join(paths.evidenceDir, 'probe-events.log');
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    appendFileSync(eventsPath, stamped + '\n');
  };

  // Scratch repo for the child (fresh worktree-like working directory).
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'l1-leak-repo-'));
  await execFile('git', ['init', '-q'], { cwd: repoDir });
  writeFileSync(path.join(repoDir, 'TASK.md'), 'L1 leak reproduction scratch task.\n');
  await execFile('git', ['add', '-A'], { cwd: repoDir });
  await execFile('git', ['-c', 'user.name=l1-probe', '-c', 'user.email=l1-probe@invalid', 'commit', '-qm', 'scratch'], { cwd: repoDir });

  const objective = `Run exactly this one command in the foreground and wait for it to finish (about ${Math.round(WEDGE_SECONDS / 60)} minutes; that is intended; do not poll it and do not run anything else while it runs): bash -lc 'for i in $(seq 1 ${WEDGE_SECONDS}); do sleep 1; done; echo wedge-window-complete'. When it has finished, append the line DONE to progress.md, commit, and end your turn with the completion block.`;

  const spawnArgs = [
    'spawn', '--runtime', 'pi',
    '--cwd', repoDir,
    '--model-selector', 'zai/glm-5.3-flash',
    '--thinking', 'high',
    '--owner', 'l1-leak-probe',
    '--ttl', '86400',
    '--label', 'l1-leak-child',
    '--goal-objective', objective,
    '--goal-max-turns', '10',
    '--goal-budget-tokens', '120000',
    '--route-limit', 'zai/glm-5.3-flash=8',
    '--id-only', '--json',
    '--socket', socketPath, '--token-path', tokenPath,
  ];
  log('spawning goal child A via pi-orch…');
  const spawned = await piOrch(spawnArgs, 240_000);
  if (spawned.exitCode !== 0) throw new Error(`pi-orch spawn failed (${spawned.exitCode}): ${(spawned.stderr || spawned.stdout).slice(0, 500)}`);
  const childA = (spawned.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0];
  if (!childA) throw new Error(`no session id in spawn output: ${spawned.stdout.slice(0, 300)}`);
  log(`child A (goal, wedge): ${childA}`);

  // Watch subject B: a plain Pi session (never prompted). pi-orch spawn without a goal.
  const spawnedB = await piOrch([
    'spawn', '--runtime', 'pi',
    '--cwd', repoDir,
    '--model-selector', 'zai/glm-5.3-flash',
    '--owner', 'l1-leak-probe',
    '--ttl', '86400',
    '--label', 'l1-leak-observer',
    '--id-only', '--json',
    '--socket', socketPath, '--token-path', tokenPath,
  ], 240_000);
  if (spawnedB.exitCode !== 0) throw new Error(`pi-orch spawn B failed (${spawnedB.exitCode}): ${(spawnedB.stderr || spawnedB.stdout).slice(0, 500)}`);
  const childB = (spawnedB.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0];
  if (!childB) throw new Error(`no session id in spawn B output: ${spawnedB.stdout.slice(0, 300)}`);
  log(`child B (watch subject): ${childB}`);

  const busy = await waitUntilSustainedBusy(target, childA, 8 * 60_000);
  if (!busy) throw new Error('child A never became sustainably busy — cannot run the reproduction');
  log('child A is sustainably busy — wedge turn underway (shapes fire relative to now)');

  const t0 = Date.now();
  const marks: Array<string> = [];

  // Shape W: watch on B, deadline condition 25 s, wake targets busy A with follow_up.
  const watchReg = await internalApiRequest<{ watchId?: string; generation?: string }>(target.socketPath, target.tokenPath, 'POST', `/sessions/${childB}/watch`, {
    conditions: [{ id: 'deadline-wake', type: 'deadline', afterSeconds: 25 }],
    label: 'l1-leak wake follow_up into busy A',
    onFire: {
      type: 'prompt',
      targetSessionId: childA,
      mode: 'follow_up',
      message: 'Wake check: reply with the current progress only.',
      maxWakeups: 1,
    },
  }, 20_000);
  marks.push(`watch register → HTTP ${watchReg.status} ${JSON.stringify(watchReg.json).slice(0, 200)}`);

  setTimeout(() => { void (async () => {
    // Shape S: detached steer into the busy turn (joined, lease-less control).
    // Fired late so it cannot feed eligible activity into the wake run before
    // its start window closes.
    const steer = await internalApiRequest(target.socketPath, target.tokenPath, 'POST', `/sessions/${childA}/prompt`, {
      message: 'Steer check: keep going.',
      mode: 'steer',
      detach: true,
      verbosity: 'answers',
    }, 20_000).catch((e) => ({ status: -1, json: String(e) }));
    marks.push(`steer → HTTP ${steer.status} ${JSON.stringify(steer.json).slice(0, 200)}`);
  })(); }, 215_000);

  setTimeout(() => { void (async () => {
    // Shape Q: detached follow_up via the prompt path (queued, lease-less control).
    const fu = await internalApiRequest(target.socketPath, target.tokenPath, 'POST', `/sessions/${childA}/prompt`, {
      message: 'Queued check: note this for your next turn.',
      mode: 'follow_up',
      detach: true,
      verbosity: 'answers',
    }, 20_000).catch((e) => ({ status: -1, json: String(e) }));
    marks.push(`queued follow_up → HTTP ${fu.status} ${JSON.stringify(fu.json).slice(0, 200)}`);
  })(); }, 230_000);

  setTimeout(() => { void (async () => {
    // Shape A: abort of the busy session (cancelSession drains every active run).
    const abort = await internalApiRequest(target.socketPath, target.tokenPath, 'POST', `/sessions/${childA}/abort`, {}, 30_000).catch((e) => ({ status: -1, json: String(e) }));
    marks.push(`abort → HTTP ${abort.status} ${JSON.stringify(abort.json).slice(0, 200)}`);
  })(); }, 245_000);

  // Sample until the session settles for SETTLE_MS after having been busy, bounded overall.
  const overallDeadline = t0 + (WEDGE_SECONDS + 300) * 1000;
  let lastBusyAt = Date.now();
  let sawBusyAfterAbort = false;
  while (Date.now() < overallDeadline) {
    const s = await sample(target, childA).catch((e) => ({ capacity: {} as CapacityLite, nonTerminal: [], receipts: [], error: String(e) } as unknown as Awaited<ReturnType<typeof sample>>));
    const entry = {
      ts: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      capacity: {
        available: s.capacity.available,
        reason: s.capacity.reason ?? null,
        activeTurns: s.capacity.activeTurns,
        quarantinedRuns: s.capacity.quarantinedRuns,
        quarantinedOldestAgeMs: (s.capacity as { quarantinedOldestAgeMs?: number }).quarantinedOldestAgeMs ?? null,
        stalledRuns: s.capacity.stalledRuns,
      },
      nonTerminalReceipts: s.nonTerminal.map((r) => ({ runId: r.runId, status: r.status, mode: r.mode ?? r.dispatchMode })),
      receipts: s.receipts.map((r) => ({ runId: r.runId, status: r.status, mode: r.mode ?? r.dispatchMode, errorCode: r.errorCode ?? null })),
    };
    appendFileSync(timelinePath, JSON.stringify(entry) + '\n');
    const busyNow = s.nonTerminal.some((r) => r.status === 'started');
    if (busyNow) { lastBusyAt = Date.now(); sawBusyAfterAbort = true; }
    const settledLongEnough = sawBusyAfterAbort && (Date.now() - lastBusyAt) >= SETTLE_MS;
    if (settledLongEnough) { log('settle window reached — stopping sampling'); break; }
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
  }

  const summary = { runId, childA, childB, wedgeSeconds: WEDGE_SECONDS, marks, finishedAt: new Date().toISOString() };
  writeFileSync(path.join(paths.evidenceDir, 'probe-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  log(`probe complete — marks: ${marks.length}, timeline: ${timelinePath}`);
}

const isDirect = process.argv[1] && process.argv[1].endsWith('probe.ts');
if (isDirect) {
  main().catch((err) => {
    console.error('[l1-leak] probe FAILED:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
