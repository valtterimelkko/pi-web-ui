#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REGISTRY_PATH = path.join(os.homedir(), '.pi-web-ui', 'session-registry.json');

function encodeClaudeProjectDir(cwd) {
  const encodedCwd = cwd.split(path.sep).join('-').replace(/^-/, '');
  return `-${encodedCwd}`;
}

function getNativeClaudeSessionPath({ homeDir, cwd, claudeSessionId }) {
  if (!cwd || !claudeSessionId) return null;
  return path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${claudeSessionId}.jsonl`);
}

export function findSessionEntry(entries, query) {
  return entries.find((entry) => (
    entry.id === query
    || entry.path === query
    || entry.claudeSessionId === query
    || entry.opencodeSessionId === query
    || entry.antigravityConversationId === query
  )) ?? null;
}

export function buildSessionDebugReport(entry, opts = {}) {
  const homeDir = opts.homeDir ?? os.homedir();
  const lines = [
    `Query target:         ${entry.id}`,
    `Runtime:              ${entry.sdkType}`,
    `Status:               ${entry.status}`,
    `Working directory:    ${entry.cwd || 'N/A'}`,
    `Registry entry path:  ${entry.path || 'N/A'}`,
    `Session registry:     ${path.join(homeDir, '.pi-web-ui', 'session-registry.json')}`,
    `Messages tracked:     ${entry.messageCount ?? 'N/A'}`,
    `Created at:           ${entry.createdAt || 'N/A'}`,
    `Last activity:        ${entry.lastActivity || 'N/A'}`,
    '',
    'Primary logs:',
    '  - Pi Web UI service journal: sudo journalctl -u pi-web-ui -f',
  ];

  if (entry.sdkType === 'pi') {
    lines.push(
      '  - Pi worker processes:        ps aux | grep "pi --mode rpc"',
      '',
      'Session files and state:',
      `  - Pi session file:           ${entry.path || 'N/A'}`,
      `  - Pi session directory:      ${path.join(homeDir, '.pi', 'agent', 'sessions')}`,
      '',
      'Useful checks:',
      '  - Readiness / workers:       curl http://localhost:<server-port>/api/health/ready | jq ".workerStats"',
    );
    return lines.join('\n');
  }

  if (entry.sdkType === 'claude') {
    const nativeClaudeSessionPath = getNativeClaudeSessionPath({
      homeDir,
      cwd: entry.cwd,
      claudeSessionId: entry.claudeSessionId,
    });

    lines.push(
      '  - Claude-auth quick check:    claude auth status --json',
      '  - Claude channel lines only:  sudo journalctl -u pi-web-ui -f | grep ClaudeChannel',
      '',
      'Session files and state:',
      `  - Pi-owned replay store:     ${entry.path || 'N/A'}`,
      `  - Claude session ID:         ${entry.claudeSessionId || 'N/A'}`,
      `  - Native Claude session JSONL: ${nativeClaudeSessionPath || 'Unavailable (missing cwd or claudeSessionId)'}`,
      `  - Claude hook config:        ${path.join(homeDir, '.claude', 'settings.json')}`,
      '',
      'Useful checks:',
      '  - Readiness / runtime flags:  curl http://localhost:<server-port>/api/health/ready',
      '  - Channel source code:        server/src/claude/claude-channel-service.ts',
      '  - Legacy direct path:         server/src/claude/claude-process-pool.ts',
    );
    return lines.join('\n');
  }

  if (entry.sdkType === 'opencode') {
    lines.push(
      '  - OpenCode service journal:   sudo journalctl -u opencode-serve -f',
      '',
      'Session files and state:',
      `  - OpenCode session ID:       ${entry.opencodeSessionId || 'N/A'}`,
      '  - Transcript source:          OpenCode runtime / message APIs (Pi stores registry metadata only)',
      `  - Goal engine state dir:     ${path.join(homeDir, '.opencode', 'goal-engine')}`,
      '',
      'Useful checks:',
      '  - OpenCode readiness:         curl http://localhost:<server-port>/api/health/ready | jq ".checks.opencode"',
      '  - OpenCode models:            curl "http://localhost:<server-port>/api/models?sdkType=opencode"',
    );
    return lines.join('\n');
  }

  if (entry.sdkType === 'antigravity') {
    const conversationId = entry.antigravityConversationId || 'N/A';
    lines.push(
      '  - Antigravity log lines:      sudo journalctl -u pi-web-ui -f | grep -i antigravity',
      '',
      'Session files and state:',
      `  - Antigravity session JSONL: ${path.join(homeDir, '.pi-web-ui', 'antigravity-sessions', `${entry.id}.jsonl`)}`,
      `  - Conversation ID:           ${conversationId}`,
      `  - Conversation DB:           ${entry.antigravityConversationId ? path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations', `${entry.antigravityConversationId}.db`) : 'Unavailable (missing antigravityConversationId)'}`,
      `  - agy CLI logs:              ${path.join(homeDir, '.gemini', 'antigravity-cli', 'log', 'cli-*.log')}`,
      '',
      'Useful checks:',
      '  - agy binary:                 agy --version',
      '  - agy models:                 agy models',
      '  - agy auth / quick prompt:    agy -p "Reply OK"',
      '  - REST models:                curl "http://localhost:<server-port>/api/models?sdkType=antigravity"',
    );
    return lines.join('\n');
  }

  lines.push('', 'No runtime-specific hints available for this entry.');
  return lines.join('\n');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

/**
 * Build the offline half of the session evidence bundle.
 *
 * This intentionally contains only registry metadata, locators, and bounded
 * commands. It never copies firstMessage, transcript text, tool payloads, or
 * credentials; live process-local logs and receipts belong to the Internal API
 * evidence endpoint.
 */
export function buildSessionEvidenceJson(entry, opts = {}) {
  const homeDir = opts.homeDir ?? os.homedir();
  const registryPath = opts.registryPath ?? path.join(homeDir, '.pi-web-ui', 'session-registry.json');
  const encodedId = encodeURIComponent(entry.id);
  const aliases = {
    internalId: entry.id,
    path: entry.path,
    ...(entry.claudeSessionId ? { claudeSessionId: entry.claudeSessionId } : {}),
    ...(entry.opencodeSessionId ? { opencodeSessionId: entry.opencodeSessionId } : {}),
    ...(entry.antigravityConversationId ? { antigravityConversationId: entry.antigravityConversationId } : {}),
  };

  let runtime = {};
  let journalUnit = 'pi-web-ui';
  if (entry.sdkType === 'pi') {
    runtime = {
      sessionPath: entry.path,
      sessionDirectory: entry.path?.endsWith('.jsonl') ? path.dirname(entry.path) : entry.path,
    };
  } else if (entry.sdkType === 'claude') {
    runtime = {
      replayPath: entry.path,
      claudeSessionId: entry.claudeSessionId ?? '',
      nativeSessionPath: getNativeClaudeSessionPath({
        homeDir,
        cwd: entry.cwd,
        claudeSessionId: entry.claudeSessionId,
      }) ?? '',
    };
  } else if (entry.sdkType === 'opencode') {
    journalUnit = 'opencode-serve';
    runtime = {
      opencodeSessionId: entry.opencodeSessionId ?? '',
      transcriptSource: 'OpenCode runtime/message APIs',
      goalEngineStateDir: path.join(homeDir, '.opencode', 'goal-engine'),
    };
  } else if (entry.sdkType === 'antigravity') {
    runtime = {
      sessionJsonl: path.join(homeDir, '.pi-web-ui', 'antigravity-sessions', `${entry.id}.jsonl`),
      conversationId: entry.antigravityConversationId ?? '',
      conversationDb: entry.antigravityConversationId
        ? path.join(homeDir, '.gemini', 'antigravity-cli', 'conversations', `${entry.antigravityConversationId}.db`)
        : '',
      agyLogs: path.join(homeDir, '.gemini', 'antigravity-cli', 'log', 'cli-*.log'),
    };
  }

  return {
    mode: 'offline',
    sessionId: entry.id,
    runtime: entry.sdkType,
    aliases,
    summary: {
      status: entry.status,
      cwd: entry.cwd || undefined,
      model: entry.model || undefined,
      messageCount: entry.messageCount ?? undefined,
      createdAt: entry.createdAt || undefined,
      lastActivity: entry.lastActivity || undefined,
    },
    sources: {
      registryPath,
      runtime,
      commands: [
        `npm run debug:where -- --registry ${shellQuote(registryPath)} ${shellQuote(entry.id)}`,
        `sudo journalctl -u ${journalUnit} --since '15 minutes ago' --no-pager | grep -F -- ${shellQuote(`sid=${entry.id}`)}`,
      ],
    },
    diagnostics: {
      processLocal: true,
      available: false,
      records: [],
    },
    receiptSummary: {
      durable: true,
      available: false,
      count: 0,
    },
    warnings: [
      'Offline locator mode: process-local diagnostics are unavailable.',
      'Use the authenticated Internal API evidence endpoint for live logs and receipts.',
    ],
    links: {
      info: `/api/v1/sessions/${encodedId}/info`,
      diagnostics: `/api/v1/sessions/${encodedId}/diagnostics`,
      transcript: `/api/v1/sessions/${encodedId}/transcript`,
      screen: `/api/v1/sessions/${encodedId}/transcript?view=screen`,
      history: `/api/v1/sessions/${encodedId}/history`,
      evidence: `/api/v1/sessions/${encodedId}/evidence`,
    },
  };
}

export async function loadRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  const raw = await fs.readFile(registryPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`Registry at ${registryPath} does not contain an entries array`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = [...argv];
  let registryPath = DEFAULT_REGISTRY_PATH;
  let json = false;
  const positionals = [];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--registry') {
      const next = args.shift();
      if (!next) throw new Error('Missing value after --registry');
      registryPath = next;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      return { help: true, json, registryPath, query: null };
    }
    positionals.push(arg);
  }

  return {
    help: false,
    json,
    registryPath,
    query: positionals[0] ?? null,
  };
}

function printHelp() {
  console.log(`Usage:\n  npm run debug:where -- [--json] <session-id|runtime-session-id|path|antigravity-conversation-id> [--registry /path/to/session-registry.json]\n\nExamples:\n  npm run debug:where -- 123e4567-e89b-12d3-a456-426614174000\n  npm run debug:where -- --json abc123-claude-session-id\n  npm run debug:where -- /root/.pi-web-ui/claude-sessions/123.jsonl\n  npm run debug:where -- 4f1d3d93-7f2d-4a58-a7b0-123456789abc`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { help, json, registryPath, query } = parseArgs(argv);
  if (help || !query) {
    printHelp();
    return help ? 0 : 1;
  }

  const registry = await loadRegistry(registryPath);
  const entry = findSessionEntry(registry.entries, query);
  if (!entry) {
    console.error(`No session entry matched '${query}' in ${registryPath}`);
    console.error('Tip: try the internal session id, runtime-native session id, Antigravity conversation id, or the registry path field.');
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(buildSessionEvidenceJson(entry, {
      homeDir: os.homedir(),
      registryPath,
    }), null, 2));
  } else {
    console.log(buildSessionDebugReport(entry, { homeDir: os.homedir() }));
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
