/**
 * Session Worker Process
 * Manages a single Pi SDK RPC process for session isolation.
 */

import { spawn, ChildProcess } from 'node:child_process';
import type { SessionWorkerState, WorkerOptions, RPCEvent, EventHandler } from './types.js';
import { RPCProtocolBridge } from './rpc-protocol-bridge.js';
import type { WorkerStatus } from '@pi-web-ui/shared';
import { getCrashLogger } from './crash-logger.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('SessionWorker');


export class SessionWorker {
  private state: SessionWorkerState;
  private bridge: RPCProtocolBridge;
  private eventHandlers: Set<EventHandler> = new Set();
  private stdoutBuffer: string = '';

  constructor(options: WorkerOptions) {
    this.state = {
      process: null,
      sessionPath: options.sessionPath,
      options,
      status: 'spawning' as WorkerStatus,
      lastActivity: Date.now(),
      spawnedAt: Date.now(),
      eventBuffer: [],
    };
    this.bridge = new RPCProtocolBridge();
  }

  /**
   * Spawn the worker process.
   */
  async spawn(): Promise<void> {
    const { sessionPath, model, thinkingLevel, maxOldSpaceSize = 512 } = this.state.options;
    
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

    // Handle stdout (JSONL events)
    this.state.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data.toString());
    });

    // Handle stderr (logs)
    this.state.process.stderr?.on('data', (data: Buffer) => {
      logger.error(`[SessionWorker:${this.state.pid}] stderr:`, data.toString());
    });

    // Handle process exit
    this.state.process.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    // Handle process spawn errors
    this.state.process.on('spawn', () => {
      this.state.status = 'ready';
      logger.info(`[SessionWorker:${this.state.pid}] Process spawned successfully`);
    });

    this.state.process.on('error', (err) => {
      this.state.status = 'error';
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
      }
    });

    // Wait for ready state (streaming_started or similar)
    await this.waitForReady();
  }

  /**
   * Send a command to the worker.
   */
  async sendCommand(command: Parameters<RPCProtocolBridge['formatRPCCommand']>[0]): Promise<void> {
    if (!this.state.process?.stdin) {
      throw new Error('Worker process not running');
    }

    const line = this.bridge.formatRPCCommand(command);
    this.state.process.stdin.write(line);
    this.state.lastActivity = Date.now();
  }

  /**
   * Subscribe to worker events.
   */
  subscribe(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
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

  /**
   * Terminate the worker gracefully.
   */
  async terminate(): Promise<void> {
    const proc = this.state.process;
    if (!proc) return;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  /**
   * Handle stdout data (JSONL lines).
   */
  private handleStdout(data: string): void {
    this.stdoutBuffer += data;
    
    // Process complete lines
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const event = this.bridge.parseRPCLine(line);
      if (event) {
        this.handleEvent(event);
      }
    }
  }

  /**
   * Handle a parsed RPC event.
   */
  private handleEvent(event: RPCEvent): void {
    this.state.lastActivity = Date.now();
    this.state.eventBuffer.push(event);

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
    const previousStatus = this.state.status;
    this.state.status = 'terminated';

    // Log basic exit info
    logger.info(`[SessionWorker:${this.state.pid}] Exited with code=${code}, signal=${signal}`);

    // Record crash for monitoring (skip if graceful shutdown via terminate())
    if (signal !== 'SIGTERM' || code !== 0) {
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
    }
  }

  /**
   * Wait for worker to be ready.
   */
  private async waitForReady(timeout = 30000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Worker spawn timeout'));
      }, timeout);

      const unsubscribe = this.subscribe((event) => {
        // Worker is ready when we receive any event or after a short delay
        if (event.type === 'streaming_started' || event.type === 'message_start') {
          clearTimeout(timer);
          unsubscribe();
          this.state.status = 'ready';
          resolve();
        }
      });

      // Also resolve after a short delay if no events
      setTimeout(() => {
        clearTimeout(timer);
        unsubscribe();
        this.state.status = 'ready';
        resolve();
      }, 1000);
    });
  }
}
