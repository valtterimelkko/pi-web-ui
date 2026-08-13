#!/usr/bin/env node
/**
 * Disposable Command Code browser-path validation over the authenticated
 * WebSocket used by the UI. The caller must provide a validation server base
 * URL; this script never starts or stops a server and never targets production
 * implicitly.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { access, stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const base = flag('base');
const validationDir = flag('validation-dir');
const cwd = flag('cwd', validationDir ? path.join(validationDir, 'workspace') : undefined);
const model = flag('model', 'qwen/qwen3.8-max');
const effort = flag('effort', 'medium');
const password = flag('password', process.env.WS_VALIDATE_PASSWORD ?? 'validation-pass');
const origin = flag('origin', 'https://tmux.letsautomate.work');
const timeoutMs = Number(flag('timeout', '90000'));

if (!base || !cwd) {
  console.error('Usage: npm run validate:commandcode:browser -- --base http://127.0.0.1:<port> --validation-dir <disposable-dir> [--password <password>]');
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout must be positive');

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ password }),
});
if (!login.ok) throw new Error(`WebSocket validation login failed: ${login.status} ${await login.text()}`);
const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin } });
const events = [];
let sessionId;

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms; events=${JSON.stringify(events)}`)), timeoutMs);
  const fail = (error) => { clearTimeout(timer); reject(error); };
  ws.on('error', fail);
  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'authenticated') {
      ws.send(JSON.stringify({ type: 'new_session', sdkType: 'commandcode', cwd, model, effort }));
      return;
    }
    if (message.type === 'error') {
      fail(new Error(`Command Code browser validation failed: ${message.code ?? 'UNKNOWN'} ${message.message ?? ''}`));
      return;
    }
    if (message.type === 'session_created') {
      sessionId = message.sessionPath;
      events.push({ type: 'session_created', sessionId, sdkType: message.sdkType, model: message.model, effort: message.effort });
      ws.send(JSON.stringify({ type: 'prompt', sessionId, message: 'Reply with the exact text COMMAND-CODE-BROWSER-LIVE-OK and nothing else.' }));
      return;
    }
    if (message.type !== 'session_event') return;
    const eventType = message.event?.type;
    if (['agent_start', 'message_start', 'message_update', 'message_end', 'agent_end'].includes(eventType)) {
      events.push({ type: eventType });
    }
    if (eventType === 'agent_end') {
      clearTimeout(timer);
      resolve({ sessionId, events });
    }
  });
});
ws.close();

const browserMarker = path.join(validationDir, 'command-code-native-home', sessionId, '.commandcode', 'browser-write-check');
const workspaceMarker = path.join(cwd, 'workspace-write-check');
await access(browserMarker);
let workspaceWriteSucceeded = false;
try { await access(workspaceMarker); workspaceWriteSucceeded = true; } catch { /* expected: read-only workspace */ }
const browserMode = (await stat(browserMarker)).mode & 0o777;
const report = {
  verdict: workspaceWriteSucceeded ? 'FAILED workspace was writable' : 'OK contained browser path',
  sessionId,
  model,
  effort,
  events,
  privateHomeMarker: browserMarker,
  privateHomeMode: browserMode.toString(8),
  workspaceMarker,
  workspaceWriteSucceeded,
};
console.log(JSON.stringify(report, null, 2));
process.exit(workspaceWriteSucceeded ? 1 : 0);
