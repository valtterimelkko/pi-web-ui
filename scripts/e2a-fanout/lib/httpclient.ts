/** Minimal Internal API client over a unix socket (GET only, bearer token). */
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

export interface SocketConn {
  socketPath: string;
  tokenPath: string;
}

export function readToken(conn: SocketConn): string {
  return readFileSync(conn.tokenPath, 'utf8').trim();
}

export function getJson(conn: SocketConn, path: string, timeoutMs = 5000): Promise<{ status: number; body: unknown }> {
  const token = readToken(conn);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: conn.socketPath,
        path,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: text });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${String(timeoutMs)}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function getCapacity(conn: SocketConn): Promise<Record<string, unknown> | null> {
  try {
    const { status, body } = await getJson(conn, '/api/v1/capacity');
    if (status !== 200 || typeof body !== 'object' || body === null) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}
