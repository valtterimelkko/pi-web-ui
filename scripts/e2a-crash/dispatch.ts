/**
 * Child dispatch + observation for the E2a-6c crash-recovery arms.
 * Children are created and armed through `pi-orch` (the sanctioned parent
 * client) against OUR disposable server's socket; transcripts, drains and
 * process snapshots come from the Internal API / /proc directly.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';

const execFile = promisify(execFileCb);

export const PI_ORCH_BIN = '/root/pi-orch/bin/pi-orch';

export interface OrchTarget {
  socketPath: string;
  tokenPath: string;
  parentSession: string;
}

async function piOrch(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout } = await execFile(PI_ORCH_BIN, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (e.stdout !== undefined || e.stderr !== undefined) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: typeof e.code === 'number' ? e.code : 1 };
    }
    throw err;
  }
}

export interface SpawnedChild {
  sessionId: string;
  label: string;
  repoDir: string;
  objective: string;
}

/** Spawn one goal child through pi-orch (create + arm at create time). */
export async function spawnGoalChild(
  target: OrchTarget,
  opts: { repoDir: string; objective: string; label: string; owner: string; maxTurns: number; budgetTokens: number; thinking?: string; modelSelector?: string },
): Promise<string> {
  const args = [
    'spawn',
    '--runtime', 'pi',
    '--cwd', opts.repoDir,
    '--model-selector', opts.modelSelector ?? 'zai/glm-5.3-flash',
    '--thinking', opts.thinking ?? 'high',
    '--owner', opts.owner,
    '--ttl', '86400',
    '--label', opts.label,
    '--goal-objective', opts.objective,
    '--goal-max-turns', String(opts.maxTurns),
    '--goal-budget-tokens', String(opts.budgetTokens),
    '--route-limit', 'zai/glm-5.3-flash=8',
    '--id-only',
    '--json',
    '--socket', target.socketPath,
    '--token-path', target.tokenPath,
    '--parent-session', target.parentSession,
  ];
  const { stdout, exitCode, stderr } = await piOrch(args, 120_000);
  if (exitCode === 22) {
    // TEMPLATE_NOT_DELIVERED (observed 2026-10-02 23:04Z: the goal-template
    // follow-up raced the busy objective turn). The remedy pi-orch names:
    // re-send the template with `prompt --message <instructions>`.
    const { applyGoalObjectiveTemplate } = await import('/root/pi-orch/src/completion-template.ts');
    await new Promise((r) => setTimeout(r, 5_000));
    let sessionId = parseSpawnSessionId(stdout) ?? parseSpawnSessionId(stderr);
    if (!sessionId) {
      // Last resort: the id is embedded in the TEMPLATE_NOT_DELIVERED message.
      const m = stderr.match(/delivered to ([0-9a-f][0-9a-f-]{16,})/);
      if (!m) throw new Error(`pi-orch spawn template failure and no session id recoverable: ${stderr.slice(0, 300)}`);
      sessionId = m[1];
    }
    const resend = await piOrch([
      'prompt', sessionId, '--message', applyGoalObjectiveTemplate(opts.objective),
      '--socket', target.socketPath, '--token-path', target.tokenPath, '--parent-session', target.parentSession, '--id-only',
    ], 60_000);
    if (resend.exitCode !== 0) throw new Error(`template re-send failed (exit ${resend.exitCode}): ${resend.stderr.slice(0, 200)}`);
    return sessionId;
  }
  if (exitCode !== 0) throw new Error(`pi-orch spawn failed (exit ${exitCode}): ${stderr.slice(0, 300) || stdout.slice(0, 400)}`);
  const sessionId2 = parseSpawnSessionId(stdout) ?? parseSpawnSessionId(stderr);
  if (!sessionId2) throw new Error(`pi-orch spawn: no session id in output: ${stdout.slice(0, 200)}`);
  return sessionId2;
}

function parseSpawnSessionId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const id = (parsed.sessionId ?? parsed.id) as string | undefined;
    return typeof id === 'string' && id.length >= 8 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Register a pure-observer watch (agent_end + goal_end) on a child; returns the watch id. */
export async function registerObserverWatch(target: OrchTarget, sessionId: string, label: string): Promise<string> {
  const { stdout, exitCode } = await piOrch([
    'watch', sessionId, 'register',
    '--conditions', 'agent_end,goal_end',
    '--label', label,
    '--id-only',
    '--socket', target.socketPath,
    '--token-path', target.tokenPath,
    '--parent-session', target.parentSession,
  ], 30_000);
  if (exitCode !== 0) throw new Error(`watch register failed (exit ${exitCode}): ${stdout.slice(0, 300)}`);
  return stdout.trim().split('\n').pop() as string;
}

export interface ChildStatus {
  busy?: boolean;
  goalState?: string;
  goalObjectivePresent?: boolean;
  lastRunState?: string;
  raw: Record<string, unknown>;
}

/** `pi-orch status <sessionId> --json`, parsed defensively. */
export async function getChildStatus(target: OrchTarget, sessionId: string): Promise<ChildStatus> {
  const { stdout, exitCode } = await piOrch([
    'status', sessionId, '--json',
    '--socket', target.socketPath,
    '--token-path', target.tokenPath,
  ], 30_000);
  if (exitCode !== 0) return { raw: { error: stdout.slice(0, 200) } };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { raw: { unparsable: stdout.slice(0, 200) } };
  }
  const children = Array.isArray(parsed.children) ? (parsed.children as Array<Record<string, unknown>>) : [];
  const mine = children.find((c) => String(c.sessionId ?? c.id) === sessionId) ?? children[0] ?? {};
  const goal = typeof mine.goal === 'object' && mine.goal !== null ? (mine.goal as Record<string, unknown>) : {};
  const lastRun = typeof mine.lastRun === 'object' && mine.lastRun !== null ? (mine.lastRun as Record<string, unknown>) : {};
  return {
    busy: mine.busy === true || mine.state === 'busy' || mine.status === 'busy',
    goalState: typeof mine.goalStatus === 'string' ? mine.goalStatus : typeof goal.state === 'string' ? goal.state : typeof mine.goalState === 'string' ? (mine.goalState as string) : undefined,
    goalObjectivePresent: Boolean(mine.goalObjective ?? goal.objective),
    lastRunState: typeof lastRun.state === 'string' ? lastRun.state : typeof lastRun.status === 'string' ? (lastRun.status as string) : undefined,
    raw: mine,
  };
}

/** Raw Internal API request over the unix socket. Never logs the token. */
export function internalApiRequest<T>(socketPath: string, tokenPath: string, method: string, apiPath: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path: apiPath,
        headers: {
          Authorization: `Bearer ${readFileSync(tokenPath, 'utf8').trim()}`,
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Internal API ${method} ${apiPath} -> ${res.statusCode}: ${data.slice(0, 300)}`));
            return;
          }
          try {
            resolve((data.length > 0 ? JSON.parse(data) : {}) as T);
          } catch (err) {
            reject(new Error(`Internal API ${method} ${apiPath}: unparsable response: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Internal API ${method} ${apiPath} timed out`)));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function getTranscript(socketPath: string, tokenPath: string, sessionId: string): Promise<unknown> {
  return internalApiRequest<unknown>(socketPath, tokenPath, 'GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`);
}

/** Start a drain with a short timeout (drain-timeout arm). The endpoint BLOCKS until the verdict — the request timeout derives from it (08-parent-note). */
export async function startDrain(socketPath: string, tokenPath: string, timeoutSeconds: number, reason: string): Promise<unknown> {
  const { drainRequestTimeoutMs } = await import('./analysis.ts');
  return internalApiRequest<unknown>(socketPath, tokenPath, 'POST', '/api/v1/drain', { reason, timeoutSeconds }, drainRequestTimeoutMs(timeoutSeconds));
}

export async function getDrainStatus(socketPath: string, tokenPath: string): Promise<unknown> {
  return internalApiRequest<unknown>(socketPath, tokenPath, 'GET', '/api/v1/drain');
}

/** Assert the served model of a runtime matches expectations via /api/v1/models (by script, never by eye). */
export async function assertServedModel(socketPath: string, tokenPath: string, runtime: string, selector: string): Promise<void> {
  const res = await internalApiRequest<{ models?: Record<string, Array<{ id?: string; modelId?: string; provider?: string }>> }>(
    socketPath, tokenPath, 'GET', '/api/v1/models',
  );
  const models = res.models?.[runtime] ?? [];
  const found =
    Array.isArray(models) &&
    models.some((m) => String(m.id ?? m.modelId ?? '') === selector || `${m.provider ?? ''}/${m.id ?? m.modelId ?? ''}` === selector);
  if (!found) {
    throw new Error(`Model assertion FAILED: ${selector} not served for runtime ${runtime} (${Array.isArray(models) ? models.length : 'non-array'} models listed)`);
  }
}

// ---------------------------------------------------------------------------
// Process snapshots (orphaned tool processes)
// ---------------------------------------------------------------------------

export interface ProcRecord {
  pid: number;
  cmd: string;
  cgroup: string;
}

/** All processes whose cgroup sits under `cgroupPrefix`, from /proc (point-in-time snapshot). */
export function processesUnderCgroup(cgroupPrefix: string): ProcRecord[] {
  const out: ProcRecord[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid <= 1) continue;
    try {
      const cg = readFileSync(`/proc/${entry}/cgroup`, 'utf8').trim();
      const line = cg.split('\n').find((l) => l.startsWith('0::'));
      const path0 = line ? line.slice(3) : '';
      if (!path0.startsWith(cgroupPrefix)) continue;
      let cmd = '';
      try {
        cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim().slice(0, 160);
      } catch { /* exited */ }
      out.push({ pid, cmd, cgroup: path0 });
    } catch { /* process exited between readdir and read */ }
  }
  return out;
}

/** Snapshot processes belonging to the children's tool commands: anything under the anchor cgroup EXCEPT the anchor's own sleeper. */
export function snapshotChildToolProcesses(anchorCgroup: string): ProcRecord[] {
  return processesUnderCgroup(anchorCgroup).filter((p) => !p.cmd.includes('sleep infinity') && p.pid !== 1);
}
