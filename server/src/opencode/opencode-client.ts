import type {
  OpenCodeSession,
  OpenCodeMessage,
  OpenCodeSessionStatus,
  OpenCodeSSEEvent,
} from './opencode-types.js';

export class OpenCodeClient {
  private baseUrl: string;
  private authHeaders: Record<string, string>;

  constructor(baseUrl: string, authHeaders: Record<string, string>) {
    this.baseUrl = baseUrl;
    this.authHeaders = authHeaders;
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

  async createSession(): Promise<OpenCodeSession> {
    const response = await this.request('/session', { method: 'POST' });
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

  async getSessionStatus(id: string): Promise<OpenCodeSessionStatus> {
    const response = await this.request(`/session/${id}/status`);
    const data = await response.json() as { status: OpenCodeSessionStatus };
    return data.status;
  }

  async promptAsync(sessionId: string, message: string): Promise<void> {
    await this.request(`/session/${sessionId}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async sendMessage(sessionId: string, message: string): Promise<unknown> {
    const response = await this.request(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    return response.json();
  }

  async getMessages(sessionId: string): Promise<OpenCodeMessage[]> {
    const response = await this.request(`/session/${sessionId}/message`);
    return response.json() as Promise<OpenCodeMessage[]>;
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(`/session/${sessionId}/abort`, { method: 'POST' });
  }

  async replyPermission(sessionId: string, permissionId: string, approved: boolean): Promise<void> {
    await this.request(`/session/${sessionId}/permissions/${permissionId}`, {
      method: 'POST',
      body: JSON.stringify({ response: approved }),
    });
  }

  async getProviders(): Promise<unknown> {
    const response = await this.request('/config/providers');
    return response.json();
  }

  subscribeEvents(onEvent: (event: OpenCodeSSEEvent) => void): () => void {
    const url = `${this.baseUrl}/event`;
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
