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

  /** Total accumulated response text length for output extraction on resumed calls. */
  accumulatedLength(turns: AntigravityTurn[]): number {
    return turns.reduce((acc, t) => acc + t.response.length, 0);
  }
}
