/**
 * Shared launch sequence for Gate 0 (preflight) and Gate 1 (micro-soak):
 * build the isolated agent dir, start the disposable server as a transient
 * systemd unit (with the production heap cap + --inspect), wait for it to be
 * observably up, and write the initial run-state.json.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { buildIsolatedAgentDir } from './agent-dir.js';
import { resolveRunPaths, serverUnitName, supervisorUnitName, type RunPaths } from './paths.js';
import { startTransientUnit, waitForMainPid } from './systemd-units.js';
import { InspectorClient } from './inspector.js';
import { saveRunState } from './run-state-io.js';
import { assertOutsideProductionPaths, productionGuardedPaths } from '../../server/src/live-validation/heap-soak/isolation.js';
import { createBreakerState } from '../../server/src/live-validation/heap-soak/circuit-breaker.js';
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

export async function launchDisposableServer(runId: string, mode: 'micro' | 'full'): Promise<LaunchResult> {
  const paths = resolveRunPaths(runId);
  mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(paths.childWorkspaceRoot, { recursive: true });
  mkdirSync(paths.snapshotDir, { recursive: true });
  mkdirSync(paths.fakeHomeDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.boardStoreDir, { recursive: true });
  mkdirSync(paths.bgTasksDir, { recursive: true });

  // Isolation: run dir must never alias a production path.
  assertOutsideProductionPaths(path.resolve(paths.runDir), productionGuardedPaths(homedir()));

  const { agentDir } = buildIsolatedAgentDir(paths.agentDir);
  assertOutsideProductionPaths(path.resolve(agentDir), productionGuardedPaths(homedir()));

  const inspectorPort = await findFreeTcpPort();
  const serverUnit = serverUnitName(runId);
  const supervisorUnit = supervisorUnitName(runId);
  const root = repoRoot();

  await startTransientUnit({
    unitName: serverUnit,
    sliceName: 'pi-web-ui-soak.slice',
    restart: 'no', // the server must NEVER be auto-restarted — that would reset the heap under test
    workingDirectory: root,
    properties: {
      MemoryMax: '6G',
      TasksMax: '512',
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
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      // agent-os-inject: no real `agent-os` process may run for a soak child.
      AGENT_OS_BIN: path.join(root, 'scripts', 'heap-soak', 'agent-os-stub.mjs'),
      AGENT_OS_STUB_LOG: paths.agentOsStubLog,
      AGENT_OS_INJECT_LOG: paths.agentOsInjectLog,
      BOARD_STORE_DIR: paths.boardStoreDir,
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
    ],
  });

  const serverMainPid = await waitForMainPid(serverUnit, 30_000);
  const inspector = await InspectorClient.connect(inspectorPort, 20_000);
  inspector.close();

  const socketPath = path.join(paths.validationDir, 'internal-api.sock');
  const tokenPath = path.join(paths.validationDir, 'internal-api-token');
  // Wait for the token file to exist (the server writes it during boot).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { readFileSync(tokenPath); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
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
    server: { unitName: serverUnit, socketPath, tokenPath, inspectorPort, mainPid: serverMainPid },
    supervisor: { unitName: supervisorUnit },
    cycleCount: 0,
    laneBreakers,
    csvPath: paths.csvPath,
    eventsLogPath: paths.eventsLogPath,
  };
  saveRunState(paths.runStatePath, runState);

  return { paths, serverUnit, supervisorUnit, serverMainPid, inspectorPort, socketPath, tokenPath, client };
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
