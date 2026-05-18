import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionDebugReport,
  findSessionEntry,
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
