#!/usr/bin/env node
/**
 * Disposable Command Code browser-path validation over the authenticated
 * WebSocket used by the UI. The caller must provide a validation server base
 * URL; this script never starts or stops a server and never targets production
 * implicitly.
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { assertBrowserInternalApiIsolation, assertBrowserWebSocketEvidence } from './command-code-browser-validation.mjs';

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
const hasEffortFlag = process.argv.includes('--effort');
const effort = flag('effort', model === 'meta/muse-spark-1.2-contributor' ? undefined : 'medium');
const expectedText = flag('expected-text', model === 'meta/muse-spark-1.2-contributor' ? 'MUSE-LIVE-OK' : 'COMMAND-CODE-BROWSER-LIVE-OK');
if (model === 'meta/muse-spark-1.2-contributor' && hasEffortFlag) {
  throw new Error('Muse does not support native effort; omit --effort');
}
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
let availability;
let created;
let assistantText = '';

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms; events=${JSON.stringify(events)}`)), timeoutMs);
  const fail = (error) => { clearTimeout(timer); reject(error); };
  ws.on('error', fail);
  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'commandcode_available') {
      availability = message;
      return;
    }
    if (message.type === 'authenticated') {
      ws.send(JSON.stringify({
        type: 'new_session', sdkType: 'commandcode', cwd, model,
        ...(effort === undefined ? {} : { effort }),
      }));
      return;
    }
    if (message.type === 'error') {
      fail(new Error(`Command Code browser validation failed: ${message.code ?? 'UNKNOWN'} ${message.message ?? ''}`));
      return;
    }
    if (message.type === 'session_created') {
      created = message;
      sessionId = message.sessionPath;
      events.push({ type: 'session_created', sessionId, sdkType: message.sdkType, model: message.model, effort: message.effort });
      ws.send(JSON.stringify({ type: 'prompt', sessionId, message: `Reply with the exact text ${expectedText} and nothing else.` }));
      return;
    }
    if (message.type !== 'session_event') return;
    const event = message.event ?? {};
    const eventType = event.type;
    if (['agent_start', 'message_start', 'message_update', 'message_end', 'agent_end'].includes(eventType)) {
      events.push({ type: eventType });
    }
    if (eventType === 'message_update') {
      const assistant = event.assistantMessageEvent;
      if (assistant?.type === 'text_delta' && typeof assistant.delta === 'string') assistantText += assistant.delta;
    }
    if (eventType === 'agent_end') {
      clearTimeout(timer);
      resolve({ sessionId, events });
    }
  });
});
ws.close();

let replaySession;
const replayAssistantText = await new Promise((resolve, reject) => {
  const replayWs = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin } });
  let text = '';
  const timer = setTimeout(() => {
    replayWs.close();
    reject(new Error(`timed out waiting for browser replay history for ${sessionId}`));
  }, Math.min(timeoutMs, 30000));
  const finish = () => {
    clearTimeout(timer);
    replayWs.close();
    resolve(text);
  };
  replayWs.on('error', (error) => { clearTimeout(timer); reject(error); });
  replayWs.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'authenticated') {
      replayWs.send(JSON.stringify({ type: 'switch_session', sessionPath: sessionId }));
      return;
    }
    if (message.type === 'session_switched') {
      replaySession = message;
      return;
    }
    if (message.type === 'session_event') {
      const event = message.event ?? {};
      const assistant = event.assistantMessageEvent;
      if (event.type === 'message_update' && assistant?.type === 'text_delta' && typeof assistant.delta === 'string') text += assistant.delta;
      return;
    }
    if (message.type === 'history_end') finish();
    if (message.type === 'error') {
      clearTimeout(timer);
      replayWs.close();
      reject(new Error(`Command Code browser replay failed: ${message.message ?? 'unknown error'}`));
    }
  });
});

const browserMarker = path.join(validationDir, 'command-code-native-home', sessionId, '.commandcode', 'browser-write-check');
const workspaceMarker = path.join(cwd, 'workspace-write-check');
await access(browserMarker);
let workspaceWriteSucceeded = false;
try { await access(workspaceMarker); workspaceWriteSucceeded = true; } catch { /* expected: read-only workspace */ }
const browserMode = (await stat(browserMarker)).mode & 0o777;
const websocketEvidence = { availability, created, replaySession, events, assistantText, replayAssistantText };
assertBrowserWebSocketEvidence(websocketEvidence, { model, effort, expectedText });
if (workspaceWriteSucceeded) throw new Error('Command Code browser containment failed: workspace is writable');

const token = (await import('node:fs/promises')).readFile;
const tokenValue = (await token(path.join(validationDir, 'internal-api-token'), 'utf8')).trim();
function internalRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({
      socketPath: path.join(validationDir, 'internal-api.sock'),
      method,
      path: pathname,
      headers: {
        Host: 'localhost',
        Authorization: `Bearer ${tokenValue}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
        resolve({ status: response.statusCode ?? 0, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}
const internalGet = (pathname) => internalRequest('GET', pathname);
const internalPost = (pathname, body) => internalRequest('POST', pathname, body);
const [capabilities, models, sessions, sessionRoot, sessionInfo, history, transcript, evidence, diagnostics, notifications, approvals, transfer, receipt] = await Promise.all([
  internalGet('/api/v1/capabilities'),
  internalGet('/api/v1/models'),
  internalGet('/api/v1/sessions'),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/info`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/history`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript?scope=visible_full`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/evidence?expand=transcript,screen,runs`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/diagnostics`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/notifications`),
  internalGet(`/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals/pending`),
  internalPost(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transfer`, { createNew: true, targetRuntime: 'pi', targetCwd: cwd }),
  internalGet('/api/v1/runs/browser-fixture-missing'),
]);
const apiEvidenceText = [history, transcript, evidence]
  .map((response) => JSON.stringify(response.body))
  .join('');
if ([history, transcript, evidence].some((response) => response.status >= 200 && response.status < 300)) {
  throw new Error(`Command Code browser replay/evidence surfaces were exposed through Internal API: ${JSON.stringify({ history: history.status, transcript: transcript.status, evidence: evidence.status })}`);
}
assertBrowserInternalApiIsolation({
  sessionId,
  capabilities: capabilities.body,
  models: models.body,
  sessions: sessions.body,
  sessionRootStatus: sessionRoot.status,
  sessionInfoStatus: sessionInfo.status,
  hiddenSurfaceStatuses: {
    history: history.status,
    transcript: transcript.status,
    evidence: evidence.status,
    diagnostics: diagnostics.status,
    notifications: notifications.status,
    approvals: approvals.status,
    transfer: transfer.status,
    receipt: receipt.status,
  },
  replayAssistantText,
});

const report = {
  verdict: 'OK contained browser path',
  sessionId,
  model,
  effort,
  expectedText,
  availability,
  created,
  replaySession,
  events,
  assistantText,
  replayAssistantText,
  apiEvidenceText,
  privateHomeMarker: browserMarker,
  privateHomeMode: browserMode.toString(8),
  workspaceMarker,
  workspaceWriteSucceeded,
};
console.log(JSON.stringify(report, null, 2));
process.exit(0);
