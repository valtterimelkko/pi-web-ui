/**
 * Internal API Error Code Catalog
 *
 * Single source of truth for every error `code` string the Internal API can
 * return over the wire. Previously these were ~17 inline string literals
 * scattered across routes/middleware; this catalog makes them discoverable and
 * drift-proof.
 *
 * IMPORTANT contract invariant: the string VALUES must never change. External
 * consumers (live-validation scripts, the orchestration skill, Agent OS-style
 * local tools) switch on these exact strings. Renaming a value is a breaking
 * change that requires a new route major version (see
 * docs/INTERNAL-API-CONTRACT.md).
 *
 * Adding a new code is additive and safe.
 */

// ─── Stable wire-string values ───────────────────────────────────────────────

/**
 * Error code constants. Each value is the literal sent on the wire as
 * `{ error, code }`. Use `ErrorCode.SESSION_NOT_FOUND` etc. at call sites
 * instead of the raw string.
 */
export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_CREATE_FAILED: 'SESSION_CREATE_FAILED',
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  OPENCODE_UNAVAILABLE: 'OPENCODE_UNAVAILABLE',
  RUNTIME_ERROR: 'RUNTIME_ERROR',
  PROMPT_INJECTION: 'PROMPT_INJECTION',
  UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  WATCH_NOT_FOUND: 'WATCH_NOT_FOUND',
  TRANSFER_DISPATCH_FAILED: 'TRANSFER_DISPATCH_FAILED',
  EMPTY_TRANSCRIPT: 'EMPTY_TRANSCRIPT',
  ASK_ALREADY_CLOSED: 'ASK_ALREADY_CLOSED',
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  APPROVAL_REQUEST_NOT_FOUND: 'APPROVAL_REQUEST_NOT_FOUND',
  SESSION_NOT_STREAMING: 'SESSION_NOT_STREAMING',
  TURN_STALLED: 'TURN_STALLED',
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  RETENTION_CLAIM_NOT_FOUND: 'RETENTION_CLAIM_NOT_FOUND',
  RETENTION_CLAIM_OWNER_MISMATCH: 'RETENTION_CLAIM_OWNER_MISMATCH',
  RETENTION_RESIDENT_CAPACITY_EXHAUSTED: 'RETENTION_RESIDENT_CAPACITY_EXHAUSTED',
  RETENTION_STORE_UNAVAILABLE: 'RETENTION_STORE_UNAVAILABLE',
  ADMISSION_CAPACITY_EXHAUSTED: 'ADMISSION_CAPACITY_EXHAUSTED',
  PROVIDER_NOT_ALLOWED: 'PROVIDER_NOT_ALLOWED',
  COMMANDCODE_CLI_MISSING: 'COMMANDCODE_CLI_MISSING',
  COMMANDCODE_AUTH_REQUIRED: 'COMMANDCODE_AUTH_REQUIRED',
  COMMANDCODE_MODEL_UNAVAILABLE: 'COMMANDCODE_MODEL_UNAVAILABLE',
  COMMANDCODE_PROTOCOL_ERROR: 'COMMANDCODE_PROTOCOL_ERROR',
  COMMANDCODE_NO_RESPONSE: 'COMMANDCODE_NO_RESPONSE',
  COMMANDCODE_MAX_TURNS: 'COMMANDCODE_MAX_TURNS',
  COMMANDCODE_CREDITS: 'COMMANDCODE_CREDITS',
  COMMANDCODE_RATE_LIMITED: 'COMMANDCODE_RATE_LIMITED',
  COMMANDCODE_NETWORK_FAILURE: 'COMMANDCODE_NETWORK_FAILURE',
  COMMANDCODE_PROVIDER_FAILURE: 'COMMANDCODE_PROVIDER_FAILURE',
  COMMANDCODE_RESUME_IDENTITY_DRIFT: 'COMMANDCODE_RESUME_IDENTITY_DRIFT',
  COMMANDCODE_ROLE_REFUSED: 'COMMANDCODE_ROLE_REFUSED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Ordered list of every code (used by tests to assert completeness). */
export const ALL_ERROR_CODES: readonly ErrorCode[] = Object.values(ErrorCode);

// ─── Per-code metadata ───────────────────────────────────────────────────────

/**
 * Metadata for one error code. `httpStatus` is the canonical status used when
 * the code is the top-level response error; individual routes may still choose
 * a status (e.g. transfer returns 400 with `success:false`), but this is the
 * documented default. `hint`/`docs` are optional and populated for the most
 * actionable codes (see Task 11 / docs/INTERNAL-API-CONTRACT.md).
 */
export interface ErrorCodeInfo {
  /** Canonical HTTP status for this code. */
  readonly httpStatus: number;
  /** Short human/agent-readable meaning. */
  readonly description: string;
  /** Typical cause. */
  readonly cause: string;
  /** Optional actionable next step (added by Task 11). */
  readonly hint?: string;
  /** Optional doc anchor (added by Task 11). */
  readonly docs?: string;
}

export const ERROR_CODE_INFO: Record<ErrorCode, ErrorCodeInfo> = {
  [ErrorCode.UNAUTHORIZED]: {
    httpStatus: 401,
    description: 'Missing or invalid Internal API bearer token.',
    cause: 'No Authorization header, wrong scheme, or token mismatch.',
    hint: 'Send `Authorization: Bearer <token>` where <token> is the contents of the token file (default ~/.pi-web-ui/internal-api-token).',
    docs: 'docs/INTERNAL-API.md#authentication',
  },
  [ErrorCode.METHOD_NOT_ALLOWED]: {
    httpStatus: 405,
    description: 'The HTTP method is not supported for this endpoint.',
    cause: 'e.g. PUT on a GET-only route.',
    hint: 'Check the endpoint reference for the allowed method.',
    docs: 'docs/INTERNAL-API.md',
  },
  [ErrorCode.NOT_FOUND]: {
    httpStatus: 404,
    description: 'Unknown endpoint or API version.',
    cause: 'Path does not match any route, or version prefix is not /api/v1.',
    hint: 'Use GET /api/v1/capabilities to discover the contracted surface.',
    docs: 'docs/INTERNAL-API.md',
  },
  [ErrorCode.INVALID_REQUEST]: {
    httpStatus: 400,
    description: 'The request body is missing a required field or is malformed.',
    cause: 'e.g. POST /sessions without `runtime`, or detach:true with a streaming verbosity.',
    hint: 'Re-read the endpoint schema and resend with the required field(s).',
    docs: 'docs/INTERNAL-API.md',
  },
  [ErrorCode.PAYLOAD_TOO_LARGE]: {
    httpStatus: 413,
    description: 'The request body exceeds the endpoint limit.',
    cause: 'A local client sent more data than the bounded Internal API parser accepts.',
    hint: 'Reduce the payload or split batch work into smaller requests.',
    docs: 'docs/INTERNAL-API-CONTRACT.md#error-code-catalog',
  },
  [ErrorCode.SESSION_NOT_FOUND]: {
    httpStatus: 404,
    description: 'No session exists with the given sessionId.',
    cause: 'Wrong/expired id, or the session was deleted.',
    hint: 'List current sessions with GET /api/v1/sessions and use a valid sessionId.',
    docs: 'docs/INTERNAL-API.md#list-sessions',
  },
  [ErrorCode.SESSION_BUSY]: {
    httpStatus: 409,
    description: 'The session is already processing a prompt.',
    cause: 'A session handles one prompt at a time; a second caller arrived mid-turn.',
    hint: 'Wait for the running turn to finish (GET /sessions/:id/wait?status=idle) then retry.',
    docs: 'docs/INTERNAL-API.md#send-prompt',
  },
  [ErrorCode.SESSION_CREATE_FAILED]: {
    httpStatus: 500,
    description: 'Session creation failed.',
    cause: 'Runtime threw while provisioning (auth, disk, profile, etc.).',
    hint: 'Inspect the server log for the runtime error; confirm the runtime is available (GET /capabilities) and any profile/auth is valid.',
    docs: 'docs/INTERNAL-API.md#create-session',
  },
  [ErrorCode.RUNTIME_UNAVAILABLE]: {
    httpStatus: 503,
    description: 'The requested runtime is not installed or not enabled.',
    cause: 'The runtime binary is missing, disabled via env, or failed its health check.',
    hint: 'Check GET /api/v1/capabilities and the runtime install/env (e.g. OPENCODE_ENABLED, which claude/agy).',
    docs: 'docs/INTERNAL-API.md#capabilities',
  },
  [ErrorCode.OPENCODE_UNAVAILABLE]: {
    httpStatus: 503,
    description: 'OpenCode backend is not available for this operation.',
    cause: 'OpenCode not installed/enabled, or the model-refresh recycle failed.',
    hint: 'Confirm OPENCODE_ENABLED and that `opencode serve` can start.',
    docs: 'docs/OPENCODE-DIRECT-INTEGRATION.md',
  },
  [ErrorCode.RUNTIME_ERROR]: {
    httpStatus: 500,
    description: 'The runtime failed while executing the prompt.',
    cause: 'A turn raised an error (provider, model, tool, abort).',
    hint: 'The response includes the runtime message; check the server log + GET /sessions/:id/diagnostics for correlated detail.',
    docs: 'docs/INTERNAL-API.md#send-prompt',
  },
  [ErrorCode.PROMPT_INJECTION]: {
    httpStatus: 400,
    description: 'The prompt was blocked by the safety/injection filter.',
    cause: 'Prompt-injection detection flagged the submitted text.',
    hint: 'Rephrase the prompt to avoid injection-like patterns; the block is pre-runtime.',
    docs: 'SECURITY.md',
  },
  [ErrorCode.UNSUPPORTED_OPERATION]: {
    httpStatus: 400,
    description: 'The operation is not supported for this runtime or configuration.',
    cause: 'e.g. steer mode outside Pi, thinking level on a non-reasoning runtime.',
    hint: 'Check GET /api/v1/capabilities for per-runtime feature support before calling.',
    docs: 'docs/INTERNAL-API.md#capabilities',
  },
  [ErrorCode.NOT_IMPLEMENTED]: {
    httpStatus: 501,
    description: 'The endpoint exists but this runtime path is not implemented.',
    cause: 'e.g. replay history for an unsupported runtime.',
    hint: 'Use a runtime that supports the feature (see capabilities).',
    docs: 'docs/INTERNAL-API.md',
  },
  [ErrorCode.INTERNAL_ERROR]: {
    httpStatus: 500,
    description: 'Unexpected internal server error.',
    cause: 'Unhandled exception in a route handler.',
    hint: 'This is a bug; inspect the server log and GET /api/v1/diagnostics for the stack.',
    docs: 'docs/OBSERVABILITY.md',
  },
  [ErrorCode.WATCH_NOT_FOUND]: {
    httpStatus: 404,
    description: 'No long-horizon watch is registered for this session.',
    cause: 'GET/DELETE /watch before POST /watch, or after teardown/restart without reload.',
    hint: 'Register a watch with POST /sessions/:id/watch first.',
    docs: 'docs/LONG-HORIZON-VALIDATION.md',
  },
  [ErrorCode.TRANSFER_DISPATCH_FAILED]: {
    httpStatus: 500,
    description: 'Cross-session context transfer could not be dispatched.',
    cause: 'The transfer machinery threw (target creation, prompt injection, IO).',
    hint: 'The response includes the underlying message; confirm the target runtime/session is valid.',
    docs: 'docs/INTERNAL-API.md#cross-session-context-transfer',
  },
  [ErrorCode.EMPTY_TRANSCRIPT]: {
    httpStatus: 404,
    description: 'The session has no visible transcript yet.',
    cause: 'GET /transcript on a session before any turn produced visible content.',
    hint: 'Send a prompt first, or use GET /sessions/:id/history for raw replay events.',
    docs: 'docs/INTERNAL-API.md#universal-transcript',
  },
  [ErrorCode.ASK_ALREADY_CLOSED]: {
    httpStatus: 409,
    description: 'The AskUserQuestion dialog already closed before this answer arrived.',
    cause: 'A /respond (or extension_ui_response) targeted an AskUserQuestion requestId that already resolved (timeout/abort/turn-end/disconnect, or a resolution race).',
    hint: 'The answer was not delivered. Re-send the content as a normal user message if it is still relevant.',
    docs: 'docs/INTERNAL-API.md#approvals',
  },
  [ErrorCode.APPROVAL_REQUEST_NOT_FOUND]: {
    httpStatus: 404,
    description: 'No pending approval or interactive question matches this identifier for the session.',
    cause: 'The requestId/toolCallId is unknown, belongs to another session, or the session is not channel-backed.',
    hint: 'Read GET /sessions/:id/approvals/pending and retry with one of its identifiers.',
    docs: 'docs/INTERNAL-API.md#approvals',
  },
  [ErrorCode.SESSION_NOT_STREAMING]: {
    httpStatus: 409,
    description: 'The requested operation requires an active turn, but the session is idle.',
    cause: 'steer or a strict follow_up was sent after the active turn ended.',
    hint: 'Use mode=prompt to continue an idle session, or retry while a turn is active.',
    docs: 'docs/INTERNAL-API.md#send-prompt',
  },
  [ErrorCode.TURN_STALLED]: {
    httpStatus: 500,
    description: 'An accepted run stopped producing events and was terminalised by the watchdog.',
    cause: 'The runtime or its dispatch path wedged without a terminal event.',
    hint: 'Inspect the run receipt and session diagnostics before retrying.',
    docs: 'docs/TROUBLESHOOTING.md',
  },
  [ErrorCode.RUN_NOT_FOUND]: {
    httpStatus: 404,
    description: 'No persisted run receipt exists with the given runId.',
    cause: 'The run id is unknown or its bounded receipt retention window has elapsed.',
    hint: 'Use the runId returned by prompt dispatch and query it before retention pruning.',
    docs: 'docs/INTERNAL-API.md#run-identity-and-receipts',
  },
  [ErrorCode.RETENTION_CLAIM_NOT_FOUND]: {
    httpStatus: 404,
    description: 'The requested retention lease does not exist for this session.',
    cause: 'The lease id is wrong, expired, released, or belongs to another session.',
    hint: 'Use the lease id returned when retention was acquired.',
    docs: 'docs/INTERNAL-API.md#source-owned-session-retention',
  },
  [ErrorCode.RETENTION_CLAIM_OWNER_MISMATCH]: {
    httpStatus: 409,
    description: 'The retention lease owner does not match the conditional release request.',
    cause: 'A cooperative local client attempted to release another owner’s lease.',
    hint: 'Release the lease with the ownerId used when it was created.',
    docs: 'docs/INTERNAL-API.md#source-owned-session-retention',
  },
  [ErrorCode.RETENTION_RESIDENT_CAPACITY_EXHAUSTED]: {
    httpStatus: 409,
    description: 'Required resident retention could not be applied.',
    cause: 'The runtime refused to materialise or retain the session.',
    hint: 'Use durable retention or retry after runtime capacity is available.',
    docs: 'docs/INTERNAL-API.md#source-owned-session-retention',
  },
  [ErrorCode.RETENTION_STORE_UNAVAILABLE]: {
    httpStatus: 503,
    description: 'The retention lease could not be persisted durably.',
    cause: 'The owner-only retention ledger was unavailable or unwritable.',
    hint: 'Inspect diagnostics and retry only after storage is healthy.',
    docs: 'docs/INTERNAL-API.md#source-owned-session-retention',
  },
  [ErrorCode.ADMISSION_CAPACITY_EXHAUSTED]: {
    httpStatus: 429,
    description: 'Runtime execution admission is temporarily exhausted.',
    cause: 'A runtime/global turn cap or memory-headroom guard refused new work.',
    hint: 'Respect Retry-After, inspect GET /api/v1/capacity, and retry later.',
    docs: 'docs/INTERNAL-API.md#execution-admission-and-capacity',
  },
  [ErrorCode.PROVIDER_NOT_ALLOWED]: {
    httpStatus: 403,
    description: 'The selected Pi provider is disabled for Internal API agent execution.',
    cause: 'Operator policy blocks this provider on the local automation surface to prevent unintended usage charges.',
    hint: 'Choose a model returned by GET /api/v1/models; subscription provider openai-codex remains distinct from direct openai.',
    docs: 'docs/INTERNAL-API.md#pi-provider-execution-policy',
  },
  [ErrorCode.COMMANDCODE_CLI_MISSING]: {
    httpStatus: 503,
    description: 'The configured Command Code executable is unavailable.',
    cause: 'The server-owned absolute executable path is missing or inaccessible.',
    hint: 'Install Command Code or correct COMMAND_CODE_EXECUTABLE_PATH.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_AUTH_REQUIRED]: {
    httpStatus: 503,
    description: 'Command Code requires authentication.',
    cause: 'The external CLI reported its documented authentication exit code.',
    hint: 'Authenticate Command Code under its own account; Pi Web UI never reads its auth file.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_MODEL_UNAVAILABLE]: {
    httpStatus: 503,
    description: 'An exact Command Code model route is unavailable.',
    cause: 'Fresh discovery did not advertise the requested exact id.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_PROTOCOL_ERROR]: {
    httpStatus: 502,
    description: 'Command Code emitted an invalid or incomplete NDJSON protocol stream.',
    cause: 'Malformed frames, missing terminal result, or result/exit contradiction.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_NO_RESPONSE]: {
    httpStatus: 502,
    description: 'Command Code ended without a model response.',
    cause: 'The CLI reported no model response or no terminal output was observed.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_MAX_TURNS]: {
    httpStatus: 502,
    description: 'Command Code reached the server-owned max-turn bound.',
    cause: 'The CLI returned its max-turns result or exit classification.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_CREDITS]: {
    httpStatus: 503,
    description: 'Command Code reported insufficient credits.',
    cause: 'The external provider/account quota cannot service the route.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_RATE_LIMITED]: {
    httpStatus: 429,
    description: 'Command Code reported a rate limit.',
    cause: 'The external provider/account quota temporarily refused the route.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_NETWORK_FAILURE]: {
    httpStatus: 502,
    description: 'Command Code reported a bounded network failure.',
    cause: 'The external provider transport failed after the CLI was launched.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_PROVIDER_FAILURE]: {
    httpStatus: 502,
    description: 'Command Code reported a provider failure.',
    cause: 'The external provider returned a documented server-side failure.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_RESUME_IDENTITY_DRIFT]: {
    httpStatus: 409,
    description: 'The stored Command Code native session identity changed.',
    cause: 'A resume result did not match the session-bound native id.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.COMMANDCODE_ROLE_REFUSED]: {
    httpStatus: 403,
    description: 'The Command Code invocation role is not admitted for this session.',
    cause: 'The role/worktree evidence does not satisfy the server-owned profile boundary.',
    docs: 'docs/INTERNAL-API-CONTRACT.md',
  },
  [ErrorCode.IDEMPOTENCY_KEY_CONFLICT]: {
    httpStatus: 409,
    description: 'An idempotency key was reused for a different request payload.',
    cause: 'The same key remains reserved within the endpoint-specific scope and retention window.',
    hint: 'Retry the original request with the same payload, or choose a new key for new work.',
    docs: 'docs/INTERNAL-API-CONTRACT.md#error-code-catalog',
  },
};

/**
 * Build a wire error body for a code. Base shape `{ error, code }` is preserved
 * exactly (additive only). Task 11 layers `hint`/`docs` onto this.
 */
export function buildErrorBody(
  code: ErrorCode,
  message: string,
  options: { hint?: boolean; docs?: boolean } = {},
): { error: string; code: string; hint?: string; docs?: string } {
  const info = ERROR_CODE_INFO[code];
  const body: { error: string; code: string; hint?: string; docs?: string } = {
    error: message,
    code,
  };
  if (options.hint && info?.hint) body.hint = info.hint;
  if (options.docs && info?.docs) body.docs = info.docs;
  return body;
}

/**
 * Build an error body enriched with the code's `hint` and `docs` (when present).
 * Additive: the base `{ error, code }` shape is preserved, so existing consumers
 * keep working. Use for the most actionable error responses (Task 11).
 */
export function enrichedErrorBody(
  code: ErrorCode,
  message: string,
): { error: string; code: string; hint?: string; docs?: string } {
  return buildErrorBody(code, message, { hint: true, docs: true });
}
