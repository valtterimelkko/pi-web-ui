/**
 * Postinstall patch: make the embedded Pi SDK pass the active session ID into
 * compaction summary requests, matching normal agent turns. Without it the
 * OpenAI-Codex adapter sends summarisation requests without session identity
 * (WebSocket request identity, session headers, prompt_cache_key), which broke
 * compaction on gpt-5.6-luna ("Model not found gpt-5.6-luna-free-1p-codexswic-ev3").
 *
 * Behaviour:
 *   - unpatched 0.80.5-shaped SDK   -> applies the patch
 *   - already patched               -> no-op success
 *   - upstream ships its own fix    -> no-op success (retire this script + postinstall hook)
 *   - unrecognised source drift     -> fails loudly, applies nothing
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = resolve(process.argv[2] ?? resolve(root, 'node_modules/@earendil-works/pi-coding-agent'));
const agentSessionPath = resolve(target, 'dist/core/agent-session.js');
const compactionPath = resolve(target, 'dist/core/compaction/compaction.js');

const agentSessionReplacements = [
  [
    'const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);',
    'const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env, this.sessionManager.getSessionId());',
    'manual compaction call',
  ],
  [
    'const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);',
    'const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env, this.sessionManager.getSessionId());',
    'automatic compaction call',
  ],
];

const compactionReplacements = [
  [
    'function createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel) {\n    const options = { maxTokens, signal, apiKey, headers, env };',
    'function createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId) {\n    const options = { maxTokens, signal, apiKey, headers, env, sessionId };',
    'summarisation options',
  ],
  [
    'export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env) {',
    'export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, sessionId) {',
    'summary signature',
  ],
  [
    'const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel);',
    'const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId);',
    'summary options call',
  ],
  [
    'export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env) {',
    'export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env, sessionId) {',
    'compaction signature',
  ],
  [
    '? await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env)',
    '? await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, sessionId)',
    'split summary call',
  ],
  [
    'const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn);',
    'const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, sessionId);',
    'turn-prefix call',
  ],
  [
    'summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env);',
    'summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, sessionId);',
    'standard summary call',
  ],
  [
    'async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn) {',
    'async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, sessionId) {',
    'turn-prefix signature',
  ],
  [
    'const response = await completeSummarization(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel), streamFn);',
    'const response = await completeSummarization(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId), streamFn);',
    'turn-prefix options call',
  ],
];

function classify(source, replacements) {
  const applied = replacements.filter(([, to]) => source.includes(to)).length;
  const applicable = replacements.filter(([from]) => source.includes(from)).length;
  if (applied === replacements.length) return 'patched';
  if (applicable === replacements.length) return 'unpatched';
  if (applied === 0 && applicable === 0 && source.includes('sessionId')) return 'upstream-fixed';
  return 'drifted';
}

function apply(source, replacements) {
  let out = source;
  for (const [from, to, label] of replacements) {
    if (!out.includes(from)) throw new Error(`Unexpected drift while patching: ${label}`);
    out = out.replace(from, to);
  }
  return out;
}

const agentSession = readFileSync(agentSessionPath, 'utf8');
const compaction = readFileSync(compactionPath, 'utf8');
const states = [classify(agentSession, agentSessionReplacements), classify(compaction, compactionReplacements)];

if (states.every((s) => s === 'patched')) {
  console.log('Pi Codex compaction session-ID patch already applied.');
} else if (states.every((s) => s === 'upstream-fixed')) {
  console.log(
    'Upstream Pi SDK ships its own compaction sessionId propagation; skipping patch. ' +
      'Retire scripts/patch-pi-codex-compaction-session-id.mjs, the postinstall hook, and the regression test.',
  );
} else if (states.every((s) => s === 'unpatched')) {
  writeFileSync(agentSessionPath, apply(agentSession, agentSessionReplacements));
  writeFileSync(compactionPath, apply(compaction, compactionReplacements));
  console.log('Applied Pi Codex compaction session-ID patch.');
} else {
  throw new Error(
    `Cannot apply Codex compaction patch: upstream sources changed shape ` +
      `(agent-session: ${states[0]}, compaction: ${states[1]}). ` +
      'Verify whether upstream now propagates sessionId through compaction and update this script.',
  );
}
