import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import type { ChannelEvent } from '../../src/claude/claude-channel-ws-client.js';

export interface MockClaudeChannelServerConfig {
  wsPort: number;
  hookPort: number;
}

interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  resolve: (allowed: boolean) => void;
}

export class MockClaudeChannelServer {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private wsPort: number;
  private hookPort: number;
  private clients: Set<WebSocket> = new Set();
  private receivedMessages: Array<{ type: string; [key: string]: unknown }> = [];
  private pendingPermissions: Map<string, PendingPermission> = new Map();

  constructor(config: MockClaudeChannelServerConfig) {
    this.wsPort = config.wsPort;
    this.hookPort = config.hookPort;

    this.wss = new WebSocketServer({ port: this.wsPort });

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        ws.on('message', (data) => {
          try {
            const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
            this.receivedMessages.push(parsed);
            if (parsed.type === 'permission_response') {
              const pending = this.pendingPermissions.get(parsed.requestId as string);
              if (pending) {
                this.pendingPermissions.delete(parsed.requestId as string);
                pending.resolve(parsed.allowed as boolean);
              }
            }
          } catch { /* ignore */ }
        });
        ws.on('close', () => {
          this.clients.delete(ws);
        });
      });
      resolve();
    });

    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.hookPort, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => { this.wss.close(() => resolve()); });
    await new Promise<void>((resolve) => { this.httpServer.close(() => resolve()); });
  }

  simulateReply(sessionId: string, text: string): void {
    this.emitEvent({ type: 'message_start', sessionId, message: { id: `msg-${Date.now()}`, role: 'assistant' } });
    this.emitEvent({ type: 'message_update', sessionId, message: { id: `msg-${Date.now()}` }, assistantMessageEvent: { type: 'text_delta', delta: text } });
    this.emitEvent({ type: 'message_end', sessionId, message: { id: `msg-${Date.now()}` } });
  }

  simulateToolUse(sessionId: string, toolName: string, args: Record<string, unknown>): void {
    const toolCallId = `tool-${Date.now()}`;
    this.emitEvent({ type: 'tool_execution_start', sessionId, toolCallId, toolName, args });
    this.emitEvent({
      type: 'tool_execution_end',
      sessionId,
      toolCallId,
      result: { content: [{ type: 'text', text: `Result of ${toolName}` }] },
      isError: false,
    });
  }

  simulateAgentEnd(sessionId: string, usage?: Record<string, number>): void {
    this.emitEvent({
      type: 'agent_end',
      sessionId,
      result: 'success',
      usage: usage ?? { input_tokens: 100, output_tokens: 50 },
    });
  }

  simulatePermissionRequest(sessionId: string, toolName: string): Promise<boolean> {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.emitEvent({
      type: 'permission_request',
      sessionId,
      requestId,
      toolName,
      description: `Allow ${toolName}?`,
      args: {},
    });

    return new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestId, { requestId, sessionId, toolName, resolve });

      setTimeout(() => {
        if (this.pendingPermissions.has(requestId)) {
          this.pendingPermissions.delete(requestId);
          resolve(false);
        }
      }, 5000);
    });
  }

  simulateError(sessionId: string, message: string): void {
    this.emitEvent({ type: 'error', sessionId, message });
  }

  private emitEvent(event: ChannelEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  getReceivedMessages(): Array<{ type: string; [key: string]: unknown }> {
    return [...this.receivedMessages];
  }

  clearReceivedMessages(): void {
    this.receivedMessages = [];
  }

  private handleHttpRequest(_req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }
}
