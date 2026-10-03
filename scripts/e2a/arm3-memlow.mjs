#!/usr/bin/env node
// E2a-3 arm 3 — MemoryLow eviction contrast under load (contained, e2a-3-memlow unit).
//   run --out-dir D [--scale full|smoke]
//     full:  e2a-3-memlow (MemoryMax=8G, MemoryLow=4G, MemorySwapMax=0, RuntimeMaxSec=900,
//            Delegate=yes) with two file-backed sibling groups (1.5 GiB each; one with
//            memory.low, one without) + an anon hog driving the parent to its limit.
//     smoke: STRESS-GATE plumbing smoke — 64 MiB file sets, NO hog, MemoryMax=2G,
//            RuntimeMaxSec=300, no eviction pressure.
//   payload|worker|hog are unit-internal subcommands.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runOk, tryRun, sleep, waitFor } from './lib/exec.mjs';
import { parseMemoryEvents as parseMemoryEventsFallthrough } from './lib/oomrank.mjs';
import { parseMemoryCurrent, parseMemoryStat, summariseMemoryLowContrast } from './lib/memlow.mjs';

const UNIT = 'e2a-3-memlow';
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
// Deliberate-OOM arm: the hog may OOM at the unit limit — must live in e2a-oom.slice
// (STRESS-GATE.md 21:50 amendment; see arm2-oom.mjs OOM_ARM_SLICE comment).
const OOM_ARM_SLICE = 'e2a-oom.slice';

/** Pure guard: the unit's unified cgroup path must sit inside the OOM-arm slice's subtree
 *  (systemd name-derived nesting: /e2a.slice/e2a-oom.slice/<unit>). */
export function assertCgroupUnderSlice(cgroupPath, slice = OOM_ARM_SLICE) {
  const norm = `/${String(cgroupPath ?? '').replace(/^\/+|\/+$/g, '')}/`;
  if (!norm.includes(`/${slice}/`)) {
    throw new Error(`refusing to run the memlow hog: cgroup path ${cgroupPath} is not inside /${slice}/ (guard would trip)`);
  }
  return norm.replace(/\/+$/, '');
}

/** systemd-run argv for the MemoryLow contrast unit (arm 3). */
export function buildMemlowUnitArgv({
  unit = UNIT,
  slice = OOM_ARM_SLICE,
  scale = SCALES.full,
  payloadPath,
  outDir,
  scaleName = 'full',
}) {
  return [
    'systemd-run', `--unit=${unit}`, '--collect', '--quiet',
    `--property=Slice=${slice}`,
    `--property=MemoryMax=${scale.unitMemoryMax}`,
    `--property=MemoryLow=${scale.unitMemoryLow}`,
    '--property=MemorySwapMax=0',
    `--property=RuntimeMaxSec=${scale.runtimeMaxSec}`,
    '--property=Delegate=yes',
    '--', process.execPath, payloadPath, 'payload', '--out-dir', outDir, '--scale', scaleName,
  ];
}

const SCALES = {
  full: { fileBytes: 1536 * MiB, hogTargetBytes: Math.round(7.2 * GiB), unitMemoryMax: '8G', unitMemoryLow: '4G', sibLow: 2 * GiB, runtimeMaxSec: 900, passes: 6 },
  smoke: { fileBytes: 64 * MiB, hogTargetBytes: 0, unitMemoryMax: '2G', unitMemoryLow: '64M', sibLow: 64 * MiB, runtimeMaxSec: 300, passes: 2 },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  const self = fileURLToPathSelf();

  if (cmd === 'run') {
    const outDir = arg('--out-dir', '/root/e2a-runs/a3/arm3');
    const scaleName = arg('--scale', 'full');
    const scale = SCALES[scaleName];
    if (!scale) throw new Error(`unknown scale ${scaleName}`);
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    // Stale artefacts from a previous pass would be picked up instantly (results wait)
    // or pollute the pass analysis (timings append) — clear them all first.
    for (const f of ['results.json', 'hog.json', 'psi.jsonl', 'timings-low.jsonl', 'timings-free.jsonl']) {
      fs.rmSync(path.join(outDir, f), { force: true });
    }
    // Working-set files are written INSIDE the unit by the workers (page-cache
    // charging), so no driver-side dd here.
    const argv = buildMemlowUnitArgv({ payloadPath: self, outDir, scaleName });
    await runOk(argv[0], argv.slice(1));
    // Driver-side path assertion: the unit's real cgroup must be under e2a-oom.slice.
    const cgOut = await runOk('systemctl', ['show', UNIT, '-p', 'ControlGroup', '--no-pager']);
    const cg = /^ControlGroup=(.+)$/m.exec(cgOut.stdout.trim())?.[1];
    assertCgroupUnderSlice(cg);
    const resultsPath = path.join(outDir, 'results.json');
    await waitFor(() => fs.existsSync(resultsPath), { timeoutMs: (scale.runtimeMaxSec - 10) * 1000, pollMs: 2000, label: 'memlow results' });
    await tryRun('systemctl', ['stop', UNIT]);
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    if (results.scale !== 'smoke') {
      const verdict = summariseMemoryLowContrast({ low: results.low, free: results.free });
      results.verdict = verdict;
      fs.writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      console.log('memlow smoke OK:', JSON.stringify({ siblings: Object.keys(results.siblings ?? {}), passes: results.passes }));
    }
    return;
  }

  if (cmd === 'payload') {
    const outDir = arg('--out-dir');
    const scaleName = arg('--scale', 'full');
    const scale = SCALES[scaleName];
    // FIRST, before any pressure: this unit must live under e2a-oom.slice
    // (STRESS-GATE 21:50 amendment — the guard excuses kills only there).
    assertCgroupUnderSlice(readOwnCgroup());
    const cgRoot = readOwnCgroup();
    const fsRoot = `/sys/fs/cgroup${cgRoot}`;
    // Move self into a control subgroup so controllers can be enabled (no-internal-process rule).
    fs.mkdirSync(`${fsRoot}/control`, { recursive: true });
    fs.writeFileSync(`${fsRoot}/control/cgroup.procs`, String(process.pid));
    fs.writeFileSync(`${fsRoot}/cgroup.subtree_control`, '+memory');
    for (const sib of ['sib-low', 'sib-free']) fs.mkdirSync(`${fsRoot}/${sib}`, { recursive: true });
    fs.writeFileSync(`${fsRoot}/sib-low/memory.low`, String(scale.sibLow));
    const lowReadback = fs.readFileSync(`${fsRoot}/sib-low/memory.low`, 'utf8').trim();
    if (Number(lowReadback) !== scale.sibLow) throw new Error(`sib-low memory.low readback ${lowReadback} != ${scale.sibLow}`);

    const timingsLow = path.join(outDir, 'timings-low.jsonl');
    const timingsFree = path.join(outDir, 'timings-free.jsonl');
    // Workers WRITE their own working set first: pages written by a process are
    // charged to that process's cgroup — a driver-written file would stay charged
    // to the driver (measured 22:08 run: unit memory peak 4.0M, no contrast possible).
    const workerArgs = (file, timings) => [
      self, 'worker', '--file', file, '--timings', timings,
      '--write-bytes', String(scale.fileBytes),
      '--passes', scaleName === 'full' ? '0' : String(scale.passes), // 0 = loop until killed
    ];
    const workerLow = spawnTracked(process.execPath, workerArgs(path.join(outDir, 'sib-low.bin'), timingsLow));
    const workerFree = spawnTracked(process.execPath, workerArgs(path.join(outDir, 'sib-free.bin'), timingsFree));
    movePid(`${fsRoot}/sib-low/cgroup.procs`, workerLow.pid);
    movePid(`${fsRoot}/sib-free/cgroup.procs`, workerFree.pid);

    // Baseline pass from both workers.
    const lowTimings = new Timings(timingsLow);
    const freeTimings = new Timings(timingsFree);
    await lowTimings.waitForPass(1, 120_000);
    await freeTimings.waitForPass(1, 120_000);

    let hog = null;
    let hogNote = 'smoke: no hog (no eviction pressure by design)';
    let stopMonitor = null;
    if (scaleName === 'full') {
      // PSI monitor: /proc/pressure/memory every second for the whole arm (05-answer).
      stopMonitor = startPsiMonitor(path.join(outDir, 'psi.jsonl'));
      fs.mkdirSync(`${fsRoot}/sib-hog`, { recursive: true });
      // Hog target 6.5G: with ~3 GiB of sibling cache in the unit (max 8G), this forces
      // ~1.5 GiB of clean-cache eviction — the contrast measurement — while the PSI cap
      // (stop at full avg10 ≥ 5 / some avg10 ≥ 20, hold, record) keeps it inside the
      // 05-answer envelope. Clean-cache reclaim is cheap; the 22:25 trip came from the
      // unpaced WRITE phase, now fsync-paced.
      hog = spawnTracked(process.execPath, [self, 'hog', '--target-bytes', String(Math.min(scale.hogTargetBytes, 6.5 * GiB)), '--step-bytes', String(256 * MiB), '--step-ms', '1200', '--psi-cap-full', '5', '--psi-cap-some', '20', '--status-file', path.join(outDir, 'hog.json')]);
      movePid(`${fsRoot}/sib-hog/cgroup.procs`, hog.pid);
      const hogExit = await onceExit(hog);
      const hogStatus = readJsonIfExists(path.join(outDir, 'hog.json'));
      hogNote = `hog exit code ${hogExit} (137 = killed by the kernel at the unit limit); status: ${JSON.stringify(hogStatus)}`;
    }

    // First pass completed after the hog phase shows the eviction effect. With no hog
    // (smoke), the after pass is simply pass 2, anchored at the baseline pass's completion.
    const phaseEndMs = hog ? hog.exitAtMs : (lowTimings.pass(1).startMs + lowTimings.pass(1).ms);
    let lowAfter;
    let freeAfter;
    try {
      lowAfter = await lowTimings.waitForPassAfter(phaseEndMs, 300_000);
      freeAfter = await freeTimings.waitForPassAfter(phaseEndMs, 300_000);
    } catch (err) {
      // Pressure-capped pass: record what we have and the PSI that capped it, then stop cleanly.
      workerLow.kill('SIGKILL');
      workerFree.kill('SIGKILL');
      cleanupSiblings(fsRoot);
      fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify({ at: new Date().toISOString(), scale: scaleName, error: 'pressure-capped before any post-phase pass', detail: String(err.message), psiPeak: psiPeakFrom(path.join(outDir, 'psi.jsonl')) }, null, 2)}\n`);
      for (const f of ['sib-low.bin', 'sib-free.bin']) fs.rmSync(path.join(outDir, f), { force: true });
      throw err;
    }

    const sample = (dir) => {
      const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
      let events = {};
      try { events = parseMemoryEventsFallthrough(read('memory.events')); } catch { /* gone */ }
      const stat = parseMemoryStat(read('memory.stat'));
      return {
        memoryLow: read('memory.low').trim(),
        currentBytes: parseMemoryCurrent(read('memory.current')),
        anonBytes: stat.anon,
        fileBytes: stat.file,
        lowEvents: events.low,
        oomKillEvents: events.oom_kill,
      };
    };

    const results = {
      at: new Date().toISOString(),
      scale: scaleName,
      cgroupRoot: cgRoot,
      siblings: {
        'sib-low': sample(`${fsRoot}/sib-low`),
        'sib-free': sample(`${fsRoot}/sib-free`),
        ...(hog ? { 'sib-hog': sample(`${fsRoot}/sib-hog`) } : {}),
      },
      unit: sample(fsRoot),
      passes: {
        low: { baselineMs: lowTimings.pass(1).ms, afterMs: lowAfter.ms },
        free: { baselineMs: freeTimings.pass(1).ms, afterMs: freeAfter.ms },
      },
      hog: { note: hogNote },
    };
    results.low = {
      currentBytes: results.siblings['sib-low'].currentBytes,
      fileBytes: results.siblings['sib-low'].fileBytes,
      anonBytes: results.siblings['sib-low'].anonBytes,
      lowEvents: results.siblings['sib-low'].lowEvents,
      rereadMs: results.passes.low.afterMs,
      rereadBaselineMs: results.passes.low.baselineMs,
    };
    results.free = {
      currentBytes: results.siblings['sib-free'].currentBytes,
      fileBytes: results.siblings['sib-free'].fileBytes,
      anonBytes: results.siblings['sib-free'].anonBytes,
      lowEvents: results.siblings['sib-free'].lowEvents,
      rereadMs: results.passes.free.afterMs,
      rereadBaselineMs: results.passes.free.baselineMs,
    };
    fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify({ ...results, psiPeak: psiPeakFrom(path.join(outDir, 'psi.jsonl')), hog: results.hog }, null, 2)}\n`);

    if (stopMonitor) stopMonitor();
    workerLow.kill('SIGKILL');
    workerFree.kill('SIGKILL');
    cleanupSiblings(fsRoot);
    for (const f of ['sib-low.bin', 'sib-free.bin']) fs.rmSync(path.join(outDir, f), { force: true }); // 05-answer: delete the 3 GiB sets after the pass
    process.exit(0);
  }

  if (cmd === 'worker') {
    const file = arg('--file');
    const timings = arg('--timings');
    const passes = Number(arg('--passes', 4));
    const writeBytes = Number(arg('--write-bytes', 0));
    // Working-set write phase: buffered writes charge the page cache to THIS cgroup.
    // Paced (32 MiB + fsync + 400 ms) to keep host writeback/reclaim PSI low
    // (05-answer: guard HARD-tripped at PSI full avg10 12.01 during the unpaced write).
    if (writeBytes > 0) {
      const chunk = Buffer.alloc(32 * 1024 * 1024, 7);
      const fdw = fs.openSync(file, 'w');
      let written = 0;
      while (written < writeBytes) {
        fs.writeSync(fdw, chunk);
        fs.fsyncSync(fdw);
        written += chunk.length;
        await new Promise((r) => setTimeout(r, 400));
      }
      fs.closeSync(fdw);
    }
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    for (let pass = 1; passes === 0 || pass <= passes; pass++) {
      const t0 = Date.now();
      let off = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, off);
        if (n === 0) break;
        off += n;
      }
      const ms = Date.now() - t0;
      fs.appendFileSync(timings, `${JSON.stringify({ pass, startMs: t0, ms, bytes: off })}\n`);
    }
    return;
  }

  if (cmd === 'hog') {
    const target = Number(arg('--target-bytes'));
    const step = Number(arg('--step-bytes', 256 * MiB));
    const stepMs = Number(arg('--step-ms', 1200));
    const capFull = Number(arg('--psi-cap-full', 5)); // 05-answer: stay under host PSI full avg10 5
    const capSome = Number(arg('--psi-cap-some', 20));
    const statusFile = arg('--status-file');
    // Correction 01 item 2: the cap is enforced during allocation AND during the hold;
    // on the threshold the buffers are freed and the hog exits at once.
    const result = await runHogCore({
      targetBytes: target,
      stepBytes: step,
      stepMs,
      capFull,
      capSome,
      readPsi: readMemoryPsi,
      delay: (ms) => sleep(ms),
      holdMs: 20_000,
      holdCheckMs: 1000,
    });
    if (statusFile) {
      fs.writeFileSync(statusFile, `${JSON.stringify({ capped: result.capped, allocatedBytes: result.allocatedBytes, targetBytes: target, buffersHeld: result.buffersHeld, at: new Date().toISOString() })}\n`);
    }
    console.log(JSON.stringify({ hogDone: result.allocatedBytes, capped: result.capped != null }));
    return;
  }

  throw new Error(`unknown command: ${cmd ?? '(none)'}`);
}

function cleanupSiblings(fsRoot) {
  for (const sib of ['sib-low', 'sib-free', 'sib-hog']) {
    try { fs.rmdirSync(`${fsRoot}/${sib}`); } catch { /* not empty or gone */ }
  }
  try { fs.writeFileSync(`${fsRoot}/cgroup.subtree_control`, '-memory'); } catch { /* fine */ }
  try { fs.rmdirSync(`${fsRoot}/control`); } catch { /* busy */ }
}

function readMemoryPsi() {
  const text = fs.readFileSync('/proc/pressure/memory', 'utf8');
  const some = /some avg10=([\d.]+)/.exec(text)?.[1];
  const full = /full avg10=([\d.]+)/.exec(text)?.[1];
  return { someAvg10: Number(some ?? 0), fullAvg10: Number(full ?? 0), at: new Date().toISOString() };
}

const HOG_GIB = 1024 ** 3;

/**
 * Correction 01 item 2 — the hog's core, with injectable PSI reader and delay so the
 * stop-on-cap behaviour is unit-testable. The cap is enforced BEFORE every allocation
 * step AND throughout the hold: on the threshold the buffers are freed and the hog
 * exits at once (the old version retained its buffers and slept 20 s blind, which let
 * the host PSI pass the binding limit while the hog sat at its target).
 */
export async function runHogCore({
  targetBytes,
  stepBytes,
  stepMs = 1000,
  capFull,
  capSome,
  readPsi,
  delay = () => Promise.resolve(),
  holdMs = 20_000,
  holdCheckMs = 1000,
  maxAllocBytes = 10 * HOG_GIB,
  now = () => Date.now(),
}) {
  const tripped = (psi) => psi.fullAvg10 >= capFull || psi.someAvg10 >= capSome;
  const keep = [];
  let allocated = 0;
  let capped = null;
  while (allocated < targetBytes && allocated < maxAllocBytes) {
    const psi = readPsi();
    if (tripped(psi)) {
      capped = { phase: 'allocation', psi, allocated };
      break;
    }
    keep.push(Buffer.alloc(stepBytes, 1));
    allocated += stepBytes;
    await delay(stepMs);
  }
  if (!capped) {
    const deadline = now() + holdMs;
    while (now() < deadline) {
      await delay(holdCheckMs);
      const psi = readPsi();
      if (tripped(psi)) {
        capped = { phase: 'hold', psi, allocated };
        break;
      }
    }
  }
  keep.length = 0; // free the buffers before returning, in every path
  return { allocatedBytes: allocated, capped, buffersHeld: keep.length };
}

function startPsiMonitor(outFile) {
  const rows = [];
  const timer = setInterval(() => {
    try {
      const row = readMemoryPsi();
      rows.push(row);
      fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch { /* transient */ }
  }, 1000);
  return () => clearInterval(timer);
}

function psiPeakFrom(psiFile) {
  try {
    const rows = fs.readFileSync(psiFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return {
      samples: rows.length,
      peakFullAvg10: Math.max(...rows.map((r) => r.fullAvg10 ?? 0)),
      peakSomeAvg10: Math.max(...rows.map((r) => r.someAvg10 ?? 0)),
    };
  } catch {
    return null;
  }
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readOwnCgroup() {
  const text = fs.readFileSync('/proc/self/cgroup', 'utf8');
  const m = /^0::(.+)$/m.exec(text);
  if (!m) throw new Error('no unified cgroup path');
  return m[1];
}

function movePid(procsFile, pid) {
  fs.writeFileSync(procsFile, String(pid));
}

function spawnTracked(executable, args) {
  const child = execFile(executable, args, () => {});
  child.exitAtMs = null;
  child.on('exit', () => { child.exitAtMs = Date.now(); });
  return child;
}

function onceExit(child) {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

class Timings {
  constructor(file) { this.file = file; this.cache = new Map(); }
  readAll() {
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        this.cache.set(row.pass, row);
      }
    } catch { /* not written yet */ }
    return this.cache;
  }
  pass(n) { return this.readAll().get(n); }
  async waitForPass(n, timeoutMs) {
    return waitFor(() => this.pass(n), { timeoutMs, pollMs: 250, label: `pass ${n}` });
  }
  async waitForPassAfter(tMs, timeoutMs) {
    return waitFor(() => [...this.readAll().values()].find((r) => r.startMs >= tMs), { timeoutMs, pollMs: 250, label: 'post-phase pass' });
  }
}

function fileURLToPathSelf() {
  return fileURLToPath(import.meta.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[arm3] ${err.message}`);
    process.exitCode = 1;
  });
}
