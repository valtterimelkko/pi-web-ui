export interface OpenCodeSession {
  id: string;
  title?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenCodeMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: OpenCodeMessagePart[];
  createdAt?: string;
}

export interface OpenCodeMessagePart {
  type: 'text' | 'tool-invocation' | 'tool-result' | 'reasoning' | string;
  text?: string;
  toolInvocationId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  state?: 'partial' | 'result' | 'call' | string;
}

export interface OpenCodeSSEEvent {
  type: string;
  properties?: Record<string, unknown>;
  data?: unknown;
}

export type OpenCodeSessionStatus = 'idle' | 'running' | 'error';

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
