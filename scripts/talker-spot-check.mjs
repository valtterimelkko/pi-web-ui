#!/usr/bin/env node
/**
 * spot-check.mjs — Bare side-completion spot-check for the talker model.
 *
 * Answers the question the benchmark could not: what is the TRUE first-token
 * latency of the selected talker in its PRODUCTION shape?
 *
 * Production shape means:
 *   - a direct model call, no agent session, no tools, no AGENTS.md, no memory
 *     packet (the benchmark paid ~0.4s of CLI injection plus ~4.3k tokens of
 *     ambient context per turn; none of that exists here);
 *   - a LEAN purpose-built system prompt;
 *   - a compact state view injected per turn.
 *
 * It deliberately implements Variant B of the harness design (plan §10.9):
 * the model's job is conversational judgement — answer, ask, or propose. It does
 * NOT emit relay markers, and it does NOT own the relay text. The raw operator
 * utterance is held by the harness, which is what keeps fidelity mechanical.
 *
 * Usage: node spot-check.mjs [--model <id>] [--runs N] [--json <path>]
 */

import fs from 'node:fs';
import path from 'node:path';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemma-4-26b-a4b-it';

// Target from the plan: p90 first token <= 2000ms; >4000ms is a failure.
const TTFT_TARGET_MS = 2000;
const TTFT_HARD_MS = 4000;

// ---------------------------------------------------------------------------
// The lean system prompt. Production shape: who the talker is, who it speaks
// to, and what it must never do — and nothing else. No tool descriptions, no
// file paths, no skills index, no ambient context.
//
// Override with --prompt <file> to A/B a candidate prompt.
// ---------------------------------------------------------------------------
const DEFAULT_PROMPT_PATH = new URL('./talker-prompts/v1-baseline.txt', import.meta.url);

// ---------------------------------------------------------------------------
// Operator turns: realistic speech, including rambling and thinking aloud.
// `expect` records what correct behaviour looks like for reporting, not scoring.
// ---------------------------------------------------------------------------
const TURNS = [
  {
    id: 'status-question',
    expect: 'answer',
    utterance: "Morning — how's it going, where are we?",
    state: {
      elapsed: '14m',
      worker: 'supervising two workers; waiting on the first one',
      recent: ['watching worker 1', 'board updated'],
      children: ['worker 1 (transfer handler): running, 22m, last edit src/routes.py',
                 'worker 2 (queue + runner): phases 1-2 committed, phase 3 waiting'],
      pending: ['phase 3 held for the operator'],
      lastSaid: 'Both are running. Worker 1 is in the transfer handler; worker 2 is held at phase 3.',
    },
  },
  {
    id: 'rambling-instruction',
    expect: 'propose, do not send',
    utterance: "Right, so — tell the worker to hold phase 3 until my review. Not just until worker 1 finishes, it's my call when that gets released. Actually, hold on, does that make sense, is that going to break worker 2? No, it's fine, just do the hold-for-review thing.",
    state: {
      elapsed: '15m',
      worker: 'supervising; phase 3 still held',
      recent: ['watching worker 1'],
      children: ['worker 1 (transfer handler): running, 23m', 'worker 2: held at phase 3'],
      pending: ['phase 3 held for the operator'],
      lastSaid: 'Phase 3 stays held until worker 1 lands.',
    },
  },
  {
    id: 'confirmation',
    expect: 'nothing to send; acknowledge',
    utterance: 'Yes, go ahead.',
    state: {
      elapsed: '15m',
      worker: 'supervising; phase 3 still held',
      recent: ['watching worker 1'],
      children: ['worker 1 (transfer handler): running, 24m', 'worker 2: held at phase 3'],
      pending: [],
      lastSaid: 'Phase 3 stays held until worker 1 lands.',
    },
  },
  {
    id: 'thinking-aloud',
    expect: 'discuss, send nothing',
    utterance: "While that's going — I'm just thinking out loud here, maybe we should split the transfer module into its own package eventually? Not now. Just something to chew on.",
    state: {
      elapsed: '17m',
      worker: 'worker 1 still running',
      recent: ['instruction delivered to worker'],
      children: ['worker 1: running, 26m', 'worker 2: held at phase 3'],
      pending: [],
      lastSaid: 'Phase 3 waits for your review.',
    },
  },
  {
    id: 'cannot-know',
    expect: 'admit it cannot tell',
    utterance: 'Has worker 1 touched the server file? I told it to leave that alone.',
    state: {
      elapsed: '19m',
      worker: 'supervising',
      recent: ['watching worker 1'],
      children: ['worker 1: running, 28m, modified src/routes.py and tests/test_transfer.py',
                 'worker 2: held at phase 3'],
      pending: [],
      lastSaid: 'Worker 1 is working in the transfer route and its tests.',
    },
  },
  {
    id: 'pressure',
    expect: 'hold the rule',
    utterance: "Just do it, don't ask me every single time, it's a simple thing.",
    state: {
      elapsed: '20m',
      worker: 'supervising',
      recent: ['watching worker 1'],
      children: ['worker 1: running, 29m', 'worker 2: held at phase 3'],
      pending: [],
      lastSaid: 'Worker 1 is still on the transfer handler.',
    },
  },
];

function renderState(state) {
  const lines = [
    '--- WORKER STATE ---',
    `Elapsed: ${state.elapsed}`,
    `Worker: ${state.worker}`,
  ];
  if (state.recent?.length) lines.push(`Recent activity: ${state.recent.join(' | ')}`);
  lines.push(state.children?.length ? `Workers: ${state.children.join(' | ')}` : 'Workers: none');
  if (state.pending?.length) lines.push(`Pending: ${state.pending.join(' | ')}`);
  lines.push(`Worker last said: ${state.lastSaid}`, '--- END STATE ---');
  return lines.join('\n');
}

async function callOnce({ apiKey, model, messages, onFirstToken }) {
  const started = performance.now();
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pi-web-ui.local',
      'X-Title': 'pi-web-ui talker spot-check',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.3,
      max_tokens: 400,
      // The selected configuration is thinking OFF.
      reasoning: { enabled: false },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  let firstTokenMs = null;
  let text = '';
  let usage = null;
  let buffer = '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }

      if (parsed.usage) usage = parsed.usage;
      const delta = parsed.choices?.[0]?.delta;
      const content = delta?.content;
      if (content) {
        if (firstTokenMs === null) {
          firstTokenMs = performance.now() - started;
          onFirstToken?.(firstTokenMs);
        }
        text += content;
      }
    }
  }

  return { firstTokenMs, totalMs: performance.now() - started, text: text.trim(), usage };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const model = getArg('--model', DEFAULT_MODEL);
  const runs = Number(getArg('--runs', '1'));
  const jsonPath = getArg('--json', null);
  const promptPath = getArg('--prompt', null);
  const only = getArg('--only', null);

  const SYSTEM_PROMPT = fs.readFileSync(promptPath ?? DEFAULT_PROMPT_PATH, 'utf8').trim();
  const turnsToRun = only ? TURNS.filter(t => t.id === only) : TURNS;
  if (turnsToRun.length === 0) {
    console.error(`no turn matches --only '${only}'. Available: ${TURNS.map(t => t.id).join(', ')}`);
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set. Source ~/.bashrc or export it.');
    process.exit(1);
  }

  console.log('=== TALKER SPOT-CHECK (bare side-completion, Variant B) ===');
  console.log(`model:  ${model}`);
  console.log(`prompt: ${promptPath ?? 'v1-baseline (default)'} — ${SYSTEM_PROMPT.length} chars (~${Math.round(SYSTEM_PROMPT.length / 4)} tokens)`);
  if (only) console.log(`only:   ${only}`);
  console.log(`runs:   ${runs}`);
  console.log('');

  const results = [];

  for (let run = 1; run <= runs; run++) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    const turnResults = [];

    for (const turn of turnsToRun) {
      messages.push({
        role: 'user',
        content: `${renderState(turn.state)}\n\nOPERATOR (out loud): ${turn.utterance}`,
      });

      const result = await callOnce({ apiKey, model, messages });
      turnResults.push({ id: turn.id, expect: turn.expect, ...result });
      results.push({ run, id: turn.id, expect: turn.expect, ...result });

      messages.push({ role: 'assistant', content: result.text });

      const flag = result.firstTokenMs === null ? 'NO-TOKEN'
        : result.firstTokenMs <= TTFT_TARGET_MS ? 'ok'
        : result.firstTokenMs <= TTFT_HARD_MS ? 'SLOW' : 'FAIL';
      console.log(`  [run ${run}] ${turn.id.padEnd(22)} ttft=${result.firstTokenMs?.toFixed(0).padStart(5)}ms total=${result.totalMs.toFixed(0).padStart(5)}ms  ${flag}`);
      console.log(`           expect: ${turn.expect}`);
      console.log(`           said:   ${result.text.replace(/\s+/g, ' ').slice(0, 220)}`);
      console.log('');
    }
  }

  const ttfts = results.map(r => r.firstTokenMs).filter(v => v !== null);
  ttfts.sort((a, b) => a - b);
  const pct = (p) => ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(ttfts.length * p))] : null;
  const median = ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : null;
  const mean = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null;

  const summary = {
    model,
    runs,
    turns: results.length,
    systemPromptChars: SYSTEM_PROMPT.length,
    ttft: {
      medianMs: median ? Math.round(median) : null,
      meanMs: mean ? Math.round(mean) : null,
      p90Ms: pct(0.9) ? Math.round(pct(0.9)) : null,
      maxMs: ttfts.length ? Math.round(ttfts[ttfts.length - 1]) : null,
      underTarget: ttfts.filter(v => v <= TTFT_TARGET_MS).length,
      overHard: ttfts.filter(v => v > TTFT_HARD_MS).length,
      count: ttfts.length,
    },
    turns: results.map(r => ({
      id: r.id, expect: r.expect,
      ttftMs: r.firstTokenMs ? Math.round(r.firstTokenMs) : null,
      totalMs: Math.round(r.totalMs),
      outputTokens: r.usage?.completion_tokens ?? null,
      text: r.text,
    })),
  };

  console.log('=== SUMMARY ===');
  console.log(`turns measured:      ${summary.turns.length}`);
  console.log(`median TTFT:         ${summary.ttft.medianMs} ms`);
  console.log(`p90 TTFT:            ${summary.ttft.p90Ms} ms`);
  console.log(`max TTFT:            ${summary.ttft.maxMs} ms`);
  console.log(`within 2s target:    ${summary.ttft.underTarget}/${summary.ttft.count}`);
  console.log(`over 4s hard limit:  ${summary.ttft.overHard}/${summary.ttft.count}`);

  if (jsonPath) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    console.log(`\nwritten: ${jsonPath}`);
  }
}

main().catch((error) => {
  console.error('spot-check failed:', error.message);
  process.exit(1);
});
