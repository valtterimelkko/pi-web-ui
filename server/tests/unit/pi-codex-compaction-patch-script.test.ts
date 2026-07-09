import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'scripts/patch-pi-codex-compaction-session-id.mjs');

const AGENT_SESSION_080_5 = `
const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);
const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);
`;

const COMPACTION_080_5 = `
function createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel) {
    const options = { maxTokens, signal, apiKey, headers, env };
}
export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env) {
    const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel);
}
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn) {
    const response = await completeSummarization(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel), streamFn);
}
export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env) {
    const historyResult = messagesToSummarize.length > 0
        ? await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env)
        : undefined;
    const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn);
    summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env);
}
`;

function makeInstall(agentSession: string, compaction: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-codex-patch-test-'));
  mkdirSync(join(dir, 'dist/core/compaction'), { recursive: true });
  writeFileSync(join(dir, 'dist/core/agent-session.js'), agentSession);
  writeFileSync(join(dir, 'dist/core/compaction/compaction.js'), compaction);
  return dir;
}

function runPatcher(dir: string): string {
  return execFileSync(process.execPath, [script, dir], { encoding: 'utf8' });
}

describe('patch-pi-codex-compaction-session-id script', () => {
  it('patches an unpatched 0.80.5-shaped SDK and is idempotent', () => {
    const dir = makeInstall(AGENT_SESSION_080_5, COMPACTION_080_5);
    expect(runPatcher(dir)).toContain('Applied Pi Codex compaction session-ID patch.');

    const agentSession = readFileSync(join(dir, 'dist/core/agent-session.js'), 'utf8');
    const compaction = readFileSync(join(dir, 'dist/core/compaction/compaction.js'), 'utf8');
    expect(agentSession.match(/this\.sessionManager\.getSessionId\(\)\)/g)).toHaveLength(2);
    expect(compaction).toContain('const options = { maxTokens, signal, apiKey, headers, env, sessionId };');
    expect(compaction).toContain('thinkingLevel, streamFn, env, sessionId)');

    expect(runPatcher(dir)).toContain('already applied');
    expect(readFileSync(join(dir, 'dist/core/agent-session.js'), 'utf8')).toBe(agentSession);
  });

  it('no-ops when upstream ships its own sessionId propagation', () => {
    const dir = makeInstall(
      'const result = await compact({ preparation, sessionId: this.sessionManager.getSessionId() });',
      'export async function compact(options) { const { sessionId } = options; }',
    );
    expect(runPatcher(dir)).toContain('Upstream Pi SDK ships its own compaction sessionId propagation');
  });

  it('fails loudly on unrecognised drift without modifying files', () => {
    const dir = makeInstall('await compactEntirelyDifferent();', 'export function somethingElse() {}');
    expect(() => runPatcher(dir)).toThrowError(/upstream sources changed shape/);
    expect(readFileSync(join(dir, 'dist/core/agent-session.js'), 'utf8')).toBe('await compactEntirelyDifferent();');
  });
});
