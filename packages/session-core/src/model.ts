/**
 * The session render model: what the readers and the fold produce and what
 * the cards consume. Moved from `client/src/store/sessionStore.ts` (`Message`,
 * `BackgroundChildIdentity`) and `client/src/hooks/useSessionStream.ts`
 * (`ContentPart`, `ToolCallState`, `LiveMessage`), which re-export them.
 */
import type { SubagentToolSummary } from './subagent-summary.js';

/**
 * Content part types for live messages
 */
export type ContentPartType = 'text' | 'thinking';

/**
 * A content part in a live message
 */
export interface ContentPart {
  type: ContentPartType;
  text?: string;
  thinking?: string;
}

/**
 * Tool call state during streaming
 */
export interface ToolCallState {
  id: string;
  name: string;
  args: unknown;
  result?: unknown;
  status: 'pending' | 'success' | 'error';
}

/**
 * A live message being streamed or completed
 */
export interface LiveMessage {
  id: string;
  // 'custom' is an extension-injected message (e.g. the marked Agent OS capture
  // lane). Rendered lists filter it out by role exactly as before; the field is
  // widened so the store's marker can pass through type-honestly.
  role: 'user' | 'assistant' | 'tool' | 'custom';
  /** Structural extension marker (customType), carried additively. */
  customType?: string;
  content: ContentPart[];
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  toolResult?: {
    output: string;
    isError: boolean;
    summary?: SubagentToolSummary;
    /** Contract 1.34.0: bounded background-child identity for background launches. */
    background?: { taskId: string; runId?: string; kind?: string; model?: string };
  };
  timestamp: number;
  isComplete: boolean;
  error?: {
    message: string;
    provider?: string;
    model?: string;
  };
}

/** Bounded background-child identity carried on subagent tool results (contract 1.34.0). */
export interface BackgroundChildIdentity {
  taskId: string;
  runId?: string;
  kind?: string;
  model?: string;
}

/** One rendered row of a session: a user/assistant message or one tool call. */
export interface Message {
  id: string;
  // 'custom' is an extension-injected message (pi sendMessage). It is carried
  // so the talker's spoken-context scan can key on its structural marker
  // (customType); rendered projections keep filtering it out by role.
  role: 'user' | 'assistant' | 'tool' | 'custom';
  /** The extension's structural marker for custom messages (e.g. the routine
   *  Agent OS capture lane's 'agent-os-capture'). Absent for real messages. */
  customType?: string;
  content: string | ContentPart[];
  timestamp: number;
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  toolResult?: {
    output: string;
    isError: boolean;
    // Compact subagent/evaluated_subagent summary (model + tool-usage), computed
    // server-side and forwarded on `tool_execution_end`. Present only for Pi
    // subagent-family tools; absent for every other tool/runtime.
    summary?: SubagentToolSummary;
    // Contract 1.34.0: bounded background-child identity for background launches.
    background?: BackgroundChildIdentity;
  };
  isComplete?: boolean; // Optional for backward compatibility with LiveMessage
  error?: {
    message: string;
    provider?: string;
    model?: string;
  };
}

/** Name the centre-facing API uses for the store's `Message`. */
export type RenderMessage = Message;
