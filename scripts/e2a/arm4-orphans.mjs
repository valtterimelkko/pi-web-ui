#!/usr/bin/env node
// E2a-3 arm 4 — orphans after a hard server crash (disposable topology, placement on in OUR anchor).
//   boot --run-dir D [--memory-max 2G] [--runtime-max 300]   slice + anchor + server; asserts tools root
//   child --run-dir D --message-file F [--ttl 3600]           spawn + prompt one real zai/glm-5.3-flash child via pi-orch
//   snapshot --run-dir D --out F                              placed-group/process snapshot (cgroup, limits, cmdline)
//   kill-server --run-dir D --mode hard|graceful              SIGKILL (hard crash) or SIGTERM stop (graceful contrast)
//   restart-server --run-dir D [--memory-max M] [--runtime-max S]
//   session-state --run-dir D --session SID                   pi-orch status for the child after restart
//   smoke --run-dir D                                         full plumbing smoke: boot → 1 tiny child → hard kill →
//                                                             sweep check → session state → teardown (STRESS-GATE smoke
//                                                             allowance: MemoryMax=2G, RuntimeMaxSec=300, ≤2 model children)
//   teardown [--run-dir D]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOk, tryRun, sleep, waitFor } from './lib/exec.mjs';
import {
  ensureSlice, startAnchor, startServer, assertToolsRootIsOurs, placedGroupsSnapshot,
  stopUnit, hardKillUnit, teardown, writeRunState, REPO_ROOT,
} from './lib/disposable-server.mjs';
import { buildAgentDir } from './lib/agentdir.mjs';
import { serverUnitName } from './lib/topology.mjs';

const PI_ORCH = '/root/pi-orch/bin/pi-orch';
const OWNER = 'orch-e2-0798cc10-E2a-3';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  const outDir = (d) => { fs.mkdirSync(path.dirname(d), { recursive: true, mode: 0o700 }); return d; };
  const writeJson = (file, obj) => fs.writeFileSync(outDir(file), `${JSON.stringify(obj, null, 2)}\n`);

  if (cmd === 'boot') {
    const runDir = requireArg(arg, '--run-dir');
    const memoryMax = arg('--memory-max', '2G');
    const runtimeMaxSec = Number(arg('--runtime-max', 300));
    // Idempotent boot: our own units may linger from a failed run (Restart=always on the anchor).
    await teardown({}).catch(() => {});
    await ensureSlice({});
    await startAnchor({});
    const agent = await buildAgentDir({
      destDir: path.join(runDir, 'agent'),
      sourceDir: path.join(process.env.HOME ?? '/root', '.pi', 'agent'),
    });
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'heap-soak', 'agent-os-stub.mjs'), path.join(runDir, 'agent-os-stub.mjs'));
    const server = await startServer({ runDir, memoryMax, runtimeMaxSec });
    const toolsRoot = await assertToolsRootIsOurs({ server });
    const state = { at: new Date().toISOString(), runDir, memoryMax, runtimeMaxSec, agent: { copied: agent.copied, skippedMissing: agent.skippedMissing }, server, toolsRoot };
    writeRunState(runDir, state);
    writeJson(path.join(runDir, 'boot.json'), state);
    console.log(JSON.stringify({ booted: true, unit: server.unit, socket: server.socketPath, toolsRoot: toolsRoot.verifiedLine }));
    return;
  }

  if (cmd === 'child') {
    const runDir = requireArg(arg, '--run-dir');
    const messageFile = requireArg(arg, '--message-file');
    const state = readRunState(runDir);
    const message = fs.readFileSync(messageFile, 'utf8');
    const cwd = path.join(runDir, 'child-cwd');
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const spawnOut = await runOk(PI_ORCH, [
      'spawn', '--socket', state.server.socketPath, '--token-path', state.server.tokenPath,
      '--runtime', 'pi', '--cwd', cwd,
      '--model-selector', 'zai/glm-5.3-flash', '--thinking', 'low',
      '--owner', OWNER, '--ttl', arg('--ttl', '3600'), '--id-only',
    ]);
    const sessionId = spawnOut.stdout.trim();
    const promptOut = await runOk(PI_ORCH, [
      'prompt', sessionId, '--socket', state.server.socketPath, '--token-path', state.server.tokenPath,
      '--message', message, '--no-completion-template', '--id-only',
    ]);
    const runId = promptOut.stdout.trim();
    writeJson(path.join(runDir, `child-${sessionId}.json`), { sessionId, runId, at: new Date().toISOString() });
    console.log(JSON.stringify({ sessionId, runId }));
    return;
  }

  if (cmd === 'snapshot') {
    const _runDir = requireArg(arg, '--run-dir');
    const snap = await placedGroupsSnapshot({});
    if (arg('--out')) writeJson(arg('--out'), { at: new Date().toISOString(), ...snap });
    console.log(JSON.stringify({ groups: Object.keys(snap.groups).length, processes: Object.keys(snap.processes).length }));
    return;
  }

  if (cmd === 'kill-server') {
    const runDir = requireArg(arg, '--run-dir');
    const mode = arg('--mode', 'hard');
    const at = new Date().toISOString();
    if (mode === 'hard') {
      const hard = await hardKillUnit(serverUnitName());
      writeJson(path.join(runDir, `kill-${mode}.json`), { at, mode, ...hard });
      console.log(JSON.stringify({ killed: mode, at, pidsKilled: hard.killed }));
      return;
    }
    await stopUnit(serverUnitName());
    writeJson(path.join(runDir, `kill-${mode}.json`), { at, mode });
    console.log(JSON.stringify({ killed: mode, at }));
    return;
  }

  if (cmd === 'restart-server') {
    const runDir = requireArg(arg, '--run-dir');
    const state = readRunState(runDir);
    const server = await startServer({
      runDir,
      memoryMax: arg('--memory-max', state.memoryMax ?? '2G'),
      runtimeMaxSec: Number(arg('--runtime-max', state.runtimeMaxSec ?? 300)),
    });
    const toolsRoot = await assertToolsRootIsOurs({ server });
    const updated = { ...state, server, toolsRoot, restartedAt: new Date().toISOString() };
    writeRunState(runDir, updated);
    writeJson(path.join(runDir, 'restart.json'), { at: updated.restartedAt, unit: server.unit, toolsRoot: toolsRoot.verifiedLine });
    console.log(JSON.stringify({ restarted: true, socket: server.socketPath }));
    return;
  }

  if (cmd === 'session-state') {
    const runDir = requireArg(arg, '--run-dir');
    const sessionId = requireArg(arg, '--session');
    const state = readRunState(runDir);
    const out = await tryRun(PI_ORCH, ['status', sessionId, '--socket', state.server.socketPath, '--token-path', state.server.tokenPath, '--json']);
    writeJson(path.join(runDir, `session-state-${sessionId}.json`), { at: new Date().toISOString(), raw: out ?? '(pi-orch status failed)' });
    console.log(out ?? '(no status)');
    return;
  }

  if (cmd === 'smoke') {
    const runDir = requireArg(arg, '--run-dir');
    const evidence = {};
    // 1. boot (MemoryMax=2G / RuntimeMaxSec=300 per the smoke allowance)
    await runThis(['scripts/e2a/arm4-orphans.mjs', 'boot', '--run-dir', runDir, '--memory-max', '2G', '--runtime-max', '300']);
    const state = readRunState(runDir);
    evidence.boot = { toolsRoot: state.toolsRoot.verifiedLine, unit: state.server.unit };
    // 2. one real child runs a short placed sleep
    const messageFile = path.join(runDir, 'smoke-message.txt');
    fs.writeFileSync(messageFile, 'Use the bash tool to run exactly this one command and nothing else:\necho CGROUP_MARKER $(cat /proc/self/cgroup); echo OOM_ADJ=$(cat /proc/self/oom_score_adj); sleep 120; echo SLEEP_DONE\n');
    await runThis(['scripts/e2a/arm4-orphans.mjs', 'child', '--run-dir', runDir, '--message-file', messageFile]);
    const childRecord = JSON.parse(fs.readdirSync(runDir).filter((f) => f.startsWith('child-') && f.endsWith('.json')).map((f) => fs.readFileSync(path.join(runDir, f), 'utf8')).pop());
    evidence.child = childRecord;
    // 3. wait until the sleep is running placed, then snapshot
    await waitFor(async () => {
      const snap = await placedGroupsSnapshot({});
      return Object.values(snap.processes).some((p) => /sleep 120/.test(p.cmdline));
    }, { timeoutMs: 90_000, pollMs: 500, label: 'placed sleep process' });
    writeJson(path.join(runDir, 'snapshot-before-kill.json'), { at: new Date().toISOString(), ...(await placedGroupsSnapshot({})) });
    // 4. hard kill
    await runThis(['scripts/e2a/arm4-orphans.mjs', 'kill-server', '--run-dir', runDir, '--mode', 'hard']);
    await sleep(3000);
    // 5. orphans snapshot — the sleep (and its bash) must survive in the anchor subtree
    const after = await placedGroupsSnapshot({});
    writeJson(path.join(runDir, 'snapshot-after-kill.json'), { at: new Date().toISOString(), ...after });
    const orphanPids = Object.keys(after.processes).map(Number).filter((pid) => /sleep 120|bash/.test(after.processes[pid].cmdline));
    if (orphanPids.length === 0) throw new Error('no orphaned tool processes survived the hard kill — nothing to prove');
    evidence.orphansAfterKill = orphanPids.map((pid) => ({ pid, cmdline: after.processes[pid].cmdline, cgroup: after.processes[pid].cgroupDir, limits: after.processes[pid].limits }));
    await sleep(10_000);
    const later = await placedGroupsSnapshot({});
    const stillRunning = orphanPids.filter((pid) => later.processes[pid]);
    evidence.orphansStillRunningAfter10s = stillRunning.length;
    // 6. restart → the startup sweep kills them (D0.md §9). Poll: the sweep runs a few
    // seconds into the new server's boot, so give it time and record when it lands.
    await runThis(['scripts/e2a/arm4-orphans.mjs', 'restart-server', '--run-dir', runDir]);
    let sweepAt = null;
    try {
      await waitFor(async () => {
        const now = await placedGroupsSnapshot({});
        return !orphanPids.some((pid) => now.processes[pid]);
      }, { timeoutMs: 45_000, pollMs: 1000, label: 'startup sweep removing orphans' });
      sweepAt = new Date().toISOString();
    } catch { /* recorded as survived below */ }
    const afterRestart = await placedGroupsSnapshot({});
    writeJson(path.join(runDir, 'snapshot-after-restart.json'), { at: new Date().toISOString(), ...afterRestart });
    const survived = orphanPids.filter((pid) => afterRestart.processes[pid]);
    evidence.sweep = { orphanedBeforeRestart: orphanPids, swept: orphanPids.filter((p) => !survived.includes(p)), survived, sweepCompletedAt: sweepAt };
    // 7. child session state after restart
    await runThis(['scripts/e2a/arm4-orphans.mjs', 'session-state', '--run-dir', runDir, '--session', childRecord.sessionId]);
    evidence.sessionStateFile = path.join(runDir, `session-state-${childRecord.sessionId}.json`);
    // 8. teardown
    await teardown({ runDir });
    evidence.teardown = 'server + anchor stopped, slice reverted';
    writeJson(path.join(runDir, 'smoke.json'), evidence);
    console.log('arm4 smoke OK');
    return;
  }

  if (cmd === 'teardown') {
    await teardown({});
    console.log('teardown done');
    return;
  }

  throw new Error(`unknown command: ${cmd ?? '(none)'}`);
}

function requireArg(arg, name) {
  const v = arg(name);
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function readRunState(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'run-state.json'), 'utf8'));
}

async function runThis(args) {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), path.basename(args[0]));
  await runOk(process.execPath, [script, ...args.slice(1)], { timeoutMs: 300_000 });
}
main().catch((err) => {
  console.error(`[arm4] ${err.message}`);
  process.exitCode = 1;
});
