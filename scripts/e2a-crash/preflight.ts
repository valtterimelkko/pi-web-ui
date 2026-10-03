/**
 * STRESS-GATE pre-flight — asserted by script immediately before EACH stress
 * arm; exits non-zero (and the arm must abort) on any failure.
 *
 *  1. /root/orch-ops/orchestration-scaling/e2/GUARD-LIVE exists
 *  2. systemctl is-active e2-host-guard == active
 *  3. newest sample in host-guard/state/samples.jsonl < 15 s old
 *  4. no HOST-GUARD-TRIPPED and no current HOST-GUARD-SOFT in the state dir
 *  5. MemAvailable ≥ 12 GiB and root disk free ≥ 15 GiB
 */
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const E2 = '/root/orch-ops/orchestration-scaling/e2';
const failures: string[] = [];

// 1. GUARD-LIVE
if (!existsSync(`${E2}/GUARD-LIVE`)) failures.push('GUARD-LIVE does not exist');

// 2. guard unit active
let guardActive = false;
try {
  guardActive = execFileSync('systemctl', ['is-active', 'e2-host-guard'], { encoding: 'utf8' }).trim() === 'active';
} catch { /* not active */ }
if (!guardActive) failures.push('e2-host-guard is not active');

// 3. newest sample < 15 s old
if (existsSync(`${E2}/host-guard/state/samples.jsonl`)) {
  const lines = readFileSync(`${E2}/host-guard/state/samples.jsonl`, 'utf8').trim().split('\n');
  const last = lines[lines.length - 1];
  try {
    const atMs = (JSON.parse(last) as { atMs?: number }).atMs ?? 0;
    const ageMs = Date.now() - atMs;
    if (ageMs > 15_000) failures.push(`newest guard sample is ${Math.round(ageMs / 1000)}s old (> 15s)`);
  } catch (err) {
    failures.push(`newest guard sample unparsable: ${err instanceof Error ? err.message : String(err)}`);
  }
} else {
  failures.push('no guard samples.jsonl');
}

// 4. trip/soft files
const stateDir = `${E2}/host-guard/state`;
if (existsSync(stateDir)) {
  for (const f of readdirSync(stateDir)) {
    if (f === 'HOST-GUARD-TRIPPED') failures.push('HOST-GUARD-TRIPPED exists in the guard state dir');
    if (f === 'HOST-GUARD-SOFT') failures.push('HOST-GUARD-SOFT exists (current) in the guard state dir');
  }
}

// 5. memory + disk
try {
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const availKb = Number((meminfo.match(/^MemAvailable:\s+(\d+)/m) ?? [])[1] ?? 0);
  if (availKb < 12 * 1024 * 1024) failures.push(`MemAvailable ${(availKb / 1048576).toFixed(1)} GiB < 12 GiB`);
} catch (err) {
  failures.push(`MemAvailable unreadable: ${err instanceof Error ? err.message : String(err)}`);
}
try {
  const s = statfsSync('/');
  const freeGiB = (s.bavail * s.bsize) / 1024 ** 3;
  if (freeGiB < 15) failures.push(`root disk free ${freeGiB.toFixed(1)} GiB < 15 GiB`);
} catch (err) {
  failures.push(`disk free unreadable: ${err instanceof Error ? err.message : String(err)}`);
}

if (failures.length > 0) {
  console.error(`PREFLIGHT FAILED (${failures.length}): ${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`PREFLIGHT OK at ${new Date().toISOString()}: guard live+active+fresh, no trip/soft, mem+disk ok`);
