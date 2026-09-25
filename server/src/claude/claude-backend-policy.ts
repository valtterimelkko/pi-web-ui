import { ErrorCode } from '../internal-api/error-codes.js';

/**
 * The backend a Claude session's prompts actually execute on. `direct` is the
 * legacy profile-less `claude -p` path; `cli-direct` is a profile-bound one.
 */
export type ClaudeExecutionBackend = 'sdk-subscription' | 'cli-direct' | 'channel' | 'direct';

/**
 * The only Claude backend allowed for Internal API agent execution (operator
 * decision 2026-09-25): the Agent SDK is superior to channel-backed and direct
 * CLI Claude. The browser keeps every backend.
 */
export const INTERNAL_API_CLAUDE_BACKEND = 'sdk-subscription' as const;

export class ClaudeBackendNotAllowedError extends Error {
  readonly code = ErrorCode.CLAUDE_BACKEND_NOT_ALLOWED;

  constructor(readonly backend: ClaudeExecutionBackend, reason?: string) {
    super(`Claude backend '${backend}' is not allowed for agent execution through the Internal API; only the Claude Agent SDK backend ('${INTERNAL_API_CLAUDE_BACKEND}') is${reason ? ` (${reason})` : ''}`);
    this.name = 'ClaudeBackendNotAllowedError';
  }
}
