/** Process/systemd helpers for the harness (exec glue; nothing here is unit-tested logic). */
import { execFile as execFileCb, spawn } from 'node:child_process';
import { closeSync, openSync, statfsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export async function run(argv: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = argv[0];
  if (file === undefined) return { code: -1, stdout: '', stderr: 'empty argv' };
  try {
    const { stdout, stderr } = await execFile(file, argv.slice(1), { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    const code = typeof e.code === 'number' ? e.code : -1;
    return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? (e.killed ? '[timeout]' : String(err)) };
  }
}

/** Start a long-lived child detached from this process (own process group). */
export function spawnDetached(argv: string[], logPath: string, env?: Record<string, string>): number {
  const file = argv[0];
  if (file === undefined) return -1;
  const out = openSync(logPath, 'a');
  const child = spawn(file, argv.slice(1), { stdio: ['ignore', out, out], detached: true, env: env ? { ...process.env, ...env } : process.env });
  child.unref();
  closeSync(out);
  return child.pid ?? -1;
}

export async function systemctlShow(unit: string, props: string[]): Promise<Record<string, string>> {
  const { code, stdout } = await run(['systemctl', 'show', unit, ...props.flatMap((p) => ['-p', p]), '--no-pager'], 15_000);
  const out: Record<string, string> = {};
  if (code !== 0) return out;
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) {
      const key = line.slice(0, i);
      out[key] = line.slice(i + 1);
    }
  }
  return out;
}

export async function stopUnit(unit: string): Promise<void> {
  await run(['systemctl', 'stop', unit], 30_000);
}

export async function waitForMainPid(unit: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const props = await systemctlShow(unit, ['MainPID', 'ActiveState']);
    const pid = Number(props['MainPID']);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
    if (props['ActiveState'] === 'failed') return null;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/** First journal line of a unit matching `needle` (for the providers line). */
export async function journalGrep(unit: string, needle: string, sinceMin = 10): Promise<string | null> {
  const { code, stdout } = await run(
    ['journalctl', '-u', unit, '--output=cat', '--since', `-${String(sinceMin)} min`, '--no-pager'],
    20_000,
  );
  if (code !== 0) return null;
  const line = stdout.split('\n').find((l) => l.includes(needle));
  return line ?? null;
}

export function freeDiskGiB(): number {
  const s = statfsSync('/');
  return (s.bavail * s.bsize) / (1024 ** 3);
}
