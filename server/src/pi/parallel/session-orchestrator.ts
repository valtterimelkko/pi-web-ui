/**
 * Session Orchestrator - Coordinate subagent sessions in worktrees
 *
 * Manages the lifecycle of parallel agent sessions, each running in
 * isolated git worktrees. Routes events to correct UI views.
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { WorktreeManager, WorktreeInfo } from './worktree-manager.js';
import type { TaskNode } from './plan-parser.js';
import { createLogger } from '../../logging/logger.js';

const logger = createLogger('SessionOrchestrator');


export interface OrchestrationSession {
  id: string;
  worktreeId: string;
  worktreePath: string;
  taskId: string;
  taskTitle: string;
  status: 'pending' | 'starting' | 'running' | 'completed' | 'error' | 'merged';
  process?: ChildProcess;
  startTime?: Date;
  endTime?: Date;
  error?: string;
  progress: number;
  messageCount: number;
}

export interface OrchestrationConfig {
  orchestrationId: string;
  repoPath: string;
  planTitle: string;
  baseBranch: string;
  autoMerge: boolean;
  maxParallel: number;
}

export interface OrchestrationState {
  id: string;
  config: OrchestrationConfig;
  sessions: Map<string, OrchestrationSession>;
  status: 'initializing' | 'running' | 'paused' | 'completed' | 'error';
  currentGroup: number;
  totalGroups: number;
  startTime: Date;
  endTime?: Date;
}

export interface SessionEvent {
  type: 'session_started' | 'session_progress' | 'session_completed' | 'session_error' | 'session_merged';
  orchestrationId: string;
  sessionId: string;
  data?: unknown;
}

type EventCallback = (event: SessionEvent) => void;

/**
 * Generate unique session ID
 */
function generateSessionId(worktreeId: string): string {
  return `session-${worktreeId}`;
}

/**
 * Session Orchestrator class
 */
export class SessionOrchestrator {
  private worktreeManager: WorktreeManager;
  private orchestrations: Map<string, OrchestrationState> = new Map();
  private eventCallbacks: Set<EventCallback> = new Set();

  constructor(worktreeManager: WorktreeManager) {
    this.worktreeManager = worktreeManager;
  }

  /**
   * Subscribe to orchestration events
   */
  onEvent(callback: EventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  /**
   * Emit an event to all subscribers
   */
  private emit(event: SessionEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        logger.error('[SessionOrchestrator] Event callback error:', error);
      }
    }
  }

  /**
   * Start a new orchestration
   */
  async startOrchestration(
    config: OrchestrationConfig,
    tasks: TaskNode[],
    parallelGroupIndex: number = 0
  ): Promise<OrchestrationState> {
    const state: OrchestrationState = {
      id: config.orchestrationId,
      config,
      sessions: new Map(),
      status: 'initializing',
      currentGroup: parallelGroupIndex,
      totalGroups: 0, // Will be set by caller
      startTime: new Date(),
    };

    this.orchestrations.set(config.orchestrationId, state);

    // Start sessions for each task
    const groupTasks = tasks; // Tasks for this parallel group
    
    for (const task of groupTasks) {
      const sessionId = generateSessionId(task.id);
      
      const session: OrchestrationSession = {
        id: sessionId,
        worktreeId: task.id,
        worktreePath: '', // Will be set when worktree is created
        taskId: task.id,
        taskTitle: task.title,
        status: 'pending',
        progress: 0,
        messageCount: 0,
      };

      state.sessions.set(sessionId, session);
    }

    state.status = 'running';
    return state;
  }

  /**
   * Start a session in a worktree
   */
  async startSession(
    orchestrationId: string,
    worktree: WorktreeInfo,
    task: TaskNode,
    agentType?: string
  ): Promise<OrchestrationSession> {
    const state = this.orchestrations.get(orchestrationId);
    if (!state) {
      throw new Error(`Orchestration ${orchestrationId} not found`);
    }

    const sessionId = generateSessionId(worktree.id);
    let session = state.sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        taskId: task.id,
        taskTitle: task.title,
        status: 'pending',
        progress: 0,
        messageCount: 0,
      };
      state.sessions.set(sessionId, session);
    }

    session.worktreePath = worktree.path;
    session.status = 'starting';
    session.startTime = new Date();

    // Update worktree status
    await this.worktreeManager.updateWorktreeStatus(worktree.id, 'running', sessionId);

    // Spawn pi process in worktree
    const args = [
      '--mode', 'json',
      '-p', '--no-session',
      '--cwd', worktree.path,
    ];

    if (agentType) {
      args.push('--agent', agentType);
    }

    // Add the task description
    const taskPrompt = `Task: ${task.title}\n\n${task.description}`;
    args.push(taskPrompt);

    logger.info(`[SessionOrchestrator] Starting session ${sessionId} in ${worktree.path}`);

    try {
      const childProcess = spawn('pi', args, {
        cwd: worktree.path,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      session.process = childProcess;
      session.status = 'running';

      // Handle stdout (JSON output from pi)
      let outputBuffer = '';
      childProcess.stdout?.on('data', (data: Buffer) => {
        outputBuffer += data.toString();
        session!.messageCount++;
        session!.progress = Math.min(95, session!.progress + 1);

        this.emit({
          type: 'session_progress',
          orchestrationId,
          sessionId,
          data: { output: data.toString(), messageCount: session.messageCount },
        });
      });

      // Handle stderr
      childProcess.stderr?.on('data', (data: Buffer) => {
        logger.error(`[SessionOrchestrator] Session ${sessionId} stderr:`, data.toString());
      });

      // Handle completion
      childProcess.on('close', async (code) => {
        session!.endTime = new Date();
        session!.process = undefined;

        if (code === 0) {
          session!.status = 'completed';
          session!.progress = 100;
          
          await this.worktreeManager.updateWorktreeStatus(worktree.id, 'completed');
          
          this.emit({
            type: 'session_completed',
            orchestrationId,
            sessionId,
            data: { output: outputBuffer },
          });

          logger.info(`[SessionOrchestrator] Session ${sessionId} completed`);
        } else {
          session!.status = 'error';
          session!.error = `Process exited with code ${code}`;
          
          await this.worktreeManager.updateWorktreeStatus(worktree.id, 'error');
          
          this.emit({
            type: 'session_error',
            orchestrationId,
            sessionId,
            data: { error: session.error, code },
          });

          logger.error(`[SessionOrchestrator] Session ${sessionId} failed with code ${code}`);
        }
      });

      // Handle errors
      childProcess.on('error', async (error) => {
        session!.status = 'error';
        session!.error = error.message;
        session!.process = undefined;
        
        await this.worktreeManager.updateWorktreeStatus(worktree.id, 'error');
        
        this.emit({
          type: 'session_error',
          orchestrationId,
          sessionId,
          data: { error: error.message },
        });

        logger.error(`[SessionOrchestrator] Session ${sessionId} error:`, error);
      });

      this.emit({
        type: 'session_started',
        orchestrationId,
        sessionId,
        data: { worktreePath: worktree.path, taskId: task.id },
      });

    } catch (error) {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : 'Unknown error';
      
      await this.worktreeManager.updateWorktreeStatus(worktree.id, 'error');
      
      this.emit({
        type: 'session_error',
        orchestrationId,
        sessionId,
        data: { error: session.error },
      });

      throw error;
    }

    return session;
  }

  /**
   * Get orchestration state
   */
  getOrchestration(orchestrationId: string): OrchestrationState | undefined {
    return this.orchestrations.get(orchestrationId);
  }

  /**
   * Get session state
   */
  getSession(orchestrationId: string, sessionId: string): OrchestrationSession | undefined {
    const state = this.orchestrations.get(orchestrationId);
    return state?.sessions.get(sessionId);
  }

  /**
   * Get all sessions for an orchestration
   */
  getSessions(orchestrationId: string): OrchestrationSession[] {
    const state = this.orchestrations.get(orchestrationId);
    return state ? Array.from(state.sessions.values()) : [];
  }

  /**
   * Pause an orchestration (stops accepting new sessions)
   */
  pauseOrchestration(orchestrationId: string): void {
    const state = this.orchestrations.get(orchestrationId);
    if (state) {
      state.status = 'paused';
    }
  }

  /**
   * Resume an orchestration
   */
  resumeOrchestration(orchestrationId: string): void {
    const state = this.orchestrations.get(orchestrationId);
    if (state && state.status === 'paused') {
      state.status = 'running';
    }
  }

  /**
   * Abort a session
   */
  async abortSession(orchestrationId: string, sessionId: string): Promise<void> {
    const session = this.getSession(orchestrationId, sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.process) {
      session.process.kill('SIGTERM');
      session.process = undefined;
    }

    session.status = 'error';
    session.error = 'Aborted by user';
    session.endTime = new Date();

    await this.worktreeManager.updateWorktreeStatus(session.worktreeId, 'error');
    
    this.emit({
      type: 'session_error',
      orchestrationId,
      sessionId,
      data: { error: 'Aborted by user' },
    });
  }

  /**
   * Check if all sessions in current group are complete
   */
  isGroupComplete(orchestrationId: string): boolean {
    const state = this.orchestrations.get(orchestrationId);
    if (!state) return false;

    for (const session of state.sessions.values()) {
      if (session.status === 'running' || session.status === 'starting' || session.status === 'pending') {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if any session has errors
   */
  hasErrors(orchestrationId: string): boolean {
    const state = this.orchestrations.get(orchestrationId);
    if (!state) return false;

    for (const session of state.sessions.values()) {
      if (session.status === 'error') {
        return true;
      }
    }

    return false;
  }

  /**
   * Get orchestration summary
   */
  getSummary(orchestrationId: string): {
    total: number;
    completed: number;
    running: number;
    error: number;
    pending: number;
  } {
    const state = this.orchestrations.get(orchestrationId);
    if (!state) {
      return { total: 0, completed: 0, running: 0, error: 0, pending: 0 };
    }

    let completed = 0;
    let running = 0;
    let error = 0;
    let pending = 0;

    for (const session of state.sessions.values()) {
      switch (session.status) {
        case 'completed':
        case 'merged':
          completed++;
          break;
        case 'running':
        case 'starting':
          running++;
          break;
        case 'error':
          error++;
          break;
        case 'pending':
        default:
          pending++;
          break;
      }
    }

    return {
      total: state.sessions.size,
      completed,
      running,
      error,
      pending,
    };
  }

  /**
   * Cleanup completed orchestrations
   */
  cleanup(maxAge: number = 3600000): void {
    const now = Date.now();
    
    for (const [id, state] of this.orchestrations.entries()) {
      if (state.endTime && now - state.endTime.getTime() > maxAge) {
        this.orchestrations.delete(id);
      }
    }
  }
}

/**
 * Create a session orchestrator
 */
export function createSessionOrchestrator(worktreeManager: WorktreeManager): SessionOrchestrator {
  return new SessionOrchestrator(worktreeManager);
}
