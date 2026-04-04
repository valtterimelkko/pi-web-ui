/**
 * Claude Process Pool
 * Manages active `claude -p` subprocesses (one per active prompt).
 * Mirrors the WorkerPool pattern used for Pi SDK workers.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { ClaudeEventNormalizer } from './claude-event-normalizer.js';

export interface ClaudeProcessOptions {
  /** Our internal session UUID */
  sessionId: string;
  /** Claude Code's --session-id for conversation continuity */
  claudeSessionId: string;
  cwd: string;
  /** Model shorthand accepted by the claude CLI, e.g. 'sonnet', 'opus', 'haiku' */
  model: string;
  prompt: string;
}

export type ClaudeEventHandler = (event: NormalizedEvent) => void;

export interface ActiveProcess {
  sessionId: string;
  process: ChildProcess;
  startedAt: number;
}

export class ClaudeProcessPool {
  private maxProcesses: number;
  private activeProcesses: Map<string, ActiveProcess> = new Map();
  private normalizer: ClaudeEventNormalizer = new ClaudeEventNormalizer();

  constructor(maxProcesses: number = 10) {
    this.maxProcesses = maxProcesses;
  }

  /**
   * Spawn a Claude CLI subprocess for the given session/prompt.
   * Forwards normalised events to `onEvent` and calls `onComplete` when done.
   */
  async spawn(
    options: ClaudeProcessOptions,
    onEvent: ClaudeEventHandler,
    onComplete: (error?: Error) => void,
  ): Promise<void> {
    if (this.activeProcesses.size >= this.maxProcesses) {
      throw new Error(
        `Claude process pool is full (max ${this.maxProcesses} concurrent processes). ` +
          `Try again after an existing prompt completes.`,
      );
    }

    // ── Build environment WITHOUT API keys ──────────────────────────────────
    // Removing these forces Claude CLI to use its subscription auth instead of
    // pay-per-use API keys.  This is critical for the dual-SDK feature.
    const claudeEnv: NodeJS.ProcessEnv = { ...process.env };
    delete claudeEnv.ANTHROPIC_API_KEY;     // CRITICAL: forces subscription auth
    delete claudeEnv.ANTHROPIC_AUTH_TOKEN;  // CRITICAL: forces subscription auth

    // ── Spawn the process ───────────────────────────────────────────────────
    const proc = spawn(
      'claude',
      [
        '-p', options.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'acceptEdits',
        '--model', options.model,
        '--session-id', options.claudeSessionId,
      ],
      {
        cwd: options.cwd,
        env: claudeEnv,
        // Explicitly ignore stdin so Claude CLI does not keep waiting for input.
        // Leaving stdin open can keep the process alive and make the next turn fail
        // with "Session ID ... is already in use".
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const active: ActiveProcess = {
      sessionId: options.sessionId,
      process: proc,
      startedAt: Date.now(),
    };
    this.activeProcesses.set(options.sessionId, active);

    // ── Stream stdout line by line ──────────────────────────────────────────
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const events = this.normalizer.normalize(line, options.sessionId);
        for (const ev of events) {
          try {
            onEvent(ev);
          } catch (handlerErr) {
            console.error('[ClaudeProcessPool] onEvent handler threw:', handlerErr);
          }
        }
      } catch (parseErr) {
        console.error('[ClaudeProcessPool] Failed to normalise line:', parseErr);
      }
    });

    // ── Forward stderr to server logs ───────────────────────────────────────
    proc.stderr?.on('data', (chunk: Buffer) => {
      console.error(`[ClaudeProcessPool:${options.sessionId}] stderr:`, chunk.toString());
    });

    // ── Handle process exit ─────────────────────────────────────────────────
    proc.on('error', (err) => {
      this.activeProcesses.delete(options.sessionId);
      onComplete(new Error(`Claude process spawn error: ${err.message}`));
    });

    proc.on('exit', (code, signal) => {
      this.activeProcesses.delete(options.sessionId);
      rl.close();

      if (code !== 0 && signal !== 'SIGTERM') {
        onComplete(
          new Error(
            `Claude process exited with code=${code ?? 'null'}, signal=${signal ?? 'null'}`,
          ),
        );
      } else {
        try {
          onEvent({
            type: 'agent_end',
            sessionId: options.sessionId,
            timestamp: Date.now(),
            data: {},
          });
        } catch {
          // non-fatal
        }
        onComplete();
      }
    });
  }

  /**
   * Abort the running Claude process for a session (SIGTERM).
   */
  abort(sessionId: string): void {
    const active = this.activeProcesses.get(sessionId);
    if (active) {
      active.process.kill('SIGTERM');
      this.activeProcesses.delete(sessionId);
    }
  }

  /** Number of currently running processes. */
  getActiveCount(): number {
    return this.activeProcesses.size;
  }

  /** Return true if a process is currently running for the given session. */
  isActive(sessionId: string): boolean {
    return this.activeProcesses.has(sessionId);
  }
}
