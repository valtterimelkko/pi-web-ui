export type McpClientErrorCode =
  | 'UNSAFE_LOCAL_PATH'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_CANCELLED'
  | 'TRANSPORT_ERROR'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_RESPONSE'
  | 'INCOMPATIBLE_CONTRACT'
  | 'INTERNAL_API_ERROR';

export interface McpClientErrorOptions {
  status?: number;
  hint?: string;
  docs?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  cause?: unknown;
}

export class InternalApiClientError extends Error {
  readonly code: McpClientErrorCode | string;
  readonly status?: number;
  readonly hint?: string;
  readonly docs?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: McpClientErrorCode | string, message: string, options: McpClientErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InternalApiClientError';
    this.code = code;
    this.status = options.status;
    this.hint = options.hint;
    this.docs = options.docs;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.docs === undefined ? {} : { docs: this.docs }),
      retryable: this.retryable,
      ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
    };
  }
}

export function asInternalApiClientError(error: unknown): InternalApiClientError {
  if (error instanceof InternalApiClientError) return error;
  return new InternalApiClientError('TRANSPORT_ERROR', 'Internal API transport failed.', { cause: error, retryable: true });
}
