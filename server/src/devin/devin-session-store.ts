import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access, rename, stat, chmod, rm } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Devin per-session turn store — one JSONL per session under
 * `<DEVIN_SESSION_DIR>/<sessionId>.jsonl`, mirroring the Antigravity store's
 * durability contract (startTurn persisted BEFORE any streaming event; atomic
 * finalize via temp+rename; 0600/0700 hygiene; per-file write chains).
 * RC2: failures are never blank — an error turn stores a self-describing body.
 */

export type DevinTurnStatus = 'running' | 'done' | 'error';

export interface DevinStoredUsage {
  input: number;
  output: number;
  /** Devin reports cachedRead on some models; 0 when absent (uniform shape). */
  cacheRead: number;
  total: number;
}

export interface DevinStoredToolCall {
  toolName: string;
  args?: unknown;
  output?: string;
  isError: boolean;
  errorMessage?: string;
}

export interface DevinTurn {
  turnId: string;
  prompt: string;
  response: string; // '' while running; final text or error note when finalized
  model: string;
  nativeSessionId: string | null; // the `devin acp` session id (e.g. brass-akubra)
  timestamp: number;
  status?: DevinTurnStatus;
  error?: string;
  turnDurationMs?: number;
  usage?: DevinStoredUsage;
  stopReason?: string;
  cancelled?: boolean;
  tools?: DevinStoredToolCall[];
}

/** Stored tool-call caps (antigravity parity: keep an agentic turn from
 *  ballooning the JSONL). */
export const DEVIN_STORED_TOOL_LIMIT = 50;
export const DEVIN_STORED_TOOL_OUTPUT_LIMIT = 2_000;

export function isTurnDone(turn: DevinTurn): boolean {
  return turn.status === undefined || turn.status === 'done';
}

/** Fields finalizeTurn may patch on an existing turn line. */
export interface DevinTurnPatch {
  status?: DevinTurnStatus;
  response?: string;
  error?: string;
  nativeSessionId?: string | null;
  turnDurationMs?: number;
  usage?: DevinStoredUsage;
  stopReason?: string;
  cancelled?: boolean;
  tools?: DevinStoredToolCall[];
}

const MAX_VERIFIED_MODE_PATHS = 1024;

export class DevinSessionStore {
  private sessionDir: string;
  private readonly modeVerified = new Set<string>();
  private dirModeVerified = false;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.jsonl`);
  }

  /** Durable on-disk transcript path for a session (session-info surfacing). */
  sessionFilePath(sessionId: string): string {
    return this.sessionPath(sessionId);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
    if (!this.dirModeVerified) {
      const info = await stat(this.sessionDir);
      if ((info.mode & 0o077) !== 0) await chmod(this.sessionDir, 0o700);
      this.dirModeVerified = true;
    }
  }

  async loadHistory(sessionId: string): Promise<DevinTurn[]> {
    try {
      const raw = await readFile(this.sessionPath(sessionId), 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());
      return lines.map((l) => JSON.parse(l) as DevinTurn);
    } catch {
      return [];
    }
  }

  private async appendLine(sessionPath: string, entry: DevinTurn): Promise<void> {
    return this.enqueueWrite(sessionPath, async () => {
      const line = JSON.stringify(entry) + '\n';
      if (!this.modeVerified.has(sessionPath)) {
        try {
          const info = await stat(sessionPath);
          if ((info.mode & 0o077) !== 0) await chmod(sessionPath, 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await writeFile(sessionPath, line, { flag: 'a', mode: 0o600 });
      this.rememberVerifiedMode(sessionPath);
    });
  }

  async startTurn(
    sessionId: string,
    input: { turnId: string; prompt: string; model: string; nativeSessionId: string | null; timestamp: number },
  ): Promise<DevinTurn> {
    await this.ensureDir();
    const entry: DevinTurn = {
      turnId: input.turnId,
      prompt: input.prompt,
      response: '',
      model: input.model,
      nativeSessionId: input.nativeSessionId,
      timestamp: input.timestamp,
      status: 'running',
    };
    await this.appendLine(this.sessionPath(sessionId), entry);
    return entry;
  }

  async finalizeTurn(sessionId: string, turnId: string, patch: DevinTurnPatch): Promise<void> {
    await this.ensureDir();
    const p = this.sessionPath(sessionId);
    await this.enqueueWrite(p, async () => {
      let raw = '';
      try {
        raw = await readFile(p, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const lines = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as DevinTurn);
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].turnId === turnId) {
          lines[i] = { ...lines[i], ...patch };
          found = true;
          break;
        }
      }
      if (!found) {
        lines.push({
          turnId,
          prompt: '',
          response: patch.response ?? '',
          model: '',
          nativeSessionId: patch.nativeSessionId ?? null,
          timestamp: 0,
          ...patch,
        });
      }
      const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      await this.atomicWrite(p, content);
    });
  }

  private rememberVerifiedMode(sessionPath: string): void {
    if (this.modeVerified.has(sessionPath)) return;
    if (this.modeVerified.size >= MAX_VERIFIED_MODE_PATHS) {
      const oldest = this.modeVerified.values().next().value as string | undefined;
      if (oldest !== undefined) this.modeVerified.delete(oldest);
    }
    this.modeVerified.add(sessionPath);
  }

  private enqueueWrite<T>(sessionPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(sessionPath) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const stored = queued.then(() => undefined, () => undefined);
    this.writeChains.set(sessionPath, stored);
    const cleanup = (): void => {
      if (this.writeChains.get(sessionPath) === stored) this.writeChains.delete(sessionPath);
    };
    stored.then(cleanup, cleanup);
    return queued;
  }

  private async atomicWrite(targetPath: string, content: string): Promise<void> {
    const tmp = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, { flag: 'wx', mode: 0o600 });
      await rename(tmp, targetPath);
      this.rememberVerifiedMode(targetPath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      await access(this.sessionPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }
}
