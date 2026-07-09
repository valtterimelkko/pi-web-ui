import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const agentSessionPath = resolve(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js');
const compactionPath = resolve(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js');

function replaceRequired(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) {
    throw new Error(`Cannot apply Codex compaction patch: upstream ${label} changed.`);
  }
  return source.replace(from, to);
}

let agentSession = readFileSync(agentSessionPath, 'utf8');
agentSession = replaceRequired(
  agentSession,
  'const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);',
  'const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env, this.sessionManager.getSessionId());',
  'manual compaction call',
);
agentSession = replaceRequired(
  agentSession,
  'const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);',
  'const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env, this.sessionManager.getSessionId());',
  'automatic compaction call',
);

let compaction = readFileSync(compactionPath, 'utf8');
const replacements = [
  ['function createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel) {\n    const options = { maxTokens, signal, apiKey, headers, env };', 'function createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId) {\n    const options = { maxTokens, signal, apiKey, headers, env, sessionId };', 'summarisation options'],
  ['export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env) {', 'export async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, sessionId) {', 'summary signature'],
  ['const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel);', 'const completionOptions = createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId);', 'summary options call'],
  ['export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env) {', 'export async function compact(preparation, model, apiKey, headers, customInstructions, signal, thinkingLevel, streamFn, env, sessionId) {', 'compaction signature'],
  ['? await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env)', '? await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, sessionId)', 'split summary call'],
  ['const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn);', 'const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, sessionId);', 'turn-prefix call'],
  ['summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env);', 'summary = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, env, sessionId);', 'standard summary call'],
  ['async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn) {', 'async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, headers, env, signal, thinkingLevel, streamFn, sessionId) {', 'turn-prefix signature'],
  ['const response = await completeSummarization(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel), streamFn);', 'const response = await completeSummarization(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId), streamFn);', 'turn-prefix options call'],
];
for (const [from, to, label] of replacements) {
  compaction = replaceRequired(compaction, from, to, label);
}

writeFileSync(agentSessionPath, agentSession);
writeFileSync(compactionPath, compaction);
console.log('Applied Pi Codex compaction session-ID patch.');
