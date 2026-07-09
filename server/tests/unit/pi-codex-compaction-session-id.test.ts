import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const agentSession = readFileSync(
  join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js'),
  'utf8',
);
const compaction = readFileSync(
  join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js'),
  'utf8',
);

describe('Pi SDK Codex compaction', () => {
  it('passes the active session ID to Codex summarisation requests', () => {
    expect(agentSession).toContain('this.agent.streamFn, env, this.sessionManager.getSessionId())');
    expect(compaction).toContain('env, sessionId };');
    expect(compaction).toContain('thinkingLevel, streamFn, env, sessionId)');
  });
});
