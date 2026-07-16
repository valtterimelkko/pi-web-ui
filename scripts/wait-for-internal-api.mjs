#!/usr/bin/env node
/* eslint-disable no-constant-condition -- bounded loop exits via readiness deadline */
/** Wait for the expected Pi Web UI Internal API identity on a Unix socket. */
import { stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const socketPath = process.env.PI_WEB_UI_WAIT_SOCKET
  ?? path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock');
const timeoutMs = parseIntEnv('PI_WEB_UI_WAIT_TIMEOUT_MS', 60_000);
const intervalMs = Math.max(10, parseIntEnv('PI_WEB_UI_WAIT_INTERVAL_MS', 250));
const requestTimeoutMs = Math.max(50, parseIntEnv('PI_WEB_UI_WAIT_REQUEST_TIMEOUT_MS', 1000));
const deadline = Date.now() + timeoutMs;

while (true) {
  if (await isReady()) {
    process.stdout.write(JSON.stringify({ status: 'ready', socketPath }) + '\n');
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    console.error(`Internal API readiness timed out after ${timeoutMs}ms: ${socketPath}`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, deadline - Date.now())));
}

async function isReady() {
  try {
    if (!(await stat(socketPath)).isSocket()) return false;
    const response = await requestHealth();
    if (response.status !== 200) return false;
    const body = JSON.parse(response.body);
    return body?.status === 'ok' && body?.contract?.name === 'pi-web-ui-internal-api';
  } catch {
    return false;
  }
}

function requestHealth() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: '/api/v1/health',
      method: 'GET',
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error('health request timed out')));
    req.once('error', reject);
    req.end();
  });
}

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    console.error(`${name} must be a non-negative integer`);
    process.exit(64);
  }
  return Number(raw);
}
