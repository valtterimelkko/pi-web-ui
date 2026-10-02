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
import { fileURLToPath } from 'node:url';
import { runOk, tryRun, sleep, waitFor } from './lib/exec.mjs';
import { parseMemoryEvents as parseMemoryEventsFallthrough } from './lib/oomrank.mjs';
import { parseMemoryCurrent, parseMemoryStat, summariseMemoryLowContrast } from './lib/memlow.mjs';

const UNIT = 'e2a-3-memlow';
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

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
    // Working-set files (real data, not sparse: hole reads may bypass page-cache charging).
    for (const name of ['sib-low.bin', 'sib-free.bin']) {
      const file = path.join(outDir, name);
      if (!fs.existsSync(file)) {
        await runOk('dd', ['if=/dev/zero', `of=${file}`, 'bs=1M', `count=${Math.round(scale.fileBytes / MiB)}`], { timeoutMs: 120_000 });
      }
    }
    const argv = [
      'systemd-run', `--unit=${UNIT}`, '--collect', '--quiet',
      `--property=MemoryMax=${scale.unitMemoryMax}`,
      `--property=MemoryLow=${scale.unitMemoryLow}`,
      '--property=MemorySwapMax=0',
      `--property=RuntimeMaxSec=${scale.runtimeMaxSec}`,
      '--property=Delegate=yes',
      '--', process.execPath, self, 'payload', '--out-dir', outDir, '--scale', scaleName,
    ];
    await runOk(argv[0], argv.slice(1));
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
    const workerLow = spawnTracked(process.execPath, [self, 'worker', '--file', path.join(outDir, 'sib-low.bin'), '--timings', timingsLow, '--passes', String(scale.passes)]);
    const workerFree = spawnTracked(process.execPath, [self, 'worker', '--file', path.join(outDir, 'sib-free.bin'), '--timings', timingsFree, '--passes', String(scale.passes)]);
    movePid(`${fsRoot}/sib-low/cgroup.procs`, workerLow.pid);
    movePid(`${fsRoot}/sib-free/cgroup.procs`, workerFree.pid);

    // Baseline pass from both workers.
    const lowTimings = new Timings(timingsLow);
    const freeTimings = new Timings(timingsFree);
    await lowTimings.waitForPass(1, 120_000);
    await freeTimings.waitForPass(1, 120_000);

    let hog = null;
    let hogNote = 'smoke: no hog (no eviction pressure by design)';
    if (scaleName === 'full') {
      fs.mkdirSync(`${fsRoot}/sib-hog`, { recursive: true });
      hog = spawnTracked(process.execPath, [self, 'hog', '--target-bytes', String(scale.hogTargetBytes), '--step-bytes', String(256 * MiB), '--step-ms', '1500']);
      movePid(`${fsRoot}/sib-hog/cgroup.procs`, hog.pid);
      const hogExit = await onceExit(hog);
      hogNote = `hog exit code ${hogExit} (137 = killed by the kernel at the unit limit)`;
    }

    // First pass completed after the hog phase shows the eviction effect. With no hog
    // (smoke), the after pass is simply pass 2, anchored at the baseline pass's completion.
    const phaseEndMs = hog ? hog.exitAtMs : (lowTimings.pass(1).startMs + lowTimings.pass(1).ms);
    const lowAfter = await lowTimings.waitForPassAfter(phaseEndMs, 300_000);
    const freeAfter = await freeTimings.waitForPassAfter(phaseEndMs, 300_000);

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
    fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);

    workerLow.kill('SIGKILL');
    workerFree.kill('SIGKILL');
    cleanupSiblings(fsRoot);
    process.exit(0);
  }

  if (cmd === 'worker') {
    const file = arg('--file');
    const timings = arg('--timings');
    const passes = Number(arg('--passes', 4));
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    for (let pass = 1; pass <= passes; pass++) {
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
    const stepMs = Number(arg('--step-ms', 1500));
    const keep = [];
    let allocated = 0;
    while (allocated < target && allocated < 10 * GiB) {
      const buf = Buffer.alloc(step, 1);
      keep.push(buf);
      allocated += step;
      await sleep(stepMs);
    }
    console.log(JSON.stringify({ hogDone: allocated }));
    await sleep(5000);
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

main().catch((err) => {
  console.error(`[arm3] ${err.message}`);
  process.exitCode = 1;
});
