import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeSSEEvent,
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

  async createSession(directory?: string): Promise<OpenCodeSession> {
    const response = await this.request(this.withDirectory('/session', directory), {
      method: 'POST',
      body: JSON.stringify({}),
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

  async promptAsync(sessionId: string, directory: string, message: string, modelId?: string): Promise<void> {
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

  async replyPermission(sessionId: string, directory: string, permissionId: string, approved: boolean): Promise<void> {
    await this.request(this.withDirectory(`/session/${sessionId}/permissions/${permissionId}`, directory), {
      method: 'POST',
      body: JSON.stringify({ response: approved ? 'once' : 'reject' }),
    });
  }

  async getProviders(directory?: string): Promise<unknown> {
    const response = await this.request(this.withDirectory('/config/providers', directory));
    return response.json();
  }

  subscribeEvents(onEvent: (event: OpenCodeSSEEvent) => void, directory?: string): () => void {
    const url = `${this.baseUrl}${this.withDirectory('/event', directory)}`;
    const headers: Record<string, string> = { ...this.authHeaders };

    let aborted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (aborted) return () => {};

      const controller = new AbortController();

      fetch(url, { headers, signal: controller.signal })
        .then(async (response) => {
          if (!response.ok || !response.body) {
            if (!aborted) reconnectTimer = setTimeout(connect, 3000);
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6)) as OpenCodeSSEEvent;
                  onEvent(data);
                } catch {
                  // ignore malformed SSE data
                }
              }
            }
          }

          if (!aborted) reconnectTimer = setTimeout(connect, 3000);
        })
        .catch(() => {
          if (!aborted) reconnectTimer = setTimeout(connect, 3000);
        });

      return () => { controller.abort(); };
    };

    const cleanup = connect();

    return () => {
      aborted = true;
      cleanup();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }
}
