#!/usr/bin/env node
/**
 * E2a-5 arm 1 — independent re-run of hb4's two-arm admission proof on THIS
 * build only (Hb4.md §4.2 M4 method; single server, master's build not needed:
 * the claim under re-test is this build's working-set behaviour).
 *
 * Claim hb4: admission admits under heavy *reclaimable* page cache and refuses
 * under real *anonymous* memory.
 *
 * Runs INSIDE a delegated transient unit (e2a-5-admission, MemoryMax=6G,
 * MemorySwapMax=1G, Delegate=yes) and builds the production-shaped topology:
 *
 *   <unit>/control — the disposable server + this driver (memory.max 4G)
 *   <unit>/tools   — the tools slice (memory.max 2600M / memory.high 2400M)
 *     <unit>/tools/arm1-cache — page-cache arm group (allocation-free fill)
 *     <unit>/tools/arm2-anon  — self-capped anonymous allocation (~2.3 GB)
 *
 * Probes per arm: ONE timestamped raw sample per group, then GET /capacity and
 * a real POST /sessions on zai/glm-5.3-flash. Host MemAvailable must be ≥ 12G
 * at start. Deliberate allocations self-cap ≪ 10 GB (COMMON-BRIEF rule 4).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn as spawnProc } from 'node:child_process';
import path from 'node:path';
import {
  parseArgs, now, readNum, readTrim, assertMemAvailable, sampleCgroup, rmdirCgroup,
  bootServer, api, readBuildIdentity, MB, GiB,
} from './lib.mjs';

const argv = parseArgs(process.argv.slice(2));
const WT = argv['worktree'];
const RUN_DIR = argv['run-dir'];
const PORT = argv['port'] ?? '0';
if (!WT || !RUN_DIR) {
  console.error('usage: node hb4-admission.mjs --worktree=<wt> --run-dir=<dir> [--port=<port>]');
  process.exit(64);
}
mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

const CG_ROOT = '/sys/fs/cgroup';
const TOOLS_MAX = 2600 * MB;
const TOOLS_HIGH = 2400 * MB;
const CONTROL_MAX = 4 * GiB;
const CACHE_MB = 2250;     // arm 1: ~2.2 GB clean page cache
const ANON_CAP_MB = 2350;  // arm 2: self-cap; target ~2.3 GB anon
const ANON_TARGET_MB = 2200;

// Admission knobs — identical to Hb4.md §4.2 (the method under re-test).
const ADMISSION_ENV = {
  INTERNAL_API_ADMISSION_MIN_HEADROOM_MB: '4800',
  INTERNAL_API_ADMISSION_RESERVED_MB_PER_TURN: '1',
  INTERNAL_API_ADMISSION_HOST_MIN_HEADROOM_MB: '512',
  INTERNAL_API_ADMISSION_MAX_ACTIVE_TURNS: '8',
  INTERNAL_API_ADMISSION_INTERACTIVE_RESERVE: '1',
  INTERNAL_API_ADMISSION_RESERVED_PIDS_PER_TURN: '8',
};

const result = {
  proof: 'e2a5-hb4-admission-rerun',
  startedAt: now(),
  worktree: WT,
  runDir: RUN_DIR,
  admissionEnv: ADMISSION_ENV,
  expectations: { '1-page-cache': 'admitted', '2-anon': 'refused(memory_pressure)' },
  arms: [],
  pass: false,
};
const out = (l) => console.log(l);
const finish = (code) => {
  result.finishedAt = now();
  writeFileSync(path.join(RUN_DIR, 'hb4-admission-result.json'), JSON.stringify(result, null, 2) + '\n');
  process.exit(code);
};

let server = null;
let toolsDir = null;
let controlDir = null;

try {
  // ── unit + topology (hb4's no-internal-process bootstrap) ────────────────
  const unitCgroupRel = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n')
    .find((l) => l.startsWith('0::'))?.slice(3);
  if (!unitCgroupRel) { console.error('ABORT: no cgroup v2 self path'); finish(1); }
  const unitDir = CG_ROOT + unitCgroupRel;
  const unitMax = readNum(path.join(unitDir, 'memory.max'));
  if (unitMax === undefined || !(unitMax > 0) || unitMax > 12 * GiB) {
    console.error(`ABORT: unit ${unitDir} memory.max=${unitMax} not bounded ≤ 12G — run inside the e2a-5-admission unit`); finish(1);
  }
  if (unitCgroupRel.includes('pi.slice') || unitCgroupRel.includes('pi-web-ui')) {
    console.error(`ABORT: refusing a production-shaped cgroup ${unitCgroupRel}`); finish(1);
  }
  result.unitCgroup = unitCgroupRel;
  result.unitMemoryMaxBytes = unitMax;

  controlDir = path.join(unitDir, 'control');
  toolsDir = path.join(unitDir, 'tools');
  mkdirSync(controlDir, { recursive: true });
  writeFileSync(path.join(controlDir, 'cgroup.procs'), String(process.pid));
  writeFileSync(path.join(unitDir, 'cgroup.subtree_control'), '+memory +pids');
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(path.join(controlDir, 'memory.max'), String(CONTROL_MAX));
  writeFileSync(path.join(toolsDir, 'memory.max'), String(TOOLS_MAX));
  writeFileSync(path.join(toolsDir, 'memory.high'), String(TOOLS_HIGH));
  writeFileSync(path.join(toolsDir, 'cgroup.subtree_control'), '+memory +pids');
  for (const [p, want] of [
    [path.join(controlDir, 'memory.max'), CONTROL_MAX],
    [path.join(toolsDir, 'memory.max'), TOOLS_MAX],
    [path.join(toolsDir, 'memory.high'), TOOLS_HIGH],
  ]) {
    const got = readNum(p);
    if (got !== want) { console.error(`ABORT: ${p} readback ${got} != ${want}`); finish(1); }
  }
  result.topology = { controlDir, toolsDir, toolsMaxBytes: TOOLS_MAX, toolsHighBytes: TOOLS_HIGH, controlMaxBytes: CONTROL_MAX };

  // Host safety pre-flight: MemAvailable ≥ 12 GiB before any arm.
  result.hostMemAvailableBytesAtStart = assertMemAvailable(12 * GiB);

  // ── isolated agent dir: zai credential ONLY (never printed) ──────────────
  const agentDir = path.join(RUN_DIR, 'agent-dir');
  mkdirSync(agentDir, { recursive: true });
  const fullAuth = JSON.parse(readFileSync('/root/.pi/agent/auth.json', 'utf8'));
  if (!fullAuth.zai) { console.error('ABORT: no zai credential present'); finish(1); }
  writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ zai: fullAuth.zai }, null, 2) + '\n');
  const fullModels = JSON.parse(readFileSync('/root/.pi/agent/models.json', 'utf8'));
  writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { zai: fullModels.providers?.zai ?? {} } }, null, 2) + '\n');
  result.credentialCopies = ['agent-dir/auth.json', 'agent-dir/models.json'];

  const fakeHome = path.join(RUN_DIR, 'fake-home');
  mkdirSync(fakeHome, { recursive: true });

  result.build = readBuildIdentity(WT);
  if (!result.build?.revision) { console.error('ABORT: no build identity — build first'); finish(1); }

  // ── one disposable server, PI_TOOLS_SLICE at this unit's live tools tree ─
  const valDir = path.join(RUN_DIR, 'val');
  server = await bootServer({
    wt: WT, valDir,
    env: {
      ...ADMISSION_ENV,
      NODE_ENV: 'test',
      HOME: fakeHome,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_TOOLS_PLACEMENT: 'on',
      PI_TOOLS_CGROUP_ROOT: CG_ROOT,
      PI_TOOLS_SLICE: toolsDir,
      PI_TOOLS_RUNTIME_DIR: path.join(RUN_DIR, 'placement'),
      ...(PORT !== '0' ? { PORT } : {}),
    },
    logFile: path.join(RUN_DIR, 'server.log'),
  });
  result.server = { valDir, buildRevision: result.build.revision, startedAt: now() };
  out(`server up: build ${result.build.revision?.slice(0, 8)} socket ${server.socketPath}`);

  // Parent adjustment 2: the server journal must list ONLY the arm's route.
  const provLine = readTrim(path.join(RUN_DIR, 'server.log'))?.split('\n').find((l) => l.includes('Available providers (with auth):'));
  const provList = provLine?.split('Available providers (with auth):')[1]?.trim() ?? null;
  result.availableProviders = { line: provLine ?? null, list: provList };
  if (provList !== 'zai') {
    console.error(`ABORT: provider assertion failed — expected only 'zai', got: ${provList ?? '(line missing)'}`);
    finish(1);
  }
  out('provider assertion ok: only zai');

  const workspace = path.join(RUN_DIR, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const capacityProbe = async () => {
    const at = now();
    const r = await api({ socketPath: server.socketPath, tokenPath: server.tokenPath, method: 'GET', apiPath: '/api/v1/capacity' });
    const body = JSON.parse(r.body);
    return {
      at, httpStatus: r.status, available: body.available, reason: body.reason ?? null,
      activeTurns: body.activeTurns ?? null,
      memory: {
        currentBytes: body.memory?.currentBytes, limitBytes: body.memory?.limitBytes,
        highBytes: body.memory?.highBytes, headroomBytes: body.memory?.headroomBytes,
        minimumHeadroomBytes: body.memory?.minimumHeadroomBytes,
        projectedHeadroomBytes: body.memory?.projectedHeadroomBytes, source: body.memory?.source,
      },
    };
  };
  const admissionProbe = async () => {
    const at = now();
    try {
      const r = await api({
        socketPath: server.socketPath, tokenPath: server.tokenPath, method: 'POST', apiPath: '/api/v1/sessions',
        body: { runtime: 'pi', cwd: workspace, model: 'zai/glm-5.3-flash', source: 'e2a5-hb4-rerun' },
      });
      if (r.status !== 201) {
        let body = {};
        try { body = JSON.parse(r.body); } catch { /* non-JSON */ }
        const verdict = r.status === 503 && body.code === 'ADMISSION_CAPACITY_EXHAUSTED'
          ? `refused(${body.reason ?? 'unknown'})`
          : `error(${r.status}/${body.code ?? '?'})`;
        return { at, verdict, httpStatus: r.status, code: body.code ?? null, reason: body.reason ?? null };
      }
      const j = JSON.parse(r.body);
      let deleted = null;
      try {
        await api({ socketPath: server.socketPath, tokenPath: server.tokenPath, method: 'DELETE', apiPath: `/api/v1/sessions/${j.sessionId}` });
        deleted = now();
      } catch { deleted = 'delete-failed'; }
      return { at, verdict: 'admitted', httpStatus: 201, sessionId: j.sessionId, servedModel: j.model ?? null, deletedAt: deleted };
    } catch (e) {
      return { at, verdict: `error(${String(e).slice(0, 120)})` };
    }
  };

  const runArmProbes = (arm) => async () => {
    const cap = await capacityProbe();
    const adm = await admissionProbe();
    arm.probes = [{ kind: 'capacity', ...cap }, { kind: 'create', ...adm }];
    arm.verdicts = { expected: result.expectations[arm.arm] ?? 'n/a', actual: adm.verdict };
    arm.ok = (arm.arm === '1-page-cache') ? adm.verdict === 'admitted'
      : (arm.arm === '2-anon') ? (adm.verdict.startsWith('refused') && adm.reason === 'memory_pressure')
      : true;
    out(`arm ${arm.arm}: ${adm.verdict} (capacity available=${cap.available} current=${((cap.memory.currentBytes ?? 0) / MB).toFixed(1)}MB activeTurns=${cap.activeTurns})`);
  };

  // ── baseline positive control ─────────────────────────────────────────────
  {
    const arm = { arm: 'baseline', startedAt: now(), sampleTools: sampleCgroup('tools-baseline', toolsDir), sampleControl: sampleCgroup('control-baseline', controlDir) };
    await runArmProbes(arm)();
    arm.finishedAt = now();
    result.arms.push(arm);
  }

  // ── ARM 1: ~2.2 GB clean page cache inside the tools subtree ─────────────
  {
    const arm = { arm: '1-page-cache', startedAt: now() };
    const group = path.join(toolsDir, 'arm1-cache');
    mkdirSync(group, { recursive: true });
    const cacheFile = path.join(RUN_DIR, 'cache.bin');
    const fill = spawnProc('node', ['-e', `
      const fs = require('fs');
      fs.writeFileSync(process.env.ARM_GROUP + '/cgroup.procs', String(process.pid));
      const file = process.argv[1];
      const size = ${CACHE_MB} * 1024 * 1024;
      const chunk = Buffer.alloc(32 * 1024 * 1024, 1);
      const fd = fs.openSync(file, 'w');
      for (let w = 0; w < size; w += chunk.length) fs.writeSync(fd, chunk);
      fs.fsyncSync(fd); fs.closeSync(fd);
      const fd2 = fs.openSync(file, 'r');
      const sink = Buffer.alloc(chunk.length);
      let r = 0;
      while (r < size) { const n = fs.readSync(fd2, sink, 0, sink.length, null); if (n <= 0) break; r += n; }
      fs.closeSync(fd2);
      console.log('FILLED');
    `, cacheFile], { cwd: RUN_DIR, env: { ...process.env, ARM_GROUP: group }, stdio: ['ignore', 'pipe', 'pipe'] });
    let fillOut = '';
    fill.stdout.on('data', (d) => { fillOut += d; });
    fill.stderr.on('data', (d) => { fillOut += d; });
    const fillExit = await new Promise((res) => fill.once('exit', res));
    arm.fill = { exitCode: fillExit, output: fillOut.trim().split('\n').slice(-2), cacheFileMB: CACHE_MB, at: now() };
    if (fillExit !== 0) throw new Error(`arm 1 fill failed: ${fillOut.slice(-300)}`);

    // Wait for inactive_file to dominate (bounded retries, all sampled).
    let sample = sampleCgroup('tools-arm1', toolsDir);
    const tries = [{ at: sample.at, inactiveFileBytes: sample.inactiveFileBytes }];
    for (let i = 0; i < 5 && (sample.inactiveFileBytes ?? 0) < 1.8 * GiB; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      sample = sampleCgroup(`tools-arm1-retry-${i + 1}`, toolsDir);
      tries.push({ at: sample.at, inactiveFileBytes: sample.inactiveFileBytes });
    }
    arm.sampleTools = sample;
    arm.sampleControl = sampleCgroup('control-arm1', controlDir);
    arm.settleTries = tries;
    await runArmProbes(arm)();
    arm.finishedAt = now();
    result.arms.push(arm);

    // teardown: drop the cache, reclaim, remove the group
    rmSync(cacheFile, { force: true });
    try { writeFileSync(path.join(toolsDir, 'memory.reclaim'), '3G'); } catch { /* best effort */ }
    await rmdirCgroup(group, 'arm1-cache');
    arm.postTeardown = { at: now(), sampleTools: sampleCgroup('tools-arm1-post', toolsDir) };
  }

  // ── recovery control after reclaim ────────────────────────────────────────
  {
    const arm = { arm: '1-recovery', startedAt: now(), sampleTools: sampleCgroup('tools-recovery', toolsDir) };
    await runArmProbes(arm)();
    arm.finishedAt = now();
    result.arms.push(arm);
  }

  // ── ARM 2: self-capped anonymous allocation (~2.3 GB) ────────────────────
  {
    const arm = { arm: '2-anon', startedAt: now() };
    const group = path.join(toolsDir, 'arm2-anon');
    mkdirSync(group, { recursive: true });
    const alloc = spawnProc('node', ['-e', `
      const fs = require('fs');
      const g = process.env.ARM_GROUP;
      fs.writeFileSync(g + '/cgroup.procs', String(process.pid));
      const CAP = ${ANON_CAP_MB} * 1024 * 1024, TARGET = ${ANON_TARGET_MB} * 1024 * 1024;
      const bufs = []; let total = 0;
      const stat = () => Number((fs.readFileSync(g + '/memory.stat', 'utf8').split('\\n').find(l => l.startsWith('anon ')) || 'anon 0').split(/\\s+/)[1]);
      while (total < CAP) {
        const b = Buffer.alloc(64 * 1024 * 1024, 1); bufs.push(b); total += b.length;
        b.fill(2);
        if (stat() >= TARGET) break;
      }
      console.log('READY anon=' + stat());
      setInterval(() => { bufs[0].fill(3); }, 1000);
      process.on('SIGTERM', () => process.exit(0));
    `], { cwd: RUN_DIR, env: { ...process.env, ARM_GROUP: group }, stdio: ['ignore', 'pipe', 'pipe'] });
    let allocOut = '';
    alloc.stdout.on('data', (d) => { allocOut += d; });
    alloc.stderr.on('data', (d) => { allocOut += d; });
    let ready = null;
    for (let i = 0; i < 300 && ready === null; i++) {
      const m = allocOut.match(/READY anon=(\d+)/);
      if (m) ready = Number(m[1]);
      else if (alloc.exitCode !== null) break;
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (ready === null) throw new Error(`arm 2 allocator never READY: ${allocOut.slice(-300)}`);
    arm.allocator = { pid: alloc.pid, readyAnonBytes: ready, capMB: ANON_CAP_MB, targetAnonMB: ANON_TARGET_MB, at: now() };
    arm.sampleTools = sampleCgroup('tools-arm2', toolsDir);
    arm.sampleControl = sampleCgroup('control-arm2', controlDir);
    await runArmProbes(arm)();
    arm.finishedAt = now();
    result.arms.push(arm);

    try { alloc.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 500));
    try { alloc.kill('SIGKILL'); } catch { /* already gone */ }
    await rmdirCgroup(group, 'arm2-anon');
  }

  await server.stop();
  result.server.stoppedAt = now();
  result.pass = result.arms.filter((a) => ['1-page-cache', '2-anon'].includes(a.arm)).every((a) => a.ok);
  const arm1 = result.arms.find((a) => a.arm === '1-page-cache');
  const arm2 = result.arms.find((a) => a.arm === '2-anon');
  out(`hb4 re-run pass=${result.pass} (arm1=${arm1?.verdicts?.actual} ok=${arm1?.ok} arm2=${arm2?.verdicts?.actual} ok=${arm2?.ok})`);
  finish(result.pass ? 0 : 2);
} catch (e) {
  result.error = String(e && e.stack ? e.stack : e);
  try { if (server) await server.stop(); } catch { /* best effort */ }
  if (toolsDir) await rmdirCgroup(path.join(toolsDir, 'arm2-anon'), 'arm2-anon');
  if (toolsDir) await rmdirCgroup(path.join(toolsDir, 'arm1-cache'), 'arm1-cache');
  finish(1);
}
