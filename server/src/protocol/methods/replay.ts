/**
 * Replay Method Handler
 * Handles the JSON-RPC 'replay' method for reading session history
 */

import type { MethodHandler } from './types.js';
import type { ReplayParams, ReplayResult } from './types.js';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Replay method handler
 * 
 * Reads session history from the session file and returns events.
 * 
 * @param params - Replay parameters with fromIndex, limit, and options
 * @param context - Method execution context
 * @returns Replay result with events array
 * @throws Error if session file not found or unreadable
 */
export const replay: MethodHandler<ReplayParams, ReplayResult> = async (
  params: ReplayParams,
  context
): Promise<ReplayResult> => {
  const { sessionPath, multiSessionManager } = context;

  // Default values
  const fromIndex = params.fromIndex ?? 0;
  const limit = params.limit ?? 100;
  const includeToolResults = params.includeToolResults ?? false;

  // Validate parameters
  if (fromIndex < 0) {
    throw new Error('Invalid replay: fromIndex must be >= 0');
  }

  if (limit < 1 || limit > 1000) {
    throw new Error('Invalid replay: limit must be between 1 and 1000');
  }

  // Check if session exists
  const agentSession = multiSessionManager.getAgentSession(sessionPath);
  if (!agentSession) {
    throw new Error(`Session not found: ${sessionPath}`);
  }

  // Get the session file path
  const sessionFile = agentSession.sessionFile;
  if (!sessionFile) {
    throw new Error('Session file path not available');
  }

  // Check if file exists
  if (!existsSync(sessionFile)) {
    return {
      events: [],
      totalEvents: 0,
      startIndex: fromIndex,
    };
  }

  try {
    // Read the session file (JSONL format)
    const fileContent = await readFile(sessionFile, 'utf-8');
    const lines = fileContent.split('\n').filter((line) => line.trim());

    // Parse all events
    const allEvents: Array<{
      id: string;
      type: string;
      timestamp: number;
      data: unknown;
    }> = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as Record<string, unknown>;

        // Skip tool results if not requested
        if (!includeToolResults && entry.type === 'tool_result') {
          continue;
        }

        allEvents.push({
          id: (entry.id as string) ?? `event-${i}`,
          type: (entry.type as string) ?? 'unknown',
          timestamp: (entry.timestamp as number) ?? Date.now(),
          data: entry,
        });
      } catch {
        // Skip malformed lines
        console.warn(`[replay] Failed to parse line ${i} in session ${sessionPath}`);
      }
    }

    // Apply pagination
    const totalEvents = allEvents.length;
    const startIndex = Math.min(fromIndex, totalEvents);
    const endIndex = Math.min(startIndex + limit, totalEvents);
    const events = allEvents.slice(startIndex, endIndex);

    console.log(
      `[replay] Returning ${events.length} events from session ${sessionPath} (total: ${totalEvents}, fromIndex: ${startIndex})`
    );

    return {
      events,
      totalEvents,
      startIndex,
    };
  } catch (error) {
    console.error(`[replay] Failed to read session file ${sessionFile}:`, error);
    throw new Error(
      `Failed to read session history: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
};

export default replay;
