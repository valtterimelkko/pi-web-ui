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
