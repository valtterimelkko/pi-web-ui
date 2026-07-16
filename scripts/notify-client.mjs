#!/usr/bin/env node
/* eslint-disable no-constant-condition -- bounded loops exit via deadline/process status */
/** Durable Internal-API notification client used by scripts/notify.sh. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, chmod, link, lstat, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const socketPath = process.env.PI_WEB_UI_NOTIFY_SOCKET
  ?? path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock');
const tokenPath = process.env.PI_WEB_UI_NOTIFY_TOKEN_FILE
  ?? path.join(os.homedir(), '.pi-web-ui', 'internal-api-token');
const spoolDir = process.env.PI_WEB_UI_NOTIFY_SPOOL_DIR
  ?? path.join(os.homedir(), '.pi-web-ui', 'notifications', 'ingress');
const waitMs = parseNonNegativeInt(process.env.PI_WEB_UI_NOTIFY_WAIT_MS, 30_000);
const retryMs = Math.max(10, parseNonNegativeInt(process.env.PI_WEB_UI_NOTIFY_RETRY_MS, 250));
const requestTimeoutMs = Math.max(100, parseNonNegativeInt(process.env.PI_WEB_UI_NOTIFY_REQUEST_TIMEOUT_MS, 5_000));
const idempotencyKey = process.env.PI_WEB_UI_NOTIFY_IDEMPOTENCY_KEY ?? randomUUID();
const maxSpoolFiles = 1000;
const maxSpoolBytes = 32 * 1024;
const spoolTtlMs = 7 * 24 * 60 * 60 * 1000;

class PermanentError extends Error {}

if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
  fail('notify: PI_WEB_UI_NOTIFY_IDEMPOTENCY_KEY must be 1-128 safe ASCII characters');
}

const input = await readStdinJson();
const payload = validatePayload(input);
const deadline = Date.now() + waitMs;
let lastRetryableError = 'Internal API unavailable';

while (true) {
  try {
    if (await isExpectedApiHealthy()) {
      const token = (await readFile(tokenPath, 'utf8')).trim();
      if (!token) throw new PermanentError(`notification token is empty: ${tokenPath}`);
      const response = await request({
        method: 'POST',
        requestPath: '/api/v1/notifications',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      if (response.status >= 200 && response.status < 300) {
        let statusUrl;
        try { statusUrl = JSON.parse(response.body)?.statusUrl; } catch { /* older compatible server */ }
        console.error(`notify: accepted (HTTP ${response.status})${statusUrl ? `; status ${statusUrl}` : ''} — ${payload.title}`);
        process.exit(0);
      }
      if (response.status >= 400 && response.status < 500
        && response.status !== 408 && response.status !== 429) {
        throw new PermanentError(`server returned HTTP ${response.status}${response.body ? ` — ${response.body.slice(0, 300)}` : ''}`);
      }
      lastRetryableError = `server returned HTTP ${response.status}`;
    }
  } catch (error) {
    if (error instanceof PermanentError) fail(`notify: ${error.message}`);
    lastRetryableError = error instanceof Error ? error.message : String(error);
  }

  if (Date.now() >= deadline) break;
  await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
}

try {
  const queuedPath = await spool({
    version: 1,
    idempotencyKey,
    ...payload,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + spoolTtlMs).toISOString(),
  });
  console.error(`notify: queued locally for retry (${lastRetryableError}) — ${queuedPath}`);
  process.exit(0);
} catch (error) {
  fail(`notify: Internal API unavailable and local queue failed — ${error instanceof Error ? error.message : String(error)}`);
}

async function isExpectedApiHealthy() {
  try {
    const info = await stat(socketPath);
    if (!info.isSocket()) return false;
    const response = await request({ method: 'GET', requestPath: '/api/v1/health' });
    if (response.status !== 200) return false;
    const parsed = JSON.parse(response.body);
    return parsed?.status === 'ok' && parsed?.contract?.name === 'pi-web-ui-internal-api';
  } catch {
    return false;
  }
}

function request({ method, requestPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 64 * 1024) chunks.push(chunk);
      });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error('Internal API request timed out')));
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function spool(record) {
  await mkdir(spoolDir, { recursive: true, mode: 0o700 });
  await chmod(spoolDir, 0o700);
  const fileName = `${createHash('sha256').update(idempotencyKey).digest('hex')}.json`;
  const existing = (await readdir(spoolDir)).filter((name) => name.endsWith('.json'));
  if (existing.length >= maxSpoolFiles && !existing.includes(fileName)) {
    throw new Error(`notification queue limit reached (${maxSpoolFiles})`);
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > maxSpoolBytes) throw new Error('notification exceeds local queue size limit');

  const destination = path.join(spoolDir, fileName);
  const temp = path.join(spoolDir, `.${fileName.slice(0, -5)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, destination);
      return destination;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxSpoolBytes) {
        throw new Error('idempotency conflict with unsafe existing local queue record');
      }
      const prior = JSON.parse(await readFile(destination, 'utf8'));
      const samePayload = prior?.idempotencyKey === record.idempotencyKey
        && prior?.title === record.title
        && prior?.body === record.body
        && (prior?.deepLink ?? undefined) === (record.deepLink ?? undefined);
      if (!samePayload) throw new Error('idempotency conflict with existing local queue record');
      return destination;
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('notify: failed to parse notification payload');
  }
}

function validatePayload(value) {
  if (!value || typeof value !== 'object') fail('notify: notification payload must be an object');
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const body = typeof value.body === 'string' ? value.body : '';
  const deepLink = typeof value.deepLink === 'string' ? value.deepLink.trim() : undefined;
  if (!title || title.length > 500) fail('notify: title must contain 1-500 characters');
  if (!body || body.length > 20_000) fail('notify: body must contain 1-20000 characters');
  if (deepLink && deepLink.length > 2000) fail('notify: deep link exceeds 2000 characters');
  return { title, body, ...(deepLink ? { deepLink } : {}) };
}

function parseNonNegativeInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) fail(`notify: invalid non-negative integer: ${raw}`);
  return Number(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
