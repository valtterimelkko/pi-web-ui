#!/usr/bin/env npx tsx
/**
 * Deep validation: verify model/thinking-level persistence end-to-end.
 *
 * Tests:
 * 1. Create opus session → send prompt → verify native Claude JSONL uses opus
 * 2. Create haiku session → send prompt → verify native Claude JSONL uses haiku
 * 3. Send follow-up to opus session → verify model restored to opus (shared PTY)
 * 4. Verify registry model/thinkingLevel persisted after prompt round-trips
 */
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const client = new InternalApiClient();
const claudeProjectsDir = join(homedir(), '.claude', 'projects');

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, details?: string) {
  results.push({ name, passed, details });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${name}${details ? ` — ${details}` : ''}`);
}

function findClaudeSessionFile(cwd: string, claudeSessionId?: string): string | null {
  const encodedCwd = cwd.split('/').filter(Boolean).join('-');
  const projectDir = join(claudeProjectsDir, `-${encodedCwd}`);
  try {
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return null;
    if (claudeSessionId) {
      const match = files.find(f => f === `${claudeSessionId}.jsonl`);
      if (match) return join(projectDir, match);
    }
    // Latest by modification time (lexicographic sort of UUIDs is unreliable)
    const sorted = files
      .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return join(projectDir, sorted[0]!.name);
  } catch {
    return null;
  }
}

function getModelFromClaudeJsonl(filePath: string): { model: string | null; messageCount: number } {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    let lastModel: string | null = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Assistant messages have entry.message.model
        if (entry.type === 'assistant' && entry.message?.model) {
          lastModel = entry.message.model;
        }
        // Result entries also have model info
        if (entry.type === 'result' && entry.model) {
          // e.g. "claude-sonnet-4-6" → normalize
          lastModel = entry.model;
        }
      } catch { /* skip */ }
    }
    return { model: lastModel, messageCount: lines.length };
  } catch {
    return { model: null, messageCount: 0 };
  }
}

function normalizeModelName(model: string | null): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  if (lower.includes('sonnet')) return 'sonnet';
  return lower;
}

function getRegistryEntry(sessionId: string) {
  const registryPath = join(homedir(), '.pi-web-ui', 'session-registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  return registry.entries.find((e: { id: string }) => e.id === sessionId);
}

async function main() {
  const cwd = '/root/pi-web-ui';

  console.log('\n=== TEST 1: Create opus session, send prompt, verify model ===\n');

  const opusSession = await client.createSession({
    runtime: 'claude',
    cwd,
    model: 'opus',
    source: 'validate-model-persistence',
    ephemeral: true,
  });

  console.log('Created opus session:', opusSession.sessionId, '(claude:', opusSession.claudeSessionId || 'N/A', ')');

  const opusEntryBefore = getRegistryEntry(opusSession.sessionId);
  record(
    'Registry has model=opus at creation',
    opusEntryBefore?.model === 'opus',
    `model=${opusEntryBefore?.model}`,
  );

  const opusEvents = await client.promptStream(opusSession.sessionId, {
    message: 'Reply with exactly: OPUS-MODEL-CONFIRMED',
    verbosity: 'full',
  });

  const opusText = opusEvents
    .filter(e => e.type === 'message_update')
    .map(e => {
      const d = e.data as Record<string, unknown> | undefined;
      const msgEvent = d?.assistantMessageEvent as { delta?: string } | undefined;
      return msgEvent?.delta ?? '';
    })
    .join('');

  record(
    'Opus session received response',
    opusEvents.some(e => e.type === 'agent_end'),
    `text="${opusText.slice(0, 80)}"`,
  );

  // Wait for async writes
  await new Promise(r => setTimeout(r, 2000));

  // Check native Claude JSONL for the model actually used
  const opusClaudeFile = findClaudeSessionFile(cwd);
  if (opusClaudeFile) {
    const { model: actualModel, messageCount } = getModelFromClaudeJsonl(opusClaudeFile);
    const normalized = normalizeModelName(actualModel);
    record(
      'Native Claude JSONL shows opus model',
      normalized === 'opus',
      `file model="${actualModel}" (${messageCount} messages)`,
    );
  } else {
    record('Native Claude JSONL shows opus model', false, 'file not found');
  }

  const opusEntryAfter = getRegistryEntry(opusSession.sessionId);
  record(
    'Registry still has model=opus after prompt',
    opusEntryAfter?.model === 'opus',
    `model=${opusEntryAfter?.model}`,
  );

  console.log('\n=== TEST 2: Create haiku session, send prompt, verify model ===\n');

  const haikuSession = await client.createSession({
    runtime: 'claude',
    cwd,
    model: 'haiku',
    source: 'validate-model-persistence',
    ephemeral: true,
  });

  console.log('Created haiku session:', haikuSession.sessionId);

  const haikuEntryBefore = getRegistryEntry(haikuSession.sessionId);
  record(
    'Registry has model=haiku at creation',
    haikuEntryBefore?.model === 'haiku',
    `model=${haikuEntryBefore?.model}`,
  );

  const haikuEvents = await client.promptStream(haikuSession.sessionId, {
    message: 'Reply with exactly: HAIKU-MODEL-CONFIRMED',
    verbosity: 'full',
  });

  const haikuText = haikuEvents
    .filter(e => e.type === 'message_update')
    .map(e => {
      const d = e.data as Record<string, unknown> | undefined;
      const msgEvent = d?.assistantMessageEvent as { delta?: string } | undefined;
      return msgEvent?.delta ?? '';
    })
    .join('');

  record(
    'Haiku session received response',
    haikuEvents.some(e => e.type === 'agent_end'),
    `text="${haikuText.slice(0, 80)}"`,
  );

  await new Promise(r => setTimeout(r, 2000));

  // Check the haiku session's Claude file
  const haikuClaudeFile = findClaudeSessionFile(cwd, haikuSession.claudeSessionId);
  if (haikuClaudeFile) {
    const { model: actualModel, messageCount } = getModelFromClaudeJsonl(haikuClaudeFile);
    const normalized = normalizeModelName(actualModel);
    record(
      'Native Claude JSONL shows haiku model',
      normalized === 'haiku',
      `file model="${actualModel}" (${messageCount} messages)`,
    );
  } else {
    // Check latest file
    const latestFile = findClaudeSessionFile(cwd);
    if (latestFile) {
      const { model: actualModel } = getModelFromClaudeJsonl(latestFile);
      const normalized = normalizeModelName(actualModel);
      record(
        'Native Claude JSONL shows haiku model',
        normalized === 'haiku',
        `latest file model="${actualModel}"`,
      );
    } else {
      record('Native Claude JSONL shows haiku model', false, 'file not found');
    }
  }

  const haikuEntryAfter = getRegistryEntry(haikuSession.sessionId);
  record(
    'Registry still has model=haiku after prompt',
    haikuEntryAfter?.model === 'haiku',
    `model=${haikuEntryAfter?.model}`,
  );

  console.log('\n=== TEST 3: Follow-up to opus session (shared PTY was contaminated by haiku) ===\n');

  // This is THE critical test: after haiku ran on the shared PTY,
  // sending a prompt to the opus session should restore opus first.
  const opusFollowupEvents = await client.promptStream(opusSession.sessionId, {
    message: 'Reply with exactly: OPUS-RESTORED-OK',
    verbosity: 'full',
  });

  const opusFollowupText = opusFollowupEvents
    .filter(e => e.type === 'message_update')
    .map(e => {
      const d = e.data as Record<string, unknown> | undefined;
      const msgEvent = d?.assistantMessageEvent as { delta?: string } | undefined;
      return msgEvent?.delta ?? '';
    })
    .join('');

  record(
    'Opus follow-up received response after haiku contamination',
    opusFollowupEvents.some(e => e.type === 'agent_end'),
    `text="${opusFollowupText.slice(0, 80)}"`,
  );

  await new Promise(r => setTimeout(r, 2000));

  // Check that opus session's model is still opus in registry
  const opusEntryFinal = getRegistryEntry(opusSession.sessionId);
  record(
    'Registry still has model=opus after haiku contamination + follow-up',
    opusEntryFinal?.model === 'opus',
    `model=${opusEntryFinal?.model}`,
  );

  // Check haiku session's model is still haiku
  const haikuEntryFinal = getRegistryEntry(haikuSession.sessionId);
  record(
    'Registry still has model=haiku after opus follow-up',
    haikuEntryFinal?.model === 'haiku',
    `model=${haikuEntryFinal?.model}`,
  );

  console.log('\n=== TEST 4: Race condition — simultaneous set_model + set_thinking_level ===\n');

  // Create a fresh session for the race test
  const raceSession = await client.createSession({
    runtime: 'claude',
    cwd,
    model: 'sonnet',
    source: 'validate-model-persistence',
    ephemeral: true,
  });

  console.log('Created race session:', raceSession.sessionId);

  // Fire set_model and set_thinking_level simultaneously
  const [modelResult, thinkingResult] = await Promise.all([
    client.controlSession(raceSession.sessionId, { action: 'set_model', modelId: 'opus' }),
    client.controlSession(raceSession.sessionId, { action: 'set_thinking_level', level: 'xhigh' }),
  ]);

  await new Promise(r => setTimeout(r, 1000));

  const raceEntry = getRegistryEntry(raceSession.sessionId);
  record(
    'Race: model=opus after simultaneous set_model+set_thinking_level',
    raceEntry?.model === 'opus',
    `model=${raceEntry?.model}`,
  );
  record(
    'Race: thinkingLevel=xhigh after simultaneous set',
    raceEntry?.thinkingLevel === 'xhigh',
    `thinkingLevel=${raceEntry?.thinkingLevel}`,
  );

  // Cleanup
  try {
    await client.deleteSession(opusSession.sessionId);
    await client.deleteSession(haikuSession.sessionId);
    await client.deleteSession(raceSession.sessionId);
  } catch { /* ephemeral */ }

  console.log('\n=== SUMMARY ===\n');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed}/${results.length} checks passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
