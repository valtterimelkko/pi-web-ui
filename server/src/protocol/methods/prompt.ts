/**
 * Prompt Method Handler
 * Handles the JSON-RPC 'prompt' method for sending user prompts to the agent
 */

import type { MethodHandler } from './types.js';
import type { PromptParams, PromptResult } from './types.js';
import { randomUUID } from 'crypto';

/**
 * Prompt method handler
 * 
 * Validates content, creates an agent turn, and returns a request ID
 * for correlation with streaming events.
 * 
 * @param params - Prompt parameters with content and optional images
 * @param context - Method execution context
 * @returns Prompt result with request ID
 * @throws Error if session not found or content is invalid
 */
export const prompt: MethodHandler<PromptParams, PromptResult> = async (
  params: PromptParams,
  context
): Promise<PromptResult> => {
  const { sessionPath, multiSessionManager } = context;

  // Validate content
  if (!params.content || typeof params.content !== 'string') {
    throw new Error('Invalid prompt: content must be a non-empty string');
  }

  if (params.content.trim().length === 0) {
    throw new Error('Invalid prompt: content cannot be empty or whitespace only');
  }

  // Validate images if provided
  if (params.images) {
    if (!Array.isArray(params.images)) {
      throw new Error('Invalid prompt: images must be an array');
    }

    for (const image of params.images) {
      if (image.type !== 'image') {
        throw new Error('Invalid prompt: image type must be "image"');
      }
      if (!image.data || typeof image.data !== 'string') {
        throw new Error('Invalid prompt: image data must be a base64 string');
      }
      if (!image.mimeType || typeof image.mimeType !== 'string') {
        throw new Error('Invalid prompt: image mimeType must be specified');
      }
      // Validate common image mime types
      const validMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!validMimeTypes.includes(image.mimeType)) {
        throw new Error(`Invalid prompt: unsupported image mimeType "${image.mimeType}"`);
      }
    }
  }

  // Get the agent session
  const agentSession = multiSessionManager.getAgentSession(sessionPath);
  if (!agentSession) {
    throw new Error(`Session not found: ${sessionPath}`);
  }

  // Generate or use provided request ID
  const requestId = params.requestId ?? randomUUID();

  // Create the agent turn
  try {
    await agentSession.prompt(params.content, {
      images: params.images,
    });

    console.log(`[prompt] Created prompt for session ${sessionPath}, requestId=${requestId}`);

    return {
      requestId,
      accepted: true,
    };
  } catch (error) {
    console.error(`[prompt] Failed to create prompt for session ${sessionPath}:`, error);
    throw new Error(
      `Failed to create prompt: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
};

export default prompt;
