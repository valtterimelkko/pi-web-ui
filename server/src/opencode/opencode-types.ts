export type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';

export interface OpenCodePermissionRule {
  permission: string;
  action: OpenCodePermissionAction;
  pattern: string;
}

export interface OpenCodeSession {
  id: string;
  slug: string;
  version: string;
  projectID: string;
  directory: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
  permission?: OpenCodePermissionRule[] | null;
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  parentID?: string;
  mode?: string;
  agent?: string;
  path?: { cwd: string; root: string };
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  modelID?: string;
  providerID?: string;
  model?: { providerID: string; modelID: string };
  time: {
    created: number;
    completed?: number;
  };
  finish?: string;
  error?: { name?: string; data?: { message?: string } };
  summary?: { diffs: unknown[] };
}

export interface OpenCodeMessagePart {
  type: 'text' | 'step-start' | 'step-finish' | 'tool-invocation' | string;
  id: string;
  sessionID: string;
  messageID: string;
  text?: string;
  time?: { start?: number; end?: number };
  snapshot?: string;
  reason?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { write?: number; read?: number };
  };
  cost?: number;
  toolInvocationId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
}

export interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodeMessagePart[];
}

export interface OpenCodeSSEEvent {
  type: string;
  properties?: Record<string, unknown>;
  data?: unknown;
}

export type OpenCodeSessionStatusType = 'idle' | 'busy';

export interface OpenCodePermissionRequest {
  id: string;
  sessionId: string;
  toolName?: string;
  args?: unknown;
  description?: string;
}

export interface OpenCodeConfig {
  host: string;
  port: number;
  password: string;
  workingDir: string;
  enabled: boolean;
}
