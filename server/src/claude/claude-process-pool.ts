/**
 * Claude Process Pool
 * Manages active `claude -p` subprocesses (one per active prompt).
 * Mirrors the WorkerPool pattern used for Pi SDK workers.
 */

import { spawn, ChildProcess, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import { ClaudeEventNormalizer } from './claude-event-normalizer.js';
import type { ResolvedClaudeLaunch } from './claude-profiles.js';
import {
  isTransientClaudeError,
  getTransientRetryConfig,
  computeBackoffMs,
} from './claude-transient-errors.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('ClaudeProcessPool');


export interface ClaudeProcessOptions {
  sessionId: string;
  claudeSessionId: string;
  cwd: string;
  model: string;
  prompt: string;
  isFollowUp?: boolean;
  /**
   * Optional resolved profile launch. When provided, uses the profile's
   * executable, env, model, and CLI args instead of the hardcoded defaults.
   * When absent, preserves the existing behavior (strip API keys, use `claude`).
   */
  resolvedLaunch?: ResolvedClaudeLaunch;
  /**
   * Reasoning effort level (Claude `--effort`), e.g. 'low'|'medium'|'high'|
   * 'xhigh'|'max'. When set, forwarded to the CLI. Z.ai maps these for GLM.
   */
  effort?: string;
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
  /** Injectable lock-cleaner for testing. Defaults to removeStaleSessionLock. */
  private readonly _lockCleaner: (cwd: string, claudeSessionId: string) => Promise<boolean>;

  constructor(maxProcesses: number = 10, postExitGraceMs: number = 1500,
    lockCleaner?: (cwd: string, claudeSessionId: string) => Promise<boolean>) {
    this.maxProcesses = maxProcesses;
    this.postExitGraceMs = postExitGraceMs;
    this._lockCleaner = lockCleaner ?? removeStaleSessionLock;
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
    transientRetryCount: number = 0,
  ): Promise<void> {
    // ── Wait for any previous process for this session to fully exit ────────
    // This is critical after an abort: the old process may still be dying and
    // holding the session lock.  We wait for it to exit, then add a grace
    // period for the lock file to be cleaned up.
    const pendingExit = this.exitPromises.get(options.sessionId);
    if (pendingExit) {
      logger.info(`[ClaudeProcessPool] Waiting for previous process to exit for ${options.sessionId}...`);
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

    // ── Build environment ──────────────────────────────────────────────────
    // If a resolved profile is provided, use its env (already has API keys
    // stripped/set per profile). Otherwise, strip API keys to force subscription.
    const claudeEnv: NodeJS.ProcessEnv = options.resolvedLaunch
      ? options.resolvedLaunch.env
      : (() => {
          const env = { ...process.env };
          delete env.ANTHROPIC_API_KEY;     // CRITICAL: forces subscription auth
          delete env.ANTHROPIC_AUTH_TOKEN;  // CRITICAL: forces subscription auth
          return env;
        })();

    // ── Determine executable and model ─────────────────────────────────────
    // Resolve the claude binary to an absolute path to avoid PATH resolution
    // issues in spawned subprocesses (common with env replacement).
    const rawExecutable = options.resolvedLaunch?.executable ?? 'claude';
    let executable = rawExecutable;
    if (rawExecutable === 'claude' || rawExecutable === 'node') {
      try {
        executable = execSync(`which ${rawExecutable}`, { encoding: 'utf-8', timeout: 2000 }).trim();
      } catch {
        // Fall back to the raw name; spawn will fail with ENOENT if truly missing
        executable = rawExecutable;
      }
    }
    const effectiveModel = options.resolvedLaunch?.model ?? options.model;
    const extraCliArgs = options.resolvedLaunch?.cliArgsBase ?? [];

    // Ensure cwd exists — spawn fails with ENOENT if the working directory is missing
    try {
      mkdirSync(options.cwd, { recursive: true });
    } catch {
      // non-fatal: if we can't create it, spawn will fail with a clear error
    }

    // ── Spawn the process ───────────────────────────────────────────────────
    // Use --permission-mode dontAsk with a broad --allowedTools list so Claude
    // auto-approves common tools without prompting. In dontAsk mode, any tool NOT
    // in the allowlist is silently denied (instead of hanging for approval).
    // This is the recommended approach for non-interactive server-side usage.
    const allowedTools = options.resolvedLaunch?.sdkOptions.allowedTools?.join(',') ??
      'Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,Skill,TodoWrite';
    const permissionMode = options.resolvedLaunch?.sdkOptions.permissionMode ?? 'dontAsk';

    const proc = spawn(
      executable,
      [
        '-p', options.prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--permission-mode', permissionMode,
        '--allowedTools', allowedTools,
        '--model', effectiveModel,
        ...(options.effort ? ['--effort', options.effort] : []),
        ...extraCliArgs.filter((a) => a !== '--model' && a !== effectiveModel),
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
    // Track whether the model produced any real output, and the final result
    // outcome, so we can (a) surface a silent empty/error result as an error and
    // (b) safely retry transient failures only while nothing has streamed.
    let sawAssistantContent = false;
    let resultSeen = false;
    let resultIsError = false;
    let resultHasTokens = false;
    let lastResultText: string | undefined;

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const events = this.normalizer.normalize(line, options.sessionId);
        for (const ev of events) {
          if (ev.type === 'message_update' || ev.type === 'tool_execution_start') {
            sawAssistantContent = true;
          }
          if (ev.type === 'claude_result') {
            resultSeen = true;
            const d = ev.data as Record<string, unknown> | undefined;
            resultIsError = d?.isError === true;
            lastResultText = typeof d?.result === 'string' ? (d.result as string) : undefined;
            const usage = d?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            resultHasTokens = !!usage && ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)) > 0;
            if (lastResultText && lastResultText.trim()) sawAssistantContent = true;
          }
          try {
            onEvent(ev);
          } catch (handlerErr) {
            logger.error('[ClaudeProcessPool] onEvent handler threw:', handlerErr);
          }
        }
      } catch (parseErr) {
        logger.error('[ClaudeProcessPool] Failed to normalise line:', parseErr);
      }
    });

    // ── Collect stderr for error diagnosis and logging ────────────────────
    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
      if (!text.includes('no stdin data received')) {
        logger.error(`[ClaudeProcessPool:${options.sessionId}] stderr:`, text.trim());
      }
    });

    // ── Handle process exit ─────────────────────────────────────────────────
    proc.on('error', (err) => {
      this.activeProcesses.delete(options.sessionId);
      exitResolve();
      onComplete(new Error(`Claude process spawn error: ${err.message}`));
    });

    proc.on('exit', async (code, signal) => {
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
        logger.info(`[ClaudeProcessPool] Stale exit handler fired for ${options.sessionId}, skipping`);
        return;
      }

      // If the process failed because the session is still locked, try to remove
      // the stale lock and retry with backoff.
      if (code !== 0 && stderrOutput.includes('is already in use') && retryCount < 5) {
        // On first retry attempt, try to strip the stale `last-prompt` lock entry
        // from the Claude session JSONL.  This is the root cause of persistent
        // "Session ID already in use" after an abort (SIGTERM).
        if (retryCount === 0) {
          try {
            const cleaned = await this._lockCleaner(options.cwd, options.claudeSessionId);
            if (cleaned) {
              logger.info(`[ClaudeProcessPool] Removed stale last-prompt lock for ${options.claudeSessionId}, retrying immediately`);
              // Retry quickly since we've fixed the root cause
              setTimeout(() => {
                this.spawn(options, onEvent, onComplete, retryCount + 1, transientRetryCount).catch((retryErr) => {
                  onComplete(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
                });
              }, 500);
              return;
            }
          } catch (cleanErr) {
            logger.warn('[ClaudeProcessPool] Failed to clean stale lock:', cleanErr);
          }
        }

        const delay = 1500 + retryCount * 1000; // 1.5s, 2.5s, 3.5s, 4.5s, 5.5s
        logger.info(`[ClaudeProcessPool] Session lock detected for ${options.sessionId}, retry ${retryCount + 1}/5 in ${delay}ms...`);
        setTimeout(() => {
          this.spawn(options, onEvent, onComplete, retryCount + 1).catch((retryErr) => {
            onComplete(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
          });
        }, delay);
        return;
      }

      // ── Classify the outcome ────────────────────────────────────────────
      // A SIGTERM is a user abort and is treated as a clean stop. Otherwise we
      // treat a non-zero exit, an error result, or a silent empty result (no
      // output + 0 tokens — the "Opus never answered" symptom) as a failure.
      const exitFailure = code !== 0 && signal !== 'SIGTERM';
      const emptyResult = signal !== 'SIGTERM' && !sawAssistantContent && resultSeen && !resultHasTokens && !resultIsError;
      const failed = exitFailure || resultIsError || emptyResult;

      if (!failed) {
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
        return;
      }

      const stderrTail = stderrOutput.trim().slice(0, 500);
      const failMessage = resultIsError
        ? (lastResultText && lastResultText.trim() ? lastResultText : 'Claude returned an error result.')
        : emptyResult
          ? 'Claude returned an empty response (no output, 0 tokens) — the model may be temporarily unavailable or overloaded.'
          : `Claude process exited with code=${code ?? 'null'}, signal=${signal ?? 'null'}${stderrTail ? `: ${stderrTail}` : ''}`;

      // ── Transient-failure retry (overload / temporarily unavailable / 5xx /
      // socket errors). Bounded, exponential backoff, and only while nothing has
      // streamed so a successful turn is never duplicated. An empty zero-token
      // result is treated as transient (it is the capacity-failure fingerprint).
      const transientCfg = getTransientRetryConfig();
      const transient = !sawAssistantContent
        && (emptyResult || isTransientClaudeError(`${stderrOutput} ${lastResultText ?? ''}`));
      if (transient && transientRetryCount < transientCfg.maxRetries) {
        const delay = computeBackoffMs(transientRetryCount + 1, transientCfg.baseDelayMs, transientCfg.maxDelayMs);
        logger.warn(
          `[ClaudeProcessPool] Transient failure for ${options.sessionId} ` +
          `(retry ${transientRetryCount + 1}/${transientCfg.maxRetries}): ${failMessage} — retrying in ${delay}ms`,
        );
        setTimeout(() => {
          this.spawn(options, onEvent, onComplete, retryCount, transientRetryCount + 1).catch((retryErr) => {
            onComplete(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
          });
        }, delay);
        return;
      }

      onComplete(new Error(failMessage));
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

// ─── Standalone lock-cleaning function (exported for testing) ────────────────

/**
 * Resolve the Claude CLI session JSONL path from cwd and claudeSessionId.
 * Claude stores sessions at:
 *   ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl
 * where <encoded-cwd> is the cwd with '/' and '.' replaced by '-'.
 */
export function resolveClaudeSessionPath(cwd: string, claudeSessionId: string): string {
  // Claude encodes the cwd path: '/' → '-', '.' → '-', prefixed with '-'
  // e.g. /root/tasks → -root-tasks
  // e.g. /root/.skills-global → -root--skills-global
  const encodedCwd = '-' + cwd.replace(/[/.]/g, '-');
  return join(homedir(), '.claude', 'projects', encodedCwd, `${claudeSessionId}.jsonl`);
}

/**
 * Remove the stale `last-prompt` lock entry from a Claude session JSONL file.
 *
 * When a `claude -p` subprocess is killed (SIGTERM), it may leave a
 * `{"type":"last-prompt",...}` entry in the session file. This acts as a lock
 * that prevents any future `--resume` from working ("Session ID already in use").
 *
 * This function strips the last line if it's a `last-prompt` entry, making
 * the session resumable again.
 *
 * @returns true if a lock was actually removed, false if no lock found or file missing.
 */
export async function removeStaleSessionLock(cwd: string, claudeSessionId: string): Promise<boolean> {
  const filePath = resolveClaudeSessionPath(cwd, claudeSessionId);
  return removeLockFromFile(filePath);
}

/**
 * Core lock-removal logic operating directly on a file path.
 * Exported for direct unit testing without needing to set up the
 * full ~/.claude/projects directory structure.
 */
export async function removeLockFromFile(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }

  const lines = content.split('\n');
  let removed = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'last-prompt') {
        lines.splice(i, 1);
        removed++;
      }
    } catch {
      // Not valid JSON — skip
    }
  }

  if (removed > 0) {
    const newContent = lines.join('\n').replace(/\n{3,}/g, '\n\n');
    await writeFile(filePath, newContent.endsWith('\n') ? newContent : newContent + '\n');
    logger.info(`[ClaudeProcessPool] Stripped ${removed} stale last-prompt lock(s) from ${filePath}`);
    return true;
  }

  return false;
}
