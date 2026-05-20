import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import type {
  ApprovalResponseResult,
  CapabilitiesResponse,
  CreateSessionResponse,
  SendPromptRequest,
  SessionControlRequest,
  SessionDetail,
  SessionHistoryResponse,
} from '../internal-api/types.js';
import type { InternalApiClientLike, ValidationRuntime } from './types.js';

const DEFAULT_SOCKET_PATH = `${homedir()}/.pi-web-ui/internal-api.sock`;
const DEFAULT_TOKEN_PATH = `${homedir()}/.pi-web-ui/internal-api-token`;

function parseJsonResponse<T>(raw: string): T {
  if (!raw.trim()) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

function parseSse(raw: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const chunks = raw.split('\n\n').map((chunk) => chunk.trim()).filter(Boolean);
  for (const chunk of chunks) {
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
    if (eventType === 'complete') continue;
    const payload = dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : {};
    if (payload?.type) {
      events.push(payload as NormalizedEvent);
    } else {
      events.push({
        type: eventType,
        timestamp: Date.now(),
        data: payload,
      } as NormalizedEvent);
    }
  }
  return events;
}

export class InternalApiClient implements InternalApiClientLike {
  private readonly socketPath: string;
  private readonly token: string;

  constructor(options?: { socketPath?: string; tokenPath?: string; token?: string }) {
    this.socketPath = options?.socketPath ?? DEFAULT_SOCKET_PATH;
    this.token = options?.token ?? readFileSync(options?.tokenPath ?? DEFAULT_TOKEN_PATH, 'utf8').trim();
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
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
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(raw || `Internal API request failed: ${res.statusCode}`));
            return;
          }
          resolve(parseJsonResponse<T>(raw));
        });
      });
      req.on('error', reject);
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  async createSession(input: { runtime: ValidationRuntime; cwd?: string; model?: string; source?: string; scenarioId?: string; ephemeral?: boolean }): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>('POST', '/api/v1/sessions', input);
  }

  async promptStream(sessionId: string, input: SendPromptRequest): Promise<NormalizedEvent[]> {
    return new Promise((resolve, reject) => {
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
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(raw || `Prompt stream failed: ${res.statusCode}`));
            return;
          }
          resolve(parseSse(raw));
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify({ ...input, verbosity: input.verbosity ?? 'full' }));
      req.end();
    });
  }

  async getSessionInfo(sessionId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/info`);
  }

  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('GET', '/api/v1/capabilities');
  }

  async controlSession(sessionId: string, input: SessionControlRequest): Promise<unknown> {
    return this.request('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/control`, input);
  }

  async getSessionHistory(sessionId: string): Promise<SessionHistoryResponse> {
    return this.request<SessionHistoryResponse>('GET', `/api/v1/sessions/${encodeURIComponent(sessionId)}/history`);
  }

  async respondToApproval(sessionId: string, requestId: string, approved: boolean): Promise<ApprovalResponseResult> {
    return this.request<ApprovalResponseResult>('POST', `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(requestId)}/respond`, { approved });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }
}
