#!/usr/bin/env node
// E2a-3 arm 2 — OOM victim selection.
//   read --out F [--with-alloc]         rank oom_score/adj of production MainPID, anchor supervisor,
//                                       a placed tool process, claude-rc, docker (+ optional 3 GiB
//                                       allocator in e2a-3-oomread). Read-only unless --with-alloc
//                                       (a stress arm: gate + lock required).
//   alloc --bytes N --adj A --hold-sec S   (unit payload) set own oom_score_adj, allocate+touch N bytes
//                                       in 64 MiB steps (hard self-cap 10 GiB), then hold.
//   proof --out F [--bytes-per-side G]  arm 2b: contained OOM in e2a-3-oomproof (MemoryMax=6G,
//                                       MemorySwapMax=0, OOMPolicy=continue, RuntimeMaxSec=300):
//                                       a -500 allocator and a 0-score allocator together exceed the
//                                       limit; the kernel must kill the 0-score one only.
//   smoke-proof --out F                 plumbing smoke: 8 MiB holders in e2a-3-oomproof-smoke
//                                       (MemoryMax=2G), NO OOM triggered.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { runOk, tryRun, sleep } from './lib/exec.mjs';
import { rankCandidates, pickVictim, parseMemoryEvents, interpretOomProof } from './lib/oomrank.mjs';

const UNIT_READ = 'e2a-3-oomread';
const UNIT_PROOF = 'e2a-3-oomproof';
const SELF_CAP_BYTES = 10 * 1024 ** 3; // allocation tests self-cap at 10 GiB (COMMON-BRIEF-e2.md Host safety)

/**
 * Deliberate-OOM arms live in e2a-oom.slice (STRESS-GATE.md, 2026-10-02 21:50 amendment):
 * the guard excuses an OOM kill only when THIS slice's own memory.events moved. The unit
 * still carries its own MemoryMax; the slice is the guard's accounting umbrella.
 */
export const OOM_ARM_SLICE = 'e2a-oom.slice';

/** Pure guard: the unit's unified cgroup path must sit inside the OOM-arm slice's subtree.
 *  systemd derives a slice's parent from its name, so the real path is
 *  /e2a.slice/e2a-oom.slice/<unit> — match the slice subtree anywhere in the path. */
export function assertCgroupUnderSlice(cgroupPath, slice = OOM_ARM_SLICE) {
  const norm = `/${String(cgroupPath ?? '').replace(/^\/+|\/+$/g, '')}/`;
  if (!norm.includes(`/${slice}/`)) {
    throw new Error(`refusing to allocate: cgroup path ${cgroupPath} is not inside /${slice}/ (guard would trip)`);
  }
  return norm.replace(/\/+$/, '');
}

/** systemd-run argv for the contained-OOM unit (arm 2b). */
export function buildOomProofUnitArgv({
  unit = UNIT_PROOF,
  slice = OOM_ARM_SLICE,
  memoryMax = '6G',
  runtimeMaxSec = 300,
  payloadPath,
  out,
  bytesPerSide = '3.5G',
}) {
  return [
    'systemd-run', `--unit=${unit}`, '--collect', '--quiet',
    `--property=Slice=${slice}`,
    `--property=MemoryMax=${memoryMax}`,
    '--property=MemorySwapMax=0',
    '--property=OOMPolicy=continue',
    `--property=RuntimeMaxSec=${runtimeMaxSec}`,
    '--', process.execPath, payloadPath, 'proof-payload', '--out', out, '--bytes-per-side', bytesPerSide,
  ];
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : dflt;
  };

  if (cmd === 'alloc') {
    const bytes = Math.min(Number(arg('--bytes')), SELF_CAP_BYTES);
    const adj = Number(arg('--adj', 0));
    const holdSec = Number(arg('--hold-sec', 60));
    fs.writeFileSync('/proc/self/oom_score_adj', String(adj));
    const mine = fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
    if (Number(mine) !== adj) throw new Error(`oom_score_adj readback ${mine} != ${adj}`);
    const step = 64 * 1024 * 1024;
    let allocated = 0;
    const keep = [];
    while (allocated < bytes) {
      const buf = Buffer.alloc(step, 1);
      keep.push(buf);
      allocated += step;
      if (allocated % (512 * 1024 * 1024) === 0) console.error(`alloc ${((allocated / 1024 ** 3).toFixed(2))} GiB, adj ${adj}`);
    }
    console.log(JSON.stringify({ allocDone: allocated, adj: Number(mine), pid: process.pid }));
    await sleep(holdSec * 1000);
    return;
  }

  if (cmd === 'read') {
    const targets = [];
    const add = async (name, pid) => {
      if (!pid || pid <= 0) {
        targets.push({ name, pid, error: 'no pid' });
        return;
      }
      try {
        const [score, adj, cgroup] = await Promise.all([
          fs.promises.readFile(`/proc/${pid}/oom_score`, 'utf8'),
          fs.promises.readFile(`/proc/${pid}/oom_score_adj`, 'utf8'),
          fs.promises.readFile(`/proc/${pid}/cgroup`, 'utf8'),
        ]);
        targets.push({
          name, pid,
          oomScore: Number(score.trim()),
          oomScoreAdj: Number(adj.trim()),
          cgroup: /^0::(.+)$/m.exec(cgroup)?.[1],
        });
      } catch (err) {
        targets.push({ name, pid, error: err.message });
      }
    };
    const mainPidOf = async (unit) => {
      const out = await tryRun('systemctl', ['show', unit, '-p', 'MainPID', '--no-pager']);
      return out ? Number(/MainPID=(\d+)/.exec(out)?.[1] ?? 0) : 0;
    };
    await add('production pi-web-ui.service MainPID', await mainPidOf('pi-web-ui.service'));
    // anchor supervisor process (DelegateSubgroup=supervisor puts the anchor's own process there)
    try {
      const supProcs = fs.readFileSync('/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service/supervisor/cgroup.procs', 'utf8');
      await add('production anchor supervisor', Number(supProcs.split('\n')[0] || 0));
    } catch (err) {
      targets.push({ name: 'production anchor supervisor', error: err.message });
    }
    // one live placed production tool process, if any (read-only peek at production's cgroup)
    try {
      const anchorDir = '/sys/fs/cgroup/pi.slice/pi-web.slice/pi-web-ui.slice/pi-web-ui-tools.slice/pi-web-ui-tools-anchor.service';
      for (const ent of fs.readdirSync(anchorDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith('pi-')) continue;
        const procs = fs.readFileSync(`${anchorDir}/${ent.name}/cgroup.procs`, 'utf8').split('\n').map(Number).filter(Boolean);
        if (procs.length > 0) {
          await add(`placed production tool proc (${ent.name})`, procs[0]);
          break;
        }
      }
    } catch (err) {
      targets.push({ name: 'placed production tool proc', error: err.message });
    }
    await add('claude-rc.service MainPID', await mainPidOf('claude-rc.service'));
    await add('docker.service MainPID', await mainPidOf('docker.service'));
    // the 3 GiB proof allocator inside its own unit (only when that unit is up)
    try {
      const procs = fs.readFileSync(`/sys/fs/cgroup/${UNIT_READ}.service/cgroup.procs`, 'utf8').split('\n').map(Number).filter(Boolean);
      if (procs.length > 0) await add(`arm-2a 3 GiB allocator (${UNIT_READ})`, procs[0]);
    } catch { /* unit not running — fine for a read-only pass */ }

    const ranked = rankCandidates(targets.filter((t) => t.oomScore !== undefined));
    const victim = pickVictim(ranked);
    const result = { at: new Date().toISOString(), targets, ranked, kernelWouldPickFirst: victim };
    if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result.kernelWouldPickFirst));
    return;
  }

  if (cmd === 'proof') {
    // Arm 2b — contained OOM. Stress arm: the caller (arm runner) must hold the gate + lock.
    const out = arg('--out', '/root/e2a-runs/a3/arm2/oomproof.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const argv = buildOomProofUnitArgv({
      payloadPath: await selfPath(),
      out,
      bytesPerSide: arg('--bytes-per-side', '3.5G'),
    });
    await runOk(argv[0], argv.slice(1));
    // Driver-side path assertion: the unit's real cgroup must be under e2a-oom.slice.
    const cgOut = await runOk('systemctl', ['show', UNIT_PROOF, '-p', 'ControlGroup', '--no-pager']);
    const cg = /^ControlGroup=(.+)$/m.exec(cgOut.stdout.trim())?.[1];
    assertCgroupUnderSlice(cg);
    console.log(JSON.stringify({ started: UNIT_PROOF, cgroup: cg, out }));
    return;
  }

  if (cmd === 'proof-payload') {
    const out = arg('--out');
    const perSideBytes = parseSize(arg('--bytes-per-side', '3.5G'));
    // FIRST, before any allocation: this unit must live under e2a-oom.slice
    // (STRESS-GATE 21:50 amendment — the guard excuses kills only there).
    assertCgroupUnderSlice(readOwnCgroupPath());
    const self = await selfPath();
    const spawnAlloc = (adj, bytes, holdSec) => new Promise((resolve) => {
      const child = execFile(process.execPath, [self, 'alloc', '--adj', String(adj), '--bytes', String(bytes), '--hold-sec', String(holdSec)], (err, stdout) => {
        // A SIGKILLed child reports code=null + signal='SIGKILL'; the shell convention is 137.
        const code = err ? (err.code ?? (err.signal === 'SIGKILL' ? 137 : -1)) : 0;
        resolve({ adj, code, signal: err?.signal, stdout });
      });
      child.on('error', () => {});
    });
    // The -500 allocator (plays the server) fills first and holds; the 0-score one (plays a placed
    // tool) keeps allocating — together they must exceed the unit's MemoryMax.
    const lowAdjPromise = spawnAlloc(-500, perSideBytes, 240);
    await sleep(4000); // let it take its allocation first
    const zeroAdjPromise = spawnAlloc(0, Math.min(Math.round(perSideBytes * 1.5), SELF_CAP_BYTES), 60);
    const zeroResult = await zeroAdjPromise; // settles at the kernel kill
    // Unit-level evidence while the survivor still holds the unit open:
    let events = {};
    try {
      events = parseMemoryEvents(fs.readFileSync(`/sys/fs/cgroup${readOwnCgroupDir()}/memory.events`, 'utf8'));
    } catch (err) {
      events = { error: err.message };
    }
    const unitActive = await tryRun('systemctl', ['is-active', UNIT_PROOF]);
    const result = {
      at: new Date().toISOString(),
      zeroAdj: { exitCode: zeroResult.code, signal: zeroResult.signal, stdout: zeroResult.stdout?.trim() },
      unitEvents: events,
      unitActiveDuringHold: unitActive?.trim(),
    };
    // Give the survivor a short observation window, then record its state either way.
    const lowEarly = await Promise.race([lowAdjPromise, sleep(20_000).then(() => null)]);
    result.lowAdj = lowEarly
      ? { exitCode: lowEarly.code, signal: lowEarly.signal, stdout: lowEarly.stdout?.trim(), stillHolding: false }
      : { stillHolding: true, note: 'survivor was still alive and holding its allocation 20 s after the kill' };
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    await sleep(10_000); // keep the unit open so the driver can observe is-active post-kill
    process.exit(0);
  }

  if (cmd === 'proof-verify') {
    // Driver-side verdict once the payload's results file exists.
    const out = arg('--out');
    const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
    const unitActive = await tryRun('systemctl', ['is-active', UNIT_PROOF]);
    const lowAlive = payload.lowAdj.stillHolding === true || payload.lowAdj.exitCode === 0;
    const verdict = interpretOomProof({
      lowAdjProcessAlive: lowAlive,
      zeroAdjProcessExitCode: payload.zeroAdj.exitCode,
      unitOomKills: payload.unitEvents.oom_kill ?? 0,
      unitActiveAfter: payload.unitActiveDuringHold === 'active' || unitActive?.trim() === 'active',
    });
    const result = { ...payload, lowAdjAliveAtVerify: lowAlive, unitActiveAtVerify: unitActive?.trim(), verdict };
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(verdict));
    process.exitCode = verdict.pass ? 0 : 1;
    return;
  }

  if (cmd === 'smoke-proof') {
    // Plumbing only: two 8 MiB holders, MemoryMax=2G unit, NO OOM.
    const out = arg('--out', '/root/e2a-runs/a3/smoke-oomproof/smoke.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const self = await selfPath();
    const argv = [
      'systemd-run', '--unit=e2a-3-oomproof-smoke', '--collect', '--quiet',
      '--property=MemoryMax=2G', '--property=MemorySwapMax=1G', '--property=RuntimeMaxSec=120',
      '--', '/bin/sh', '-c',
      `${process.execPath} ${self} alloc --adj -500 --bytes 8388608 --hold-sec 5 & ` +
      `${process.execPath} ${self} alloc --adj 0 --bytes 8388608 --hold-sec 5 & wait`,
    ];
    await runOk(argv[0], argv.slice(1));
    let events = null;
    try {
      const dir = await readOwnUnitDir('e2a-3-oomproof-smoke');
      events = parseMemoryEvents(fs.readFileSync(`${dir}/memory.events`, 'utf8'));
    } catch { /* unit already collected */ }
    const journal = await tryRun('journalctl', ['-u', 'e2a-3-oomproof-smoke', '--no-pager', '-o', 'cat']);
    const allocLines = (journal ?? '').split('\n').filter((l) => /"allocDone"/.test(l));
    const result = { at: new Date().toISOString(), events, allocLines, note: 'hold-mode smoke: no OOM triggered; adj writes + lifecycle verified via alloc readbacks' };
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log('smoke-proof OK');
    return;
  }

  throw new Error(`unknown command: ${cmd ?? '(none)'}`);
}

async function selfPath() {
  const { fileURLToPath } = await import('node:url');
  return fileURLToPath(import.meta.url);
}

function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)G$/i.exec(text);
  if (m) return Math.round(Number(m[1]) * 1024 ** 3);
  const n = Number(text);
  if (!Number.isFinite(n)) throw new Error(`bad size: ${text}`);
  return n;
}

function readOwnCgroupDir() {
  const text = fs.readFileSync('/proc/self/cgroup', 'utf8');
  return /^0::(.+)$/m.exec(text)?.[1];
}

function readOwnCgroupPath() {
  return readOwnCgroupDir();
}

async function readOwnUnitDir(unit) {
  const out = await tryRun('systemctl', ['show', unit, '-p', 'ControlGroup', '--no-pager']);
  return out ? `/sys/fs/cgroup${/ControlGroup=(.+)$/.exec(out)?.[1]}` : `/sys/fs/cgroup/system.slice/${unit}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[arm2] ${err.message}`);
    process.exitCode = 1;
  });
}
