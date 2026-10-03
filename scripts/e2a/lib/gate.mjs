// E2a-3 harness — STRESS-GATE pre-flight evaluator + stress lock (COMMON-BRIEF-e2.md Host safety, e2/STRESS-GATE.md).
// Pure logic lives in evaluateGate(); the CLI wraps the real host checks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const GiB = 1024 ** 3;

export const E2_DIR = '/root/orch-ops/orchestration-scaling/e2';
export const GUARD_LIVE_PATH = path.join(E2_DIR, 'GUARD-LIVE');
export const GUARD_STATE_DIR = path.join(E2_DIR, 'host-guard', 'state');
export const GUARD_SAMPLES_PATH = path.join(GUARD_STATE_DIR, 'samples.jsonl');
export const LOCK_DIR = path.join(E2_DIR, 'stress-lock.d');

/**
 * Decide whether a stress arm may start. Every condition from STRESS-GATE.md
 * (guard live, fresh sample, no trip flags) plus COMMON-BRIEF-e2.md Host
 * safety pre-flight (MemAvailable ≥ 12 GiB, root disk ≥ 15 GiB) and the
 * cross-lane stress lock. All failures are collected, not fail-first.
 */
export function evaluateGate(input) {
  const reasons = [];
  if (!input.guardLiveFileExists) reasons.push('e2/GUARD-LIVE does not exist (guard not accepted/live yet)');
  if (!input.guardActive) reasons.push('guard unit e2-host-guard is not active');
  if (!(input.lastSampleAgeSec < 15)) reasons.push(`guard's newest sample is not under 15 s old (${input.lastSampleAgeSec} s)`);
  if (input.trippedFlagExists) reasons.push('HOST-GUARD-TRIPPED exists in the guard state directory');
  if (input.softFlagExists) reasons.push('HOST-GUARD-SOFT exists in the guard state directory');
  if (!(input.memAvailableBytes >= 12 * GiB)) reasons.push(`MemAvailable ${fmtBytes(input.memAvailableBytes)} < 12 GiB`);
  if (!(input.diskFreeBytes >= 15 * GiB)) reasons.push(`root disk free ${fmtBytes(input.diskFreeBytes)} < 15 GiB`);
  if (input.lockHeld) reasons.push('stress lock e2/stress-lock.d is held by another arm');
  return { allowed: reasons.length === 0, reasons };
}

function fmtBytes(n) {
  return `${(n / GiB).toFixed(1)} GiB`;
}

// ---------- real host checks (IO) ----------

export function readMemAvailable() {
  const text = fs.readFileSync('/proc/meminfo', 'utf8');
  const m = /^MemAvailable:\s+(\d+) kB$/m.exec(text);
  if (!m) throw new Error('MemAvailable not found in /proc/meminfo');
  return Number(m[1]) * 1024;
}

export function readRootDiskFree() {
  const out = execFileSync('df', ['-B1', '/'], { encoding: 'utf8' });
  const lines = out.trim().split('\n');
  const cols = lines[lines.length - 1].split(/\s+/);
  return Number(cols[3]);
}

export function isGuardActive() {
  try {
    const out = execFileSync('systemctl', ['is-active', 'e2-host-guard'], { encoding: 'utf8' }).trim();
    return out === 'active';
  } catch {
    return false;
  }
}

export function guardSampleAgeSec(samplesPath = GUARD_SAMPLES_PATH) {
  let stat;
  try {
    stat = fs.statSync(samplesPath);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  // Prefer the newest row's own timestamp; fall back to file mtime.
  try {
    const text = fs.readFileSync(samplesPath, 'utf8');
    const idx = text.lastIndexOf('\n', Math.max(text.length - 2, 0));
    const lastLine = text.slice(idx + 1).trim();
    if (lastLine) {
      const row = JSON.parse(lastLine);
      const atMs = row.atMs ?? (row.at ? Date.parse(row.at) : NaN);
      if (Number.isFinite(atMs)) return (Date.now() - atMs) / 1000;
    }
  } catch {
    /* fall through to mtime */
  }
  return (Date.now() - stat.mtimeMs) / 1000;
}

export function guardFlagExists(name, stateDir = GUARD_STATE_DIR) {
  try {
    fs.statSync(path.join(stateDir, name));
    return true;
  } catch {
    return false;
  }
}

export function lockHeld(lockDir = LOCK_DIR) {
  try {
    const entries = fs.readdirSync(lockDir);
    // An empty lock directory left behind by a crashed arm still counts as held
    // unless its owner file marks it stale; the STRESS-GATE says never remove a
    // lock you do not own, so an empty dir is reported for the parent.
    if (entries.length === 0) return true;
    return true;
  } catch {
    return false;
  }
}

export function lockOwner(lockDir = LOCK_DIR) {
  try {
    return fs.readFileSync(path.join(lockDir, 'owner'), 'utf8').trim();
  } catch {
    return '(no owner file)';
  }
}

/** Atomic acquire: mkdir fails when the lock is held. */
export function acquireLock(owner, lockDir = LOCK_DIR) {
  try {
    fs.mkdirSync(lockDir);
  } catch {
    return { acquired: false, holder: lockOwner(lockDir) };
  }
  fs.writeFileSync(path.join(lockDir, 'owner'), `${owner}\n`, { mode: 0o644 });
  return { acquired: true };
}

/** Pure release decision (correction 01 item 1): the lock may be removed only by
 *  its owner — the caller's token must be a prefix of the recorded owner text.
 *  A missing or unreadable owner file is a refusal, never a removal. */
export function evaluateRelease(ownerText, callerToken) {
  if (typeof ownerText !== 'string' || ownerText.trim() === '') {
    return { allowed: false, reason: 'owner file missing or unreadable' };
  }
  if (typeof callerToken !== 'string' || callerToken.trim() === '') {
    return { allowed: false, reason: 'no caller token given' };
  }
  // Word-boundary match (parent FINAL correction 02): the token must be followed by
  // whitespace or the end of the owner text, so `lane E2a-6` cannot release a lock
  // owned by `lane E2a-6c …`.
  const owner = ownerText.trim();
  const token = callerToken.trim();
  const boundaryOk = owner === token || (owner.startsWith(token) && /\s/.test(owner.charAt(token.length)));
  if (!boundaryOk) {
    return { allowed: false, reason: `caller token ${JSON.stringify(callerToken)} does not match lock owner ${JSON.stringify(owner.slice(0, 60))}` };
  }
  return { allowed: true };
}

/** Release only if the caller owns the lock; otherwise refuse and change nothing. */
export function releaseLock(callerToken, lockDir = LOCK_DIR) {
  let ownerText;
  try {
    ownerText = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8');
  } catch {
    return { released: false, reason: 'owner file missing or unreadable (not the lock owner)' };
  }
  const verdict = evaluateRelease(ownerText, callerToken);
  if (!verdict.allowed) return { released: false, reason: verdict.reason };
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    return { released: true };
  } catch (err) {
    return { released: false, reason: err.message };
  }
}

/** One real pre-flight evaluation against the host. */
export function checkGateNow() {
  return evaluateGate({
    guardLiveFileExists: fs.existsSync(GUARD_LIVE_PATH),
    guardActive: isGuardActive(),
    lastSampleAgeSec: guardSampleAgeSec(),
    memAvailableBytes: readMemAvailable(),
    diskFreeBytes: readRootDiskFree(),
    softFlagExists: guardFlagExists('HOST-GUARD-SOFT'),
    trippedFlagExists: guardFlagExists('HOST-GUARD-TRIPPED'),
    lockHeld: lockHeld(),
  });
}

/** Clear a guard flag if we own it (only cpu-burner-window). */
export function clearGuardFlag(name, stateDir = GUARD_STATE_DIR) {
  if (name !== 'cpu-burner-window') throw new Error(`refusing to touch guard flag ${name}: only cpu-burner-window is allowed`);
  try {
    fs.rmSync(path.join(stateDir, name), { force: true });
  } catch {
    /* already gone */
  }
}

/** Touch/remove a guard control flag — the lane may touch ONLY `cpu-burner-window`. */
export function setGuardFlag(name, value, stateDir = GUARD_STATE_DIR) {
  if (name !== 'cpu-burner-window') throw new Error(`refusing to touch guard flag ${name}: only cpu-burner-window is allowed`);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, name), value, { mode: 0o644 });
}

// ---------- CLI ----------

export async function cli() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const cmd = args[0];
  if (cmd === '--check') {
    const gate = checkGateNow();
    console.log(JSON.stringify({ allowed: gate.allowed, reasons: gate.reasons }, null, 2));
    process.exitCode = gate.allowed ? 0 : 1;
    return;
  }
  if (cmd === '--acquire') {
    const arm = flag('--arm', 'unnamed-arm');
    const expectedEndUtc = flag('--expected-end-utc', 'unspecified');
    const gate = checkGateNow();
    if (!gate.allowed) {
      console.log(JSON.stringify({ acquired: false, reasons: gate.reasons }, null, 2));
      process.exitCode = 1;
      return;
    }
    const lock = acquireLock(`lane E2a-3 arm ${arm} unit(s) e2a-3-* start ${new Date().toISOString()} expected end ${expectedEndUtc}`);
    if (!lock.acquired) {
      console.log(JSON.stringify({ acquired: false, reasons: [`stress lock held by: ${lock.holder}`] }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ acquired: true, arm, at: new Date().toISOString() }));
    return;
  }
  if (cmd === '--release') {
    const token = flag('--token');
    if (!token) {
      console.log(JSON.stringify({ released: false, reason: '--token is required (the release refuses without an owner check)' }));
      process.exitCode = 1;
      return;
    }
    const r = releaseLock(token);
    console.log(JSON.stringify(r));
    process.exitCode = r.released ? 0 : 1;
    return;
  }
  if (cmd === '--lock-owner') {
    console.log(lockHeld() ? lockOwner() : '(lock free)');
    return;
  }
  throw new Error(`unknown gate command: ${cmd ?? '(none)'} (use --check | --acquire --arm A | --release | --lock-owner)`);
}
