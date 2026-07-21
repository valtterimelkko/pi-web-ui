import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSessionDebugReport,
  buildSessionEvidenceJson,
  findSessionEntry,
  runCli,
} from '../../scripts/debug-where.mjs';

test('buildSessionDebugReport includes Claude replay store, native Claude JSONL, and hook config', () => {
  const report = buildSessionDebugReport({
    id: 'claude-1',
    sdkType: 'claude',
    path: '/home/test/.pi-web-ui/claude-sessions/claude-1.jsonl',
    claudeSessionId: 'abc123',
    cwd: '/root/pi-web-ui',
    firstMessage: '',
    messageCount: 4,
    createdAt: '2026-05-18T00:00:00.000Z',
    lastActivity: '2026-05-18T01:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  assert.match(report, /Runtime:\s+claude/i);
  assert.match(report, /Pi-owned replay store:[^\n]*claude-sessions\/claude-1\.jsonl/i);
  assert.match(report, /Native Claude session JSONL:[^\n]*\.claude\/projects\/-root-pi-web-ui\/abc123\.jsonl/i);
  assert.match(report, /Claude hook config:[^\n]*\.claude\/settings\.json/i);
});

test('buildSessionDebugReport includes OpenCode session id and log hints', () => {
  const report = buildSessionDebugReport({
    id: 'oc-1',
    sdkType: 'opencode',
    path: 'oc-1',
    opencodeSessionId: 'opencode-session-42',
    cwd: '/root/tasks',
    firstMessage: '',
    messageCount: 3,
    createdAt: '2026-05-18T00:00:00.000Z',
    lastActivity: '2026-05-18T01:00:00.000Z',
    status: 'running',
  }, { homeDir: '/home/test' });

  assert.match(report, /Runtime:\s+opencode/i);
  assert.match(report, /OpenCode session ID:\s+opencode-session-42/i);
  assert.match(report, /journalctl -u opencode-serve -f/i);
  assert.match(report, /Transcript source:\s+OpenCode runtime/i);
});

test('findSessionEntry resolves by internal id, runtime session id, or path', () => {
  const entries = [
    {
      id: 'claude-1',
      sdkType: 'claude',
      path: '/tmp/claude-1.jsonl',
      claudeSessionId: 'native-claude-99',
      cwd: '/root/pi-web-ui',
      firstMessage: '',
      messageCount: 0,
      createdAt: '2026-05-18T00:00:00.000Z',
      lastActivity: '2026-05-18T00:00:00.000Z',
      status: 'idle',
    },
  ];

  assert.equal(findSessionEntry(entries, 'claude-1')?.id, 'claude-1');
  assert.equal(findSessionEntry(entries, 'native-claude-99')?.id, 'claude-1');
  assert.equal(findSessionEntry(entries, '/tmp/claude-1.jsonl')?.id, 'claude-1');
  assert.equal(findSessionEntry(entries, 'missing'), null);
});

test('findSessionEntry resolves Antigravity conversation ids', () => {
  const entries = [
    {
      id: 'ag-1',
      sdkType: 'antigravity',
      path: 'ag-1',
      antigravityConversationId: 'conversation-uuid-123',
      cwd: '/root/tasks',
      firstMessage: '',
      messageCount: 2,
      createdAt: '2026-05-18T00:00:00.000Z',
      lastActivity: '2026-05-18T00:00:00.000Z',
      status: 'idle',
    },
  ];

  assert.equal(findSessionEntry(entries, 'conversation-uuid-123')?.id, 'ag-1');
});

test('buildSessionDebugReport includes Antigravity session, conversation, and log hints', () => {
  const report = buildSessionDebugReport({
    id: 'ag-1',
    sdkType: 'antigravity',
    path: 'ag-1',
    antigravityConversationId: 'conversation-uuid-123',
    cwd: '/root/tasks',
    firstMessage: '',
    messageCount: 2,
    createdAt: '2026-05-18T00:00:00.000Z',
    lastActivity: '2026-05-18T01:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  assert.match(report, /Runtime:\s+antigravity/i);
  assert.match(report, /Conversation ID:\s+conversation-uuid-123/i);
  assert.match(report, /antigravity-sessions\/ag-1\.jsonl/i);
  assert.match(report, /\.gemini\/antigravity-cli\/conversations\/conversation-uuid-123\.db/i);
  assert.match(report, /journalctl -u pi-web-ui -f \| grep -i antigravity/i);
  assert.match(report, /Session registry:/i);
});

test('buildSessionEvidenceJson is bounded offline locator evidence and omits prompt text', () => {
  const evidence = buildSessionEvidenceJson({
    id: 'ag-1',
    sdkType: 'antigravity',
    path: 'ag-1',
    antigravityConversationId: 'conversation-uuid-123',
    cwd: '/root/tasks',
    firstMessage: 'private prompt that must not be copied',
    messageCount: 2,
    createdAt: '2026-05-18T00:00:00.000Z',
    lastActivity: '2026-05-18T01:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  assert.equal(evidence.mode, 'offline');
  assert.equal(evidence.sessionId, 'ag-1');
  assert.equal(evidence.aliases.antigravityConversationId, 'conversation-uuid-123');
  assert.equal(evidence.diagnostics.processLocal, true);
  assert.equal(evidence.summary.messageCount, 2);
  assert.equal(JSON.stringify(evidence).includes('private prompt that must not be copied'), false);
});

test('runCli --json emits machine-readable offline evidence and preserves alias lookup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-json-'));
  const registryPath = path.join(dir, 'session-registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    version: 1,
    updatedAt: '2026-05-18T01:00:00.000Z',
    entries: [{
      id: 'claude-1',
      sdkType: 'claude',
      path: '/tmp/claude-1.jsonl',
      claudeSessionId: 'native-claude-99',
      cwd: '/root/pi-web-ui',
      firstMessage: 'private prompt must not be emitted',
      messageCount: 4,
      createdAt: '2026-05-18T00:00:00.000Z',
      lastActivity: '2026-05-18T01:00:00.000Z',
      status: 'idle',
    }],
  }));

  const output = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await runCli(['--json', '--registry', registryPath, 'native-claude-99']), 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(errors, []);
  const evidence = JSON.parse(output.join('\n'));
  assert.equal(evidence.mode, 'offline');
  assert.equal(evidence.sessionId, 'claude-1');
  assert.equal(evidence.aliases.claudeSessionId, 'native-claude-99');
  assert.equal(JSON.stringify(evidence).includes('private prompt must not be emitted'), false);
});
