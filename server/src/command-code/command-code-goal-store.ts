/**
 * Cross-runtime goal function (contract 1.27.0) — per-session Command Code
 * goal records.
 *
 * The server-side source of truth for what the goal-runner mod was armed
 * with, whether auto-continue/pause flags are set, and (via `clearedAt`)
 * whether the goal was cleared. The MOD's own state file under the session's
 * native home remains the runtime read channel; this store drives arming and
 * control.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface CommandCodeGoalRecord {
  objective: string;
  maxTurns: number;
  verifier: 'command' | 'model' | 'both';
  verifyCommand?: string;
  modelVerifier?: string;
  autoContinue: boolean;
  status: 'running' | 'paused' | 'cleared';
  pausedReason?: 'user' | 'budget' | 'stop-hook-cap';
  startedAt: number;
  updatedAt: number;
  clearedAt?: number;
}

export class CommandCodeGoalStore {
  constructor(private readonly dir: string) {}

  private fileFor(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.json`);
  }

  async get(sessionId: string): Promise<CommandCodeGoalRecord | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.fileFor(sessionId), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async arm(
    sessionId: string,
    input: Pick<CommandCodeGoalRecord, 'objective' | 'maxTurns' | 'verifier' | 'verifyCommand' | 'modelVerifier' | 'autoContinue'>,
  ): Promise<CommandCodeGoalRecord> {
    const now = Date.now();
    const record: CommandCodeGoalRecord = {
      ...input,
      verifyCommand: input.verifyCommand || undefined,
      modelVerifier: input.modelVerifier || undefined,
      status: 'running',
      startedAt: now,
      updatedAt: now,
    };
    await this.write(sessionId, record);
    return record;
  }

  async patch(sessionId: string, patch: Partial<CommandCodeGoalRecord>): Promise<CommandCodeGoalRecord | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await this.write(sessionId, next);
    return next;
  }

  private async write(sessionId: string, record: CommandCodeGoalRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.fileFor(sessionId), JSON.stringify(record), 'utf8');
  }
}
