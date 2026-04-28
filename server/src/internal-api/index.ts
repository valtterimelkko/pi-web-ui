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
  SessionRuntime,
  CreateSessionRequest,
  SendPromptRequest,
  CreateSessionResponse,
  SessionInfo,
  SessionDetail,
  ListSessionsResponse,
  PromptResponse,
  ModelInfo,
  ModelsResponse,
  HealthResponse,
  ApiError,
  SSETaskStatusEvent,
} from './types.js';
export { SSE_EVENT_TYPES } from './types.js';
