import { request as httpRequest, type ClientRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  ApprovalResponseRequest,
  ApprovalResponseResult,
  CapabilitiesResponse,
  CreateSessionResponse,
  DeleteWatchResponse,
  ListSessionsResponse,
  ModelsResponse,
  PendingApprovalsResponse,
  PromptDispatchResponse,
  RefreshModelsResponse,
  RegisterWatchRequest,
  RunReceipt,
  SendPromptRequest,
  SessionControlRequest,
  SessionControlResponse,
  ThinkingLevel,
  SessionDetail,
  SessionEvidenceResponse,
  SessionHistoryResponse,
  CommandCodeRoleAttestationRequest,
  WaitResponse,
  WatchResponse,
} from '../internal-api/types.js';
import type { InternalApiClientLike, ValidationRuntime } from './types.js';

const DEFAULT_SOCKET_PATH = `${homedir()}/.pi-web-ui/internal-api.sock`;
const DEFAULT_TOKEN_PATH = `${homedir()}/.pi-web-ui/internal-api-token`;

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function setRequestTimeout(req: ClientRequest, timeoutMs: number, method: string, path: string): () => void {
  // ClientRequest#setTimeout measures socket inactivity. Validation needs an
  // absolute deadline so keepalive chunks cannot hold a run open forever.
  const timer = setTimeout(() => {
    req.destroy(new Error(`Internal API ${method} ${path} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  const clear = () => clearTimeout(timer);
  req.once('close', clear);
  return clear;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function createCommandCodeFixtureAttestation(secret: string, model: string, cwd: string): CommandCodeRoleAttestationRequest {
  const issuedAt = new Date().toISOString();
  const payload = {
    role: 'conductor-root' as const,
    model: model as CommandCodeRoleAttestationRequest['model'],
    ...(model === 'qwen/qwen3.8-max' ? { effort: 'medium' as const } : {}),
    cwd,
    worktreeRoot: cwd,
    leaseId: 'live-validation-fixture-lease',
    issuedAt,
  };
  const canonical = JSON.stringify(payload);
  return { ...payload, signature: createHmac('sha256', secret).update(canonical).digest('hex') };
}

function countEvents(events: NormalizedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    const requested = typeof event.type === 'string' ? event.type.slice(0, 80) : 'malformed';
    const key = Object.hasOwn(counts, requested) || Object.keys(counts).length < 50 ? requested : 'other';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export class InternalApiRequestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string | undefined,
    public readonly responseBody: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'InternalApiRequestError';
  }
}

function parseJsonResponse<T>(raw: string): T {
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function parseSseEvent(chunk: string): NormalizedEvent | null {
  const lines = chunk.split('\n');
  let eventType = 'message';
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (eventType === 'complete') return null;
  const payload = dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : {};
  if (payload?.type) {
    return payload as NormalizedEvent;
  }
  return {
    type: eventType,
    timestamp: Date.now(),
    data: payload,
  } as NormalizedEvent;
}

function parseSseCompletion(raw: string): { dispatchMode?: string } {
  const chunks = raw.split('\n\n').map((chunk) => chunk.trim()).filter(Boolean);
  for (const chunk of chunks) {
    if (!chunk.split('\n').some((line) => line.trim() === 'event: complete')) continue;
    const data = chunk.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    try {
      const parsed = JSON.parse(data) as { dispatchMode?: unknown };
      return typeof parsed.dispatchMode === 'string' ? { dispatchMode: parsed.dispatchMode } : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseSse(raw: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const chunks = raw.split('\n\n').map((chunk) => chunk.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const parsed = parseSseEvent(chunk);
    if (parsed) events.push(parsed);
  }
  return events;
}

export class InternalApiClient implements InternalApiClientLike {
  private readonly socketPath: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private readonly promptEvidence = new Map<string, { runId?: string; eventCounts: Record<string, number>; dispatchMode?: string }>();

  constructor(options?: {
    socketPath?: string;
    tokenPath?: string;
    token?: string;
    requestTimeoutMs?: number;
    promptTimeoutMs?: number;
  }) {
    this.socketPath = options?.socketPath ?? DEFAULT_SOCKET_PATH;
    this.token = options?.token ?? readFileSync(options?.tokenPath ?? DEFAULT_TOKEN_PATH, 'utf8').trim();
    this.requestTimeoutMs = positiveTimeout(options?.requestTimeoutMs, 30_000);
    this.promptTimeoutMs = positiveTimeout(options?.promptTimeoutMs, 5 * 60_000);
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    return new Promise((resolve, reject) => {
      let clearDeadline = () => {};
      const req = httpRequest({
        socketPath: this.socketPath,
        path,
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          clearDeadline();
          if ((res.statusCode ?? 500) >= 400) {
            let responseBody: unknown;
            try { responseBody = parseJsonResponse<unknown>(raw); } catch { responseBody = raw; }
            const body = responseBody && typeof responseBody === 'object' ? responseBody as Record<string, unknown> : undefined;
            reject(new InternalApiRequestError(
              res.statusCode ?? 500,
              typeof body?.code === 'string' ? body.code : undefined,
              responseBody,
              typeof body?.message === 'string' ? body.message : raw || `Internal API request failed: ${res.statusCode}`,
            ));
            return;
          }
          resolve(parseJsonResponse<T>(raw));
        });
      });
      clearDeadline = setRequestTimeout(req, timeoutMs, method, path);
      req.on('error', (error) => {
        clearDeadline();
        reject(error);
      });
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async createSession(input: { runtime: ValidationRuntime; cwd?: string; model?: string; thinkingLevel?: ThinkingLevel; source?: string; scenarioId?: string; ephemeral?: boolean; pin?: boolean; pinTtlSeconds?: number; invocationRole?: 'conductor-root' | 'implementation-child'; commandCodeAttestation?: CommandCodeRoleAttestationRequest }): Promise<CreateSessionResponse> {
    const request = { ...input } as typeof input & { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; invocationRole?: 'conductor-root'; commandCodeAttestation?: CommandCodeRoleAttestationRequest };
    if (input.runtime === 'commandcode' && input.source === 'live-validation-commandcode-fixture') {
      const cwd = input.cwd ?? process.cwd();
      const model = input.model ?? 'qwen/qwen3.8-max';
      request.model = model;
      if (model === 'qwen/qwen3.8-max') request.effort = 'medium';
      request.invocationRole = 'conductor-root';
      request.commandCodeAttestation = createCommandCodeFixtureAttestation(this.token, model, cwd);
    }
    return this.request<CreateSessionResponse>('POST', '/api/v1/sessions', request);
  }

  /** Detached (fire-and-forget) prompt dispatch: returns 202 immediately; the
   * turn keeps running server-side. Read results later via getSessionInfo(). */
  async promptDetached(sessionId: string, message: string): Promise<{ sessionId: string; runId: string; detached: boolean; status: string }> {
    this.promptEvidence.delete(sessionId);
    const result = await this.request<{ sessionId: string; runId: string; detached: boolean; status: string }>(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`,
      { message, verbosity: 'answers', detach: true },
    );
    this.promptEvidence.set(sessionId, { runId: result.runId, eventCounts: {} });
    return result;
  }

  async promptStream(sessionId: string, input: SendPromptRequest): Promise<NormalizedEvent[]> {
    this.promptEvidence.delete(sessionId);
    return new Promise((resolve, reject) => {
      let clearDeadline = () => {};
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-Verbosity': input.verbosity ?? 'full',
        },
      }, (res) => {
        const runId = headerValue(res.headers['x-run-id']);
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          clearDeadline();
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(raw || `Prompt stream failed: ${res.statusCode}`));
            return;
          }
          const events = parseSse(raw);
          const completion = parseSseCompletion(raw);
          this.promptEvidence.set(sessionId, { runId, eventCounts: countEvents(events), ...completion });
          resolve(events);
        });
      });
      clearDeadline = setRequestTimeout(req, this.promptTimeoutMs, 'POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`);
      req.on('error', (error) => {
        clearDeadline();
        reject(error);
      });
      req.write(JSON.stringify({ ...input, verbosity: input.verbosity ?? 'full' }));
      req.end();
    });
  }

  async getSessionInfo(sessionId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/info`);
  }

  async getSessionEvidence(sessionId: string, expand: string[] = []): Promise<SessionEvidenceResponse> {
    const allowed = new Set(['diagnostics', 'transcript', 'screen', 'runs']);
    const values = [...new Set(expand.filter((value) => allowed.has(value)))];
    const query = values.length > 0 ? `?expand=${encodeURIComponent(values.join(','))}` : '';
    return this.request<SessionEvidenceResponse>(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/evidence${query}`,
    );
  }

  /**
   * Stream a prompt, invoking `onEvent` for each parsed SSE event as soon as it
   * arrives. Required for mid-turn interactions (e.g. answering an
   * AskUserQuestion) that block the turn until resolved: the buffered
   * {@link promptStream} would deadlock waiting for the turn to end.
   */
  async promptStreamLive(
    sessionId: string,
    input: SendPromptRequest,
    onEvent: (event: NormalizedEvent) => void,
  ): Promise<NormalizedEvent[]> {
    this.promptEvidence.delete(sessionId);
    return new Promise((resolve, reject) => {
      let clearDeadline = () => {};
      const req = httpRequest({
        socketPath: this.socketPath,
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-Verbosity': input.verbosity ?? 'full',
        },
      }, (res) => {
        const runId = headerValue(res.headers['x-run-id']);
        if ((res.statusCode ?? 500) >= 400) {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk.toString(); });
          res.on('end', () => {
            clearDeadline();
            reject(new Error(raw || `Prompt stream failed: ${res.statusCode}`));
          });
          return;
        }
        const events: NormalizedEvent[] = [];
        let dispatchMode: string | undefined;
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          // SSE events are separated by a blank line (\n\n). Emit each complete
          // event immediately so a consumer can react mid-turn.
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const rawChunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            dispatchMode ??= parseSseCompletion(`${rawChunk}\n\n`).dispatchMode;
            const parsed = parseSseEvent(rawChunk.trim());
            if (parsed) {
              events.push(parsed);
              try { onEvent(parsed); } catch { /* consumer error is non-fatal to the stream */ }
            }
          }
        });
        res.on('end', () => {
          clearDeadline();
          this.promptEvidence.set(sessionId, { runId, eventCounts: countEvents(events), ...(dispatchMode ? { dispatchMode } : {}) });
          resolve(events);
        });
      });
      clearDeadline = setRequestTimeout(req, this.promptTimeoutMs, 'POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`);
      req.on('error', (error) => {
        clearDeadline();
        reject(error);
      });
      req.write(JSON.stringify({ ...input, verbosity: input.verbosity ?? 'full' }));
      req.end();
    });
  }

  getLastPromptEvidence(sessionId: string): { runId?: string; eventCounts: Record<string, number>; dispatchMode?: string } | undefined {
    const evidence = this.promptEvidence.get(sessionId);
    return evidence ? { ...evidence, eventCounts: { ...evidence.eventCounts } } : undefined;
  }

  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('GET', '/api/v1/capabilities');
  }

  /** Fetch the live model list across all (or one) runtime. */
  async getModels(runtime?: string): Promise<ModelsResponse> {
    const query = runtime ? `?runtime=${runtime}` : '';
    return this.request<ModelsResponse>('GET', `/api/v1/models${query}`);
  }

  async refreshOpenCodeModels(input: { warmCache?: boolean; recycle?: boolean } = {}): Promise<RefreshModelsResponse> {
    return this.request<RefreshModelsResponse>('POST', '/api/v1/models/refresh', input);
  }

  /**
   * Refresh the Pi runtime's OpenRouter catalogue (fetch + cache + register) and
   * return a snapshot diff. Drives the weekly automation; safe to call ad hoc.
   */
  async refreshPiOpenRouterModels(): Promise<RefreshModelsResponse> {
    return this.request<RefreshModelsResponse>('POST', '/api/v1/models/refresh', { runtime: 'pi' });
  }

  async controlSession(sessionId: string, input: SessionControlRequest): Promise<unknown> {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/control`, input);
  }

  async getSessionHistory(sessionId: string): Promise<SessionHistoryResponse> {
    return this.request<SessionHistoryResponse>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/history`);
  }

  async respondToApproval(sessionId: string, requestId: string, body: ApprovalResponseRequest): Promise<ApprovalResponseResult> {
    return this.request<ApprovalResponseResult>(
      'POST',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}/respond`,
      body,
    );
  }

  async getPendingApprovals(sessionId: string): Promise<PendingApprovalsResponse> {
    return this.request<PendingApprovalsResponse>(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/pending`,
    );
  }

  async getCapacity(): Promise<{ activeTurns: number; stalledRuns: number; [key: string]: unknown }> {
    return this.request('GET', '/api/v1/capacity');
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async optInNotifications(sessionId: string, label?: string): Promise<unknown> {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/notifications/opt-in`, label ? { label } : {});
  }

  async getNotificationState(sessionId: string): Promise<{ optIn: unknown; deliveries: unknown[] }> {
    return this.request<{ optIn: unknown; deliveries: unknown[] }>(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/notifications`,
    );
  }

  // ─── Long-horizon validation surface ──────────────────────────────────────

  async listSessions(): Promise<ListSessionsResponse> {
    return this.request<ListSessionsResponse>('GET', '/api/v1/sessions');
  }

  /** Answers-mode prompt (non-streaming), including idempotent replay responses. */
  async prompt(sessionId: string, input: SendPromptRequest): Promise<PromptDispatchResponse> {
    this.promptEvidence.delete(sessionId);
    const result = await this.request<PromptDispatchResponse>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      ...input,
      verbosity: input.verbosity ?? 'answers',
    });
    this.promptEvidence.set(sessionId, { runId: result.runId, eventCounts: {} });
    return result;
  }

  async promptWithIdempotency(
    sessionId: string,
    input: SendPromptRequest,
  ): Promise<PromptDispatchResponse> {
    return this.prompt(sessionId, input);
  }

  async getRunReceipt(runId: string): Promise<RunReceipt> {
    return this.request<RunReceipt>('GET', `/api/v1/runs/${encodeURIComponent(runId)}`);
  }

  async pinSession(sessionId: string): Promise<SessionControlResponse> {
    return this.request<SessionControlResponse>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/control`, { action: 'pin' } satisfies SessionControlRequest);
  }

  async waitForStatus(sessionId: string, status: 'idle' | 'running' = 'idle', timeoutMs = 60000): Promise<WaitResponse> {
    return this.request<WaitResponse>(
      'GET',
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/wait?status=${status}&timeout=${timeoutMs}`,
      undefined,
      Math.max(this.requestTimeoutMs, timeoutMs + 5_000),
    );
  }

  async registerWatch(sessionId: string, body: RegisterWatchRequest): Promise<WatchResponse> {
    return this.request<WatchResponse>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`, body);
  }

  async getWatch(sessionId: string, sinceIndex?: number): Promise<WatchResponse> {
    const qs = sinceIndex && sinceIndex > 0 ? `?sinceIndex=${sinceIndex}` : '';
    return this.request<WatchResponse>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch${qs}`);
  }

  async deleteWatch(sessionId: string): Promise<DeleteWatchResponse> {
    return this.request<DeleteWatchResponse>('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}/watch`);
  }
}
