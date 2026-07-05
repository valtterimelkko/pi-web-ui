// WebSocket Event Types

export const WS_EVENTS = {
  // Client -> Server
  AUTH: 'auth',
  CREATE_SESSION: 'session:create',
  GET_SESSION: 'session:get',
  LIST_SESSIONS: 'session:list',
  SEND_MESSAGE: 'message:send',
  ABORT: 'agent:abort',
  READ_FILE: 'file:read',
  LIST_FILES: 'file:list',
  
  // Server -> Client
  AUTH_SUCCESS: 'auth:success',
  AUTH_ERROR: 'auth:error',
  SESSION_CREATED: 'session:created',
  SESSION_UPDATED: 'session:updated',
  MESSAGE_RECEIVED: 'message:received',
  MESSAGE_STREAM: 'message:stream',
  AGENT_STATUS: 'agent:status',
  TOOL_START: 'tool:start',
  TOOL_END: 'tool:end',
  FILE_CHANGED: 'file:changed',
  ERROR: 'error',
} as const;

// Default Configuration

export const DEFAULT_CONFIG = {
  SERVER_PORT: 3001,
  CLIENT_PORT: 5173,
  JWT_EXPIRES_IN: '7d',
  RATE_LIMIT_WINDOW_MS: 900000, // 15 minutes
  RATE_LIMIT_MAX: 100,
} as const;

// File Extensions

export const CODE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx',
  '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.lua',
  '.sh', '.bash', '.zsh',
  '.json', '.yaml', '.yml', '.toml',
  '.md', '.txt', '.env.example',
] as const;

export const IGNORED_PATTERNS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '*.min.js',
  '*.min.css',
  '.env',
  '.env.local',
] as const;

// Message Limits

export const MAX_MESSAGE_LENGTH = 100000;
export const MAX_FILE_SIZE = 1024 * 1024; // 1MB
/**
 * Maximum number of files a user can attach to a single prompt across all
 * runtimes. Authoritative cap — imported and enforced by the chat composer
 * (`client/src/lib/fileAttachments.ts` → `MessageInput.tsx`). Flexible from 1
 * up to this many; the user is never required to attach exactly this many.
 */
export const MAX_FILES_PER_MESSAGE = 5;

// Timeouts

export const TIMEOUTS = {
  AGENT_RESPONSE: 120000, // 2 minutes
  FILE_READ: 10000, // 10 seconds
  COMMAND_EXEC: 60000, // 1 minute
  WS_HEARTBEAT: 30000, // 30 seconds
} as const;
