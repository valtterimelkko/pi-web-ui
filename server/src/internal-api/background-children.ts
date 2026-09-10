/**
 * Child-orchestration surfacing (contract 1.34.0) — Pi background-subagent
 * bridge and snapshot reader.
 *
 * The Pi subagent extension persists background-task state as `custom`
 * entries (customType 'background-tasks') in the session file and pushes
 * extension-UI status/widget messages on state change. Those messages
 * historically never reached the Internal API event broker, so background
 * children were invisible outside the session transcript. This module:
 *
 *  - {@link readBackgroundTasksSnapshot} — reads the on-disk truth (the LATEST
 *    'background-tasks' entry) and projects it into shared
 *    {@link ChildCardProjection}s;
 *  - {@link createPiBackgroundChildBridge} — an extension-UI observer that,
 *    on background-surfacing status/widget messages, re-reads the snapshot,
 *    dedupes, and emits a `background_child_state` normalized event to the
 *    broker plus a structured browser message.
 *
 * All errors are swallowed: the browser channel must never be disrupted by
 * broker-side problems, and missing disk state is answered with silence
 * rather than an invented projection.
 */

import fs from 'fs/promises';
import type { ChildCardKind, ChildCardProjection } from '@pi-web-ui/shared';

/** Extension UI keys owned by the subagent extension's surfacing. */
export const BACKGROUND_STATUS_KEY = 'background-tasks';
export const BACKGROUND_STATUS_WIDGET_KEY = 'background-tasks-widget';

/** Extension UI keys owned by the background-shell extension's surfacing (contract 1.41.0). */
export const BACKGROUND_SHELL_STATUS_KEY = 'background-shell';
export const BACKGROUND_SHELL_STATUS_WIDGET_KEY = 'background-shell-widget';

/** Session-file custom types bridged into child cards, with their card kind. */
const BRIDGED_ENTRY_TYPES: ReadonlyArray<{ customType: string; kind: ChildCardKind }> = [
  { customType: 'background-tasks', kind: 'background_subagent' },
  { customType: 'bg-shell-tasks', kind: 'background_shell' },
];

/** Upper bound for the tail read — background entries carry short summaries only. */
const DEFAULT_TAIL_BYTES = 512 * 1024;

/** Raw per-task shape persisted by the subagent extension (subset we consume). */
interface RawBackgroundTask {
  taskId?: unknown;
  runId?: unknown;
  kind?: unknown;
  agent?: unknown;
  task?: unknown;
  cwd?: unknown;
  model?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  summary?: unknown;
  errorMessage?: unknown;
}

/** Raw per-task shape persisted by the background-shell extension (subset we consume). */
interface RawShellTask {
  taskId?: unknown;
  command?: unknown;
  label?: unknown;
  cwd?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  exitCode?: unknown;
  errorMessage?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const MAX_TASK_CHARS = 200;

function mapStatus(status: string | undefined): {
  status: ChildCardProjection['status'];
  timedOut?: boolean;
  error?: string;
} {
  switch (status) {
    case 'running':
      return { status: 'running' };
    case 'completed':
      return { status: 'completed' };
    case 'failed':
      return { status: 'failed' };
    case 'timed_out':
      return { status: 'failed', timedOut: true };
    case 'aborted':
      return { status: 'cancelled' };
    case 'lost':
    case 'orphaned':
      return { status: 'failed', error: status };
    default:
      return { status: 'failed', error: status ? `unknown status: ${status}` : 'unknown' };
  }
}

function projectTask(raw: RawBackgroundTask): ChildCardProjection | null {
  const id = asString(raw.taskId);
  if (!id) return null;
  const mapped = mapStatus(asString(raw.status));
  const startedAtIso = asString(raw.startedAt);
  const endedAtIso = asString(raw.endedAt);
  const startedAt = startedAtIso ? Date.parse(startedAtIso) : undefined;
  const endedAt = endedAtIso ? Date.parse(endedAtIso) : undefined;
  const taskText = asString(raw.task);
  const summary = asString(raw.summary);
  return {
    id,
    kind: 'background_subagent',
    status: mapped.status,
    label: asString(raw.agent) ?? id,
    ...(asString(raw.model) !== undefined ? { model: asString(raw.model) } : {}),
    ...(asString(raw.runId) !== undefined ? { runId: asString(raw.runId) } : {}),
    ...(asString(raw.cwd) !== undefined ? { cwd: asString(raw.cwd) } : {}),
    ...(taskText !== undefined ? { task: taskText.length > MAX_TASK_CHARS ? `${taskText.slice(0, MAX_TASK_CHARS - 1)}…` : taskText } : {}),
    ...(summary !== undefined ? { error: mapped.error ?? undefined } : {}),
    ...(mapped.timedOut ? { timedOut: true } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(endedAt) ? { endedAt } : {}),
    ...(mapped.error !== undefined || asString(raw.errorMessage) !== undefined
      ? { error: asString(raw.errorMessage) ?? mapped.error }
      : {}),
  };
}

function projectShellTask(raw: RawShellTask): ChildCardProjection | null {
  const id = asString(raw.taskId);
  if (!id) return null;
  const mapped = mapStatus(asString(raw.status));
  const startedAtIso = asString(raw.startedAt);
  const endedAtIso = asString(raw.endedAt);
  const startedAt = startedAtIso ? Date.parse(startedAtIso) : undefined;
  const endedAt = endedAtIso ? Date.parse(endedAtIso) : undefined;
  const command = asString(raw.command);
  const commandText = command !== undefined && command.length > MAX_TASK_CHARS ? `${command.slice(0, MAX_TASK_CHARS - 1)}…` : command;
  const label = asString(raw.label) ?? commandText ?? id;
  const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : undefined;
  const error = asString(raw.errorMessage) ?? mapped.error;
  return {
    id,
    kind: 'background_shell',
    status: mapped.status,
    label,
    ...(asString(raw.cwd) !== undefined ? { cwd: asString(raw.cwd) } : {}),
    ...(commandText !== undefined ? { task: commandText } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(mapped.timedOut ? { timedOut: true } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(endedAt) ? { endedAt } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Read the authoritative background-child snapshot from a Pi session file via
 * a bounded tail read: the LATEST entry of each bridged custom type
 * (`background-tasks` from the subagent extension, `bg-shell-tasks` from the
 * background-shell extension — contract 1.41.0), projected and merged.
 * Returns [] for missing/unreadable files or sessions without entries.
 */
export async function readBackgroundTasksSnapshot(
  sessionPath: string,
  tailBytes: number = DEFAULT_TAIL_BYTES,
): Promise<ChildCardProjection[]> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(sessionPath, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, tailBytes);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer.toString('utf-8').split('\n');
    // When tailing, the first line is likely truncated mid-JSON — skip it.
    const effectiveLines = start > 0 ? lines.slice(1) : lines;

    // One backwards pass; remember the newest entry per bridged type.
    const latest = new Map<string, { tasks: unknown[] }>();
    for (let i = effectiveLines.length - 1; i >= 0; i--) {
      if (latest.size === BRIDGED_ENTRY_TYPES.length) break;
      const line = effectiveLines[i]?.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = parsed as Record<string, unknown>;
      if (rec?.type !== 'custom') continue;
      const bridged = BRIDGED_ENTRY_TYPES.find((b) => b.customType === rec.customType);
      if (!bridged || latest.has(bridged.customType)) continue;
      const data = rec.data as { tasks?: unknown } | undefined;
      if (!data || !Array.isArray(data.tasks)) continue;
      latest.set(bridged.customType, { tasks: data.tasks });
    }

    const children: ChildCardProjection[] = [];
    for (const bridged of BRIDGED_ENTRY_TYPES) {
      const found = latest.get(bridged.customType);
      if (!found) continue;
      for (const raw of found.tasks) {
        if (!raw || typeof raw !== 'object') continue;
        const projected =
          bridged.kind === 'background_shell'
            ? projectShellTask(raw as RawShellTask)
            : projectTask(raw as RawBackgroundTask);
        if (projected) children.push(projected);
      }
    }
    return children;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

export interface PiBackgroundChildBridge {
  (message: unknown): Promise<void>;
}

export interface CreatePiBackgroundChildBridgeDeps {
  /** Registry id of the session (used in event payloads and browser messages). */
  sessionId: string;
  /** Read the authoritative child snapshot; throw = unreadable → stay silent. */
  readChildren: () => Promise<ChildCardProjection[]>;
  /** Broker publish callback (already bound to the right broker key). */
  publish: (event: { type: string; timestamp: number; data: unknown }) => void;
  /** Browser broadcast callback (onBrowserMessage). */
  broadcast: (message: Record<string, unknown>) => void;
}

function isBackgroundUiMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  if (m.type === 'extension_status') {
    const status = m.status as { key?: unknown } | undefined;
    return status?.key === BACKGROUND_STATUS_KEY || status?.key === BACKGROUND_SHELL_STATUS_KEY;
  }
  if (m.type === 'widget_content' || m.type === 'widget_cleared') {
    return m.key === BACKGROUND_STATUS_WIDGET_KEY || m.key === BACKGROUND_SHELL_STATUS_WIDGET_KEY;
  }
  return false;
}

/**
 * Build the extension-UI → broker/browser bridge. Identical consecutive
 * snapshots are deduped so bursts of status pushes do not flood the streams.
 */
export function createPiBackgroundChildBridge(deps: CreatePiBackgroundChildBridgeDeps): PiBackgroundChildBridge {
  let lastSnapshotJson: string | null = null;

  return async (message: unknown): Promise<void> => {
    try {
      if (!isBackgroundUiMessage(message)) return;
      const children = await deps.readChildren();
      const snapshotJson = JSON.stringify(children);
      if (snapshotJson === lastSnapshotJson) return;
      lastSnapshotJson = snapshotJson;

      const timestamp = Date.now();
      deps.publish({ type: 'background_child_state', timestamp, data: { sessionId: deps.sessionId, children } });
      deps.broadcast({ type: 'background_child_state', sessionId: deps.sessionId, children });
    } catch {
      /* never break the caller (WebSocket fan-out) or the broker */
    }
  };
}
