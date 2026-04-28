/**
 * Shared protocol types for process-per-session architecture.
 * These types are used by both server and client for communication.
 */

import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ImageContent, Model } from '@mariozechner/pi-ai';

/** Pi SDK worker lifecycle status. Used by worker pool and frontend worker indicators. */
export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'terminated' | 'error';

/** Options passed when spawning a Pi SDK worker process. */
export interface WorkerOptions {
  sessionPath: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxOldSpaceSize?: number; // Memory limit in MB, default 512
}

/** Snapshot of a Pi SDK worker process state. */
export interface WorkerInfo {
  sessionPath: string;
  status: WorkerStatus;
  pid?: number;
  memoryUsage?: number;
  lastActivity: number;
  spawnedAt: number;
  error?: string;
}

/** Commands sent from the main server to a Pi SDK worker via RPC. */
export type InternalCommand = 
  | { type: 'prompt'; message: string; images?: ImageContent[] }
  | { type: 'steer'; message: string; images?: ImageContent[] }
  | { type: 'abort' }
  | { type: 'get_state' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'compact'; customInstructions?: string };

/**
 * Common event shape produced by all runtime adapters (Pi SDK, Claude Direct, OpenCode Direct)
 * before being converted to the frontend-compatible format in connection.ts.
 *
 * This is the normalization contract: every runtime must emit events in this shape.
 */
export interface NormalizedEvent {
  type: string;
  sessionId?: string;
  timestamp: number;
  data: unknown;
}

/** Wrapper sent over WebSocket to route a NormalizedEvent to the correct client session. */
export interface SessionEventEnvelope {
  type: 'session_event';
  sessionId: string;
  event: NormalizedEvent;
}

// --- Git types ---

export interface GitFileStatus {
  path: string;
  staged: boolean;
  status: string; // 'M' | 'A' | 'D' | 'R' | '?' | '!'
  stagedStatus?: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  untracked: GitFileStatus[];
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit?: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  refs: string;
}

export interface GitDiff {
  file: string;
  content: string;
  additions: number;
  deletions: number;
}

// --- Terminal types ---

export interface TerminalSessionInfo {
  clientId: string;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivity: number;
}

// --- File types ---

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: string;
  extension?: string;
}

// --- Pool statistics ---

export interface WorkerPoolStats {
  active: number;
  idle: number;
  total: number;
  maxWorkers: number;
}
