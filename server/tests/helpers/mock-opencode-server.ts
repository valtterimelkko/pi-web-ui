import http from 'http';

export interface MockOpenCodeServerConfig {
  port: number;
  password?: string;
}

export class MockOpenCodeServer {
  private server: http.Server;
  private port: number;
  private password: string;
  private sessions: Map<string, {
    id: string;
    status: 'idle' | 'busy';
    messages: Array<{
      info: { id: string; sessionID: string; role: string; time: { created: number } };
      parts: Array<{ type: string; id: string; sessionID: string; messageID: string; text?: string; toolName?: string; args?: unknown; result?: unknown }>;
    }>;
  }> = new Map();
  private pendingPermissions: Map<string, { id: string; sessionId: string; toolName: string; status: string }> = new Map();
  private sseClients: Array<http.ServerResponse> = [];
  private requestLog: Array<{ method: string; url: string; body?: unknown }> = [];

  constructor(config: MockOpenCodeServerConfig) {
    this.port = config.port;
    this.password = config.password ?? '';

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.password) {
      const auth = req.headers.authorization;
      const expected = `Basic ${Buffer.from(`:${this.password}`).toString('base64')}`;
      if (auth !== expected) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      this.requestLog.push({ method: req.method ?? 'GET', url: req.url ?? '/', body: parsed });

      this.route(req, res, parsed);
    });
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
    const rawUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const url = rawUrl.split('?')[0];

    if ((url === '/event' || url === '/global/event') && method === 'GET') {
      this.handleSSE(req, res);
      return;
    }

    if (url === '/session' && method === 'GET') {
      this.json(res, Array.from(this.sessions.values()));
      return;
    }

    if (url === '/session' && method === 'POST') {
      const id = `oc-mock-${Date.now()}`;
      this.sessions.set(id, { id, status: 'idle', messages: [] });
      this.json(res, {
        id,
        slug: `mock-${id}`,
        version: '1',
        projectID: 'mock-project',
        directory: '/tmp',
        title: 'Mock Session',
        time: { created: Date.now(), updated: Date.now() },
      });
      return;
    }

    const sessionMatch = url.match(/^\/session\/([^/]+)$/);
    if (sessionMatch && method === 'GET') {
      const session = this.sessions.get(sessionMatch[1]);
      if (!session) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      this.json(res, { id: session.id, slug: session.id, version: '1', projectID: 'p', directory: '/tmp', title: 'Mock', time: { created: Date.now(), updated: Date.now() } });
      return;
    }

    const messageMatch = url.match(/^\/session\/([^/]+)\/message$/);
    if (messageMatch) {
      const sessionId = messageMatch[1];
      const session = this.sessions.get(sessionId);

      if (method === 'GET') {
        this.json(res, session?.messages ?? []);
        return;
      }

      if (method === 'POST') {
        const userMsgId = `msg-user-${Date.now()}`;
        const assistantMsgId = `msg-assistant-${Date.now()}`;
        const text = (body as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? 'test';

        session?.messages.push({
          info: { id: userMsgId, sessionID: sessionId, role: 'user', time: { created: Date.now() } },
          parts: [{ type: 'text', id: `p-${userMsgId}`, sessionID: sessionId, messageID: userMsgId, text }],
        });

        session?.messages.push({
          info: { id: assistantMsgId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
          parts: [{ type: 'text', id: `p-${assistantMsgId}`, sessionID: sessionId, messageID: assistantMsgId, text: `Response to: ${text}` }],
        });

        this.json(res, {});
        return;
      }
    }

    const promptAsyncMatch = url.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (promptAsyncMatch && method === 'POST') {
      const sessionId = promptAsyncMatch[1];
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'busy';
        const text = (body as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? 'test';

        const userMsgId = `msg-user-${Date.now()}`;
        const assistantMsgId = `msg-assistant-${Date.now()}`;

        session.messages.push({
          info: { id: userMsgId, sessionID: sessionId, role: 'user', time: { created: Date.now() } },
          parts: [{ type: 'text', id: `p-${userMsgId}`, sessionID: sessionId, messageID: userMsgId, text }],
        });

        this.emitSSE({
          type: 'message.updated',
          properties: { sessionId, info: { id: userMsgId, role: 'user' } },
        });

        this.emitSSE({
          type: 'message.updated',
          properties: { sessionId, info: { id: userMsgId, role: 'user', finish: 'stop' } },
        });

        setTimeout(() => {
          this.emitSSE({
            type: 'message.updated',
            properties: { sessionId, info: { id: assistantMsgId, role: 'assistant' } },
          });

          session.messages.push({
            info: { id: assistantMsgId, sessionID: sessionId, role: 'assistant', time: { created: Date.now() } },
            parts: [{ type: 'text', id: `p-${assistantMsgId}`, sessionID: sessionId, messageID: assistantMsgId, text: `Echo: ${text}` }],
          });

          this.emitSSE({
            type: 'message.part.delta',
            properties: { sessionId, messageID: assistantMsgId, delta: `Echo: ${text}` },
          });

          this.emitSSE({
            type: 'message.updated',
            properties: { sessionId, info: { id: assistantMsgId, role: 'assistant', finish: 'stop' } },
          });

          session.status = 'idle';
          this.emitSSE({
            type: 'session.idle',
            properties: { sessionId },
          });
        }, 50);
      }
      this.json(res, {});
      return;
    }

    const abortMatch = url.match(/^\/session\/([^/]+)\/abort$/);
    if (abortMatch && method === 'POST') {
      const sessionId = abortMatch[1];
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'idle';
        this.emitSSE({ type: 'session.idle', properties: { sessionId } });
      }
      this.json(res, {});
      return;
    }

    const permMatch = url.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
    if (permMatch && method === 'POST') {
      const [, sessionId, permId] = permMatch;
      const approved = (body as { response?: boolean })?.response ?? false;
      const perm = this.pendingPermissions.get(permId);
      if (perm) {
        perm.status = approved ? 'approved' : 'denied';
      }
      this.json(res, {});
      return;
    }

    if (url === '/config/providers') {
      this.json(res, []);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  }

  private handleSSE(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    this.sseClients.push(res);
    res.write(':ok\n\n');
  }

  emitSSE(event: unknown): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(data); } catch { /* client disconnected */ }
    }
  }

  private json(res: http.ServerResponse, body: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  addPendingPermission(id: string, sessionId: string, toolName: string): void {
    this.pendingPermissions.set(id, { id, sessionId, toolName, status: 'pending' });
    this.emitSSE({
      type: 'permission.updated',
      properties: {
        sessionId,
        permission: { id, status: 'pending', tool: toolName, metadata: { toolName } },
      },
    });
  }

  getRequests(): Array<{ method: string; url: string; body?: unknown }> {
    return this.requestLog;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients = [];
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
