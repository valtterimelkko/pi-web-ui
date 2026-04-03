import type { IncomingMessage } from 'http';
import type WebSocket from 'ws';
import { verifyToken } from '../security/auth.js';
import { terminalManager } from './terminal-manager.js';

function getClientId(_req: IncomingMessage): string {
  // Use a combination of timestamp + random suffix for uniqueness
  return `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function handleTerminalWebSocket(ws: WebSocket, req: IncomingMessage): void {
  // Authenticate via cookie
  const cookies = req.headers.cookie || '';
  const jwtMatch = cookies.match(/(?:^|;\s*)jwt=([^;]+)/);
  const token = jwtMatch?.[1];

  if (!token) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  try {
    verifyToken(token);
  } catch {
    ws.close(1008, 'Invalid token');
    return;
  }

  const clientId = getClientId(req);
  let termCreated = false;

  ws.on('message', (message: Buffer | string) => {
    // Check for JSON control messages
    const data = message.toString();

    if (data.startsWith('{')) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'create') {
          const cwd = msg.cwd || process.env.HOME || '/';
          const cols = msg.cols || 80;
          const rows = msg.rows || 24;
          const result = terminalManager.create(clientId, cwd, cols, rows);
          if (!result.success) {
            ws.send(JSON.stringify({ type: 'error', error: result.error }));
            return;
          }
          termCreated = true;
          ws.send(JSON.stringify({ type: 'created', info: result.info }));

          // Forward PTY output to WebSocket
          const emitter = terminalManager.getEmitter(clientId);
          if (emitter) {
            emitter.on('data', (output: string) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(output);
              }
            });
            emitter.on('exit', ({ exitCode }: { exitCode: number }) => {
              if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'exit', exitCode }));
              }
            });
          }
        } else if (msg.type === 'resize') {
          terminalManager.resize(clientId, msg.cols || 80, msg.rows || 24);
        } else if (msg.type === 'destroy') {
          terminalManager.destroy(clientId);
          termCreated = false;
        }
      } catch {
        // Not valid JSON - treat as terminal input
        if (termCreated) {
          terminalManager.write(clientId, data);
        }
      }
    } else {
      // Binary/text input - forward to PTY
      if (termCreated) {
        terminalManager.write(clientId, data);
      }
    }
  });

  ws.on('close', () => {
    terminalManager.destroy(clientId);
  });

  ws.on('error', () => {
    terminalManager.destroy(clientId);
  });

  // Send ready signal
  ws.send(JSON.stringify({ type: 'ready', available: terminalManager.isAvailable() }));
}
