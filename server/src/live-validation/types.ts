import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  CapabilitiesResponse,
  CreateSessionResponse,
  SendPromptRequest,
  SessionControlRequest,
  SessionDetail,
  SessionHistoryResponse,
} from '../internal-api/types.js';

export type ValidationCapabilities = CapabilitiesResponse;
export type ValidationRuntime = keyof ValidationCapabilities['runtimes'];

export interface InternalApiClientLike {
  createSession(input: { runtime: ValidationRuntime; cwd?: string; model?: string; source?: string; scenarioId?: string; ephemeral?: boolean }): Promise<CreateSessionResponse>;
  promptStream(sessionId: string, input: SendPromptRequest): Promise<NormalizedEvent[]>;
  getSessionInfo(sessionId: string): Promise<SessionDetail>;
  getCapabilities(): Promise<ValidationCapabilities>;
  controlSession(sessionId: string, input: SessionControlRequest): Promise<unknown>;
  getSessionHistory(sessionId: string): Promise<SessionHistoryResponse>;
  respondToApproval(sessionId: string, requestId: string, approved: boolean): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
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
