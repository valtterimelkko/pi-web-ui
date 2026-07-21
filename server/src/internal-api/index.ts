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
  PromptDispatchResponse,
  DuplicatePromptResponse,
  DetachedPromptResponse,
  RunReceiptStatus,
  RunReceipt,
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
  ScreenViewResponse,
  SessionEvidenceResponse,
  WatchConditionType,
  WatchConditionSpec,
  WatchConditionState,
  WatchFiring,
  WatchSnapshot,
  WatchStatus,
  RegisterWatchRequest,
  WatchResponse,
  DeleteWatchResponse,
} from './types.js';
export { SSE_EVENT_TYPES } from './types.js';
export { InternalApiEventBroker } from './event-broker.js';
export type { EventBrokerSubscriber, EventBrokerOptions } from './event-broker.js';
export { WatchManager, WatchValidationError } from './watch/watch-manager.js';
export { WatchStore } from './watch/watch-store.js';
export { ConditionEngine } from './watch/condition-evaluator.js';
export { RunReceiptManager, IdempotencyKeyValidationError } from './run-receipts/run-receipt-manager.js';
export type { BeginRunInput, BeginRunResult, ExistingRunResult, RunFinishOutcome } from './run-receipts/run-receipt-manager.js';
export { RunReceiptStore } from './run-receipts/run-receipt-store.js';
export type { PersistedRunReceipt, RunReceiptStoreOptions } from './run-receipts/run-receipt-store.js';
export { resolveExecutionInstanceId } from './execution-instance.js';
