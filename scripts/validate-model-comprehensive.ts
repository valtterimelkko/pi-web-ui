#!/usr/bin/env npx tsx
/**
 * Comprehensive validation: model + thinking level persistence end-to-end.
 *
 * Covers gaps from the initial validation:
 * - Thinking level (effort) actually applied in Claude JSONL
 * - Haiku follow-up after opus (reverse direction)
 * - Sonnet model test
 * - Alternating model switches (opus→haiku→opus→haiku)
 * - Session reload from registry (model preserved)
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

function findLatestClaudeSessionFile(cwd: string): string | null {
  const encodedCwd = cwd.split('/').filter(Boolean).join('-');
  const projectDir = join(claudeProjectsDir, `-${encodedCwd}`);
  try {
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return null;
    const sorted = files
      .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return join(projectDir, sorted[0]!.name);
  } catch {
    return null;
  }
}

interface JsonlAnalysis {
  models: string[];
  effortCommands: string[];
  thinkingChars: number;
  messageCount: number;
  responseTexts: string[];
}

function analyzeJsonl(filePath: string): JsonlAnalysis {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const models: string[] = [];
  const effortCommands: string[] = [];
  const responseTexts: string[] = [];
  let thinkingChars = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Collect assistant models
      if (entry.type === 'assistant' && entry.message?.model) {
        models.push(entry.message.model);
      }
      // Collect /effort commands
      if (entry.type === 'user' && typeof entry.message?.content === 'string') {
        const text = entry.message.content;
        if (text.includes('/effort') || text.includes('command-args')) {
          if (text.includes('effort')) {
            const match = text.match(/command-args>(.*?)<\/command-args>/);
            if (match) effortCommands.push(match[1]!.trim());
            else if (text.match(/effort\s+(\w+)/)) {
              effortCommands.push(text.match(/effort\s+(\w+)/)![1]!);
            }
          }
        }
      }
      // Collect thinking content length
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            thinkingChars += block.thinking.length;
          }
          if (block.type === 'text' && typeof block.text === 'string') {
            responseTexts.push(block.text);
          }
        }
      }
    } catch { /* skip */ }
  }

  return { models, effortCommands, thinkingChars, messageCount: lines.length, responseTexts };
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

function extractResponseText(events: Array<{ type: string; data?: unknown }>): string {
  return events
    .filter(e => e.type === 'message_update')
    .map(e => {
      const d = e.data as Record<string, unknown> | undefined;
      const msgEvent = d?.assistantMessageEvent as { delta?: string } | undefined;
      return msgEvent?.delta ?? '';
    })
    .join('');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const cwd = '/root/pi-web-ui';

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 1: Thinking level — verify /effort appears in JSONL ===\n');

  // Create a session with xhigh thinking (maps to "high" in Claude Code)
  const xhighSession = await client.createSession({
    runtime: 'claude', cwd, model: 'opus', thinkingLevel: 'xhigh',
    source: 'validate-comprehensive', ephemeral: true,
  });
  console.log('Created xhigh session:', xhighSession.sessionId);

  const xhighEntry = getRegistryEntry(xhighSession.sessionId);
  record('Registry has thinkingLevel=xhigh', xhighEntry?.thinkingLevel === 'xhigh',
    `thinkingLevel=${xhighEntry?.thinkingLevel}`);

  await client.promptStream(xhighSession.sessionId, {
    message: 'What is 17 * 23? Think step by step.',
    verbosity: 'full',
  });
  await sleep(3000);

  const xhighFile = findLatestClaudeSessionFile(cwd);
  if (xhighFile) {
    const analysis = analyzeJsonl(xhighFile);
    console.log(`  JSONL: models=${analysis.models.slice(-3).join(',')}, effort commands=${effortCmdsToString(analysis.effortCommands)}, thinking chars=${analysis.thinkingChars}`);
    record(
      '/effort command found in JSONL for xhigh session',
      analysis.effortCommands.some(c => c.includes('high')),
      `commands=[${analysis.effortCommands.join(',')}]`,
    );
    record(
      'Thinking blocks present in xhigh response',
      analysis.thinkingChars > 0,
      `thinkingChars=${analysis.thinkingChars}`,
    );
  } else {
    record('/effort command found in JSONL for xhigh session', false, 'file not found');
    record('Thinking blocks present in xhigh response', false, 'file not found');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 2: Low thinking level — compare thinking budget ===\n');

  const lowSession = await client.createSession({
    runtime: 'claude', cwd, model: 'opus', thinkingLevel: 'low',
    source: 'validate-comprehensive', ephemeral: true,
  });
  console.log('Created low session:', lowSession.sessionId);

  await client.promptStream(lowSession.sessionId, {
    message: 'What is 17 * 23? Think step by step.',
    verbosity: 'full',
  });
  await sleep(3000);

  const lowFile = findLatestClaudeSessionFile(cwd);
  if (lowFile) {
    const analysis = analyzeJsonl(lowFile);
    console.log(`  JSONL: models=${analysis.models.slice(-3).join(',')}, effort commands=${effortCmdsToString(analysis.effortCommands)}, thinking chars=${analysis.thinkingChars}`);
    record(
      '/effort command found in JSONL for low session',
      analysis.effortCommands.some(c => c.includes('low')),
      `commands=[${analysis.effortCommands.join(',')}]`,
    );
    // Low effort should have LESS thinking than high effort
    const xhighAnalysis = xhighFile ? analyzeJsonl(xhighFile) : null;
    if (xhighAnalysis) {
      record(
        'High effort produces more thinking than low effort',
        xhighAnalysis.thinkingChars > analysis.thinkingChars,
        `xhigh=${xhighAnalysis.thinkingChars} chars vs low=${analysis.thinkingChars} chars`,
      );
    }
  } else {
    record('/effort command found in JSONL for low session', false, 'file not found');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 3: Sonnet model — create, prompt, verify ===\n');

  const sonnetSession = await client.createSession({
    runtime: 'claude', cwd, model: 'sonnet',
    source: 'validate-comprehensive', ephemeral: true,
  });
  console.log('Created sonnet session:', sonnetSession.sessionId);

  record('Registry has model=sonnet at creation',
    getRegistryEntry(sonnetSession.sessionId)?.model === 'sonnet',
    `model=${getRegistryEntry(sonnetSession.sessionId)?.model}`);

  const sonnetEvents = await client.promptStream(sonnetSession.sessionId, {
    message: 'Reply with exactly: SONNET-MODEL-CONFIRMED',
    verbosity: 'full',
  });
  const sonnetText = extractResponseText(sonnetEvents);
  record('Sonnet session received response',
    sonnetEvents.some(e => e.type === 'agent_end'),
    `text="${sonnetText.slice(0, 60)}"`);

  await sleep(3000);
  const sonnetFile = findLatestClaudeSessionFile(cwd);
  if (sonnetFile) {
    const analysis = analyzeJsonl(sonnetFile);
    const lastModel = normalizeModelName(analysis.models[analysis.models.length - 1] ?? null);
    record('Native JSONL shows sonnet model',
      lastModel === 'sonnet',
      `last model="${analysis.models[analysis.models.length - 1]}"`);
  } else {
    record('Native JSONL shows sonnet model', false, 'file not found');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 4: Alternating model switches (opus→haiku→opus→haiku) ===\n');

  // We already have opus and haiku sessions from the thinking level tests.
  // But those had different thinking levels. Let's create fresh ones.
  const altOpus = await client.createSession({
    runtime: 'claude', cwd, model: 'opus', thinkingLevel: 'medium',
    source: 'validate-comprehensive', ephemeral: true,
  });
  const altHaiku = await client.createSession({
    runtime: 'claude', cwd, model: 'haiku', thinkingLevel: 'medium',
    source: 'validate-comprehensive', ephemeral: true,
  });
  console.log('Created alt opus:', altOpus.sessionId);
  console.log('Created alt haiku:', altHaiku.sessionId);

  // Round 1: opus prompt
  console.log('\n  Round 1: opus prompt...');
  let events = await client.promptStream(altOpus.sessionId, {
    message: 'Reply with exactly: ROUND-1-OPUS', verbosity: 'full',
  });
  record('Round 1 opus response received',
    events.some(e => e.type === 'agent_end'),
    `text="${extractResponseText(events).slice(0, 40)}"`);
  await sleep(2000);

  // Round 2: haiku prompt
  console.log('  Round 2: haiku prompt...');
  events = await client.promptStream(altHaiku.sessionId, {
    message: 'Reply with exactly: ROUND-2-HAIKU', verbosity: 'full',
  });
  record('Round 2 haiku response received',
    events.some(e => e.type === 'agent_end'),
    `text="${extractResponseText(events).slice(0, 40)}"`);
  await sleep(2000);

  // Round 3: back to opus
  console.log('  Round 3: opus follow-up...');
  events = await client.promptStream(altOpus.sessionId, {
    message: 'Reply with exactly: ROUND-3-OPUS', verbosity: 'full',
  });
  record('Round 3 opus follow-up response received',
    events.some(e => e.type === 'agent_end'),
    `text="${extractResponseText(events).slice(0, 40)}"`);
  await sleep(2000);

  // Round 4: back to haiku
  console.log('  Round 4: haiku follow-up...');
  events = await client.promptStream(altHaiku.sessionId, {
    message: 'Reply with exactly: ROUND-4-HAIKU', verbosity: 'full',
  });
  record('Round 4 haiku follow-up response received',
    events.some(e => e.type === 'agent_end'),
    `text="${extractResponseText(events).slice(0, 40)}"`);
  await sleep(2000);

  // Verify registry models are preserved
  record('Alternating: opus registry still opus after 4 rounds',
    getRegistryEntry(altOpus.sessionId)?.model === 'opus',
    `model=${getRegistryEntry(altOpus.sessionId)?.model}`);
  record('Alternating: haiku registry still haiku after 4 rounds',
    getRegistryEntry(altHaiku.sessionId)?.model === 'haiku',
    `model=${getRegistryEntry(altHaiku.sessionId)?.model}`);

  // Verify the last JSONL has both opus and haiku responses in correct sequence
  const altFile = findLatestClaudeSessionFile(cwd);
  if (altFile) {
    const analysis = analyzeJsonl(altFile);
    // Look for the response texts to confirm both models were used
    const allTexts = analysis.responseTexts.join(' ');
    record('Alternating: both opus and haiku responses in JSONL',
      allTexts.includes('ROUND-1-OPUS') && allTexts.includes('ROUND-2-HAIKU') &&
      allTexts.includes('ROUND-3-OPUS') && allTexts.includes('ROUND-4-HAIKU'),
      `found texts in JSONL`);
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 5: Haiku follow-up after opus (reverse direction) ===\n');

  // After rounds 3+4, the PTY last ran haiku. Now send an opus prompt
  // then immediately a haiku follow-up to test opus→haiku restoration.
  console.log('  Sending opus prompt to contaminate PTY...');
  await client.promptStream(altOpus.sessionId, {
    message: 'Reply with exactly: CONTAMINATION-OPUS', verbosity: 'full',
  });
  await sleep(2000);

  console.log('  Sending haiku follow-up (should restore haiku on shared PTY)...');
  events = await client.promptStream(altHaiku.sessionId, {
    message: 'Reply with exactly: HAIKU-RESTORED-OK', verbosity: 'full',
  });
  const haikuRestoredText = extractResponseText(events);
  record(
    'Haiku follow-up after opus contamination received response',
    events.some(e => e.type === 'agent_end'),
    `text="${haikuRestoredText.slice(0, 60)}"`,
  );

  await sleep(2000);
  // Verify the response was actually haiku
  const reverseFile = findLatestClaudeSessionFile(cwd);
  if (reverseFile) {
    const analysis = analyzeJsonl(reverseFile);
    // Get the model of the last assistant message
    const lastModel = normalizeModelName(analysis.models[analysis.models.length - 1] ?? null);
    record(
      'Haiku follow-up response used haiku model',
      lastModel === 'haiku',
      `last model in JSONL="${analysis.models[analysis.models.length - 1] ?? 'none'}"`,
    );
  } else {
    record('Haiku follow-up response used haiku model', false, 'file not found');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 6: Session reload — model preserved in registry ===\n');

  // Verify that the registry entry for our sessions still has the correct
  // model after all the operations above. This simulates what happens on
  // page refresh: the frontend reads from the registry.
  const opusCheck = getRegistryEntry(altOpus.sessionId);
  const haikuCheck = getRegistryEntry(altHaiku.sessionId);
  const sonnetCheck = getRegistryEntry(sonnetSession.sessionId);

  record('Registry preserves opus after all operations',
    opusCheck?.model === 'opus',
    `model=${opusCheck?.model}, thinkingLevel=${opusCheck?.thinkingLevel}`);
  record('Registry preserves haiku after all operations',
    haikuCheck?.model === 'haiku',
    `model=${haikuCheck?.model}, thinkingLevel=${haikuCheck?.thinkingLevel}`);
  record('Registry preserves sonnet after all operations',
    sonnetCheck?.model === 'sonnet',
    `model=${sonnetCheck?.model}`);

  // Verify the session info API returns the correct model
  const opusInfo = await client.getSessionInfo(altOpus.sessionId);
  record(
    'Session info API returns correct model for opus',
    (opusInfo as Record<string, unknown>)?.model === 'opus' ||
    normalizeModelName((opusInfo as Record<string, string>)?.model) === 'opus',
    `model from API=${(opusInfo as Record<string, unknown>)?.model ?? 'N/A'}`,
  );

  const haikuInfo = await client.getSessionInfo(altHaiku.sessionId);
  record(
    'Session info API returns correct model for haiku',
    (haikuInfo as Record<string, unknown>)?.model === 'haiku' ||
    normalizeModelName((haikuInfo as Record<string, string>)?.model) === 'haiku',
    `model from API=${(haikuInfo as Record<string, unknown>)?.model ?? 'N/A'}`,
  );

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== TEST 7: Thinking level persistence across prompts ===\n');

  const thinkSession = await client.createSession({
    runtime: 'claude', cwd, model: 'opus', thinkingLevel: 'high',
    source: 'validate-comprehensive', ephemeral: true,
  });
  console.log('Created thinking session:', thinkSession.sessionId);

  // Send first prompt
  await client.promptStream(thinkSession.sessionId, {
    message: 'Reply with exactly: THINK-1', verbosity: 'full',
  });
  await sleep(5000);

  // Check thinking level is still high after prompt
  const thinkEntry = getRegistryEntry(thinkSession.sessionId);
  record('Thinking level=high preserved after first prompt',
    thinkEntry?.thinkingLevel === 'high',
    `thinkingLevel=${thinkEntry?.thinkingLevel}`);

  // Send second prompt (follow-up) — retry if busy
  let secondOk = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.promptStream(thinkSession.sessionId, {
        message: 'Reply with exactly: THINK-2', verbosity: 'full',
      });
      secondOk = true;
      break;
    } catch {
      await sleep(5000);
    }
  }
  await sleep(2000);

  const thinkEntry2 = getRegistryEntry(thinkSession.sessionId);
  record('Thinking level=high preserved after second prompt',
    thinkEntry2?.thinkingLevel === 'high',
    `thinkingLevel=${thinkEntry2?.thinkingLevel}`);

  // ═══════════════════════════════════════════════════════════════════
  // Cleanup
  console.log('\n=== Cleanup ===\n');
  for (const sid of [
    xhighSession.sessionId, lowSession.sessionId, sonnetSession.sessionId,
    altOpus.sessionId, altHaiku.sessionId, thinkSession.sessionId,
  ]) {
    try { await client.deleteSession(sid); } catch { /* ephemeral */ }
  }

  console.log('\n=== SUMMARY ===\n');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed}/${results.length} checks passed, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailed checks:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  ❌ ${r.name}${r.details ? ` — ${r.details}` : ''}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

function effortCmdsToString(cmds: string[]): string {
  return cmds.length > 0 ? `[${cmds.join(',')}]` : 'none';
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
