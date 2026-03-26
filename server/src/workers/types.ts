/**
 * Worker process types for session isolation.
 */

import type { ChildProcess } from 'node:child_process';
import type { WorkerOptions, WorkerStatus, WorkerInfo } from '@pi-web-ui/shared';

// Re-export types from shared package
export type { WorkerOptions, WorkerStatus, WorkerInfo };

// RPC types from Pi SDK (redefined here since they're not exported from main package)
export type RpcCommand =
  | { id?: string; type: 'prompt'; message: string; images?: unknown[]; streamingBehavior?: 'steer' | 'followUp' }
  | { id?: string; type: 'steer'; message: string; images?: unknown[] }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'set_thinking_level'; level: unknown }
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'get_messages' };

export type RpcResponse =
  | { id?: string; type: 'response'; command: string; success: true; data?: unknown }
  | { id?: string; type: 'response'; command: string; success: false; error: string };

export type RpcExtensionUIRequest =
  | { type: 'extension_ui_request'; id: string; method: 'select'; title: string; options: string[]; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'confirm'; title: string; message: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'input'; title: string; placeholder?: string; timeout?: number }
  | { type: 'extension_ui_request'; id: string; method: 'editor'; title: string; prefill?: string }
  | { type: 'extension_ui_request'; id: string; method: 'notify'; message: string; notifyType?: 'info' | 'warning' | 'error' };

// Session worker state
export interface SessionWorkerState {
  process: ChildProcess | null;
  sessionPath: string;
  options: WorkerOptions;
  status: WorkerStatus;
  pid?: number;
  lastActivity: number;
  spawnedAt: number;
  error?: string;
  eventBuffer: RPCEvent[];
}

// RPC event types (from Pi SDK stdout)
export type RPCEvent = 
  | { type: 'message_start'; id: string; role: string }
  | { type: 'message_update'; id: string; delta: unknown }
  | { type: 'message_end'; id: string }
  | { type: 'tool_execution_start'; id: string; name: string; input: unknown }
  | { type: 'tool_execution_update'; id: string; delta: string }
  | { type: 'tool_execution_end'; id: string; result: unknown; isError: boolean }
  | { type: 'extension_ui_request'; id: string; method: string; [key: string]: unknown }
  | { type: 'session_compaction'; messageCount: number; removedCount: number }
  | { type: 'error'; message: string }
  | { type: 'streaming_started' }
  | { type: 'streaming_ended' };

// Event handler type
export type EventHandler = (event: RPCEvent) => void;

// Worker manager config
export interface WorkerManagerConfig {
  maxWorkers?: number; // Default 15
  idleTimeoutMs?: number; // Default 30 minutes
  maxOldSpaceSize?: number; // Default 512MB
  piPath?: string; // Path to pi binary, default 'pi'
}
