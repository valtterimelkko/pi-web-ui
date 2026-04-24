import http from 'node:http';
import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeSSEEvent,
  OpenCodePermissionRule,
} from './opencode-types.js';

export class OpenCodeClient {
  private baseUrl: string;
  private authHeaders: Record<string, string>;

  constructor(baseUrl: string, authHeaders: Record<string, string>) {
    this.baseUrl = baseUrl;
    this.authHeaders = authHeaders;
  }

  private withDirectory(path: string, directory?: string): string {
    if (!directory) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}directory=${encodeURIComponent(directory)}`;
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.authHeaders,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenCode API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
    }
    return response;
  }

  async createSession(directory?: string, permission?: OpenCodePermissionRule[]): Promise<OpenCodeSession> {
    const response = await this.request(this.withDirectory('/session', directory), {
      method: 'POST',
      body: JSON.stringify(permission ? { permission } : {}),
    });
    return response.json() as Promise<OpenCodeSession>;
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    const response = await this.request('/session');
    return response.json() as Promise<OpenCodeSession[]>;
  }

  async getSession(id: string): Promise<OpenCodeSession> {
    const response = await this.request(`/session/${id}`);
    return response.json() as Promise<OpenCodeSession>;
  }

  async promptAsync(sessionId: string, directory: string, message: string, modelId?: string, agent?: string): Promise<void> {
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: message }],
    };

    if (modelId) {
      const [providerID, ...modelParts] = modelId.split('/');
      const resolvedModelID = modelParts.join('/');
      if (providerID && resolvedModelID) {
        body.model = { providerID, modelID: resolvedModelID };
      }
    }

    if (agent) {
      body.agent = agent;
    }

    await this.request(this.withDirectory(`/session/${sessionId}/prompt_async`, directory), {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async sendMessage(sessionId: string, message: string): Promise<unknown> {
    const response = await this.request(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text: message }] }),
    });
    return response.json();
  }

  async getMessages(sessionId: string, directory: string): Promise<OpenCodeMessage[]> {
    const response = await this.request(this.withDirectory(`/session/${sessionId}/message`, directory));
    return response.json() as Promise<OpenCodeMessage[]>;
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.request(this.withDirectory(`/session/${sessionId}/abort`, directory), { method: 'POST' });
  }

  async replyPermission(
    sessionId: string,
    directory: string,
    permissionId: string,
    approved: boolean,
    approveMode: 'once' | 'always' = 'always',
  ): Promise<void> {
    await this.request(this.withDirectory(`/session/${sessionId}/permissions/${permissionId}`, directory), {
      method: 'POST',
      body: JSON.stringify({ response: approved ? approveMode : 'reject' }),
    });
  }

  async getProviders(directory?: string): Promise<unknown> {
    const response = await this.request(this.withDirectory('/config/providers', directory));
    return response.json();
  }

  subscribeEvents(onEvent: (event: OpenCodeSSEEvent) => void, _directory?: string): () => void {
    const path = '/global/event';
    let aborted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentReq: http.ClientRequest | null = null;
    let eventCount = 0;

    const parsedUrl = new URL(this.baseUrl);

    const connect = () => {
      if (aborted) return;

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path,
        method: 'GET',
        headers: {
          ...this.authHeaders,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      };

      console.log('[OpenCodeSSE] Connecting to global event stream');

      const req = http.get(options, (res) => {
        if (res.statusCode !== 200) {
          console.error(`[OpenCodeSSE] Bad status ${res.statusCode}, reconnecting`);
          res.resume();
          if (!aborted) reconnectTimer = setTimeout(connect, 3000);
          return;
        }

        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const raw = JSON.parse(line.slice(6)) as { payload?: OpenCodeSSEEvent } | OpenCodeSSEEvent;
                const data = ('payload' in raw && raw.payload) ? raw.payload : raw as OpenCodeSSEEvent;
                eventCount++;
                onEvent(data);
              } catch (e) {
                console.error(`[OpenCodeSSE] Parse error:`, e instanceof Error ? e.message : String(e));
              }
            }
          }
        });

        res.on('end', () => {
          console.log(`[OpenCodeSSE] Stream ended after ${eventCount} events, reconnecting`);
          currentReq = null;
          if (!aborted) reconnectTimer = setTimeout(connect, 3000);
        });

        res.on('error', (err) => {
          console.error(`[OpenCodeSSE] Response error:`, err.message);
          currentReq = null;
          if (!aborted) reconnectTimer = setTimeout(connect, 3000);
        });
      });

      req.on('error', (err) => {
        console.error(`[OpenCodeSSE] Request error:`, err.message);
        currentReq = null;
        if (!aborted) reconnectTimer = setTimeout(connect, 3000);
      });

      currentReq = req;
    };

    connect();

    return () => {
      aborted = true;
      if (currentReq) {
        currentReq.destroy();
        currentReq = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }
}
