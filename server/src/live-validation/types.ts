import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  ApprovalResponseRequest,
  CapabilitiesResponse,
  CreateSessionResponse,
  SendPromptRequest,
  SessionControlRequest,
  SessionDetail,
  SessionEvidenceResponse,
  SessionHistoryResponse,
  PromptDispatchResponse,
  RunReceipt,
  ThinkingLevel,
} from '../internal-api/types.js';

export type ValidationCapabilities = CapabilitiesResponse;
export type ValidationRuntime = keyof ValidationCapabilities['runtimes'];

export interface InternalApiClientLike {
  createSession(input: { runtime: ValidationRuntime; cwd?: string; model?: string; thinkingLevel?: ThinkingLevel; source?: string; scenarioId?: string; ephemeral?: boolean }): Promise<CreateSessionResponse>;
  promptStream(sessionId: string, input: SendPromptRequest): Promise<NormalizedEvent[]>;
  promptWithIdempotency(sessionId: string, input: SendPromptRequest): Promise<PromptDispatchResponse>;
  getRunReceipt(runId: string): Promise<RunReceipt>;
  /**
   * Stream a prompt, invoking `onEvent` for each SSE event as it arrives
   * (before the turn completes). Needed for mid-turn interactions such as
   * answering an AskUserQuestion, which blocks the turn until answered.
   * Resolves with the full event list once the stream ends.
   */
  promptStreamLive(sessionId: string, input: SendPromptRequest, onEvent: (event: NormalizedEvent) => void): Promise<NormalizedEvent[]>;
  getSessionInfo(sessionId: string): Promise<SessionDetail>;
  /** Read the compact, alias-resolving troubleshooting evidence bundle. */
  getSessionEvidence?(sessionId: string, expand?: string[]): Promise<SessionEvidenceResponse>;
  getCapabilities(): Promise<ValidationCapabilities>;
  controlSession(sessionId: string, input: SessionControlRequest): Promise<unknown>;
  getSessionHistory(sessionId: string): Promise<SessionHistoryResponse>;
  /** Answer an approval/permission/AskUserQuestion request. */
  respondToApproval(sessionId: string, requestId: string, body: ApprovalResponseRequest): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
  optInNotifications(sessionId: string, label?: string): Promise<unknown>;
  getNotificationState(sessionId: string): Promise<{ optIn: unknown; deliveries: unknown[] }>;
  getLastPromptEvidence?(sessionId: string): { runId?: string; eventCounts: Record<string, number> } | undefined;
}

export interface ValidationAssertion {
  name: string;
  passed: boolean;
  details?: string;
}

export interface ValidationScenarioResult {
  scenarioId: string;
  runtime: ValidationRuntime;
  passed: boolean;
  skipped?: boolean;
  reason?: string;
  assertions: ValidationAssertion[];
  sessionId?: string;
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  runId?: string;
  model?: string;
  backendMode?: string;
  executionInstanceId?: string;
  eventCounts?: Record<string, number>;
  attemptHistory?: Array<{
    attempt: number;
    passed: boolean;
    skipped?: boolean;
    durationMs: number;
    reason?: string;
  }>;
  cleanupWarnings?: string[];
  failure?: { name: string; message: string };
}

export interface ValidationContext {
  client: InternalApiClientLike;
  runtime: ValidationRuntime;
  capabilities: ValidationCapabilities;
  cwd: string;
  timeoutMs?: number;
  /** Optional explicit model id (e.g. `kilo/...`, `opencode/...-free`). */
  model?: string;
}

export interface ValidationScenario {
  id: string;
  description: string;
  requires?: Array<keyof ValidationCapabilities['runtimes'][ValidationRuntime]>;
  run(context: ValidationContext): Promise<ValidationScenarioResult>;
}

export interface ValidationSummary {
  sawAgentStart: boolean;
  sawAgentEnd: boolean;
  assistantText: string;
  toolNames: string[];
  heartbeatCount: number;
  approvalRequestIds: string[];
  events: NormalizedEvent[];
}
