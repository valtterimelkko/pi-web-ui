import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/** Stop admission, allow a short grace period, then close persistent clients. */
export async function closeServerWithGrace(
  server: Server,
  sockets: Set<Socket>,
  graceMs: number,
): Promise<void> {
  if (!server.listening) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  timer = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, graceMs);
  timer.unref?.();

  try {
    await closed;
  } finally {
    if (timer) clearTimeout(timer);
    // Also close connections accepted immediately before server.close took effect.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  }
}
