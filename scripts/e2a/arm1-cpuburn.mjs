#!/usr/bin/env node
// E2a-3 arm 1 — CPU burner on every core + guard flag + PSI sampling.
// Real arm runs only after e2/GUARD-LIVE exists and under the stress lock (STRESS-GATE.md).
//   flag on|off [--state-dir D]          touch/remove the cpu-burner-window guard flag (the only flag this lane may touch)
//   start --seconds N [--payload burn|sleep] [--unit e2a-3-cpuburn]
//                                        start the burner transient unit (CPUWeight=1, MemoryMax=1G, RuntimeMaxSec=N+30)
//   wait-done [--unit e2a-3-cpuburn]     block until the burner unit is no longer active
//   sample-psi --out F --seconds N       append PSI/load samples every 5 s (JSONL) — proof the burn saturated the host
//   selftest-smoke --state-dir D         plumbing smoke: sleep payload for 3 s + flag on/off against a TEST state dir (no CPU burn)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { runOk, tryRun, sleep, waitFor } from './lib/exec.mjs';
import { setGuardFlag, clearGuardFlag } from './lib/gate.mjs';

// 10-parent-note: `kill $$` kills only the parent shell — the 16 background subshell
// loops LEAK (they have no RuntimeMaxSec inside a placed child group). The payload now
// runs the burn loop in its own setsid process group and kills THAT group at the end.
const BURN_SHELL = (seconds) =>
  `setsid sh -c 'for i in $(seq 16); do (while :; do :; done) & done; sleep ${seconds}' & outer=$!; sleep ${seconds}; kill -- -$outer 2>/dev/null; wait $outer 2>/dev/null; exit 0`;
const SLEEP_SHELL = (seconds) => `sleep ${seconds}`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  const stateDir = arg('--state-dir');

  if (cmd === 'flag') {
    const on = rest[0] === 'on';
    if (on) setGuardFlag('cpu-burner-window', new Date().toISOString(), stateDir);
    else clearGuardFlag('cpu-burner-window', stateDir);
    console.log(`cpu-burner-window ${on ? 'set' : 'cleared'} in ${stateDir ?? '(canonical guard state dir)'}`);
    return;
  }

  if (cmd === 'start') {
    const seconds = Number(arg('--seconds', 600));
    const payload = arg('--payload', 'burn') === 'sleep' ? SLEEP_SHELL(seconds) : BURN_SHELL(seconds);
    const unit = arg('--unit', 'e2a-3-cpuburn');
    const argv = [
      'systemd-run', `--unit=${unit}`, '--collect', '--quiet',
      '--property=CPUWeight=1',
      '--property=MemoryMax=1G',
      `--property=RuntimeMaxSec=${seconds + 30}`,
      '--', '/bin/sh', '-c', payload,
    ];
    await runOk(argv[0], argv.slice(1));
    console.log(JSON.stringify({ started: unit, seconds, payload: payload.slice(0, 40) }));
    return;
  }

  if (cmd === 'wait-done') {
    const unit = arg('--unit', 'e2a-3-cpuburn');
    await waitFor(async () => (await tryRun('systemctl', ['is-active', unit]))?.trim() !== 'active', {
      timeoutMs: 60 * 15 * 1000, pollMs: 2000, label: `${unit} inactive`,
    });
    console.log(`${unit} inactive`);
    return;
  }

  if (cmd === 'sample-psi') {
    const out = arg('--out');
    const seconds = Number(arg('--seconds', 30));
    const end = Date.now() + seconds * 1000;
    const rows = [];
    while (Date.now() < end) {
      rows.push(sampleNow());
      fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      await sleep(5000);
    }
    console.log(JSON.stringify({ samples: rows.length, out }));
    return;
  }

  if (cmd === 'verify-workers') {
    const out = await tryRun('pgrep', ['-f', 'while :; do :; done']);
    const n = (out ?? '').split('\n').filter((l) => /^\d+$/.test(l.trim())).length;
    console.log(JSON.stringify({ burnerWorkers: n }));
    process.exitCode = n === 0 ? 0 : 1;
    return;
  }

  if (cmd === 'selftest-smoke') {
    // Plumbing only: sleep payload (no CPU burn) + guard flag in a TEST dir.
    const testDir = stateDir ?? '/root/e2a-runs/a3/smoke-cpuburn/state';
    setGuardFlag('cpu-burner-window', 'smoke', testDir);
    if (!fs.existsSync(path.join(testDir, 'cpu-burner-window'))) throw new Error('flag not written');
    const argv = [
      'systemd-run', '--unit=e2a-3-cpuburn-smoke', '--collect', '--quiet',
      '--property=CPUWeight=1', '--property=MemoryMax=1G', '--property=RuntimeMaxSec=60',
      '--', '/bin/sh', '-c', SLEEP_SHELL(3),
    ];
    await runOk(argv[0], argv.slice(1));
    await waitFor(async () => (await tryRun('systemctl', ['is-active', 'e2a-3-cpuburn-smoke']))?.trim() !== 'active', { timeoutMs: 30_000, label: 'smoke unit done' });
    clearGuardFlag('cpu-burner-window', testDir);
    if (fs.existsSync(path.join(testDir, 'cpu-burner-window'))) throw new Error('flag not removed');
    console.log('cpuburn smoke OK: unit lifecycle + flag write/clear');
    return;
  }

  throw new Error(`unknown command: ${cmd ?? '(none)'}`);
}

function sampleNow() {
  const psi = (p) => {
    try {
      const t = fs.readFileSync(p, 'utf8');
      const some = /some avg10=([\d.]+)/.exec(t)?.[1];
      const full = /full avg10=([\d.]+)/.exec(t)?.[1];
      return { someAvg10: some === undefined ? undefined : Number(some), fullAvg10: full === undefined ? undefined : Number(full) };
    } catch {
      return undefined;
    }
  };
  const load = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number);
  const memAvail = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1];
  return {
    at: new Date().toISOString(),
    atMs: Date.now(),
    cpuPsi: psi('/proc/pressure/cpu'),
    memPsi: psi('/proc/pressure/memory'),
    load1: load[0],
    load5: load[1],
    memAvailableBytes: memAvail ? Number(memAvail) * 1024 : undefined,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[arm1] ${err.message}`);
    process.exitCode = 1;
  });
}
