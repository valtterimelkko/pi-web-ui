import type { SdkType } from '@pi-web-ui/shared';

export type TransferScope = 'visible_recent' | 'visible_full';

export interface TransferSourceRef {
  sessionId: string;
  sdkType: SdkType;
  pathOrRuntimeId: string;
}

export interface TransferTargetRef {
  targetSessionId?: string;
  createNew?: boolean;
  sdkType?: SdkType;
  cwd?: string;
}

export interface VisibleTranscriptItem {
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp?: number;
  toolName?: string;
  toolPrimaryArg?: string;
}

export interface VisibleTranscriptSource {
  sessionId: string;
  displayName: string;
  sdkType: SdkType;
  cwd: string;
  createdAt?: string;
  lastActivity?: string;
}

export interface VisibleTranscript {
  source: VisibleTranscriptSource;
  scope: TransferScope;
  itemCount: number;
  truncated: boolean;
  items: VisibleTranscriptItem[];
}

export interface TransferHandoffPayload {
  header: string;
  body: string;
  metadata: {
    sourceDisplayName: string;
    sourceSdkType: SdkType;
    sourceCwd: string;
    transferTimestamp: string;
    scope: TransferScope;
  };
  fullText: string;
}

export interface TransferRequest {
  sourceSessionId: string;
  targetSessionId?: string;
  createNew?: boolean;
  targetSdkType?: SdkType;
  targetCwd?: string;
  scope: TransferScope;
  sourceDisplayName?: string;
}

export const TRANSFER_ERROR_CODES = {
  SOURCE_NOT_FOUND: 'TRANSFER_SOURCE_NOT_FOUND',
  TARGET_NOT_FOUND: 'TRANSFER_TARGET_NOT_FOUND',
  TARGET_BUSY: 'TRANSFER_TARGET_BUSY',
  SELF_TRANSFER: 'TRANSFER_SELF_TRANSFER',
  EMPTY_SOURCE: 'TRANSFER_EMPTY_SOURCE',
  SOURCE_TOO_LARGE: 'TRANSFER_SOURCE_TOO_LARGE',
  INVALID_SCOPE: 'TRANSFER_INVALID_SCOPE',
  INVALID_REQUEST: 'TRANSFER_INVALID_REQUEST',
  PROMPT_INJECTION: 'TRANSFER_PROMPT_INJECTION',
  RUNTIME_UNAVAILABLE: 'TRANSFER_RUNTIME_UNAVAILABLE',
  DISPATCH_FAILED: 'TRANSFER_DISPATCH_FAILED',
} as const;

export type TransferErrorCode = typeof TRANSFER_ERROR_CODES[keyof typeof TRANSFER_ERROR_CODES];

export const VISIBLE_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'glob',
  'grep',
  'webfetch',
  'skill',
  'task',
]);

export const TOOL_PRIMARY_ARG_KEYS: Record<string, string> = {
  read: 'filePath',
  write: 'filePath',
  edit: 'filePath',
  bash: 'command',
  glob: 'pattern',
  grep: 'pattern',
  webfetch: 'url',
  skill: 'name',
  task: 'description',
};

export const MAX_TOOL_OUTPUT_LENGTH = 200;
export const RECENT_ITEM_COUNT = 20;
