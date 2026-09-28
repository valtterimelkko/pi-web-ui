/**
 * B1.2 lag reproduction — browser-like WebSocket driver.
 *
 * Reproduces the observed production activity shape: a browser tab connects
 * with cookie+JWT, asks for the session list once, then switches between many
 * distinct sessions in rapid succession (the 3 → 20 resident-session jump in
 * the A2 telemetry was 17 switches in about a minute, across 10–16 distinct
 * cwds). Nothing here is runtime-specific or model-driven: every switch is a
 * pure session-open/replay operation, exactly the path the spikes overlap.
 *
 * Uses the authenticated browser path (`/api/auth/login` → `/ws`) rather than
 * the Internal API, because the stalls were seen with 0–3 active API turns.
 */

import { request as httpRequest } from 'node:http';
import WebSocket from 'ws';

export interface BrowserLoadOptions {
  port: number;
  password?: string;
  origin?: string;
  /** Session paths to round-robin (the synthetic corpus). */
  sessionPaths: string[];
  cycles: number;
  sessionsPerCycle: number;
  /** Pause between two switches inside a cycle (default 75 ms). */
  gapMs?: number;
  /** Pause between cycles (default 150 ms). */
  idleMs?: number;
  /** Per-switch acknowledgement timeout (default 45 s). */
  switchTimeoutMs?: number;
}

export interface BrowserLoadResult {
  /** send(get_sessions) → sessions_list wall time; the one-off list-cache warm-up. */
  getSessionsMs: number;
  listSize: number;
  switchesAcknowledged: number;
  switchErrors: string[];
  /** send(switch_session) → session_switched wall time, in order. */
  switchLatencyMs: number[];
  cyclesCompleted: number;
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
      res.resume();
      resolve(raw.split(';')[0].split('=').slice(1).join('='));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function runBrowserLoad(options: BrowserLoadOptions): Promise<BrowserLoadResult> {
  const gapMs = options.gapMs ?? 75;
  const idleMs = options.idleMs ?? 150;
  const switchTimeoutMs = options.switchTimeoutMs ?? 45_000;
  const password = options.password ?? 'dev-password';
  const origin = options.origin ?? 'http://localhost:3000';

  const token = await login(options.port, password);
  const ws = new WebSocket(`ws://127.0.0.1:${options.port}/ws`, {
    headers: { Origin: origin, Cookie: `accessToken=${token}` },
  });

  const result: BrowserLoadResult = {
    getSessionsMs: 0,
    listSize: 0,
    switchesAcknowledged: 0,
    switchErrors: [],
    switchLatencyMs: [],
    cyclesCompleted: 0,
  };

  // A single pending waiter: the driver is intentionally sequential (a browser
  // sends the next switch after the previous switch settles).
  let pending: ((message: Record<string, unknown>) => void) | undefined;
  ws.on('message', (data) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }
    pending?.(message);
  });

  const waitFor = (predicate: (message: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = undefined;
        reject(new Error(`timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending = (message) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        pending = undefined;
        resolve(message);
      };
    });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket open timed out')), 15_000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    });

    // 1. Warm-up list request — exactly what a browser sends on connect.
    const listStarted = Date.now();
    ws.send(JSON.stringify({ type: 'get_sessions' }));
    const list = await waitFor((m) => m.type === 'sessions_list', 120_000);
    result.getSessionsMs = Date.now() - listStarted;
    result.listSize = Array.isArray(list.sessions) ? (list.sessions as unknown[]).length : 0;

    // 2. Rapid switching across distinct cwds.
    const paths = options.sessionPaths;
    let cursor = 0;
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      for (let i = 0; i < options.sessionsPerCycle && i < paths.length; i += 1) {
        const sessionPath = paths[cursor % paths.length];
        cursor += 1;
        const started = Date.now();
        ws.send(JSON.stringify({ type: 'switch_session', sessionPath }));
        try {
          const reply = await waitFor(
            (m) => m.type === 'session_switched' || (m.type === 'error' && (m as { code?: string }).code !== undefined),
            switchTimeoutMs,
          );
          if (reply.type === 'error') {
            result.switchErrors.push(`${sessionPath}: ${String((reply as { message?: unknown }).message)}`);
          } else {
            result.switchesAcknowledged += 1;
            result.switchLatencyMs.push(Date.now() - started);
          }
        } catch (error) {
          result.switchErrors.push(`${sessionPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      result.cyclesCompleted += 1;
      if (idleMs > 0) await new Promise((resolve) => setTimeout(resolve, idleMs));
    }
  } finally {
    try { ws.close(); } catch { /* best-effort */ }
  }

  return result;
}
