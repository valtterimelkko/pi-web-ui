#!/usr/bin/env node
import { startMcpServer } from './server.js';

let closing = false;
let running: Awaited<ReturnType<typeof startMcpServer>> | undefined;

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await running?.close();
  } catch (error) {
    console.error('MCP server shutdown failed:', error instanceof Error ? error.message : 'unknown error');
  }
}

async function main(): Promise<void> {
  running = await startMcpServer();
  process.stdin.once('end', () => {
    void close().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void close().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void close().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error('MCP server failed to start:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
