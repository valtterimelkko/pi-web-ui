/**
 * Liveness I/O for the heap soak supervisor: prove whether the disposable
 * server process is still the one this run was launched for.
 *
 * Kept separate from `systemd-units.ts` (which starts/stops units) so the
 * read-only observation used by death detection is obvious at a glance.
 */
import { execFile as execFileCb } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface UnitExitStatus {
  activeState: string;
  subState: string;
  /** systemd `Result` (e.g. `exit-code`, `signal`, `oom-kill`). */
  result?: string;
  /** systemd `ExecMainStatus` (e.g. `1` for a failed process). */
  execMainStatus?: string;
}

/** Read the unit's terminal/systemd status — used to record WHY the server died. */
export async function getUnitExitStatus(unitName: string): Promise<UnitExitStatus> {
  try {
    const { stdout } = await execFile('systemctl', [
      'show', unitName, '-p', 'ActiveState', '-p', 'SubState', '-p', 'Result', '-p', 'ExecMainStatus', '--no-pager',
    ]);
    const props = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/)) {
      const sep = line.indexOf('=');
      if (sep > 0) props.set(line.slice(0, sep), line.slice(sep + 1));
    }
    return {
      activeState: props.get('ActiveState') ?? 'unknown',
      subState: props.get('SubState') ?? 'unknown',
      result: props.get('Result'),
      execMainStatus: props.get('ExecMainStatus'),
    };
  } catch {
    return { activeState: 'unknown', subState: 'unknown' };
  }
}

/**
 * Bounded tail of the unit's journal, oldest-first. `-o cat` drops the
 * systemd prefix noise; `-n` bounds the read so a dead run cannot pull an
 * unbounded amount of journal into the report.
 */
export async function getUnitJournalTail(unitName: string, lines = 40): Promise<string[]> {
  try {
    const { stdout } = await execFile('journalctl', [
      '-u', unitName, '-n', String(lines), '--no-pager', '-o', 'cat',
    ], { maxBuffer: 4_000_000, timeout: 30_000 });
    return stdout.split('\n').map((s) => s.trimEnd()).filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** A single bounded connect attempt against a Unix socket: true = reachable. */
export function isSocketReachable(socketPath: string, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
