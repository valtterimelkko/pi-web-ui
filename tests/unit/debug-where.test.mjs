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

test('buildSessionDebugReport includes Command Code session files with real newlines', () => {
  const report = buildSessionDebugReport({
    id: 'commandcode-1',
    sdkType: 'commandcode',
    path: 'commandcode-1',
    commandCodeNativeSessionId: '9ad4547f-994d-45ba-997c-064286f98873',
    cwd: '/root/pi-web-ui',
    firstMessage: '',
    messageCount: 6,
    createdAt: '2026-08-15T00:00:00.000Z',
    lastActivity: '2026-08-15T01:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  assert.match(report, /Runtime:\s+commandcode/i);
  assert.match(report, /command-code\/sessions\/commandcode-1\.json/i);
  assert.match(report, /command-code\/events\/commandcode-1\.jsonl/i);
  assert.match(report, /Native session id:\s+9ad4547f-994d-45ba-997c-064286f98873/i);
  // Regression: the commandcode branch joined lines with a literal '\n' string.
  assert.equal(report.includes('\\n'), false);
  // Native transcript locators, both server-spawned and plain CLI runs.
  // Server default native home: ~/.pi-web-ui/command-code-native-home (config.ts).
  assert.match(report, /command-code-native-home\/commandcode-1\/\.commandcode\/projects\/root-pi-web-ui\/9ad4547f-994d-45ba-997c-064286f98873\.jsonl/i);
  assert.match(report, /\/home\/test\/\.commandcode\/projects\/root-pi-web-ui\/9ad4547f-994d-45ba-997c-064286f98873\.jsonl/i);
});

test('buildSessionDebugReport strips dots when encoding Command Code project dirs', () => {
  const report = buildSessionDebugReport({
    id: 'commandcode-2',
    sdkType: 'commandcode',
    path: 'commandcode-2',
    commandCodeNativeSessionId: '22d52521-ef00-49f5-9275-f44d4a5a65ea',
    cwd: '/root/.cc-probe',
    firstMessage: '',
    messageCount: 1,
    createdAt: '2026-08-15T00:00:00.000Z',
    lastActivity: '2026-08-15T01:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  // Observed on disk: /root/.cc-probe encodes to root-cc-probe (dots removed).
  assert.match(report, /projects\/root-cc-probe\/22d52521-ef00-49f5-9275-f44d4a5a65ea\.jsonl/i);
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

test('runCli resolves an on-disk Pi session absent from the registry by exact filename fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-pi-fallback-'));
  const registryPath = path.join(dir, 'session-registry.json');
  const piAgentDir = path.join(dir, 'pi-agent');
  const projectDir = path.join(piAgentDir, 'sessions', '--tmp-project--');
  const sessionId = '019faeda-0000-7000-8000-000000000001';
  const sessionPath = path.join(projectDir, `2026-07-29T00-00-00_${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ version: 1, entries: [] }));
  fs.writeFileSync(sessionPath, JSON.stringify({ type: 'session', id: sessionId, cwd: '/tmp/project', timestamp: '2026-07-29T00:00:00.000Z' }));

  const output = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  const previousPiAgentDir = process.env.PI_AGENT_DIR;
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  process.env.PI_AGENT_DIR = piAgentDir;
  try {
    assert.equal(await runCli(['--json', '--registry', registryPath, sessionId]), 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    if (previousPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousPiAgentDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(errors, []);
  const evidence = JSON.parse(output.join('\n'));
  assert.equal(evidence.sessionId, sessionId);
  assert.equal(evidence.runtime, 'pi');
  assert.equal(evidence.aliases.path, sessionPath);
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

// ── Antigravity desktop-root fallback (contract 1.42.0) ─────────────────────

const AGY_DESKTOP_UUID = 'd0d0d0d0-1111-4111-8111-00000000d001';

function makeAgyFixture(baseDir, surfaceName, uuid) {
  const conversationsDir = path.join(baseDir, surfaceName, 'conversations');
  const brainLogsDir = path.join(baseDir, surfaceName, 'brain', uuid, '.system_generated', 'logs');
  fs.mkdirSync(conversationsDir, { recursive: true });
  fs.mkdirSync(brainLogsDir, { recursive: true });
  fs.writeFileSync(path.join(conversationsDir, `${uuid}.db`), 'sqlite', 'utf-8');
  fs.writeFileSync(
    path.join(brainLogsDir, 'transcript.jsonl'),
    JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nMUSE-SPARK-PROBE\n</USER_REQUEST>' }) + '\n',
    'utf-8',
  );
  return { conversationsDir, brainTranscriptPath: path.join(brainLogsDir, 'transcript.jsonl') };
}

function withCapturedConsole(fn) {
  const output = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => output.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  return Promise.resolve(fn())
    .then((result) => {
      console.log = originalLog;
      console.error = originalError;
      return { result, output: output.join('\n'), errors: errors.join('\n') };
    })
    .catch((error) => {
      console.log = originalLog;
      console.error = originalError;
      throw error;
    });
}

test('findNativeAntigravityConversation probes the desktop root when the CLI root lacks the id', async () => {
  const { findNativeAntigravityConversation } = await import('../../scripts/debug-where.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-agy-'));
  try {
    const cli = makeAgyFixture(path.join(dir, 'cli-root'), 'conversations', 'e1111111-1111-4111-8111-000000000001');
    const desktop = makeAgyFixture(path.join(dir, 'desktop-root'), 'conversations', AGY_DESKTOP_UUID);

    const hit = await findNativeAntigravityConversation(AGY_DESKTOP_UUID, {
      homeDir: dir,
      cliConversationsDir: cli.conversationsDir,
      desktopConversationsDir: desktop.conversationsDir,
    });
    assert.ok(hit, 'expected a desktop-root hit');
    assert.equal(hit.surface, 'desktop');
    assert.equal(hit.dbPath, path.join(desktop.conversationsDir, `${AGY_DESKTOP_UUID}.db`));

    const cliHit = await findNativeAntigravityConversation('e1111111-1111-4111-8111-000000000001', {
      homeDir: dir,
      cliConversationsDir: cli.conversationsDir,
      desktopConversationsDir: desktop.conversationsDir,
    });
    assert.equal(cliHit.surface, 'cli');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findNativeAntigravityConversation returns null for non-UUID queries and misses', async () => {
  const { findNativeAntigravityConversation } = await import('../../scripts/debug-where.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-agy-'));
  try {
    const empty = path.join(dir, 'empty', 'conversations');
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(await findNativeAntigravityConversation('../../etc/passwd', {
      homeDir: dir,
      cliConversationsDir: empty,
      desktopConversationsDir: empty,
    }), null);
    assert.equal(await findNativeAntigravityConversation(AGY_DESKTOP_UUID, {
      homeDir: dir,
      cliConversationsDir: empty,
      desktopConversationsDir: empty,
    }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli falls back to a native antigravity desktop conversation absent from the registry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-agy-cli-'));
  try {
    const desktop = makeAgyFixture(path.join(dir, 'agy-home'), 'antigravity', AGY_DESKTOP_UUID);
    const registryPath = path.join(dir, 'session-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ entries: [] }));

    const previousDesktop = process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR;
    const previousCli = process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR;
    process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR = desktop.conversationsDir;
    if (previousCli === undefined) delete process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR;
    try {
      const { result, output, errors } = await withCapturedConsole(() =>
        runCli(['--registry', registryPath, AGY_DESKTOP_UUID]));
      assert.equal(result, 0);
      assert.match(output, /Antigravity desktop app/i);
      assert.match(output, new RegExp(AGY_DESKTOP_UUID));
      assert.match(output, /brain/);
      assert.equal(errors.includes('No session entry matched'), false);
    } finally {
      if (previousDesktop === undefined) delete process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR;
      else process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR = previousDesktop;
      if (previousCli === undefined) delete process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR;
      else process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR = previousCli;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli --json emits a native-antigravity evidence object for desktop conversations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-agy-json-'));
  try {
    const desktop = makeAgyFixture(path.join(dir, 'agy-home'), 'antigravity', AGY_DESKTOP_UUID);
    const registryPath = path.join(dir, 'session-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ entries: [] }));

    const previousDesktop = process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR;
    process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR = desktop.conversationsDir;
    try {
      const { output } = await withCapturedConsole(() =>
        runCli(['--json', '--registry', registryPath, AGY_DESKTOP_UUID]));
      const evidence = JSON.parse(output);
      assert.equal(evidence.mode, 'native-antigravity');
      assert.equal(evidence.surface, 'desktop');
      assert.equal(evidence.runtime, 'antigravity');
      assert.equal(evidence.nativeId, AGY_DESKTOP_UUID);
      assert.equal(evidence.conversationDb, path.join(desktop.conversationsDir, `${AGY_DESKTOP_UUID}.db`));
      assert.match(evidence.brainTranscript, /brain/);
    } finally {
      if (previousDesktop === undefined) delete process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR;
      else process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR = previousDesktop;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCli still exits 1 with the miss tip when no native antigravity match exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-where-agy-miss-'));
  try {
    const empty = path.join(dir, 'empty', 'conversations');
    fs.mkdirSync(empty, { recursive: true });
    const registryPath = path.join(dir, 'session-registry.json');
    fs.writeFileSync(registryPath, JSON.stringify({ entries: [] }));

    const previousDesktop = process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR;
    const previousCli = process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR;
    process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR = empty;
    process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR = empty;
    try {
      const { result, errors } = await withCapturedConsole(() =>
        runCli(['--registry', registryPath, AGY_DESKTOP_UUID]));
      assert.equal(result, 1);
      assert.match(errors, /No session entry matched/);
    } finally {
      if (previousDesktop === undefined) delete process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR;
      else process.env.ANTIGRAVITY_NATIVE_DESKTOP_CONVERSATIONS_DIR = previousDesktop;
      if (previousCli === undefined) delete process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR;
      else process.env.ANTIGRAVITY_NATIVE_CONVERSATIONS_DIR = previousCli;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antigravity report and evidence list both the CLI and desktop conversation roots', () => {
  const report = buildSessionDebugReport({
    id: 'agy-1',
    sdkType: 'antigravity',
    path: '/home/test/.pi-web-ui/antigravity-sessions/agy-1.jsonl',
    antigravityConversationId: AGY_DESKTOP_UUID,
    cwd: '/root',
    firstMessage: '',
    messageCount: 2,
    createdAt: '2026-09-11T10:00:00.000Z',
    lastActivity: '2026-09-11T11:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  assert.match(report, /\.gemini\/antigravity-cli\/conversations/);
  assert.match(report, /\.gemini\/antigravity\/conversations/);

  const evidence = buildSessionEvidenceJson({
    id: 'agy-1',
    sdkType: 'antigravity',
    path: '/home/test/.pi-web-ui/antigravity-sessions/agy-1.jsonl',
    antigravityConversationId: AGY_DESKTOP_UUID,
    cwd: '/root',
    firstMessage: '',
    messageCount: 2,
    createdAt: '2026-09-11T10:00:00.000Z',
    lastActivity: '2026-09-11T11:00:00.000Z',
    status: 'idle',
  }, { homeDir: '/home/test' });

  assert.equal(evidence.sources.runtime.conversationId, AGY_DESKTOP_UUID);
  assert.match(evidence.sources.runtime.conversationDb, /\.gemini\/antigravity-cli\/conversations/);
  assert.match(evidence.sources.runtime.conversationDbDesktop, /\.gemini\/antigravity\/conversations/);
});
