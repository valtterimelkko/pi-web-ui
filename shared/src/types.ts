// WebSocket Message Types

export interface WebSocketMessage<T = unknown> {
  type: string;
  payload: T;
  timestamp: number;
}

// Session Types

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  messages: Message[];
}

export type SessionStatus = 'idle' | 'processing' | 'waiting' | 'error';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageMetadata {
  tokens?: number;
  model?: string;
  files?: string[];
  tools?: string[];
}

// Authentication Types

export interface AuthPayload {
  password: string;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  error?: string;
}

export interface TokenPayload {
  iat: number;
  exp: number;
}

// Agent Types

export interface AgentState {
  status: AgentStatus;
  currentTask?: string;
  workingDirectory: string;
  activeFiles: string[];
}

export type AgentStatus = 'idle' | 'thinking' | 'executing' | 'waiting' | 'error';

// File System Types

export interface FileInfo {
  path: string;
  name: string;
  type: FileType;
  size?: number;
  modifiedAt?: number;
}

export type FileType = 'file' | 'directory';

// Tool Types

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
}

export interface ToolParameter {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

// Event Types

export interface AgentEvent {
  type: AgentEventType;
  data: unknown;
  timestamp: number;
}

export type AgentEventType = 
  | 'tool_start'
  | 'tool_end'
  | 'file_read'
  | 'file_write'
  | 'command_start'
  | 'command_end'
  | 'thinking'
  | 'error';

export interface ToolStartEvent {
  toolName: string;
  input: unknown;
}

export interface ToolEndEvent {
  toolName: string;
  output: unknown;
  duration: number;
}

export interface FileEvent {
  path: string;
  content?: string;
  operation: 'read' | 'write' | 'delete';
}

export interface CommandStartEvent {
  command: string;
  cwd: string;
}

export interface CommandEndEvent {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}

export interface ThinkingEvent {
  content: string;
}

export interface ErrorEvent {
  message: string;
  stack?: string;
  code?: string;
}
