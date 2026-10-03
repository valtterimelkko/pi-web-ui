/**
 * STRESS-GATE pre-flight: asserted by script before every arm. Abort (exit 2)
 * with named reasons if any check fails.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMemAvailableKb } from './hostsample.ts';
import { freeDiskGiB, run } from './procsystemd.ts';

export const GUARD_STATE_DIR = '/root/orch-ops/orchestration-scaling/e2/host-guard/state';
export const GUARD_LIVE = '/root/orch-ops/orchestration-scaling/e2/GUARD-LIVE';
export const LOCK_DIR = '/root/orch-ops/orchestration-scaling/e2/stress-lock.d';

export interface PreflightResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export async function preflight(opts: { requireGuard: boolean; minMemGiB: number; minDiskGiB: number }): Promise<PreflightResult> {
  const checks: PreflightResult['checks'] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  if (opts.requireGuard) {
    const guardLive = existsSync(GUARD_LIVE);
    add('GUARD-LIVE exists', guardLive, GUARD_LIVE);
    const active = await run(['systemctl', 'is-active', 'e2-host-guard'], 10_000);
    add('e2-host-guard active', active.stdout.trim() === 'active', `is-active → ${active.stdout.trim() || `exit ${String(active.code)}`}`);
    const samplesPath = join(GUARD_STATE_DIR, 'samples.jsonl');
    let ageSec = -1;
    if (existsSync(samplesPath)) {
      const st = statSync(samplesPath);
      ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
    }
    add('guard sample < 15 s old', ageSec >= 0 && ageSec < 15, `samples.jsonl age ${String(ageSec)} s`);
    const stateFiles = existsSync(GUARD_STATE_DIR) ? readdirSync(GUARD_STATE_DIR) : [];
    const tripped = stateFiles.some((f) => f.startsWith('HOST-GUARD-TRIPPED'));
    const soft = stateFiles.some((f) => f === 'HOST-GUARD-SOFT');
    add('no HOST-GUARD-TRIPPED', !tripped, tripped ? 'TRIPPED file present' : 'clean');
    add('no current HOST-GUARD-SOFT', !soft, soft ? 'SOFT file present' : 'clean (cleared copies are renamed)');
  }

  const memKb = readMemAvailableKb();
  const memGiB = memKb === null ? -1 : memKb / (1024 * 1024);
  add(`MemAvailable ≥ ${String(opts.minMemGiB)} GiB`, memGiB >= opts.minMemGiB, `${memGiB.toFixed(1)} GiB`);

  const disk = freeDiskGiB();
  add(`root disk free ≥ ${String(opts.minDiskGiB)} GiB`, disk >= opts.minDiskGiB, `${disk.toFixed(1)} GiB free`);

  return { ok: checks.every((c) => c.ok), checks };
}

/** Atomic stress-lock takeover; fails when the lock is held (mkdir is the atomic test-and-set). */
export function takeLock(ownerText: string): { taken: boolean; detail: string } {
  try {
    mkdirSync(LOCK_DIR, { recursive: false });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'EEXIST') {
      let owner = '(unreadable)';
      try {
        owner = readFileSync(join(LOCK_DIR, 'owner'), 'utf8').trim();
      } catch {
        /* lock held without an owner file */
      }
      return { taken: false, detail: `lock held by: ${owner}` };
    }
    return { taken: false, detail: `mkdir failed: ${String(err)}` };
  }
  writeFileSync(join(LOCK_DIR, 'owner'), `${ownerText}\n`);
  return { taken: true, detail: ownerText };
}

/** Release the lock ONLY if we own it (owner text matches). */
export function releaseLock(expectedOwnerSubstring: string): { released: boolean; detail: string } {
  let owner = '';
  try {
    owner = readFileSync(join(LOCK_DIR, 'owner'), 'utf8');
  } catch {
    return { released: false, detail: 'no owner file — not ours, leaving the lock alone' };
  }
  if (!owner.includes(expectedOwnerSubstring)) {
    return { released: false, detail: `owner mismatch (${owner.trim()}) — never remove a lock we do not own` };
  }
  try {
    rmSync(LOCK_DIR, { recursive: true, force: false });
    return { released: true, detail: 'removed' };
  } catch (err) {
    return { released: false, detail: `rm failed: ${String(err)}` };
  }
}
