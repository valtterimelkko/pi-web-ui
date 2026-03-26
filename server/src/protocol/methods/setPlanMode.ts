/**
 * SetPlanMode Method Handler
 * Handles the JSON-RPC 'setPlanMode' method for enabling/disabling plan mode
 */

import type { MethodHandler, SetPlanModeParams, SetPlanModeResult } from './types.js';

/**
 * SetPlanMode method handler
 * 
 * Enables or disables plan mode for the session.
 * Plan mode changes the agent's behavior to plan-first execution.
 * 
 * @param params - SetPlanMode parameters with enabled flag
 * @param context - Method execution context
 * @returns SetPlanMode result
 * @throws Error if session not found or plan mode change fails
 */
export const setPlanMode: MethodHandler<SetPlanModeParams, SetPlanModeResult> = async (
  params: SetPlanModeParams,
  context
): Promise<SetPlanModeResult> => {
  const { sessionPath, multiSessionManager } = context;

  // Validate parameters
  if (typeof params.enabled !== 'boolean') {
    throw new Error('Invalid setPlanMode: enabled must be a boolean');
  }

  // Get the agent session
  const agentSession = multiSessionManager.getAgentSession(sessionPath);
  if (!agentSession) {
    throw new Error(`Session not found: ${sessionPath}`);
  }

  try {
    // Check if the agent session supports plan mode
    // The Pi SDK's AgentSession may have a setPlanMode method in the future
    // For now, we check at runtime if the method exists
    const sessionWithPlanMode = agentSession as typeof agentSession & {
      setPlanMode?: (enabled: boolean) => Promise<void>;
    };
    
    if (typeof sessionWithPlanMode.setPlanMode === 'function') {
      await sessionWithPlanMode.setPlanMode(params.enabled);
    } else {
      // If not supported directly, we can still track the state
      // This allows for future implementation or extension-based support
      console.log(
        `[setPlanMode] Plan mode ${params.enabled ? 'enabled' : 'disabled'} for session ${sessionPath} (tracked only)`
      );

      return {
        enabled: params.enabled,
        message: 'Plan mode state tracked (agent does not support native plan mode)',
      };
    }

    console.log(
      `[setPlanMode] Plan mode ${params.enabled ? 'enabled' : 'disabled'} for session ${sessionPath}`
    );

    return {
      enabled: params.enabled,
      message: `Plan mode ${params.enabled ? 'enabled' : 'disabled'} successfully`,
    };
  } catch (error) {
    console.error(`[setPlanMode] Failed to set plan mode for session ${sessionPath}:`, error);
    throw new Error(
      `Failed to set plan mode: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
};

export default setPlanMode;
