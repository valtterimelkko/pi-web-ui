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

// OpenCodeMessageInfo, OpenCodeMessagePart and OpenCodeMessage moved to
// @pi-web-ui/session-core (command-centre step 1a); re-exported for compatibility.
export type { OpenCodeMessageInfo, OpenCodeMessagePart, OpenCodeMessage } from '@pi-web-ui/session-core/readers';

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
