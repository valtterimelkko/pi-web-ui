/**
 * B1.2 lag reproduction runner.
 *
 * Boots a DISPOSABLE validation server (transient systemd unit, isolated agent
 * dir, isolated sessions dir, isolated metrics dir), loads a synthetic
 * production-shaped session corpus into it, drives browser-like session
 * switching, and reports the A2 lag distribution the server itself recorded.
 *
 * Isolation mirrors scripts/heap-soak (the sanctioned heavy harness):
 *   - never touches /root/pi-web-ui or production state;
 *   - PI_AGENT_DIR / PI_CODING_AGENT_DIR point at a copied allowlist of config
 *     (auth/models/settings/extensions) under the run dir;
 *   - HOME, the PATH stub, AGENT_OS_*, BOARD_STORE_DIR and the watch-wake
 *     socket all point inside the run dir, so extension side effects cannot
 *     reach the real machine;
 *   - SESSION_DIR is deliberately NOT set here: the validation server sets it
 *     to <runDir>/pi-sessions itself.
 *
 * Usage (from the repo root):
 *   npx tsx scripts/lag-repro/run.ts [--cycles 10] [--per-cycle 15]
 *     [--size-scale 0.05] [--run-dir /root/lag-repro-runs/<id>] [--keep]
 */

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateCorpus, writeCorpusIndex, type CorpusSummary } from './corpus.js';
import { runBrowserLoad, type BrowserLoadResult } from './browser-client.js';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

interface Args {
  cycles: number;
  perCycle: number;
  tabs: number;
  sizeScale: number;
  runDir?: string;
  port?: number;
  repeatPool: number;
  keep: boolean;
  generateOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(`--${flag}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    cycles: Number(value('cycles') ?? 16),
    perCycle: Number(value('per-cycle') ?? 15),
    tabs: Number(value('tabs') ?? 3),
    sizeScale: Number(value('size-scale') ?? 0.05),
    runDir: value('run-dir'),
    port: value('port') ? Number(value('port')) : undefined,
    // 0 = every cycle opens new cwds (new-cwd distribution). >0 = cycle over
    // only this many sessions per tab, so every open after the first revisits a
    // warm cwd (repeat-cwd distribution).
    repeatPool: Number(value('repeat-pool') ?? 0),
    keep: argv.includes('--keep'),
    generateOnly: argv.includes('--generate-only'),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Copy only the config allowlist from the real agent dir (never sessions/ or memory/). */
function buildIsolatedAgentDir(destDir: string): void {
  const sourceDir = join(homedir(), '.pi', 'agent');
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const entry of ['auth.json', 'models.json', 'settings.json', 'extensions']) {
    const source = join(sourceDir, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(destDir, entry), { recursive: true, dereference: true });
  }
}

async function startUnit(options: {
  unitName: string;
  runDir: string;
  port: number;
}): Promise<void> {
  const stub = join(repoRoot, 'scripts', 'heap-soak', 'agent-os-stub.mjs');
  const binDir = join(options.runDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stubTarget = join(binDir, 'agent-os');
  try { unlinkSync(stubTarget); } catch { /* not present */ }
  symlinkSync(stub, stubTarget);

  const env: Record<string, string> = {
    NODE_OPTIONS: '--max-old-space-size=4096',
    PI_AGENT_DIR: join(options.runDir, 'agent'),
    PI_CODING_AGENT_DIR: join(options.runDir, 'agent'),
    HOME: join(options.runDir, 'home'),
    PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    AGENT_OS_BIN: stub,
    AGENT_OS_STUB_LOG: join(options.runDir, 'agent-os-stub.log'),
    AGENT_OS_VAULT_ROOT: join(options.runDir, 'home', 'agent-os-memory-vault'),
    BOARD_STORE_DIR: join(options.runDir, 'board'),
    PI_WEB_UI_WATCH_WAKE_SOCKET: join(options.runDir, 'internal-api.sock'),
    PI_WEB_UI_WATCH_WAKE_TOKEN_FILE: join(options.runDir, 'internal-api-token'),
    PI_WEB_UI_GOAL_HOME: join(options.runDir, 'goal-home'),
    PI_COMPACTION_LOG: join(options.runDir, 'compaction.log'),
    PI_BG_TASKS_DIR: join(options.runDir, 'bg-tasks'),
  };

  await execFileAsync('systemd-run', [
    '--unit', options.unitName,
    '--collect',
    '--property=Restart=no',
    `--working-directory=${repoRoot}`,
    ...Object.entries(env).map(([key, val]) => `--setenv=${key}=${val}`),
    '--',
    'npx', 'tsx', 'scripts/validation-server.ts',
    '--dir', options.runDir,
    '--compiled',
    '--port', String(options.port),
  ]);
}

async function unitMainPid(unitName: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['show', unitName, '-p', 'MainPID', '--no-pager']);
    const match = stdout.match(/MainPID=(\d+)/);
    const pid = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function stopUnit(unitName: string): Promise<void> {
  try { await execFileAsync('systemctl', ['stop', unitName]); } catch { /* already gone */ }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync('systemctl', ['show', unitName, '-p', 'LoadState', '--no-pager']);
      if (stdout.includes('LoadState=not-found')) return;
    } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForHttp(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health/live`);
      if (res.status < 500) return;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`validation server on port ${port} never answered (${lastError})`);
}

interface MetricsSummary {
  readings: number;
  readingsDuringLoad: number;
  maxP99Ms: number;
  maxMaxMs: number;
  readingsWithP99AtLeast300: number;
  spikeMinutes: string[];
  attributionLines: string[];
}

function summariseMetrics(metricsPath: string, loadStartedAtMs: number, attributionLines: string[]): MetricsSummary {
  if (!existsSync(metricsPath)) {
    return { readings: 0, readingsDuringLoad: 0, maxP99Ms: 0, maxMaxMs: 0, readingsWithP99AtLeast300: 0, spikeMinutes: [], attributionLines };
  }
  const readings = readFileSync(metricsPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { at: string; atMs: number; lagP99Ms: number; lagMaxMs: number });
  const duringLoad = readings.filter((reading) => reading.atMs >= loadStartedAtMs && reading.lagP99Ms > 0);
  const spikeMinutes = [...new Set(duringLoad.filter((r) => r.lagP99Ms >= 300).map((r) => r.at.slice(0, 16)))].sort();
  return {
    readings: readings.length,
    readingsDuringLoad: duringLoad.length,
    maxP99Ms: duringLoad.reduce((max, r) => Math.max(max, r.lagP99Ms), 0),
    maxMaxMs: duringLoad.reduce((max, r) => Math.max(max, r.lagMaxMs), 0),
    readingsWithP99AtLeast300: duringLoad.filter((r) => r.lagP99Ms >= 300).length,
    spikeMinutes,
    attributionLines,
  };
}

async function readAttributionLines(unitName: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('journalctl', ['-u', unitName, '--no-pager', '-o', 'cat'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .filter((line) => line.includes('LoopAttribution'))
      .slice(-200);
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = resolve(args.runDir ?? join('/root/lag-repro-runs', stamp));
  const unitName = `b12-lag-repro-${Date.now()}`;
  const port = args.port ?? (await freePort());

  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(runDir, 'home'), { recursive: true });
  buildIsolatedAgentDir(join(runDir, 'agent'));

  const corpus: CorpusSummary = await generateCorpus({
    cwdRoot: join(runDir, 'cwds'),
    sessionsDir: join(runDir, 'pi-sessions'),
    sizeScale: args.sizeScale,
    onProgress: (done, total) => process.stderr.write(`\r[corpus] ${done}/${total} files`),
  });
  process.stderr.write('\n');
  await writeCorpusIndex(corpus, join(runDir, 'corpus-index.json'));
  const summary = {
    runDir,
    unitName,
    port,
    commit: (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim(),
    corpus: { cwdCount: corpus.cwdCount, fileCount: corpus.fileCount, totalBytes: corpus.totalBytes, biggestBytes: corpus.biggestBytes },
  };
  process.stderr.write(`[corpus] ${JSON.stringify(summary.corpus)}\n`);

  if (args.generateOnly) {
    console.log(JSON.stringify({ ...summary, generateOnly: true }, null, 2));
    return;
  }

  try {
    await startUnit({ unitName, runDir, port });
    const pid = await unitMainPid(unitName);
    if (!pid) throw new Error(`unit ${unitName} never reported a MainPID`);
    await waitForHttp(port);
    process.stderr.write(`[server] up (unit ${unitName}, pid ${pid}, port ${port})\n`);

    const loadStartedAtMs = Date.now();
    // Several browser tabs, exactly as production had (two WS clients were
    // connected during the 23:15 spike), and each tab keeps under the WS
    // message budget (60 client→server messages per minute): 15 switches per
    // ~21 s is ~43/min per tab.
    const tabs = Math.max(1, args.tabs);
    const tabResults = await Promise.all(
      Array.from({ length: tabs }, (_, tab) => {
        const slice = corpus.sessions.filter((_, index) => index % tabs === tab).map((session) => session.path);
        const sessionPaths = args.repeatPool > 0 ? slice.slice(0, args.repeatPool) : slice;
        return runBrowserLoad({
          port,
          sessionPaths,
          cycles: args.cycles,
          sessionsPerCycle: args.perCycle,
          gapMs: 1_400,
        });
      }),
    );
    const drive: BrowserLoadResult = tabResults.reduce((merged, tab) => ({
      getSessionsMs: Math.max(merged.getSessionsMs, tab.getSessionsMs),
      listSize: Math.max(merged.listSize, tab.listSize),
      switchesAcknowledged: merged.switchesAcknowledged + tab.switchesAcknowledged,
      switchErrors: [...merged.switchErrors, ...tab.switchErrors],
      switchLatencyMs: [...merged.switchLatencyMs, ...tab.switchLatencyMs],
      cyclesCompleted: merged.cyclesCompleted + tab.cyclesCompleted,
    }), { getSessionsMs: 0, listSize: 0, switchesAcknowledged: 0, switchErrors: [], switchLatencyMs: [], cyclesCompleted: 0 });
    process.stderr.write(`[drive] ${JSON.stringify({
      tabs,
      listSize: drive.listSize,
      getSessionsMs: drive.getSessionsMs,
      switchesAcknowledged: drive.switchesAcknowledged,
      switchErrors: drive.switchErrors.length,
      rateLimitErrors: drive.switchErrors.filter((error) => error.includes('Rate limit')).length,
      cyclesCompleted: drive.cyclesCompleted,
    })}\n`);

    const attributionLines = await readAttributionLines(unitName);
    const metrics = summariseMetrics(join(runDir, 'metrics', 'health-metrics.jsonl'), loadStartedAtMs, attributionLines);
    const report = { ...summary, tabs, repeatPool: args.repeatPool, drive, metrics, loadStartedAtMs };
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stopUnit(unitName);
    if (!args.keep) process.stderr.write(`[keep] run dir preserved at ${runDir} (evidence)\n`);
  }
}

main().catch((error) => {
  console.error(`[lag-repro] failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
