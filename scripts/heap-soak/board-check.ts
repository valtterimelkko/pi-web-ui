/**
 * Confirms the Agent OS board has zero entries referencing a soak run's
 * paths — the direct proof that the AGENT_OS_BIN stub is working (board
 * registration only ever happens by the real `agent-os` CLI actually
 * running; with it stubbed to a no-op, no entry should ever appear).
 * Read-only: `board who --json`.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { filterBoardEntriesForRunDir, type BoardEntryLike } from '../../server/src/live-validation/heap-soak/board-entries.js';

const execFile = promisify(execFileCb);

export async function boardWhoUnderRunDir(runDir: string): Promise<{ ok: boolean; ids: string[]; detail: string }> {
  try {
    const { stdout } = await execFile('npm', ['--prefix', '/root/agent-os', 'run', '-s', 'agent-os', '--', 'board', 'who', '--json'], { timeout: 30_000, maxBuffer: 20_000_000 });
    const entries = JSON.parse(stdout) as BoardEntryLike[];
    const ids = filterBoardEntriesForRunDir(entries, runDir);
    return { ok: ids.length === 0, ids, detail: ids.length === 0 ? `0 board entries reference ${runDir}` : `${ids.length} board entries reference ${runDir}: ${ids.join(', ')}` };
  } catch (error) {
    return { ok: false, ids: [], detail: `board who check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
