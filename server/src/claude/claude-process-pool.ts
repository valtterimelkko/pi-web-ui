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
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  model: string;
  prompt: string;
  isFollowUp?: boolean;
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
  /**
   * Promises that resolve when a process finishes exiting, keyed by sessionId.
   * Used to make `spawn()` wait for a previous process (e.g. after abort) to
   * fully release its session lock before starting a new one.
   */
  private exitPromises: Map<string, Promise<void>> = new Map();
  /** Grace period (ms) to wait after a process exits before spawning a new one,
   *  to allow the Claude CLI to release its session lock file. */
  private postExitGraceMs: number;

  constructor(maxProcesses: number = 10, postExitGraceMs: number = 1500) {
    this.maxProcesses = maxProcesses;
    this.postExitGraceMs = postExitGraceMs;
  }

  /**
   * Spawn a Claude CLI subprocess for the given session/prompt.
   * Forwards normalised events to `onEvent` and calls `onComplete` when done.
   */
  async spawn(
    options: ClaudeProcessOptions,
    onEvent: ClaudeEventHandler,
    onComplete: (error?: Error) => void,
    retryCount: number = 0,
  ): Promise<void> {
    // ── Wait for any previous process for this session to fully exit ────────
    // This is critical after an abort: the old process may still be dying and
    // holding the session lock.  We wait for it to exit, then add a grace
    // period for the lock file to be cleaned up.
    const pendingExit = this.exitPromises.get(options.sessionId);
    if (pendingExit) {
      console.log(`[ClaudeProcessPool] Waiting for previous process to exit for ${options.sessionId}...`);
      await pendingExit;
      // Grace period: allow Claude CLI to release its session lock file
      await new Promise(r => setTimeout(r, this.postExitGraceMs));
      this.exitPromises.delete(options.sessionId);
    }

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
    // Use --permission-mode dontAsk with a broad --allowedTools list so Claude
    // auto-approves common tools without prompting. In dontAsk mode, any tool NOT
    // in the allowlist is silently denied (instead of hanging for approval).
    // This is the recommended approach for non-interactive server-side usage.
    // NOTE: --dangerously-skip-permissions is blocked for root users since
    // Claude CLI v2.1.100+, so we cannot use it. A future migration to the
    // Claude Agent SDK would give us canUseTool callbacks for fine-grained control.
    const proc = spawn(
      'claude',
      [
        '-p', options.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', 'dontAsk',
        '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,Skill,TodoWrite',
        '--model', options.model,
        // First turn: --session-id creates the session.
        // Follow-up turns: --resume avoids the session lock conflict.
        ...(options.isFollowUp
          ? ['--resume', options.claudeSessionId]
          : ['--session-id', options.claudeSessionId]),
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

    // ── Create exit promise so future spawns can wait for this process ──────
    let exitResolve!: () => void;
    const exitP = new Promise<void>((r) => { exitResolve = r; });
    this.exitPromises.set(options.sessionId, exitP);

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

    // ── Collect stderr for error diagnosis and logging ────────────────────
    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
      if (!text.includes('no stdin data received')) {
        console.error(`[ClaudeProcessPool:${options.sessionId}] stderr:`, text.trim());
      }
    });

    // ── Handle process exit ─────────────────────────────────────────────────
    proc.on('error', (err) => {
      this.activeProcesses.delete(options.sessionId);
      exitResolve();
      onComplete(new Error(`Claude process spawn error: ${err.message}`));
    });

    proc.on('exit', (code, signal) => {
      // Guard: only clean up if this process is still the active one.
      // After an abort + new spawn, a stale exit handler may fire for the old
      // process — we must not delete the new process or emit stale events.
      const currentEntry = this.activeProcesses.get(options.sessionId);
      const isCurrentProcess = currentEntry?.process === proc;

      if (isCurrentProcess) {
        this.activeProcesses.delete(options.sessionId);
      }

      rl.close();

      // Always resolve the exit promise so any waiting spawn() can proceed
      exitResolve();

      // If this is a stale exit from a previous (aborted) process, skip events
      if (!isCurrentProcess) {
        console.log(`[ClaudeProcessPool] Stale exit handler fired for ${options.sessionId}, skipping`);
        return;
      }

      // If the process failed because the session is still locked, retry with backoff
      if (code !== 0 && stderrOutput.includes('is already in use') && retryCount < 5) {
        const delay = 1500 + retryCount * 1000; // 1.5s, 2.5s, 3.5s, 4.5s, 5.5s
        console.log(`[ClaudeProcessPool] Session lock detected for ${options.sessionId}, retry ${retryCount + 1}/5 in ${delay}ms...`);
        setTimeout(() => {
          this.spawn(options, onEvent, onComplete, retryCount + 1).catch((retryErr) => {
            onComplete(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
          });
        }, delay);
        return;
      }

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
   * The process entry is NOT removed from activeProcesses immediately — the
   * exit handler does that when the process actually dies.  This keeps
   * `isActive()` accurate and prevents race conditions with new spawns.
   */
  abort(sessionId: string): void {
    const active = this.activeProcesses.get(sessionId);
    if (active) {
      active.process.kill('SIGTERM');
      // Do NOT delete from activeProcesses here.
      // The exit handler will clean up when the process actually exits,
      // which also resolves the exit promise so a new spawn can proceed.
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
