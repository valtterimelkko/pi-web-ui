/**
 * Browser-like WebSocket client (parent amendment 2026-09-26, on by default):
 * one long-lived authenticated socket connected to `/ws` for the duration of
 * the run, exactly like a real browser tab left open — logs in via
 * POST /api/auth/login (cookie + JWT, same path a real browser uses),
 * connects with the matching Origin + Cookie headers the server's pre-upgrade
 * guard requires (`decideWsUpgrade`: origin allow-list + cookie JWT), and
 * reconnects with backoff on any drop. The server-to-browser broadcast path
 * is a known historical leak area (see docs), so keeping one attached
 * throughout matters for the heap question even though this client never
 * issues session actions itself.
 */
import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';

export interface BrowserWsClientOptions {
  port: number;
  password?: string;
  origin?: string;
  /** Base backoff for reconnect attempts; doubles up to a cap. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface BrowserWsClientStats {
  connected: boolean;
  connectCount: number;
  reconnectCount: number;
  messagesReceived: number;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  lastError?: string;
}

async function login(port: number, password: string): Promise<string> {
  const body = JSON.stringify({ password });
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const setCookie = res.headers['set-cookie'];
      const raw = setCookie?.find((c) => c.startsWith('accessToken='));
      if ((res.statusCode ?? 500) >= 400 || !raw) {
        let errBody = '';
        res.on('data', (d) => { errBody += d; });
        res.on('end', () => reject(new Error(`login failed: ${res.statusCode} ${errBody.slice(0, 200)}`)));
        return;
      }
      const token = raw.split(';')[0].split('=').slice(1).join('=');
      res.resume();
      resolve(token);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** One long-lived, reconnecting, authenticated WS client — like a browser tab left open. */
export class BrowserLikeWsClient {
  private ws: WebSocket | undefined;
  private closed = false;
  private backoffMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly stats: BrowserWsClientStats = { connected: false, connectCount: 0, reconnectCount: 0, messagesReceived: 0 };

  constructor(private readonly options: BrowserWsClientOptions) {
    this.backoffMs = options.baseBackoffMs ?? 1000;
  }

  async start(): Promise<void> {
    await this.connectOnce();
  }

  private async connectOnce(): Promise<void> {
    if (this.closed) return;
    try {
      const token = await login(this.options.port, this.options.password ?? 'dev-password');
      const origin = this.options.origin ?? 'http://localhost:3000';
      const ws = new WebSocket(`ws://127.0.0.1:${this.options.port}/ws`, {
        headers: { Origin: origin, Cookie: `accessToken=${token}` },
      });
      this.ws = ws;
      ws.on('open', () => {
        this.stats.connected = true;
        this.stats.connectCount += 1;
        this.stats.lastConnectedAt = new Date().toISOString();
        this.backoffMs = this.options.baseBackoffMs ?? 1000; // reset backoff on a good connection
      });
      ws.on('message', () => { this.stats.messagesReceived += 1; });
      ws.on('close', () => {
        this.stats.connected = false;
        this.stats.lastDisconnectedAt = new Date().toISOString();
        this.scheduleReconnect();
      });
      ws.on('error', (error) => {
        this.stats.lastError = error instanceof Error ? error.message : String(error);
      });
    } catch (error) {
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.stats.reconnectCount += 1;
    const maxBackoff = this.options.maxBackoffMs ?? 30_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectOnce().catch(() => { /* connectOnce already schedules its own retry */ });
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, maxBackoff);
  }

  getStats(): BrowserWsClientStats {
    return { ...this.stats };
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* best-effort */ }
  }
}
