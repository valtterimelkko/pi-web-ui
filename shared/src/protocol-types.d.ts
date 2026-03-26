/**
 * Shared protocol types for process-per-session architecture.
 * These types are used by both server and client for communication.
 */
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import type { ImageContent } from '@mariozechner/pi-ai';
export type WorkerStatus = 'spawning' | 'ready' | 'streaming' | 'idle' | 'terminated' | 'error';
export interface WorkerOptions {
    sessionPath: string;
    model?: string;
    thinkingLevel?: ThinkingLevel;
    maxOldSpaceSize?: number;
}
export interface WorkerInfo {
    sessionPath: string;
    status: WorkerStatus;
    pid?: number;
    memoryUsage?: number;
    lastActivity: number;
    spawnedAt: number;
    error?: string;
}
export type InternalCommand = {
    type: 'prompt';
    message: string;
    images?: ImageContent[];
} | {
    type: 'steer';
    message: string;
    images?: ImageContent[];
} | {
    type: 'abort';
} | {
    type: 'get_state';
} | {
    type: 'set_model';
    provider: string;
    modelId: string;
} | {
    type: 'set_thinking_level';
    level: ThinkingLevel;
} | {
    type: 'compact';
    customInstructions?: string;
};
export interface NormalizedEvent {
    type: string;
    sessionId?: string;
    timestamp: number;
    data: unknown;
}
export interface SessionEventEnvelope {
    type: 'session_event';
    sessionId: string;
    event: NormalizedEvent;
}
export interface WorkerPoolStats {
    active: number;
    idle: number;
    total: number;
    maxWorkers: number;
}
//# sourceMappingURL=protocol-types.d.ts.map