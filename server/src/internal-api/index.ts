/**
 * Internal API Module
 *
 * Exposes the Pi Web UI backend for programmatic consumption by other
 * local applications via a Unix domain socket HTTP API.
 */

export { InternalApiServer } from './server.js';
export type { InternalApiConfig } from './server.js';
export type {
  Verbosity,
  PromptMode,
  SessionRuntime,
  RuntimeBackendMode,
  CreateSessionRequest,
  SendPromptRequest,
  SessionControlRequest,
  ApprovalResponseRequest,
  CreateSessionResponse,
  SessionInfo,
  SessionDetail,
  SessionHistoryResponse,
  SessionControlResponse,
  ApprovalResponseResult,
  ListSessionsResponse,
  PromptResponse,
  ModelInfo,
  ModelsResponse,
  RuntimeCapabilities,
  CapabilitiesResponse,
  HealthResponse,
  ApiError,
  SSETaskStatusEvent,
  TransferSessionRequest,
  TransferSessionResponse,
  BatchCreateEntry,
  BatchCreateRequest,
  BatchCreateResultItem,
  BatchCreateResponse,
  BatchPromptEntry,
  BatchPromptRequest,
  BatchPromptResultItem,
  BatchPromptResponse,
  AggregateUsageRequest,
  AggregateUsageResponse,
  PendingApprovalsResponse,
  WaitResponse,
  TranscriptResponse,
} from './types.js';
export { SSE_EVENT_TYPES } from './types.js';
export { InternalApiEventBroker } from './event-broker.js';
export type { EventBrokerSubscriber, EventBrokerOptions } from './event-broker.js';
