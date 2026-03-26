/**
 * Steer Method Handler
 * Handles the JSON-RPC 'steer' method for injecting mid-turn messages
 */

import type { MethodHandler, SteerParams, SteerResult } from './types.js';
import { randomUUID } from 'crypto';

/**
 * Steer method handler
 * 
 * Injects a mid-turn message into an ongoing streaming operation.
 * Only valid when the session is in 'streaming' state.
 * 
 * @param params - Steer parameters with message content
 * @param context - Method execution context
 * @returns Steer result
 * @throws Error if session not found or not streaming
 */
export const steer: MethodHandler<SteerParams, SteerResult> = async (
  params: SteerParams,
  context
): Promise<SteerResult> => {
  const { sessionPath, multiSessionManager } = context;

  // Validate message
  if (!params.message || typeof params.message !== 'string') {
    throw new Error('Invalid steer: message must be a non-empty string');
  }

  if (params.message.trim().length === 0) {
    throw new Error('Invalid steer: message cannot be empty or whitespace only');
  }

  // Generate or use provided request ID
  const requestId = params.requestId ?? randomUUID();

  // Get the agent session
  const agentSession = multiSessionManager.getAgentSession(sessionPath);
  if (!agentSession) {
    throw new Error(`Session not found: ${sessionPath}`);
  }

  // Check session status - steering is only valid during streaming
  const status = multiSessionManager.getSessionStatus(sessionPath);
  if (!status) {
    throw new Error('Session status unavailable');
  }

  if (status.status !== 'streaming') {
    return {
      accepted: false,
      requestId,
      message: `Steering is only valid during streaming (current status: ${status.status})`,
    };
  }

  try {
    // Inject the steering message
    await agentSession.steer(params.message);

    console.log(
      `[steer] Injected steering message for session ${sessionPath}, requestId=${requestId}`
    );

    return {
      accepted: true,
      requestId,
      message: 'Steering message accepted',
    };
  } catch (error) {
    console.error(`[steer] Failed to steer session ${sessionPath}:`, error);
    
    return {
      accepted: false,
      requestId,
      message: `Failed to steer: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
};

export default steer;
