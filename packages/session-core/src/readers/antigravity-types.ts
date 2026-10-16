/** Antigravity stored-turn shapes (moved from `server/src/antigravity/antigravity-session-store.ts`). */
export type AntigravityTurnStatus = 'running' | 'done' | 'error';

/** Mapped token usage from an agy result envelope (stream-json path). */
export interface AgyStoredUsage {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  total: number;
}

/** Compact stored tool call (stream-json path). Outputs are truncated at
 *  store time; the cap keeps a heavy agentic turn from ballooning the JSONL. */
export interface AgyStoredToolCall {
  toolName: string;
  args?: unknown;
  output?: string;
  isError: boolean;
  errorMessage?: string;
}

export const AGY_STORED_TOOL_LIMIT = 50;
export const AGY_STORED_TOOL_OUTPUT_LIMIT = 2_000;

export interface AntigravityTurn {
  turnId: string;
  prompt: string;
  response: string; // '' while running; final text or error note when finalized
  model: string;
  conversationId: string | null;
  timestamp: number;
  status?: AntigravityTurnStatus; // undefined === legacy 'done' (back-compat)
  error?: string; // present when status === 'error'
  rawStdoutLength?: number; // only meaningful when status === 'done' (legacy text-mode path)
  turnDurationMs?: number; // wall-clock time the agy subprocess took, set on finalize
  usage?: AgyStoredUsage; // real token usage (stream-json path)
  numTurns?: number; // cumulative agy num_turns at this turn's result
  agyStatus?: string; // raw agy terminal status (SUCCESS/ERROR/…)
  tools?: AgyStoredToolCall[]; // compact tool-call records (stream-json path)
}

