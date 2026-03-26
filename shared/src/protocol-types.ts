/**
 * Shared protocol types for process-per-session architecture.
 * These types are used by both server and client for communication.
 */

import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ImageContent, Model } from '@mariozechner/pi-ai';

// Worker status
export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'terminated' | 'error';

// Worker options for spawning
export interface WorkerOptions {
  sessionPath: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  maxOldSpaceSize?: number; // Memory limit in MB, default 512
}

// Worker metadata
export interface WorkerInfo {
  sessionPath: string;
  status: WorkerStatus;
  pid?: number;
  memoryUsage?: number;
  lastActivity: number;
  spawnedAt: number;
  error?: string;
}

// Internal command format (to be converted to RPC)
export type InternalCommand = 
  | { type: 'prompt'; message: string; images?: ImageContent[] }
  | { type: 'steer'; message: string; images?: ImageContent[] }
  | { type: 'abort' }
  | { type: 'get_state' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'compact'; customInstructions?: string };

// Normalized event format (internal representation)
export interface NormalizedEvent {
  type: string;
  sessionId?: string;
  timestamp: number;
  data: unknown;
}

// Session event wrapper for WebSocket
export interface SessionEventEnvelope {
  type: 'session_event';
  sessionId: string;
  event: NormalizedEvent;
}

// Pool statistics
export interface WorkerPoolStats {
  active: number;
  idle: number;
  total: number;
  maxWorkers: number;
}
