/** OpenCode HTTP API message shapes the replay reader consumes (moved from `server/src/opencode/opencode-types.ts`). */
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

