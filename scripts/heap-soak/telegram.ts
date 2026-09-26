/**
 * Thin wrapper around scripts/notify.sh — the ONLY production interaction the
 * heap-soak harness is allowed (per its safety rules). Every title is
 * prefixed with "[soak]"; kind is one of milestone|done|question|blocked.
 */
import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const NOTIFY_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'notify.sh');

export type NotifyKind = 'milestone' | 'done' | 'question' | 'blocked';

export interface NotifyResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function notify(kind: NotifyKind, title: string, body?: string): Promise<NotifyResult> {
  const prefixedTitle = title.startsWith('[soak]') ? title : `[soak] ${title}`;
  try {
    const { stdout, stderr } = await execFile('bash', [NOTIFY_SCRIPT, kind, prefixedTitle, body ?? '-'], { timeout: 30_000 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
}
