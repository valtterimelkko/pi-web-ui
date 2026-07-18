import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access, rename, stat, chmod } from 'node:fs/promises';
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
  /** Session-file paths whose 0o600 mode has already been verified/repaired,
   *  so append does not stat+chmod on every call. */
  private readonly modeVerified = new Set<string>();

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
    // Owner-only directory (0o700); mkdir applies the mode only when creating.
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
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
      // File exists: append. Verify/repair its mode to 0o600 ONCE per path
      // (not on every append); a legacy 0o644 file is repaired, a correct file
      // is left untouched and subsequent appends skip stat+chmod entirely.
      if (!this.modeVerified.has(sessionPath)) {
        try {
          const info = await stat(sessionPath);
          if ((info.mode & 0o077) !== 0) {
            await chmod(sessionPath, 0o600);
          }
        } catch {
          // Non-fatal: a stat/chmod failure must not block the append.
        }
        this.modeVerified.add(sessionPath);
      }
      await writeFile(sessionPath, line, { flag: 'a' });
    } catch {
      // File does not exist: create it owner-only.
      await writeFile(sessionPath, line, { flag: 'w', mode: 0o600 });
      this.modeVerified.add(sessionPath);
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
    return this.priorReplyAnchor(turns).offset;
  }

  /**
   * Same offset as {@link priorStdoutLength}, paired with the last done turn's
   * actual response text. The offset alone assumes agy replays prior turns
   * byte-for-byte identically on every invocation — an assumption that doesn't
   * always hold (agy's replay occasionally reflows by a handful of characters,
   * e.g. collapsing blank lines). The text lets the caller verify/correct the
   * offset by anchoring on real content near the expected boundary instead of
   * trusting the byte count blindly (see `extractNewReply` in
   * antigravity-service.ts).
   */
  priorReplyAnchor(turns: AntigravityTurn[]): { offset: number; text: string } {
    if (turns.length === 0) return { offset: 0, text: '' };
    for (let i = turns.length - 1; i >= 0; i--) {
      if (!isTurnDone(turns[i])) continue;
      const offset = turns[i].rawStdoutLength;
      if (offset !== undefined) return { offset, text: turns[i].response };
      // Legacy done turn without rawStdoutLength: imprecise fallback over done turns only.
      let sum = 0;
      for (let j = 0; j <= i; j++) {
        if (isTurnDone(turns[j])) sum += turns[j].response.length;
      }
      return { offset: sum, text: turns[i].response };
    }
    // No done turn to anchor on (e.g. only running/error turns): start at 0.
    return { offset: 0, text: '' };
  }
}
