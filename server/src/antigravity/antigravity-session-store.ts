import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import * as path from 'node:path';

export type AntigravityTurnStatus = 'running' | 'done' | 'error';

export interface AntigravityTurn {
  turnId: string;
  prompt: string;
  response: string; // '' while running; final text or error note when finalized
  model: string;
  conversationId: string | null;
  timestamp: number;
  status?: AntigravityTurnStatus; // undefined === legacy 'done' (back-compat)
  error?: string; // present when status === 'error'
  rawStdoutLength?: number; // only meaningful when status === 'done'
  turnDurationMs?: number; // wall-clock time the agy subprocess took, set on finalize
}

/** Fields finalizeTurn may patch on an existing turn line. */
export interface AntigravityTurnPatch {
  status?: AntigravityTurnStatus;
  response?: string;
  error?: string;
  rawStdoutLength?: number;
  conversationId?: string | null;
  turnDurationMs?: number;
}

/**
 * A turn counts as "done" when it is either explicitly finalized as 'done' or
 * has no status field at all (legacy .jsonl lines predate the lifecycle fields).
 * `running` and `error` turns are NOT done.
 */
export function isTurnDone(turn: AntigravityTurn): boolean {
  return turn.status === undefined || turn.status === 'done';
}

export class AntigravitySessionStore {
  private sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.jsonl`);
  }

  /** Instance-bound alias for isTurnDone for callers that already hold a store. */
  isDone(turn: AntigravityTurn): boolean {
    return isTurnDone(turn);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  async loadHistory(sessionId: string): Promise<AntigravityTurn[]> {
    try {
      const raw = await readFile(this.sessionPath(sessionId), 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim());
      return lines.map((l) => JSON.parse(l) as AntigravityTurn);
    } catch {
      return [];
    }
  }

  private async appendLine(sessionPath: string, entry: AntigravityTurn): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    try {
      await access(sessionPath);
      await writeFile(sessionPath, line, { flag: 'a' });
    } catch {
      await writeFile(sessionPath, line, { flag: 'w' });
    }
  }

  /**
   * Persist a turn as in-flight (`running`, empty response) the instant the
   * prompt is accepted. This is what makes a refresh-during-flight show the
   * prompt instead of an empty screen. Finalize later via finalizeTurn().
   */
  async startTurn(
    sessionId: string,
    input: { turnId: string; prompt: string; model: string; conversationId: string | null; timestamp: number },
  ): Promise<AntigravityTurn> {
    await this.ensureDir();
    const entry: AntigravityTurn = {
      turnId: input.turnId,
      prompt: input.prompt,
      response: '',
      model: input.model,
      conversationId: input.conversationId,
      timestamp: input.timestamp,
      status: 'running',
    };
    await this.appendLine(this.sessionPath(sessionId), entry);
    return entry;
  }

  async appendTurn(sessionId: string, turn: Omit<AntigravityTurn, 'turnId'>): Promise<AntigravityTurn> {
    await this.ensureDir();
    const entry: AntigravityTurn = { turnId: randomUUID(), ...turn };
    await this.appendLine(this.sessionPath(sessionId), entry);
    return entry;
  }

  /**
   * Finalize (or otherwise patch) an in-flight turn by turnId. Loads the JSONL,
   * merges the patch into the matching line, and rewrites the whole file
   * atomically (temp file + rename) so a crash mid-write cannot corrupt the
   * session history. If the turnId is not found (defensive), appends a finalized
   * line so the turn is never lost.
   */
  async finalizeTurn(sessionId: string, turnId: string, patch: AntigravityTurnPatch): Promise<void> {
    await this.ensureDir();
    const p = this.sessionPath(sessionId);

    let lines: AntigravityTurn[] = [];
    try {
      const raw = await readFile(p, 'utf-8');
      lines = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as AntigravityTurn);
    } catch {
      // No file yet — fall through to the defensive append below.
    }

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
        conversationId: patch.conversationId ?? null,
        timestamp: 0,
        ...patch,
      });
    }

    const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    await this.atomicWrite(p, content);
  }

  /** Write-then-rename so a crash during finalize can't tear the session file. */
  private async atomicWrite(targetPath: string, content: string): Promise<void> {
    const tmp = `${targetPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, { flag: 'w' });
    await rename(tmp, targetPath);
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      await access(this.sessionPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the raw stdout length of the last DONE turn.
   *
   * agy --conversation replays ALL prior assistant replies in stdout, so the
   * last done turn's cumulative rawStdoutLength is the exact byte offset at
   * which the new reply begins in the next call's stdout.
   *
   * Only `done` turns carry a valid offset: a `running` or `error` turn has
   * none, and counting it would corrupt the next turn's reply slice
   * (truncation or duplication). We walk backwards to the last done turn; if it
   * predates rawStdoutLength we fall back to the sum of done turns' response
   * lengths (imprecise but better than 0).
   */
  priorStdoutLength(turns: AntigravityTurn[]): number {
    if (turns.length === 0) return 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (!isTurnDone(turns[i])) continue;
      const offset = turns[i].rawStdoutLength;
      if (offset !== undefined) return offset;
      // Legacy done turn without rawStdoutLength: imprecise fallback over done turns only.
      let sum = 0;
      for (let j = 0; j <= i; j++) {
        if (isTurnDone(turns[j])) sum += turns[j].response.length;
      }
      return sum;
    }
    // No done turn to anchor on (e.g. only running/error turns): start at 0.
    return 0;
  }
}
