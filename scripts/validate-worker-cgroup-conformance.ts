#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  PHASE6_FIXTURE_ID,
  PHASE6_FROZEN_SETTINGS,
  assertPhase6ControlDelta,
  assertPhase6ModeComparison,
  buildPhase6ControllerArgs,
  phase6OwnedSliceName,
  runPhase6Adversarial,
  runPhase6RestartOldController,
  runPhase6RestartRecovery,
  runPhase6WorkerMode,
  snapshotPhase6CurrentCgroup,
} from '../server/src/live-validation/worker-cgroup-conformance.js';

interface CliOptions {
  controller: boolean;
  restartOld: boolean;
  restartRecover: boolean;
  nonce?: string;
  runDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { controller: false, restartOld: false, restartRecover: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--controller') options.controller = true;
    else if (arg === '--restart-old') options.restartOld = true;
    else if (arg === '--restart-recover') options.restartRecover = true;
    else if (arg === '--nonce') options.nonce = argv[++index];
    else if (arg === '--dir') options.runDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function assertOwnedRunDir(runDir: string, nonce: string): Promise<void> {
  const marker = JSON.parse(await fs.readFile(path.join(runDir, '.phase6-owned.json'), 'utf8')) as Record<string, unknown>;
  if (marker.nonce !== nonce || marker.fixture !== PHASE6_FIXTURE_ID) {
    throw new Error('Refusing Phase 6 operation without an exact nonce-owned run directory');
  }
}

async function archiveAndRemoveFixtureState(runDir: string, area: string): Promise<{ receipts: number; sessionMarkers: number }> {
  const areaDir = path.join(runDir, area);
  const receiptDir = path.join(areaDir, 'receipts');
  const sessionDir = path.join(areaDir, 'sessions');
  const receipts: unknown[] = [];
  const sessionMarkers: unknown[] = [];
  for (const [directory, target] of [[receiptDir, receipts], [sessionDir, sessionMarkers]] as const) {
    const files = await fs.readdir(directory).catch(() => []);
    for (const file of files.sort()) {
      if (!file.endsWith('.json') && !file.endsWith('.jsonl')) continue;
      const content = await fs.readFile(path.join(directory, file), 'utf8');
      const records = file.endsWith('.jsonl')
        ? content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown)
        : [JSON.parse(content) as unknown];
      target.push({ file, records });
    }
  }
  await writePrivateJson(path.join(areaDir, 'receipt-evidence.json'), receipts);
  await writePrivateJson(path.join(areaDir, 'session-evidence.json'), sessionMarkers);
  await fs.rm(receiptDir, { recursive: true, force: true });
  await fs.rm(sessionDir, { recursive: true, force: true });
  return { receipts: receipts.length, sessionMarkers: sessionMarkers.length };
}

async function runController(options: Required<Pick<CliOptions, 'nonce' | 'runDir'>>): Promise<void> {
  const controlBefore = await snapshotPhase6CurrentCgroup();
  const fixtureExecutable = path.resolve(process.cwd(), 'scripts/fixtures/phase6-worker-fixture.mjs');
  const plain = await runPhase6WorkerMode({
    mode: 'plain', nonce: options.nonce, runDir: options.runDir, fixtureExecutable,
  });
  const contained = await runPhase6WorkerMode({
    mode: 'contained', nonce: options.nonce, runDir: options.runDir, fixtureExecutable,
  });
  assertPhase6ModeComparison(plain, contained);
  const adversarial = await runPhase6Adversarial({
    nonce: options.nonce, runDir: options.runDir, fixtureExecutable,
  });
  const controlAfter = await snapshotPhase6CurrentCgroup();
  assertPhase6ControlDelta(controlBefore, controlAfter);
  const fixtureCleanup = {
    plain: await archiveAndRemoveFixtureState(options.runDir, 'plain'),
    contained: await archiveAndRemoveFixtureState(options.runDir, 'contained'),
    adversarial: await archiveAndRemoveFixtureState(options.runDir, 'adversarial'),
  };
  const sourceFiles = {
    fixture: fixtureExecutable,
    runner: path.resolve(process.cwd(), 'scripts/validate-worker-cgroup-conformance.ts'),
    harness: path.resolve(process.cwd(), 'server/src/live-validation/worker-cgroup-conformance.ts'),
    launcher: path.resolve(process.cwd(), 'server/src/workers/worker-launcher.ts'),
    pool: path.resolve(process.cwd(), 'server/src/workers/worker-pool.ts'),
    sessionWorker: path.resolve(process.cwd(), 'server/src/workers/session-worker.ts'),
    adapter: path.resolve(process.cwd(), 'server/src/workers/pilot-executor-adapter.ts'),
    rpcClient: path.resolve(process.cwd(), 'server/src/workers/session-rpc-client.ts'),
    rpcBridge: path.resolve(process.cwd(), 'server/src/workers/rpc-protocol-bridge.ts'),
    receiptManager: path.resolve(process.cwd(), 'server/src/internal-api/run-receipts/run-receipt-manager.ts'),
    receiptStore: path.resolve(process.cwd(), 'server/src/internal-api/run-receipts/run-receipt-store.ts'),
    websocketAdapter: path.resolve(process.cwd(), 'server/src/websocket/pilot-session-websocket.ts'),
  };
  const sourceHashes = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([key, file]) => [key, await sha256File(file)])));
  const revision = await execFile('git', ['rev-parse', 'HEAD']).then(({ stdout }) => String(stdout).trim()).catch(() => 'unknown');
  const summary = {
    fixture: PHASE6_FIXTURE_ID,
    revision,
    hashes: {
      ...sourceHashes,
      settings: createHash('sha256').update(JSON.stringify(PHASE6_FROZEN_SETTINGS)).digest('hex'),
    },
    settings: PHASE6_FROZEN_SETTINGS,
    target: 'disposable-transient-systemd',
    productionTouched: false,
    tmuxTouched: false,
    plain,
    contained,
    adversarial,
    control: { before: controlBefore, after: controlAfter },
    cleanup: { fixtureState: fixtureCleanup },
  };
  await writePrivateJson(path.join(options.runDir, 'summary.json'), summary);
  process.stdout.write(`${JSON.stringify({ status: 'pass', summaryPath: path.join(options.runDir, 'summary.json') })}\n`);
}

const execFile = promisify(execFileCallback);

async function stopExactOwnedSlice(nonce: string): Promise<void> {
  const sliceName = phase6OwnedSliceName(nonce);
  const unitPrefix = `pi-web-ui-phase6-${nonce}`;
  const before = await execFile('systemctl', [
    'show', sliceName, '-p', 'ControlGroup', '--no-pager',
  ]).catch(() => ({ stdout: 'ControlGroup=' }));
  const cgroupPath = String(before.stdout).match(/^ControlGroup=(.*)$/m)?.[1] ?? '';
  if (cgroupPath && (!cgroupPath.startsWith('/') || !cgroupPath.endsWith(`/${sliceName}`) || cgroupPath.includes('/../'))) {
    throw new Error(`Refusing cleanup of unexpected Phase 6 slice cgroup: ${cgroupPath}`);
  }
  await execFile('systemctl', ['stop', sliceName]).catch((error) => {
    if (!/not loaded|not found|not-found/i.test(error instanceof Error ? error.message : String(error))) throw error;
  });

  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    let cgroupEmpty = true;
    if (cgroupPath) {
      const directory = path.resolve('/sys/fs/cgroup', `.${cgroupPath}`);
      try {
        const [events, procs] = await Promise.all([
          fs.readFile(path.join(directory, 'cgroup.events'), 'utf8'),
          fs.readFile(path.join(directory, 'cgroup.procs'), 'utf8'),
        ]);
        cgroupEmpty = !/^populated\s+1$/m.test(events) && procs.trim() === '';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const { stdout } = await execFile('systemctl', [
      'list-units', '--all', '--plain', '--no-legend', `${unitPrefix}*`,
    ]);
    const ownedServices = String(stdout).split(/\r?\n/).map((line) => line.trim().split(/\s+/, 1)[0])
      .filter((unit) => unit.startsWith(unitPrefix) && unit.endsWith('.service'));
    if (cgroupEmpty && ownedServices.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Nonce-owned Phase 6 slice did not drain/collect: ${sliceName}`);
}

async function runTransientCommand(args: string[], logHandle: fs.FileHandle): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn('systemd-run', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
    });
    child.stdout?.on('data', (chunk) => { void logHandle.write(chunk); });
    child.stderr?.on('data', (chunk) => { void logHandle.write(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

function roleArgs(base: string[], nonce: string, role: 'restart-old' | 'restart-recover'): string[] {
  return base.map((arg) => {
    if (arg === `--unit=pi-web-ui-phase6-${nonce}-controller.service`) {
      return `--unit=pi-web-ui-phase6-${nonce}-${role}.service`;
    }
    if (arg === '--controller') return `--${role}`;
    return arg;
  });
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try { await fs.access(file); return; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw new Error(`Timed out waiting for restart evidence: ${file}`);
}

async function runParent(runDir?: string): Promise<void> {
  const nonce = randomBytes(6).toString('hex');
  const ownedRunDir = runDir
    ? await (async () => {
        const parent = path.resolve(runDir);
        await fs.mkdir(parent, { recursive: true, mode: 0o700 });
        return fs.mkdtemp(path.join(parent, 'pi-web-ui-phase6-'));
      })()
    : await fs.mkdtemp(path.join(os.tmpdir(), 'pi-web-ui-phase6-'));
  await fs.mkdir(ownedRunDir, { recursive: false, mode: 0o700 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  await fs.chmod(ownedRunDir, 0o700);
  await writePrivateJson(path.join(ownedRunDir, '.phase6-owned.json'), {
    fixture: PHASE6_FIXTURE_ID, nonce, createdBy: 'validate-worker-cgroup-conformance',
  });
  const scriptPath = path.resolve(process.cwd(), 'scripts/validate-worker-cgroup-conformance.ts');
  const tsxCliPath = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
  const args = buildPhase6ControllerArgs({
    nonce,
    nodePath: process.execPath,
    tsxCliPath,
    scriptPath,
    runDir: ownedRunDir,
    repoRoot: process.cwd(),
  });
  const logPath = path.join(ownedRunDir, 'controller.log');
  const logHandle = await fs.open(logPath, 'w', 0o600);
  let finalOutput: unknown;
  let cleanup: Promise<void> | undefined;
  const cleanupOnce = () => {
    cleanup ??= stopExactOwnedSlice(nonce);
    return cleanup;
  };
  const onSignal = (signal: NodeJS.Signals) => {
    void cleanupOnce().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const exitCode = await runTransientCommand(args, logHandle);
    await logHandle.sync();
    if (exitCode !== 0) {
      throw new Error(`Phase 6 disposable controller failed with exit code ${exitCode}; evidence: ${logPath}`);
    }
    const restartOldArgs = roleArgs(args, nonce, 'restart-old');
    const restartOld = runTransientCommand(restartOldArgs, logHandle);
    await waitForFile(path.join(ownedRunDir, 'restart', 'ready'), 10_000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await execFile('systemctl', ['stop', `pi-web-ui-phase6-${nonce}-restart-old.service`]);
    await restartOld.catch(() => 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const recoveryCode = await runTransientCommand(roleArgs(args, nonce, 'restart-recover'), logHandle);
    if (recoveryCode !== 0) throw new Error(`Phase 6 restart recovery failed with exit code ${recoveryCode}`);

    const summaryPath = path.join(ownedRunDir, 'summary.json');
    const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8')) as Record<string, unknown>;
    summary.restart = JSON.parse(await fs.readFile(path.join(ownedRunDir, 'restart', 'result.json'), 'utf8'));
    const restartCleanup = await archiveAndRemoveFixtureState(ownedRunDir, 'restart');
    await fs.rm(path.join(ownedRunDir, 'restart', 'manifest.json'), { force: true });
    await fs.rm(path.join(ownedRunDir, 'restart', 'ready'), { force: true });
    const cleanup = (summary.cleanup ?? {}) as Record<string, unknown>;
    summary.cleanup = { ...cleanup, restartState: restartCleanup, ephemeralStateRemaining: 0 };
    await writePrivateJson(summaryPath, summary);
    finalOutput = { status: 'pass', runDir: ownedRunDir, summaryPath, summary };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await logHandle.close();
    await cleanupOnce();
  }
  if (finalOutput && typeof finalOutput === 'object') {
    const output = finalOutput as { summaryPath: string; summary: Record<string, unknown> };
    const cleanupEvidence = (output.summary.cleanup ?? {}) as Record<string, unknown>;
    output.summary.cleanup = {
      ...cleanupEvidence,
      finalNonceUnits: [],
      nonceSlicePopulated: false,
      taskOwnedControllerCollected: true,
    };
    await writePrivateJson(output.summaryPath, output.summary);
  }
  process.stdout.write(`${JSON.stringify(finalOutput)}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.controller || options.restartOld || options.restartRecover) {
    if (!options.nonce || !options.runDir) throw new Error('controller modes require --nonce and --dir');
    await assertOwnedRunDir(path.resolve(options.runDir), options.nonce);
    const input = {
      nonce: options.nonce,
      runDir: path.resolve(options.runDir),
      fixtureExecutable: path.resolve(process.cwd(), 'scripts/fixtures/phase6-worker-fixture.mjs'),
    };
    if (options.restartOld) await runPhase6RestartOldController(input);
    else if (options.restartRecover) await runPhase6RestartRecovery(input);
    else await runController({ nonce: options.nonce, runDir: path.resolve(options.runDir) });
  } else {
    await runParent(options.runDir);
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
