// Live proof for the bounded http-server close (child S, 2026-09-15).
// Reproduces the 2026-09-14 21:15:56 shape: server.close() with a client that
// is deliberately still connected.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { closeHttpServer } from '/root/pi-web-ui-wt-stability/server/src/http-server-close.js';

async function make(port: number) {
  const server = createServer((_req, res) => { res.end('ok'); });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return server;
}

async function main(): Promise<void> {
  // CONTROL: bare server.close() with a live client - the code that hung twice.
  const bare = await make(0);
  const barePort = (bare.address() as { port: number }).port;
  const bareClient = connect(barePort, '127.0.0.1');
  await new Promise<void>((r) => bareClient.on('connect', () => r()));
  const bareStart = Date.now();
  const bareOutcome = await Promise.race([
    new Promise<string>((r) => bare.close(() => r('closed'))),
    new Promise<string>((r) => setTimeout(() => r('STILL-PENDING'), 5_000)),
  ]);
  console.log(`CONTROL bare close() with a live client: ${bareOutcome} after ${Date.now() - bareStart}ms`);

  // FIX: the bounded close.
  const fixed = await make(0);
  const fixedPort = (fixed.address() as { port: number }).port;
  const fixedClient = connect(fixedPort, '127.0.0.1');
  await new Promise<void>((r) => fixedClient.on('connect', () => r()));
  const fixedStart = Date.now();
  const outcome = await closeHttpServer(fixed, { timeoutMs: 5_000 });
  console.log(`FIX    closeHttpServer() with the same live client: ${outcome} after ${Date.now() - fixedStart}ms`);

  bareClient.destroy();
  fixedClient.destroy();
  process.exit(0);
}
main();
