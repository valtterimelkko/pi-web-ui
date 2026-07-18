/**
 * Session Worker Process
 * Manages a single Pi SDK RPC process for session isolation.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { SessionWorkerState, WorkerOptions, RPCEvent, RpcResponse, EventHandler } from './types.js';
import { RPCProtocolBridge } from './rpc-protocol-bridge.js';
import type { WorkerStatus } from '@pi-web-ui/shared';
import { getCrashLogger } from './crash-logger.js';
import { createLogger } from '../logging/logger.js';
import { getOperationalMetrics, type OperationalMetrics } from '../observability/operational-metrics.js';

const logger = createLogger('SessionWorker');

/** Maximum size of the incomplete-line stdout buffer before it is reset. */
const MAX_STDOUT_BUFFER_BYTES = 1024 * 1024; // 1 MiB

export interface SessionWorkerObservabilityOptions {
  metrics?: OperationalMetrics;
  readinessFallbackMs?: number;
  commandTimeoutMs?: number;
}

interface PendingRequest {
  command: string;
  timeout: NodeJS.Timeout;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class SessionWorker {
  private state: SessionWorkerState;
  private bridge: RPCProtocolBridge;
  private eventHandlers: Set<EventHandler> = new Set();
  private stdoutBuffer: string = '';
  /** UTF-8 decoder so multibyte chars split across stdout chunks reassemble. */
  private stdoutDecoder = new StringDecoder('utf8');
  /** Resolved on termination; makes terminate() idempotent. */
  private terminatePromise: Promise<void> | null = null;
  private readonly metrics: OperationalMetrics;
  private readonly readinessFallbackMs: number;
  private readonly commandTimeoutMs: number;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly terminatedHandlers = new Set<() => void>();
  private requestSequence = 0;
  private crashRecorded = false;

  constructor(options: WorkerOptions, observability: SessionWorkerObservabilityOptions = {}) {
    this.metrics = observability.metrics ?? getOperationalMetrics();
    this.readinessFallbackMs = observability.readinessFallbackMs ?? 1_000;
    this.commandTimeoutMs = observability.commandTimeoutMs ?? 30_000;
    this.state = {
      process: null,
      sessionPath: options.sessionPath,
      options,
      status: 'spawning' as WorkerStatus,
      lastActivity: Date.now(),
      spawnedAt: Date.now(),
    };
    this.bridge = new RPCProtocolBridge();
  }

  /**
   * Spawn the worker process.
   */
  async spawn(): Promise<void> {
    const { sessionPath, model, thinkingLevel, maxOldSpaceSize = 512 } = this.state.options;
    this.crashRecorded = false;
    
    // Build command args
    const args = [
      '--mode', 'rpc',
      '--session', sessionPath,
    ];
    
    if (model) {
      args.push('--model', model);
    }
    
    if (thinkingLevel) {
      args.push('--thinking', thinkingLevel);
    }

    // Spawn with memory limit
    this.state.process = spawn('pi', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_OPTIONS: `--max-old-space-size=${maxOldSpaceSize}`,
      },
    });

    this.state.status = 'spawning';
    this.state.pid = this.state.process.pid;
    this.state.spawnedAt = Date.now();

    // Handle stdout (JSONL events) — attach handlers (extracted for testability).
    this.attachProcessHandlers();

    // Wait for ready state (streaming_started or similar)
    await this.waitForReady();
  }

  /**
   * Send a command to the worker.
   */
  async sendCommand(command: Parameters<RPCProtocolBridge['formatRPCCommand']>[0]): Promise<void> {
    const stdin = this.state.process?.stdin;
    if (!stdin || this.state.status === 'terminated') {
      throw new Error('Worker process not running');
    }

    const id = `worker_req_${++this.requestSequence}`;
    const line = this.bridge.formatRPCCommand(command, id);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingRequests.delete(id)) return;
        reject(new Error(`Timeout waiting for worker response to ${command.type}`));
      }, this.commandTimeoutMs);
      timeout.unref?.();

      this.pendingRequests.set(id, {
        command: command.type,
        timeout,
        resolve,
        reject,
      });

      try {
        stdin.write(line);
        this.state.lastActivity = Date.now();
      } catch (error) {
        const pending = this.pendingRequests.get(id);
        this.pendingRequests.delete(id);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  /**
   * Subscribe to worker events.
   */
  subscribe(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** Subscribe to process termination so owners can release capacity eagerly. */
  onTerminated(handler: () => void): () => void {
    this.terminatedHandlers.add(handler);
    return () => this.terminatedHandlers.delete(handler);
  }

  /** Visible for deterministic lifecycle/cardinality tests and diagnostics. */
  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Get worker status.
   */
  get status(): WorkerStatus {
    return this.state.status;
  }

  /**
   * Get worker PID.
   */
  get pid(): number | undefined {
    return this.state.pid;
  }

  /**
   * Get session path.
   */
  get sessionPath(): string {
    return this.state.sessionPath;
  }

  /**
   * Get last activity timestamp.
   */
  get lastActivity(): number {
    return this.state.lastActivity;
  }

  /** Stable timestamp for the most recent process spawn attempt. */
  get spawnedAt(): number {
    return this.state.spawnedAt;
  }

  /**
   * Terminate the worker gracefully.
   */
  terminate(): Promise<void> {
    this.rejectPendingRequests(new Error('Worker terminated before responding'));

    // Idempotent: a second call returns the same in-flight promise (exact same
    // object) and does not re-kill or stack another exit listener.
    if (this.terminatePromise) return this.terminatePromise;
    const proc = this.state.process;
    if (!proc || this.state.status === 'terminated') {
      this.terminatePromise = Promise.resolve();
      return this.terminatePromise;
    }

    this.terminatePromise = new Promise((resolve) => {
      let settled = false;
      const onClosed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        proc.off('exit', onClosed);
        proc.off('close', onClosed);
        resolve();
      };
      // A failed child-process spawn emits `error` then `close`, but no `exit`.
      // Observe both terminal events so shutdown cannot hang on ENOENT/EACCES.
      proc.once('exit', onClosed);
      proc.once('close', onClosed);

      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may have already exited; resolve on the exit event below.
        }
      }, 5000);
      timeout.unref?.();

      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may have already exited; the once('exit') listener still
        // resolves if the event has yet to fire.
      }
    });
    return this.terminatePromise;
  }

  /**
   * Attach stdout/stderr/exit/spawn/error handlers to the spawned process.
   * Extracted from spawn() so the framing path is unit-testable with a fake
   * process and so multibyte decoding + buffer bounding live in one place.
   */
  private attachProcessHandlers(): void {
    const proc = this.state.process;
    if (!proc) return;

    // Handle stdout (JSONL events). Decode via StringDecoder so a multibyte
    // UTF-8 character split across chunks reassembles instead of producing a
    // replacement char.
    proc.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(this.stdoutDecoder.write(data));
    });

    // Handle stderr (logs)
    proc.stderr?.on('data', (data: Buffer) => {
      logger.error(`[SessionWorker:${this.state.pid}] stderr:`, data.toString());
    });

    // Handle both normal exit and failed-spawn close. handleExit is guarded so
    // the normal exit→close sequence settles lifecycle ownership only once.
    proc.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });
    proc.on('close', (code, signal) => {
      this.handleExit(code, signal);
    });

    // Handle process spawn errors
    proc.on('spawn', () => {
      this.state.status = 'ready';
      logger.info(`[SessionWorker:${this.state.pid}] Process spawned successfully`);
    });

    proc.on('error', (err: Error) => {
      if (this.state.status === 'terminated') return;
      this.state.status = 'error';
      this.rejectPendingRequests(new Error(`Worker process error: ${err.message}`));
      this.state.error = err.message;
      logger.error(`[SessionWorker:${this.state.pid}] Process error:`, err);

      // Record spawn failure if process hasn't fully started
      if (!this.state.pid) {
        const crashLogger = getCrashLogger();
        crashLogger.recordCrash({
          sessionPath: this.state.sessionPath,
          pid: undefined,
          exitCode: null,
          signal: null,
          memoryLimitMB: this.state.options.maxOldSpaceSize ?? 512,
          spawnedAt: this.state.spawnedAt,
          errorMessage: err.message,
          previousStatus: 'spawning',
        });
        this.crashRecorded = true;
      }
    });
  }

  /**
   * Handle stdout data (JSONL lines).
   */
  private handleStdout(data: string): void {
    // Ignore late output after termination so a dying process cannot resurrect
    // state or grow the buffer.
    if (this.state.status === 'terminated') return;

    this.stdoutBuffer += data;

    // Process complete lines
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const event = this.bridge.parseRPCLine(line);
      if (event) {
        if (event.type === 'response') {
          this.handleResponse(event);
        } else {
          this.handleEvent(event);
        }
      }
    }

    // Bound the incomplete-line buffer. An unterminated run larger than the cap
    // is discarded and reported as one controlled error — never parsed as a
    // forged partial protocol message and never grown unbounded.
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_STDOUT_BUFFER_BYTES) {
      this.stdoutBuffer = '';
      this.handleEvent({ type: 'error', message: 'Worker stdout framing buffer overflow; incomplete line discarded' });
    }
  }

  private handleResponse(response: RpcResponse): void {
    if (!response.id) return;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);
    if (response.success) {
      pending.resolve();
    } else {
      pending.reject(new Error(response.error || `${pending.command} failed`));
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Handle a parsed RPC event.
   */
  private handleEvent(event: Exclude<RPCEvent, RpcResponse>): void {
    // Late events from a terminated process must not update status/state.
    if (this.state.status === 'terminated') return;

    this.state.lastActivity = Date.now();

    // Update status based on event type
    if (event.type === 'streaming_started') {
      this.state.status = 'streaming';
    } else if (event.type === 'streaming_ended') {
      this.state.status = 'ready';
    } else if (event.type === 'error') {
      this.state.status = 'error';
      this.state.error = (event as { message: string }).message;
    }

    // Emit to subscribers
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error('[SessionWorker] Handler error:', err);
      }
    }
  }

  /**
   * Handle process exit.
   * Records crash information for monitoring.
   */
  private handleExit(code: number | null, signal: string | null): void {
    if (this.state.status === 'terminated') return;
    const previousStatus = this.state.status;
    this.state.status = 'terminated';
    this.rejectPendingRequests(new Error(`Worker process exited (code=${code}, signal=${signal})`));

    for (const handler of [...this.terminatedHandlers]) {
      try {
        handler();
      } catch (error) {
        logger.error('[SessionWorker] Termination handler error:', error);
      }
    }
    this.terminatedHandlers.clear();

    // Log basic exit info
    logger.info(`[SessionWorker:${this.state.pid}] Exited with code=${code}, signal=${signal}`);

    // Record crash for monitoring (skip if graceful shutdown via terminate())
    if (signal !== 'SIGTERM' && code !== 0 && !this.crashRecorded) {
      const crashLogger = getCrashLogger();
      crashLogger.recordCrash({
        sessionPath: this.state.sessionPath,
        pid: this.state.pid,
        exitCode: code,
        signal,
        memoryLimitMB: this.state.options.maxOldSpaceSize ?? 512,
        spawnedAt: this.state.spawnedAt,
        errorMessage: this.state.error,
        previousStatus,
      });
      this.crashRecorded = true;
    }
  }

  /**
   * Wait for worker to be ready.
   */
  private async waitForReady(timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const processRef = this.state.process;
      let unsubscribe = () => {};

      const cleanup = () => {
        clearTimeout(hardTimeout);
        clearTimeout(fallbackTimer);
        unsubscribe();
        processRef?.off('spawn', onSpawn);
        processRef?.off('error', onProcessFailure);
      };
      const ready = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.state.status = 'ready';
        resolve();
      };
      const onSpawn = () => ready();
      const onProcessFailure = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const hardTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Worker spawn timeout'));
      }, timeout);
      const fallbackTimer = setTimeout(() => {
        if (settled) return;
        this.metrics.recordWorkerReadinessFallback();
        logger.child({ sessionId: this.state.sessionPath }).warn(
          `worker readiness fallback used after ${this.readinessFallbackMs}ms without a process or RPC readiness signal`,
        );
        ready();
      }, Math.min(timeout, this.readinessFallbackMs));
      hardTimeout.unref?.();
      fallbackTimer.unref?.();

      unsubscribe = this.subscribe((event) => {
        if (event.type === 'streaming_started' || event.type === 'message_start') ready();
      });
      processRef?.once('spawn', onSpawn);
      processRef?.once('error', onProcessFailure);

      if (this.state.status === 'ready') ready();
    });
  }
}
