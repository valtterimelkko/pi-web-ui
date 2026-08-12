import { request, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { URLSearchParams } from 'node:url';
import { z } from 'zod';
import {
  assertSameIdentity,
  assertSecureSocketPath,
  readSecureToken,
  type McpConfig,
  type SecurePathIdentity,
} from './config.js';
import { InternalApiClientError } from './errors.js';
import {
  capabilitiesSchema,
  createSessionResponseSchema,
  dispatchResponseSchema,
  modelsResponseSchema,
  runReceiptSchema,
  runtimeSchema,
  sessionsResponseSchema,
  transcriptResponseSchema,
  type CapabilitiesResponse,
  type CreateSessionInput,
  type CreateSessionResponse,
  type DispatchPromptInput,
  type DispatchResponse,
  type ModelsResponse,
  type RunReceipt,
  type Runtime,
  type SessionsResponse,
  type TranscriptResponse,
} from './internal-api-types.js';

const API_PREFIX = '/api/v1';
const MIN_CONTRACT = [1, 6, 0] as const;
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{0,79}$/;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RequestCallOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeastVersion(actual: [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function safeOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  if (/bearer\s+\S+|(?:^|\b)(?:cookie|authorization|token|password|api[-_]?key)\s*[:=]/i.test(value)) return undefined;
  return value;
}

function parseErrorPayload(body: string): { code?: string; hint?: string; docs?: string } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const code = typeof record.code === 'string' && SAFE_CODE_RE.test(record.code) ? record.code : undefined;
  return {
    code,
    hint: safeOptionalString(record.hint, 512),
    docs: safeOptionalString(record.docs, 512),
  };
}

function safeOperationError(operation: string, status: number, headers: IncomingHttpHeaders, body: string): InternalApiClientError {
  const parsed = parseErrorPayload(body);
  const retryable = status === 408 || status === 429 || status >= 500;
  const retryAfterHeader = headers['retry-after'];
  const retryAfterSeconds = typeof retryAfterHeader === 'string' && /^\d+$/.test(retryAfterHeader)
    ? Number(retryAfterHeader)
    : undefined;
  return new InternalApiClientError(
    parsed.code ?? 'INTERNAL_API_ERROR',
    `Internal API rejected ${operation}.`,
    {
      status,
      hint: parsed.hint,
      docs: parsed.docs,
      retryable,
      retryAfterSeconds: Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : undefined,
    },
  );
}

function asUnsafePathError(): InternalApiClientError {
  return new InternalApiClientError('UNSAFE_LOCAL_PATH', 'Configured Internal API socket or token file failed local safety checks.');
}

function asInvalidResponseError(operation: string): InternalApiClientError {
  return new InternalApiClientError('INVALID_RESPONSE', `Internal API returned an invalid response for ${operation}.`);
}

function asTransportError(operation: string, cause: unknown): InternalApiClientError {
  return new InternalApiClientError('TRANSPORT_ERROR', `Internal API transport failed for ${operation}.`, { cause, retryable: true });
}

export class InternalApiClient {
  constructor(private readonly config: McpConfig) {}

  async getCapabilities(signal?: AbortSignal): Promise<CapabilitiesResponse> {
    const result = await this.requestJson('get_capabilities', 'GET', `${API_PREFIX}/capabilities`, undefined, capabilitiesSchema, { signal });
    this.assertCompatibleContract(result);
    return result;
  }

  async listModels(runtime?: Runtime, signal?: AbortSignal): Promise<ModelsResponse> {
    await this.assertCompatible(signal);
    const query = runtime === undefined ? '' : `?${new URLSearchParams({ runtime }).toString()}`;
    return this.requestJson('list_models', 'GET', `${API_PREFIX}/models${query}`, undefined, modelsResponseSchema, { signal });
  }

  async listSessions(signal?: AbortSignal): Promise<SessionsResponse> {
    await this.assertCompatible(signal);
    return this.requestJson('list_sessions', 'GET', `${API_PREFIX}/sessions`, undefined, sessionsResponseSchema, { signal });
  }

  async createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<CreateSessionResponse> {
    await this.assertCompatible(signal);
    const body: Record<string, string> = { runtime: input.runtime };
    if (input.model !== undefined) body.model = input.model;
    if (input.cwd !== undefined) body.cwd = input.cwd;
    return this.requestJson('create_session', 'POST', `${API_PREFIX}/sessions`, body, createSessionResponseSchema, { signal });
  }

  async dispatchPrompt(sessionId: string, input: DispatchPromptInput, signal?: AbortSignal): Promise<DispatchResponse> {
    await this.assertCompatible(signal);
    const body: Record<string, unknown> = {
      message: input.message,
      verbosity: 'answers',
      mode: 'prompt',
      detach: true,
    };
    if (input.idempotencyKey !== undefined) body.idempotencyKey = input.idempotencyKey;
    return this.requestJson(
      'dispatch_prompt',
      'POST',
      `${API_PREFIX}/sessions/${encodePathSegment(sessionId)}/prompt`,
      body,
      dispatchResponseSchema,
      { signal, idempotencyKey: input.idempotencyKey },
    );
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunReceipt> {
    await this.assertCompatible(signal);
    return this.requestJson('get_run', 'GET', `${API_PREFIX}/runs/${encodePathSegment(runId)}`, undefined, runReceiptSchema, { signal });
  }

  async getTranscript(sessionId: string, scope: 'visible_recent' | 'visible_full' = 'visible_recent', signal?: AbortSignal): Promise<TranscriptResponse> {
    await this.assertCompatible(signal);
    const query = new URLSearchParams({ scope }).toString();
    return this.requestJson(
      'get_transcript',
      'GET',
      `${API_PREFIX}/sessions/${encodePathSegment(sessionId)}/transcript?${query}`,
      undefined,
      transcriptResponseSchema,
      { signal },
    );
  }

  private async assertCompatible(signal?: AbortSignal): Promise<void> {
    await this.getCapabilities(signal);
  }

  private assertCompatibleContract(value: CapabilitiesResponse): void {
    const { contract } = value;
    const version = parseSemver(contract.contractVersion);
    if (
      contract.name !== 'pi-web-ui-internal-api' ||
      contract.routePrefix !== API_PREFIX ||
      contract.majorVersion !== 'v1' ||
      version === undefined ||
      !isAtLeastVersion(version, MIN_CONTRACT)
    ) {
      throw new InternalApiClientError(
        'INCOMPATIBLE_CONTRACT',
        'The Internal API contract is incompatible with this MCP adapter.',
      );
    }
  }

  private async requestJson<T>(
    operation: string,
    method: 'GET' | 'POST',
    route: string,
    body: Record<string, unknown> | Record<string, string> | undefined,
    schema: z.ZodType<T>,
    options: RequestCallOptions,
  ): Promise<T> {
    const socketIdentity = await this.readSocketIdentity();
    let token: string;
    try {
      token = await readSecureToken(this.config.tokenPath);
    } catch (error) {
      if (error instanceof InternalApiClientError) throw error;
      throw asUnsafePathError();
    }

    const raw = await this.requestRaw(operation, method, route, token, body, socketIdentity, options);
    try {
      const afterRequest = await this.readSocketIdentity();
      assertSameIdentity(socketIdentity, afterRequest, 'Internal API socket');
    } catch {
      throw asUnsafePathError();
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw safeOperationError(operation, raw.status, raw.headers, raw.body);
    }
    const contentType = typeof raw.headers['content-type'] === 'string' ? raw.headers['content-type'] : '';
    if (!/\bjson\b/i.test(contentType)) throw asInvalidResponseError(operation);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      throw asInvalidResponseError(operation);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw asInvalidResponseError(operation);
    return result.data;
  }

  private async readSocketIdentity(): Promise<SecurePathIdentity> {
    try {
      return await assertSecureSocketPath(this.config.socketPath);
    } catch {
      throw asUnsafePathError();
    }
  }

  private async requestRaw(
    operation: string,
    method: 'GET' | 'POST',
    route: string,
    token: string,
    body: Record<string, unknown> | Record<string, string> | undefined,
    _socketIdentity: SecurePathIdentity,
    options: RequestCallOptions,
  ): Promise<RawResponse> {
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) {
      throw new InternalApiClientError('REQUEST_CANCELLED', 'Internal API request was cancelled.');
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await new Promise<RawResponse>((resolve, reject) => {
        let settled = false;

        const finish = (error?: InternalApiClientError, value?: RawResponse) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (error) reject(error);
          else resolve(value as RawResponse);
        };

        const abortRequest = () => {
          if (settled) return;
          req?.destroy();
          finish(new InternalApiClientError(
            options.signal?.aborted ? 'REQUEST_CANCELLED' : 'REQUEST_TIMEOUT',
            options.signal?.aborted ? 'Internal API request was cancelled.' : 'Internal API request timed out.',
            { retryable: !options.signal?.aborted },
          ));
        };

        controller.signal.addEventListener('abort', abortRequest, { once: true });
        const timer = setTimeout(abortRequest, this.config.timeoutMs);
        const requestOptions: RequestOptions = {
          socketPath: this.config.socketPath,
          path: route,
          method,
          headers: {
            Host: 'localhost',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`,
            ...(serializedBody === undefined ? {} : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(serializedBody, 'utf8'),
            }),
            ...(options.idempotencyKey === undefined ? {} : { 'Idempotency-Key': options.idempotencyKey }),
          },
          signal: controller.signal,
        };
        const req = request(requestOptions, (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buffer.byteLength;
            if (total > this.config.maxResponseBytes) {
              res.destroy();
              req?.destroy();
              finish(new InternalApiClientError('RESPONSE_TOO_LARGE', 'Internal API response exceeded the configured receive limit.'));
              return;
            }
            chunks.push(buffer);
          });
          res.once('error', (error) => {
            if (!settled) finish(asTransportError(operation, error));
          });
          res.once('end', () => {
            if (settled) return;
            finish(undefined, {
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        });
        req.once('error', (error) => {
          if (!settled) finish(asTransportError(operation, error));
        });
        if (serializedBody !== undefined) req.write(serializedBody);
        req.end();
      });
    } catch (error) {
      if (error instanceof InternalApiClientError) throw error;
      throw asTransportError(operation, error);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export { InternalApiClientError } from './errors.js';
export { runtimeSchema };
