import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import * as path from 'node:path';

export interface AntigravityTurn {
  turnId: string;
  prompt: string;
  response: string;
  model: string;
  conversationId: string | null;
  timestamp: number;
  rawStdoutLength?: number; // cumulative raw stdout length after this turn (for reply extraction)
}

export class AntigravitySessionStore {
  private sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.jsonl`);
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

  async appendTurn(sessionId: string, turn: Omit<AntigravityTurn, 'turnId'>): Promise<AntigravityTurn> {
    await this.ensureDir();
    const entry: AntigravityTurn = { turnId: randomUUID(), ...turn };
    const line = JSON.stringify(entry) + '\n';
    const p = this.sessionPath(sessionId);
    try {
      await access(p);
      await writeFile(p, line, { flag: 'a' });
    } catch {
      await writeFile(p, line, { flag: 'w' });
    }
    return entry;
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
   * Returns the raw stdout length from the last turn.
   * agy --conversation replays ALL prior replies in stdout, so this is the
   * exact byte offset at which the new reply begins in the next call's stdout.
   * Falls back to sum of response lengths for turns created before rawStdoutLength was added.
   */
  priorStdoutLength(turns: AntigravityTurn[]): number {
    if (turns.length === 0) return 0;
    const last = turns[turns.length - 1];
    if (last.rawStdoutLength !== undefined) return last.rawStdoutLength;
    // Legacy fallback: sum response lengths (imprecise but better than 0)
    return turns.reduce((acc, t) => acc + t.response.length, 0);
  }
}
