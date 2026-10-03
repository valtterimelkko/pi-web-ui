// E2a-3 harness — runtime lifecycle for the disposable topology:
// e2a-3.slice (MemoryMax 12G / swap 1G) + e2a-3-tools-anchor.service + e2a-3-server.service.
// Mirrors production at scaled-down limits; every unit name starts e2a-3- (host-guard coverage).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOk, tryRun, sleep, waitFor } from './exec.mjs';
import {
  buildAnchorUnitArgv,
  buildServerUnitArgv,
  buildPlacementEnvFile,
  buildServerIsolationEnv,
  serverUnitName,
  anchorUnitName,
  sliceName,
} from './topology.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export { REPO_ROOT };

const CGROOT = '/sys/fs/cgroup';

/** A unit's real cgroup path comes from systemd (slice parents are name-derived: e2a-3.slice → /e2a.slice/e2a-3.slice). */
export async function resolveUnitCgroupPath(unit) {
  const out = await runOk('systemctl', ['show', unit, '-p', 'ControlGroup', '--no-pager']);
  const m = /^ControlGroup=(.+)$/.exec(out.stdout.trim());
  if (!m || !m[1]) throw new Error(`no ControlGroup for ${unit}`);
  return `${CGROOT}${m[1]}`;
}

export function readCgroupProcs(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'cgroup.procs'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).map(Number);
  } catch {
    return [];
  }
}

/** Realise the lane slice with its containment limits — ALWAYS (re)applied: idempotent,
 *  and verified by read-back so a silently-missing limit can never boot the topology. */
export async function ensureSlice({ slice = sliceName(), memoryMax = '12G', memorySwapMax = '1G' } = {}) {
  await runOk('systemctl', ['set-property', slice, `MemoryMax=${memoryMax}`, `MemorySwapMax=${memorySwapMax}`, '--runtime']);
  const out = await runOk('systemctl', ['show', slice, '-p', 'MemoryMax', '--no-pager']);
  const applied = /MemoryMax=(\S+)/.exec(out.stdout)?.[1];
  if (!applied || !/^\d+$/.test(applied)) {
    throw new Error(`e2a-3.slice MemoryMax did not apply (show: ${out.stdout.trim()})`);
  }
  return { slice, memoryMax, memorySwapMax, appliedBytes: Number(applied) };
}

export async function startAnchor(opts = {}) {
  const argv = buildAnchorUnitArgv(opts);
  await runOk(argv[0], argv.slice(1), { timeoutMs: 20_000 });
  const anchorUnit = opts.anchorUnit ?? anchorUnitName();
  await waitFor(async () => (await unitIsActive(anchorUnit)) === true, { timeoutMs: 15_000, label: 'anchor active' });
  // The anchor's ExecStart re-enables the controllers in its own subtree (no-internal-processes rule).
  const root = await resolveUnitCgroupPath(anchorUnit);
  await waitFor(() => {
    try {
      return /memory/.test(fs.readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8'));
    } catch {
      return false;
    }
  }, { timeoutMs: 15_000, label: 'anchor subtree controllers' });
  return { anchorUnit, cgroupPath: root };
}

export async function startServer({
  runDir,
  memoryMax = '2G',
  runtimeMaxSec = 300,
} = {}) {
  const validationDir = path.join(runDir, 'validation');
  fs.mkdirSync(validationDir, { recursive: true, mode: 0o700 });
  const socketPath = path.join(validationDir, 'internal-api.sock');
  const tokenPath = path.join(validationDir, 'internal-api-token');
  // A hard-killed predecessor leaves its socket/token files behind; waiting for
  // their existence would return before the NEW server has booted at all.
  for (const stale of [socketPath, tokenPath]) {
    try { fs.rmSync(stale, { force: true }); } catch { /* gone */ }
  }
  const envFile = path.join(runDir, 'placement.env');
  fs.writeFileSync(envFile, buildPlacementEnvFile({}), { mode: 0o600 });
  const env = buildServerIsolationEnv({ runDir, agentDir: path.join(runDir, 'agent') });
  const port = await freeTcpPort();
  const argv = buildServerUnitArgv({
    workdir: REPO_ROOT,
    validationDir,
    port,
    env,
    envFile,
    memoryMax,
    runtimeMaxSec,
  });
  await runOk(argv[0], argv.slice(1), { timeoutMs: 20_000 });
  await waitFor(() => fs.existsSync(socketPath) && fs.existsSync(tokenPath), { timeoutMs: 60_000, label: 'server socket+token' });
  return {
    unit: serverUnitName(),
    validationDir,
    socketPath,
    tokenPath,
    port,
    envFile,
    memoryMax,
    runtimeMaxSec,
  };
}

/** Assert the server resolved OUR anchor as its placement tools root (never production's).
 *  Only a `tools root verified` line naming our anchor counts — a DISABLED line also
 *  contains the anchor path and must never satisfy this assertion; the latest boot's
 *  line wins (the journal window may hold several boots). */
export async function assertToolsRootIsOurs({ server, anchorUnit = anchorUnitName() }) {
  const journal = await tryRun('journalctl', ['-u', server.unit, '--since', '-10 min', '--no-pager', '-o', 'cat']);
  const lines = (journal ?? '').split('\n').filter((l) => /Placement/i.test(l));
  const verified = lines.filter((l) => /tools root verified/.test(l) && l.includes(anchorUnit));
  const disabled = lines.filter((l) => /DISABLED/.test(l));
  const latest = verified.at(-1);
  if (!latest) {
    throw new Error(`no "[Placement] tools root verified ${anchorUnit}" line in ${server.unit} journal; placement lines: ${JSON.stringify([...disabled, ...lines].map((l) => l.trim()))}`);
  }
  if (/pi-web-ui-tools-anchor\.service/.test(latest)) {
    throw new Error(`placement resolved to PRODUCTION's anchor: ${latest}`);
  }
  return { verifiedLine: latest.trim(), lines: lines.map((l) => l.trim()) };
}

/** Snapshot every placed pi-* group under the anchor: {cgroupPath: [pids]} plus cmdline detail. */
export async function placedGroupsSnapshot({ anchorUnit = anchorUnitName() } = {}) {
  const root = await resolveUnitCgroupPath(anchorUnit);
  const out = { groups: {}, processes: {} };
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !(ent.name.startsWith('pi-') || ent.name === 'supervisor')) continue;
    const dir = path.join(root, ent.name);
    const pids = readCgroupProcs(dir);
    if (pids.length === 0) continue;
    out.groups[dir] = pids;
    for (const pid of pids) {
      let cmdline = '';
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      } catch { /* gone */ }
      let cgroup = '';
      try {
        cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
      } catch { /* gone */ }
      let limits = {};
      try {
        limits = {
          memoryMax: fs.readFileSync(path.join(dir, 'memory.max'), 'utf8').trim(),
          memoryHigh: fs.readFileSync(path.join(dir, 'memory.high'), 'utf8').trim(),
          pidsMax: fs.readFileSync(path.join(dir, 'pids.max'), 'utf8').trim(),
          memorySwapMax: fs.readFileSync(path.join(dir, 'memory.swap.max'), 'utf8').trim(),
          oomScoreAdj: fs.readFileSync(`/proc/${pid}/oom_score_adj`, 'utf8').trim(),
        };
      } catch { /* gone */ }
      out.processes[pid] = { cgroupDir: dir, cmdline, cgroup, limits };
    }
  }
  return out;
}

export async function unitIsActive(unit) {
  const out = await tryRun('systemctl', ['is-active', unit]);
  return out?.trim() === 'active';
}

export async function stopUnit(unit) {
  await tryRun('systemctl', ['stop', unit]);
}

export async function killUnitMain(unit, signal = 'SIGKILL') {
  await runOk('systemctl', ['kill', unit, `--signal=${signal}`, '--kill-who=main']);
}

/**
 * Hard crash: SIGKILL every process in the unit's cgroup (kernel-OOM style — no handler
 * runs anywhere, unlike `systemctl kill --kill-who=main`, where systemd's KillMode then
 * SIGTERMs survivors and the server's graceful shutdown cleans its placement groups).
 */
export async function hardKillUnit(unit) {
  const cgOut = await runOk('systemctl', ['show', unit, '-p', 'ControlGroup', '--no-pager']);
  const cg = /^ControlGroup=(.+)$/m.exec(cgOut.stdout.trim())?.[1];
  if (!cg) throw new Error(`no ControlGroup for ${unit}`);
  const procsText = fs.readFileSync(`${CGROOT}${cg}/cgroup.procs`, 'utf8');
  const pids = procsText.split('\n').map((l) => Number(l.trim())).filter(Boolean);
  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch { /* already gone */ }
  }
  await waitFor(async () => (await unitIsActive(unit)) === false, { timeoutMs: 20_000, label: `${unit} inactive after hard kill` }).catch(() => {});
  return { killed, cgroup: cg };
}

export async function teardown({ keepSlice = false } = {}) {
  await stopUnit(serverUnitName());
  await stopUnit(anchorUnitName());
  if (!keepSlice) {
    await tryRun('systemctl', ['revert', sliceName()]);
  }
  // Wait until both units are collected so the guard/hand-back sees nothing left.
  for (const unit of [serverUnitName(), anchorUnitName()]) {
    await waitFor(async () => (await unitIsActive(unit)) === false, { timeoutMs: 15_000, label: `${unit} stopped` }).catch(() => {});
  }
}

async function freeTcpPort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function writeRunState(runDir, state) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(runDir, 'run-state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

export { sleep, waitFor };
