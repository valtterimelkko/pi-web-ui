/**
 * Shared launch sequence for Gate 0 (preflight) and Gate 1 (micro-soak):
 * build the isolated agent dir, start the disposable server as a transient
 * systemd unit (with the production heap cap + --inspect), wait for it to be
 * observably up, and write the initial run-state.json.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { buildIsolatedAgentDir } from './agent-dir.js';
import { resolveRunPaths, serverUnitName, supervisorUnitName, type RunPaths } from './paths.js';
import { startTransientUnit, waitForMainPid } from './systemd-units.js';
import { InspectorClient } from './inspector.js';
import { saveRunState } from './run-state-io.js';
import { assertOutsideProductionPaths, productionGuardedPaths } from '../../server/src/live-validation/heap-soak/isolation.js';
import { createAuditMarker } from './prod-audit-io.js';
import { createBreakerState } from '../../server/src/live-validation/heap-soak/circuit-breaker.js';
import { buildSyntheticRegistry, DEFAULT_SYNTHETIC_REGISTRY_COUNT } from '../../server/src/live-validation/heap-soak/registry-seed.js';
import { LANE_DEFINITIONS } from '../../server/src/live-validation/heap-soak/lanes.js';
import type { RunState } from '../../server/src/live-validation/heap-soak/run-state.js';
import type { LaneName } from '../../server/src/live-validation/heap-soak/types.js';

export interface LaunchResult {
  paths: RunPaths;
  serverUnit: string;
  supervisorUnit: string;
  serverMainPid: number;
  inspectorPort: number;
  socketPath: string;
  tokenPath: string;
  client: InternalApiClient;
  auditMarkerPath: string;
  seededRegistryCount: number;
  httpPort: number;
}

async function findFreeTcpPort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no ephemeral port')); return; }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Repo root, resolved from this file's location (scripts/heap-soak/launcher.ts -> ../../). */
function repoRoot(): string {
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..');
}

export interface LaunchOptions {
  /** Parent amendment 2026-09-26: mimic production's registry size. On by default. */
  seedRegistry?: boolean;
  seedRegistryCount?: number;
}

export async function launchDisposableServer(runId: string, mode: 'micro' | 'full', options: LaunchOptions = {}): Promise<LaunchResult> {
  const root = repoRoot();
  const paths = resolveRunPaths(runId);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(paths.childWorkspaceRoot, { recursive: true });
  mkdirSync(paths.snapshotDir, { recursive: true });
  mkdirSync(paths.fakeHomeDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(paths.fakeHomeDir, 'agent-os-memory-vault'), { recursive: true, mode: 0o700 });
  mkdirSync(paths.boardStoreDir, { recursive: true });
  mkdirSync(paths.bgTasksDir, { recursive: true });
  // validationDir itself is normally created lazily by validation-server.ts's
  // own directory lock; created here too (idempotent) so the registry seed
  // file below can be written before that unit starts.
  mkdirSync(paths.validationDir, { recursive: true, mode: 0o700 });

  // Isolation: run dir must never alias a production path.
  assertOutsideProductionPaths(path.resolve(paths.runDir), productionGuardedPaths(homedir()));

  const { agentDir } = buildIsolatedAgentDir(paths.agentDir);
  assertOutsideProductionPaths(path.resolve(agentDir), productionGuardedPaths(homedir()));

  // Production-write audit marker (owner amendment 2026-09-26): created ONCE
  // here, at the true start of the run, so a later supervisor restart still
  // audits the whole run rather than resetting the "since" window.
  const auditMarker = createAuditMarker(paths.runDir);

  // Second agent-os interception layer (found live in a Gate 1 attempt,
  // 2026-09-26): AGENT_OS_BIN only redirects the agent-os-inject EXTENSION's
  // own internal spawn calls. The extension's injected prompt text also
  // encourages the MODEL to run `agent-os recall`/`capture` itself as a bash
  // tool call — that resolves via PATH, not AGENT_OS_BIN, and reached the
  // REAL /root/.npm-global/bin/agent-os shim, writing a real child session id
  // into /root/agent-os/memory-vault/evidence/usage/usage-ledger.jsonl. Fixed
  // by prepending a directory containing a same-named `agent-os` stub (the
  // identical no-op script) onto PATH, so ANY invocation of the bare command
  // — extension-spawned or model-run — resolves to the stub first.
  const pathBinDir = path.join(paths.runDir, 'bin');
  mkdirSync(pathBinDir, { recursive: true });
  const stubTarget = path.join(pathBinDir, 'agent-os');
  try { unlinkSync(stubTarget); } catch { /* fine if it doesn't exist yet */ }
  symlinkSync(path.join(root, 'scripts', 'heap-soak', 'agent-os-stub.mjs'), stubTarget);
  const isolatedPath = `${pathBinDir}:${process.env.PATH ?? '/usr/bin:/bin'}`;

  // Registry seeding (parent amendment 2026-09-26, on by default): mimic
  // production's registry size (~1,700 entries) so the disposable server's
  // boot and session-listing cost matches production rather than a
  // near-empty registry. Written directly to the isolated registry path
  // (join(validationDir, 'session-registry.json'), see
  // buildValidationIsolationEnv) BEFORE the server boots, so it loads the
  // seed on first read. Entries point at non-existent paths inside the run
  // dir only.
  const seedRegistry = options.seedRegistry ?? true;
  let seededRegistryCount = 0;
  if (seedRegistry) {
    const count = options.seedRegistryCount ?? DEFAULT_SYNTHETIC_REGISTRY_COUNT;
    const synthetic = buildSyntheticRegistry(paths.runDir, count);
    writeFileSync(path.join(paths.validationDir, 'session-registry.json'), `${JSON.stringify(synthetic)}\n`);
    seededRegistryCount = synthetic.entries.length;
  }

  const inspectorPort = await findFreeTcpPort();
  // Reserved explicitly (rather than left to validation-server.ts's own
  // internal choice) so the browser-like WS client below knows it up front.
  const httpPort = await findFreeTcpPort();
  const serverUnit = serverUnitName(runId);
  const supervisorUnit = supervisorUnitName(runId);

  await startTransientUnit({
    unitName: serverUnit,
    sliceName: 'pi-web-ui-soak.slice',
    restart: 'no', // the server must NEVER be auto-restarted — that would reset the heap under test
    workingDirectory: root,
    properties: {
      MemoryMax: '6G',
      // Matches production (parent amendment 2026-09-26): production reserves
      // 96 PIDs/turn and allows 14 API turns (~1344 projected pids at full
      // admission), well within an 8192 cgroup pids limit — 512 here was an
      // artificial cgroup constraint this harness invented, which throttled
      // admission below what production actually allows.
      TasksMax: '8192',
    },
    env: {
      NODE_OPTIONS: '--max-old-space-size=4096', // production's own heap cap
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir, // the Pi SDK reads this one, not PI_AGENT_DIR
      // Board-pollution fix (owner amendment 2026-09-26): a FAKE $HOME
      // redirects every os.homedir()-based path in the copied Pi extensions
      // (memory/storage.ts's hardcoded AGENT_DIR, goal-engine's/watch-wake's/
      // compact-observability's os.homedir() fallback, enhanced-plan-mode's
      // plans dir, commandcode-provider's taste-learning read) away from the
      // real /root — Node's os.homedir() reads $HOME first on POSIX. Belt and
      // braces below with the explicit overrides these extensions also honour.
      HOME: paths.fakeHomeDir,
      PATH: isolatedPath,
      // agent-os-inject: no real `agent-os` process may run for a soak child.
      AGENT_OS_BIN: path.join(root, 'scripts', 'heap-soak', 'agent-os-stub.mjs'),
      AGENT_OS_STUB_LOG: paths.agentOsStubLog,
      AGENT_OS_INJECT_LOG: paths.agentOsInjectLog,
      BOARD_STORE_DIR: paths.boardStoreDir,
      // Third leak vector: a child can call the real CLI repo-anchored
      // (`npm --prefix /root/agent-os run agent-os …`, the form the skills
      // document), which bypasses both AGENT_OS_BIN and the PATH stub. Agent OS
      // resolves its vault from AGENT_OS_VAULT_ROOT first, so any such call
      // writes to this per-run vault instead of the real one.
      AGENT_OS_VAULT_ROOT: path.join(paths.fakeHomeDir, 'agent-os-memory-vault'),
      // watch-wake extension: explicit isolation on top of the HOME redirect —
      // this is the one that could otherwise reach the REAL production socket.
      PI_WEB_UI_WATCH_WAKE_SOCKET: path.join(paths.validationDir, 'internal-api.sock'),
      PI_WEB_UI_WATCH_WAKE_TOKEN_FILE: path.join(paths.validationDir, 'internal-api-token'),
      PI_WEB_UI_GOAL_HOME: paths.goalHomeDir,
      PI_COMPACTION_LOG: paths.compactionLogPath,
      PI_BG_TASKS_DIR: paths.bgTasksDir,
    },
    executable: 'npx',
    args: [
      'tsx', 'scripts/validation-server.ts',
      '--dir', paths.validationDir,
      '--compiled', // production-like: server/dist, not source
      '--inspect-port', String(inspectorPort),
      '--port', String(httpPort),
    ],
  });

  const serverMainPid = await waitForMainPid(serverUnit, 30_000);
  const inspector = await InspectorClient.connect(inspectorPort, 20_000);
  inspector.close();

  const socketPath = path.join(paths.validationDir, 'internal-api.sock');
  const tokenPath = path.join(paths.validationDir, 'internal-api-token');
  // Wait for the token file to exist (the server writes it during boot).
  const tokenDeadline = Date.now() + 20_000;
  while (Date.now() < tokenDeadline) {
    try { readFileSync(tokenPath); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  // Also wait for the socket ITSELF to exist (found live via Gate 0's
  // registry-seeding check, 2026-09-26): the server writes the token file
  // well before it finishes booting far enough to bind the Unix socket
  // (Command Code init + run-receipt recovery + session registry load all
  // happen in between), so a caller that only waits on the token file can
  // still hit `connect ENOENT` on the socket path. Waiting on both before
  // handing back `client` means every caller downstream (Gate 0, Gate 1, the
  // driver's first wave) is race-free, not just the ones that happen to run
  // later in the checklist.
  const socketDeadline = Date.now() + 20_000;
  while (Date.now() < socketDeadline && !existsSync(socketPath)) {
    await new Promise((r) => setTimeout(r, 250));
  }
  const client = new InternalApiClient({ socketPath, tokenPath });

  const laneBreakers = Object.fromEntries(LANE_DEFINITIONS.map((l) => [l.name, createBreakerState(l.name)])) as Record<LaneName, ReturnType<typeof createBreakerState>>;
  const now = Date.now();
  const totalMs = mode === 'micro' ? 20 * 60_000 : 24 * 3_600_000;
  const runState: RunState = {
    runId,
    mode,
    startedAt: new Date(now).toISOString(),
    endsAt: new Date(now + totalMs).toISOString(),
    runDir: paths.runDir,
    server: { unitName: serverUnit, socketPath, tokenPath, inspectorPort, mainPid: serverMainPid, httpPort },
    supervisor: { unitName: supervisorUnit },
    cycleCount: 0,
    laneBreakers,
    csvPath: paths.csvPath,
    eventsLogPath: paths.eventsLogPath,
    prodAuditMarkerPath: auditMarker.markerPath,
  };
  saveRunState(paths.runStatePath, runState);

  return { paths, serverUnit, supervisorUnit, serverMainPid, inspectorPort, socketPath, tokenPath, client, auditMarkerPath: auditMarker.markerPath, seededRegistryCount, httpPort };
}

export async function startSupervisorUnit(runId: string, paths: RunPaths, supervisorUnit: string): Promise<void> {
  const root = repoRoot();
  await startTransientUnit({
    unitName: supervisorUnit,
    sliceName: 'pi-web-ui-soak.slice',
    restart: 'on-failure',
    workingDirectory: root,
    properties: { MemoryMax: '1G', TasksMax: '128' },
    env: { HOME: homedir(), PATH: process.env.PATH ?? '/usr/bin:/bin' },
    executable: 'npx',
    args: ['tsx', 'scripts/heap-soak/supervisor.ts', '--run-state', paths.runStatePath],
  });
  await waitForMainPid(supervisorUnit, 20_000);
}
