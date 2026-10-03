/**
 * E2a-5 shared harness library — independent live re-run of the H/H-b proofs.
 *
 * Lane brief: /root/orch-ops/orchestration-scaling/e2/E2a-5/brief.md
 * Method sources (read before writing): hb4 harness memory-proof.mjs,
 * H1 harness burst-driver.mjs + server-exec.sh, Hb5 proof.sh, H1 m1b-proof-c3.py,
 * Hb6 hb6-chip-proof.py. Numbers from those runs are claims to check, not facts.
 *
 * Nothing here targets production: every server is disposable, booted from a
 * driver, inside an `e2a-5-*` systemd unit owned by this lane.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn as spawnProc } from 'node:child_process';
import path from 'node:path';

export const MB = 1024 * 1024;
export const GiB = 1024 * 1024 * 1024;

export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const i = a.indexOf('=');
    if (a.startsWith('--')) {
      if (i < 0) out[a.slice(2)] = 'true';
      else out[a.slice(2, i)] = a.slice(i + 1);
    }
  }
  return out;
}

export const now = () => new Date().toISOString();

export function readTrim(p) {
  try { return readFileSync(p, 'utf8').trim(); } catch { return undefined; }
}

export function readNum(p) {
  const v = readTrim(p);
  return v === undefined || v === 'max' ? undefined : Number(v);
}

/** MemAvailable in bytes, straight from /proc/meminfo. */
export function memAvailableBytes() {
  const kb = Number(
    readTrim('/proc/meminfo').split('\n').find((l) => l.startsWith('MemAvailable:'))?.split(/\s+/)[1],
  );
  return kb * 1024;
}

export function assertMemAvailable(minBytes = 12 * GiB) {
  const avail = memAvailableBytes();
  if (!(avail >= minBytes)) {
    throw new Error(`ABORT: MemAvailable ${(avail / MB).toFixed(0)}MB < required ${(minBytes / MB).toFixed(0)}MB`);
  }
  return avail;
}

/**
 * One raw cgroup sample (single read per file, timestamped) — hb4's discipline:
 * every figure must be attributable to its sample.
 */
export function sampleCgroup(label, dir) {
  const s = { label, group: dir, at: now() };
  s.currentBytes = readNum(path.join(dir, 'memory.current'));
  const statRaw = readTrim(path.join(dir, 'memory.stat')) ?? '';
  const m = {};
  for (const line of statRaw.split('\n')) {
    const [k, v] = line.trim().split(/\s+/);
    if (k !== undefined && v !== undefined) m[k] = Number(v);
  }
  s.anonBytes = m.anon;
  s.fileBytes = m.file;
  s.inactiveFileBytes = m.inactive_file;
  s.workingSetBytes =
    s.currentBytes !== undefined && s.inactiveFileBytes !== undefined
      ? Math.max(0, s.currentBytes - s.inactiveFileBytes)
      : undefined;
  return s;
}

/** rmdir a (process-free) cgroup directory with bounded EBUSY retries. */
export async function rmdirCgroup(g, label) {
  for (let i = 0; i < 40; i++) {
    try { rmSync(g, { force: true }); return true; } catch (e) {
      if (i === 39) console.error(`rmdir ${label} failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Disposable server boot (hb4's shape): `node --import tsx scripts/validation-server.ts
 * --dir <valDir> --compiled` from the worktree, isolation env supplied by the caller
 * (fake HOME, isolated agent dirs, zai-only credentials, no inherited placement — the
 * wrapper strips PI_TOOLS_* itself, we still strip here for defence in depth).
 * Resolves when the unix socket + token exist; records build identity.
 */
export async function bootServer({ wt, valDir, env, logFile, timeoutMs = 120_000, port, launcherArgs = [] }) {
  mkdirSync(valDir, { recursive: true, mode: 0o700 });
  const childEnv = { ...process.env, ...env };
  for (const k of Object.keys(childEnv)) {
    // J6: drop INHERITED placement keys, but keep keys the CALLER's env object
    // explicitly provided (a proof driver may deliberately configure placement
    // against its own delegated unit; the launcher still requires the
    // --env-file/--env-key channel for the server child itself).
    if (k.startsWith('PI_TOOLS_') && env?.[k] === undefined) delete childEnv[k];
  }
  for (const k of ['PI_SESSION_ID', 'PI_WEB_UI_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_WATCH_WAKE_ARMED']) {
    delete childEnv[k];
  }
  // Inherited production secrets must not reach a disposable server (the
  // validation wrapper clears INTERNAL_API_KEY itself but not these): drop
  // them unless the CALLER's env object explicitly provided a value.
  for (const k of ['AUTH_PASSWORD', 'JWT_SECRET']) {
    if (childEnv[k] !== undefined && env?.[k] === undefined) delete childEnv[k];
  }
  const portArgs = port !== undefined ? ['--port', String(port)] : [];
  const child = spawnProc('node', ['--import', 'tsx', 'scripts/validation-server.ts', '--dir', valDir, '--compiled', ...portArgs, ...launcherArgs], {
    cwd: wt,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const onChunk = (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      if (logFile) writeFileSync(logFile, buf.slice(0, i + 1), { flag: 'a' });
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  const socketPath = path.join(valDir, 'internal-api.sock');
  const tokenPath = path.join(valDir, 'internal-api-token');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !(existsSync(socketPath) && existsSync(tokenPath))) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode} (log: ${logFile})`);
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!existsSync(socketPath)) throw new Error(`server socket never appeared (log: ${logFile})`);
  const rec = {
    child,
    valDir,
    socketPath,
    tokenPath,
    port: port !== undefined ? Number(port) : undefined,
    buildIdentity: readBuildIdentity(wt),
    stopped: false,
  };
  rec.stop = async () => {
    if (rec.stopped) return;
    rec.stopped = true;
    await new Promise((resolve) => {
      const c = spawnProc('node', ['scripts/validation-server-stop.mjs', '--dir', valDir], { cwd: wt, stdio: 'ignore' });
      c.once('exit', resolve);
      c.once('error', resolve);
      setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* done */ } }, 15_000).unref();
    });
    try { rec.child.kill('SIGTERM'); } catch { /* already gone */ }
  };
  return rec;
}

export function readBuildIdentity(wt) {
  try {
    return JSON.parse(readFileSync(path.join(wt, 'server', 'dist', 'build-identity', 'embedded-manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Authenticated Internal API call over the unix socket, built on node:http
 * (fetch cannot target a unix socket without undici dispatchers; keep the
 * dependency footprint zero).
 */
import http from 'node:http';
export function api({ socketPath, tokenPath, method, apiPath, body, timeoutMs = 60_000 }) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: apiPath,
        method,
        headers: {
          authorization: `Bearer ${readTrim(tokenPath)}`,
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', (e) => { e.apiPath = apiPath; reject(e); });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${apiPath}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** All A2 health-metrics readings from a validation dir, sorted by atMs. */
export function readMetrics(valDir) {
  const dir = path.join(valDir, 'metrics');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of fsReaddir(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
    }
  }
  out.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  return out;
}

import { readdirSync as fsReaddir } from 'node:fs';

/** Percentile (nearest-rank, ceil) over a sorted-ascending numeric array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Lag + activeTurns statistics for readings inside [fromMs, toMs].
 * Returns p50/p99/max for each of lagP50Ms/lagP99Ms/lagMaxMs fields, the
 * activeTurns samples (each reading's value — the load claim source), and the
 * reading count.
 */
export function windowStats(readings, fromMs, toMs) {
  const inWindow = readings.filter((r) => r.atMs >= fromMs && r.atMs <= toMs && r.lagP99Ms !== undefined);
  const collect = (key) => inWindow.map((r) => r[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const stat = (key) => {
    const arr = collect(key);
    return { p50: percentile(arr, 0.5), p99: percentile(arr, 0.99), max: arr[arr.length - 1] ?? null, n: arr.length };
  };
  return {
    fromMs, toMs,
    readingCount: inWindow.length,
    lagP50: stat('lagP50Ms'),
    lagP99: stat('lagP99Ms'),
    lagMax: stat('lagMaxMs'),
    activeTurnsSamples: inWindow.map((r) => ({ at: r.at, atMs: r.atMs, activeTurns: r.activeTurns, residentSessions: r.residentSessions })),
    peakActiveTurns: Math.max(0, ...inWindow.map((r) => r.activeTurns ?? 0)),
  };
}

/**
 * Replay the admission lag-gate latch rule over readings (H1's collect method):
 * threshold 300 ms sustained 2 readings latches; recovery below 150; a gap
 * over 75 s resets. Returns the trace and whether any reading window latched.
 */
export function replayLatch(readings, { thresholdMs = 300, sustained = 2, recoveryMs = 150, stalenessMs = 75_000 } = {}) {
  let consecutive = 0;
  let latched = false;
  let latchedAt = null;
  let lastAt = null;
  const trace = [];
  for (const r of readings) {
    if (r.lagP99Ms === undefined) continue;
    if (lastAt !== null && r.atMs - lastAt > stalenessMs) { consecutive = 0; latched = false; }
    lastAt = r.atMs;
    consecutive = r.lagP99Ms >= thresholdMs ? consecutive + 1 : 0;
    if (!latched && consecutive >= sustained) { latched = true; latchedAt = r.at; }
    else if (latched && r.lagP99Ms < recoveryMs) latched = false;
    trace.push({ at: r.at, atMs: r.atMs, lagP99Ms: r.lagP99Ms, lagSampleCount: r.lagSampleCount, activeTurns: r.activeTurns, consecutive, latched });
  }
  return { latched, latchedAt, trace };
}

/**
 * hb2's doubled-first-chunk detector: the rendered text must contain the
 * transcript's final assistant text EXACTLY ONCE, and the doubled variant —
 * the first chunk repeated immediately before it — must be ABSENT.
 */
export function doubledFirstChunkVerdict({ renderedText, transcriptText }) {
  if (typeof renderedText !== 'string' || typeof transcriptText !== 'string' || transcriptText.length === 0) {
    return { ok: false, reason: 'missing input' };
  }
  const occurrences = renderedText.split(transcriptText).length - 1;
  // The doubled shape repeats the first chunk (any non-empty prefix) before
  // the full text: detect any prefix-doubling of the transcript text.
  let doubledFound = false;
  for (let len = 1; len <= Math.min(64, transcriptText.length); len++) {
    const prefix = transcriptText.slice(0, len);
    if (renderedText.includes(prefix + transcriptText)) { doubledFound = true; break; }
  }
  return { ok: occurrences === 1 && !doubledFound, occurrences, doubledFound };
}

/** Expectation for the hb4 admission verdicts (the claim under re-test). */
export function hb4VerdictOk(arm, probe) {
  if (arm === '1-page-cache') return probe.verdict === 'admitted';
  if (arm === '2-anon') return probe.verdict.startsWith('refused') && probe.reason === 'memory_pressure';
  if (arm === 'baseline' || arm === '1-recovery') return true;
  return false;
}

/** Wait until the file's line count reaches n or the deadline passes. */
export async function waitForFileLines(file, n, timeoutMs, { pollMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lines = 0;
  while (Date.now() < deadline) {
    try { lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { lines = 0; }
    if (lines >= n) return { ok: true, lines };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, lines };
}

// ── correction 04 item 1: cold seeded targets (H1's offline seed method) ───

/**
 * Write `count` real-shaped Pi session FILES + registry entries — strictly
 * offline (no socket, no API): the targets are non-resident by construction.
 * Returns the target list [{sessionId, sessionPath, cwd}]. H1's seed-corpus
 * shape: <timestamp>_<uuid>.jsonl with a type:"session" header whose id
 * matches the filename, then message entries; registry entries reference them.
 */
export function writeSeedTargets({ sessionsDir, registryPath, workspacesRoot, count, messages = 24, nowMs = Date.now() }) {
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspacesRoot, { recursive: true });
  let registry = { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  if (existsSync(registryPath)) registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const existingPaths = new Set(registry.entries.map((e) => e.path));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const tsName = (d) => `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}Z`;
  const out = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const created = new Date(nowMs - (count - i) * 90_000);
    const file = path.join(sessionsDir, `${tsName(created)}_${id}.jsonl`);
    const cwd = path.join(workspacesRoot, `cold-ws-${String(i).padStart(3, '0')}`);
    mkdirSync(cwd, { recursive: true });
    const lines = [JSON.stringify({ type: 'session', id, timestamp: created.getTime(), cwd })];
    let last = created.getTime();
    let firstMessage = '';
    for (let m = 0; m < messages; m++) {
      last += 5_000;
      const role = m % 2 === 0 ? 'user' : 'assistant';
      const text = role === 'user'
        ? `cold target message ${m} for session ${i}: analyse the module and report.`
        : `cold target reply ${m}: analysis with a short summary paragraph of findings. `.repeat(4);
      if (role === 'user' && !firstMessage) firstMessage = text.slice(0, 120);
      lines.push(JSON.stringify({ type: 'message', timestamp: last, message: { role, content: [{ type: 'text', text }], timestamp: last } }));
    }
    writeFileSync(file, lines.join('\n') + '\n');
    utimesSync(file, new Date(last), new Date(last));
    if (!existingPaths.has(file)) {
      registry.entries.push({
        id, sdkType: 'pi', path: file, cwd, firstMessage, messageCount: messages,
        createdAt: new Date(created).toISOString(), lastActivity: new Date(last).toISOString(),
        status: 'idle', origin: 'internal-api',
      });
    }
    out.push({ sessionId: id, sessionPath: file, cwd });
  }
  registry.updatedAt = new Date().toISOString();
  writeFileSync(registryPath, JSON.stringify(registry));
  return out;
}

/**
 * Per-target residency classification from the server's own evidence: a target
 * is resident only if its path appears in the server's materialisation evidence
 * (rehydrate/materialise log scan or a per-session state source).
 */
export function classifyResidency(targets, residentPaths) {
  return targets.map((t) => ({ ...t, resident: residentPaths.has(t.sessionPath) }));
}

/** Percentiles over non-resident switches only, plus the exclusion count. */
export function coldOnlyPercentiles(switches) {
  const cold = switches.filter((s) => s.targetResident === false).map((s) => s.wallMs).sort((a, b) => a - b);
  return {
    coldCount: cold.length,
    excludedResident: switches.length - cold.length,
    p50: percentile(cold, 0.5),
    p99: percentile(cold, 0.99),
    max: cold[cold.length - 1] ?? null,
  };
}

/** Scan `roots` for credential-shaped files. Returns remaining paths. */
export function verifyCredentialSweep(roots) {
  const names = ['auth.json', 'models.json', 'internal-api-token', 'server.env', 'oauth_creds.json', 'antigravity-oauth-token'];
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fsReaddir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (names.includes(e.name)) found.push(full);
    }
  };
  for (const r of roots) walk(r);
  return found;
}

/** rm -rf run-owned directories (agent dir, fake HOME, ...) and return what was removed. */
export function cleanupRunOwnedDirs(dirs) {
  const removed = [];
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); removed.push(d); } catch { /* recorded by the caller */ }
  }
  return removed;
}
