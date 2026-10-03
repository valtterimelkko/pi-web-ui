/**
 * L1 reproduction — disposable server boot/stop (k-l1-* units).
 *
 * Recipe copied from scripts/e2a-crash/server.ts (the E2-proven disposable
 * topology): own slice, delegated tools anchor with production's anchor
 * properties but OUR cgroup, placement ON at OUR anchor, isolated agent dir
 * (zai credential only), fake HOME, Agent OS interception stub, notifications
 * disabled. Restart=no and a bounded RuntimeMaxSec: the probe owns the
 * lifecycle, nothing here auto-restarts.
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ANCHOR_UNIT, SERVER_UNIT, SLICE, resolveRunPaths, type RunPaths } from './paths.ts';

const execFile = promisify(execFileCb);

const REPO_ROOT = path.resolve(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));

async function systemctl(...args: string[]): Promise<string> {
  const { stdout } = await execFile('systemctl', [...args, '--no-pager']);
  return stdout;
}

async function systemdRun(args: string[]): Promise<void> {
  await execFile('systemd-run', ['--collect', '--quiet', ...args]);
}

export async function findFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('no ephemeral port'));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface UnitStatus {
  activeState: string;
  mainPid?: number;
  controlGroup?: string;
}

export async function getUnitStatus(unit: string): Promise<UnitStatus> {
  try {
    const out = await systemctl('show', unit, '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlGroup');
    const props: Record<string, string> = {};
    for (const line of out.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    const mainPid = Number(props.MainPID);
    return {
      activeState: props.ActiveState ?? 'unknown',
      mainPid: Number.isSafeInteger(mainPid) && mainPid > 0 ? mainPid : undefined,
      controlGroup: props.ControlGroup || undefined,
    };
  } catch {
    return { activeState: 'not-found' };
  }
}

/** The production anchor's properties this harness copies (from /root/pi-web-ui/deploy/, read-only). */
const ANCHOR_START_SCRIPT = [
  '#!/bin/sh',
  '# k-l1 delegated anchor start (copied from the production anchor ExecStart).',
  'r=/sys/fs/cgroup$(sed -n "s|^0::||;s|/supervisor$||p" /proc/self/cgroup)',
  '[ -d "$r" ] || exit 1',
  'echo "+cpu +memory +pids" > "$r/cgroup.subtree_control" || exit 1',
  'exec sleep infinity',
  '',
].join('\n');

async function startAnchorUnit(anchorScriptPath: string): Promise<void> {
  const status = await getUnitStatus(ANCHOR_UNIT);
  if (status.activeState === 'active') return;
  await systemdRun([
    '--unit', ANCHOR_UNIT,
    '--slice', SLICE,
    '--property', 'Restart=always',
    '--property', 'RestartSec=2',
    '--property', 'MemoryMax=6G',
    '--property', 'MemoryHigh=5G',
    '--property', 'Delegate=cpu memory pids',
    '--property', 'DelegateSubgroup=supervisor',
    '--property', 'OOMPolicy=continue',
    '--property', 'OOMScoreAdjust=-1000',
    '--property', 'ExitType=cgroup',
    '--',
    '/bin/sh', anchorScriptPath,
  ]);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const s = await getUnitStatus(ANCHOR_UNIT);
    if (s.mainPid) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Anchor unit ${ANCHOR_UNIT} never reported a MainPID`);
}

/** Assert the resolved placement root is OURS (k-l1), never production's. */
export async function assertPlacementRootIsolated(): Promise<string> {
  const anchor = await getUnitStatus(ANCHOR_UNIT);
  const cg = anchor.controlGroup ?? '';
  if (!cg.includes('k-l1')) {
    throw new Error(`Placement assertion FAILED: anchor cgroup "${cg}" is not under the k-l1 slice`);
  }
  if (cg.includes('pi-web-ui-tools')) {
    throw new Error(`Placement assertion FAILED: anchor cgroup "${cg}" aliases the production tools anchor`);
  }
  const prodAnchor = '/sys/fs/cgroup/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service';
  if (path.resolve(`/sys/fs/cgroup${cg}`) === path.resolve(prodAnchor)) {
    throw new Error('Placement assertion FAILED: resolved root equals the production anchor path');
  }
  return cg;
}

export interface StartedServer {
  unit: string;
  mainPid: number;
  socketPath: string;
  tokenPath: string;
  httpPort: number;
  anchorCgroup: string;
  launchedAt: string;
}

function prepareServerEnv(paths: RunPaths): void {
  mkdirSync(paths.fakeHomeDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(paths.fakeHomeDir, 'agent-os-memory-vault'), { recursive: true, mode: 0o700 });
  mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.boardStoreDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.bgTasksDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.evidenceDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.serverEnvFile,
    [
      'PI_TOOLS_PLACEMENT=on',
      `PI_TOOLS_SLICE=${ANCHOR_UNIT}`,
      `JWT_SECRET=${randomBytes(32).toString('hex')}`,
      `AUTH_PASSWORD=${randomBytes(24).toString('hex')}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(path.join(paths.binDir, 'anchor-start.sh'), ANCHOR_START_SCRIPT, { mode: 0o755 });
  const stubTarget = path.join(paths.binDir, 'agent-os');
  const stubSource = path.join(REPO_ROOT, 'scripts', 'heap-soak', 'agent-os-stub.mjs');
  if (!existsSync(stubSource)) throw new Error(`agent-os stub missing at ${stubSource}`);
  try { unlinkSync(stubTarget); } catch { /* absent */ }
  symlinkSync(stubSource, stubTarget);
}

export async function startServer(runId: string): Promise<StartedServer> {
  const paths = resolveRunPaths(runId);
  const launchedAt = new Date().toISOString();
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  prepareServerEnv(paths);

  // Isolated agent dir: real extension set, zai credential only (E2-proven recipe).
  const { buildCrashAgentDir } = await import('../e2a-crash/agent-dir.ts');
  const agentDirResult = buildCrashAgentDir(paths.agentDir);
  console.log(`agent dir: ${agentDirResult.extensionFileCount} files, credential providers: ${agentDirResult.credentialProviders.join(',')}`);
  if (!agentDirResult.credentialProviders.every((p) => p === 'zai')) {
    throw new Error(`credential isolation FAILED: non-zai providers present: ${agentDirResult.credentialProviders.join(',')}`);
  }

  await startAnchorUnit(path.join(paths.binDir, 'anchor-start.sh'));
  const anchorCgroup = await assertPlacementRootIsolated();

  const socketPath = path.join(paths.validationDir, 'internal-api.sock');
  const tokenPath = path.join(paths.validationDir, 'internal-api-token');
  const existing = await getUnitStatus(SERVER_UNIT);
  if (existing.activeState === 'active' && existing.mainPid && existsSync(socketPath)) {
    throw new Error(`${SERVER_UNIT} is already active — stop it first (stop-server)`);
  }

  const httpPort = await findFreeTcpPort();
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(paths.stateDir, 'http-port'), String(httpPort));

  const inheritedPath = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const setenv: Array<[string, string]> = [
    ['NODE_ENV', 'production'],
    ['NODE_OPTIONS', '--max-old-space-size=4096'],
    ['PI_CODING_AGENT_DIR', paths.agentDir],
    ['PI_AGENT_DIR', paths.agentDir],
    ['HOME', paths.fakeHomeDir],
    ['PATH', `${paths.binDir}:${inheritedPath}`],
    ['AGENT_OS_BIN', path.join(REPO_ROOT, 'scripts', 'heap-soak', 'agent-os-stub.mjs')],
    ['AGENT_OS_STUB_LOG', paths.agentOsStubLog],
    ['AGENT_OS_VAULT_ROOT', path.join(paths.fakeHomeDir, 'agent-os-memory-vault')],
    ['BOARD_STORE_DIR', paths.boardStoreDir],
    ['PI_WEB_UI_GOAL_HOME', paths.goalHomeDir],
    ['PI_COMPACTION_LOG', paths.compactionLogPath],
    ['PI_BG_TASKS_DIR', paths.bgTasksDir],
    ['PI_WEB_UI_WATCH_WAKE_SOCKET', socketPath],
    ['PI_WEB_UI_WATCH_WAKE_TOKEN_FILE', tokenPath],
    ['NOTIFICATIONS_ENABLED', 'false'],
  ];

  await systemdRun([
    '--unit', SERVER_UNIT,
    '--slice', SLICE,
    '--property', 'Restart=no',
    '--property', 'TimeoutStopSec=30s',
    '--property', 'MemoryMax=6G',
    '--property', 'MemorySwapMax=1G',
    '--property', 'RuntimeMaxSec=2700',
    '--property', 'OOMScoreAdjust=-500',
    '--property', 'OOMPolicy=continue',
    '--property', 'KillMode=control-group',
    '--property', 'TasksMax=8192',
    '--property', `WorkingDirectory=${REPO_ROOT}`,
    '--property', 'UnsetEnvironment=PI_TOOLS_PLACEMENT PI_TOOLS_SLICE PI_TOOLS_CGROUP_ROOT PI_TOOLS_RUNTIME_DIR',
    ...setenv.map(([k, v]) => ['--setenv', `${k}=${v}`]).flat(),
    '--',
    'npx', 'tsx', 'scripts/validation-server.ts',
    '--dir', paths.validationDir,
    '--compiled',
    '--port', String(httpPort),
    '--env-file', paths.serverEnvFile,
    '--env-key', 'PI_TOOLS_PLACEMENT',
    '--env-key', 'PI_TOOLS_SLICE',
    '--env-key', 'JWT_SECRET',
    '--env-key', 'AUTH_PASSWORD',
  ]);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const s = await getUnitStatus(SERVER_UNIT);
    if (s.activeState === 'failed' || s.activeState === 'inactive') {
      throw new Error(`Server unit ${SERVER_UNIT} reached ${s.activeState} during startup — check journalctl -u ${SERVER_UNIT}`);
    }
    if (s.mainPid && existsSync(socketPath) && existsSync(tokenPath)) {
      await new Promise((r) => setTimeout(r, 500));
      return { unit: SERVER_UNIT, mainPid: s.mainPid, socketPath, tokenPath, httpPort, anchorCgroup, launchedAt };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server unit ${SERVER_UNIT} did not become ready within 90s`);
}

/** Assert from the boot journal that only `zai` is an authenticated provider. */
export async function assertOnlyZaiProvider(sinceIso: string): Promise<string> {
  const { stdout } = await execFile('journalctl', ['-u', SERVER_UNIT, '--since', sinceIso, '--no-pager', '-n', '400']);
  const line = stdout.split(/\r?\n/).find((l) => /Available providers \(with auth\)/.test(l));
  if (!line) throw new Error('no "Available providers (with auth)" journal line found since boot');
  const m = line.match(/Available providers \(with auth\):(.*)$/);
  const providers = (m?.[1] ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (!providers.every((p) => p === 'zai')) {
    throw new Error(`provider isolation FAILED: ${line.slice(0, 200)}`);
  }
  return line.trim().slice(0, 300);
}

/** Stop the server + anchor units, delete the disposable token credential, and
 *  remove + verify the filtered agent-dir credential copies (correction 01).
 *  Returns the cleanup verification lines for the evidence record. */
export async function stopServer(runId?: string): Promise<string[]> {
  for (const unit of [SERVER_UNIT, ANCHOR_UNIT]) {
    try { await execFile('systemctl', ['stop', unit]); } catch { /* already stopped */ }
  }
  const idFlag = process.argv.indexOf('--run-id');
  const effectiveRunId = runId ?? process.argv[idFlag + 1];
  if (!effectiveRunId) throw new Error('stop requires --run-id <id>');
  const paths = resolveRunPaths(effectiveRunId);
  const lines: string[] = [];
  // The socket dir holds the disposable internal-api token: remove it (credential hygiene).
  const tokenPath = path.join(paths.validationDir, 'internal-api-token');
  try { unlinkSync(tokenPath); lines.push(`removed token: ${tokenPath}`); } catch { /* absent */ }
  // Correction 01 (Luna r1 finding 3): remove the filtered credential copies the
  // isolated agent dir contains (zai-only auth.json, models.json), then VERIFY
  // that no credential copy remains anywhere in the run directory.
  const agentDirCredentials = ['auth.json', 'models.json'];
  for (const name of agentDirCredentials) {
    const candidate = path.join(paths.agentDir, name);
    try { unlinkSync(candidate); lines.push(`removed credential copy: ${candidate}`); } catch { /* absent */ }
  }
  const leftovers = findCredentialCopies(paths.runDir);
  if (leftovers.length > 0) {
    throw new Error(`credential cleanup FAILED — still present after stop: ${leftovers.join(', ')}`);
  }
  lines.push(`verified clean: no auth.json/models.json/internal-api-token under ${paths.runDir}`);
  return lines;
}

/** Bounded walk of a run directory for credential copies (agent-dir scoped names). */
export function findCredentialCopies(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: import('node:fs').Stats;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        // node_modules/extension trees cannot contain OUR credential copies.
        if (entry === 'node_modules') continue;
        stack.push(full);
      } else if (entry === 'auth.json' || entry === 'models.json' || entry === 'internal-api-token') {
        found.push(full);
      }
    }
  }
  return found;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const runIdFlag = process.argv.indexOf('--run-id');
  const runId = runIdFlag > 0 ? process.argv[runIdFlag + 1] : 'l1-r1';
  switch (command) {
    case 'start': {
      const started = await startServer(runId);
      const providerLine = await assertOnlyZaiProvider(started.launchedAt);
      console.log(`SERVER_UP unit=${started.unit} pid=${started.mainPid} port=${started.httpPort} anchorCg=${started.anchorCgroup}`);
      console.log(`PROVIDER_ASSERT: ${providerLine}`);
      break;
    }
    case 'stop': {
      const lines = await stopServer(runId);
      const status = await getUnitStatus(SERVER_UNIT);
      for (const line of lines) console.log(line);
      console.log(`SERVER_STOPPED activeState=${status.activeState}`);
      break;
    }
    case 'verify-clean': {
      const paths = resolveRunPaths(runId);
      const leftovers = findCredentialCopies(paths.runDir);
      if (leftovers.length > 0) {
        console.error(`NOT CLEAN — credential copies remain: ${leftovers.join(', ')}`);
        process.exitCode = 1;
      } else {
        console.log(`VERIFIED CLEAN: no auth.json/models.json/internal-api-token under ${paths.runDir}`);
      }
      break;
    }
    default:
      console.error('usage: boot.ts start|stop|verify-clean --run-id <id>');
      process.exitCode = 2;
  }
}

if (process.argv[1] && process.argv[1].endsWith('boot.ts')) {
  main().catch((err) => {
    console.error('[l1-leak] boot FAILED:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
