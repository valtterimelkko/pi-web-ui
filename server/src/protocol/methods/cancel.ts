/**
 * Cancel Method Handler
 * Handles the JSON-RPC 'cancel' method for aborting in-flight operations
 */

import type { MethodHandler, CancelParams, CancelResult } from './types.js';

/**
 * Cancel method handler
 * 
 * Aborts any in-flight operation and cleans up resources.
 * 
 * @param params - Cancel parameters with optional request ID and reason
 * @param context - Method execution context
 * @returns Cancel result
 */
export const cancel: MethodHandler<CancelParams, CancelResult> = async (
  params: CancelParams,
  context
): Promise<CancelResult> => {
  const { sessionPath, multiSessionManager } = context;

  // Get the agent session
  const agentSession = multiSessionManager.getAgentSession(sessionPath);
  if (!agentSession) {
    // Session doesn't exist, nothing to cancel
    return {
      cancelled: false,
      message: `Session not found: ${sessionPath}`,
    };
  }

  // Check session status
  const status = multiSessionManager.getSessionStatus(sessionPath);
  if (!status) {
    return {
      cancelled: false,
      message: 'Session status unavailable',
    };
  }

  // Only cancel if the session is busy or streaming
  if (status.status !== 'busy' && status.status !== 'streaming') {
    return {
      cancelled: false,
      message: `Session is not in a cancellable state (current: ${status.status})`,
    };
  }

  try {
    // Abort the current operation
    await agentSession.abort();

    // Update session status
    multiSessionManager.updateSessionStatus(sessionPath, 'idle');

    console.log(
      `[cancel] Cancelled operation for session ${sessionPath}`,
      params.reason ? `reason: ${params.reason}` : '',
      params.requestId ? `requestId: ${params.requestId}` : ''
    );

    return {
      cancelled: true,
      message: 'Operation cancelled successfully',
    };
  } catch (error) {
    console.error(`[cancel] Failed to cancel operation for session ${sessionPath}:`, error);
    
    return {
      cancelled: false,
      message: `Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
};

export default cancel;
