#!/usr/bin/env node
/**
 * gemma-provider-quality-probe.ts — H5 provider-quality measurement, re-runnable.
 *
 * Why: google/gemma-4-26b-a4b-it is served by ~11 OpenRouter inference providers
 * and several serve it degenerate (thought-channel leak, empty content, runaway
 * repetition). The talker client (server/src/talker/model-client.ts) carries a
 * provider PREFERENCE built from this measurement. Re-run this probe when the
 * provider set changes and update TALKER_PREFERRED_PROVIDERS.
 *
 * Modes:
 *   1. Per-provider pin (default): identical request — real system prompt, a
 *      16-turn assistant history (the leak only appears once there is assistant
 *      history), reasoning off — pinned to ONE provider via
 *      `provider: { order: [p], allow_fallbacks: false }`, N samples each.
 *      Reports ok/empty/leak/repetition breakdown + latency per provider.
 *   2. `--client-calls N`: N direct calls through the production client
 *      (preference + degenerate guard + bounded retry). Expect degenerate=0;
 *      reports retries and providers seen. This is the acceptance check.
 *
 * The degenerate VERDICT uses isDegenerateReply from the production client so
 * probe and runtime can never drift; the breakdown below is reporting only.
 *
 * Usage:
 *   source ~/.bashrc   # OPENROUTER_API_KEY
 *   npx tsx scripts/gemma-provider-quality-probe.ts [--samples 4] [--providers a,b,c]
 *   npx tsx scripts/gemma-provider-quality-probe.ts --client-calls 12
 *
 * Never production: this talks only to the public OpenRouter API, like the
 * other talker probes.
 */

import fs from 'node:fs';
import { isDegenerateReply, OpenRouterTalkerClient, resolveTalkerModelConfig } from '../server/src/talker/model-client.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemma-4-26b-a4b-it';
const API_KEY = process.env.OPENROUTER_API_KEY;

const KNOWN_PROVIDERS = [
  'deepinfra', 'darkbloom', 'novita', 'dekallm', 'nextbit', 'google',
  'cloudflare', 'venice', 'parasail', 'makora', 'siliconflow',
];

const SYSTEM = fs.readFileSync(
  new globalThis.URL('./talker-prompts/v3-harness.txt', import.meta.url),
  'utf8',
).trim();

// The leak is history-dependent: a zero-history request is always clean.
// 16 turns (8 user / 8 assistant) reproduce the condition the table measured.
function history16() {
  const turns = [];
  for (let i = 1; i <= 8; i++) {
    turns.push({ role: 'user', content: `Status check ${i} — where are we?` });
    turns.push({ role: 'assistant', content: `Worker 1 is ${i % 2 ? 'running the transfer handler' : 'still on the transfer handler'}; worker 2 stays held at phase 3 until your review. Nothing needs you yet.` });
  }
  return turns;
}

const FINAL_UTTERANCE = 'Right — tell the worker to hold phase 3 until my review, not just until worker 1 finishes.';

function classify(text) {
  const t = (text ?? '').trim();
  if (!t) return 'empty';
  if (/<\|channel>|<channel\|>/.test(t)) return 'leak';
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size / words.length < 0.3) return 'repetition';
  if (words.length >= 8 && words.filter(w => w === 'thought').length / words.length > 0.4) return 'repetition';
  return 'ok';
}

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
}

async function pinnedCall(provider) {
  const started = performance.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pi-web-ui.local',
      'X-Title': 'gemma-provider-quality-probe',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        ...history16(),
        { role: 'user', content: `--- WORKER STATE ---\nElapsed: 47m\nWorker: supervising two workers; waiting on the first one\n--- END STATE ---\n\nOPERATOR (out loud): ${FINAL_UTTERANCE}` },
      ],
      stream: true,
      temperature: 0.3,
      max_tokens: 400,
      reasoning: { enabled: false },
      provider: { order: [provider], allow_fallbacks: false },
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}`, text: '', ttftMs: null, totalMs: null, provider: null };
  let text = '';
  let ttftMs = null;
  let servedBy = res.headers?.get?.('x-provider') ?? null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      if (j.provider) servedBy = j.provider;
      const c = j.choices?.[0]?.delta?.content;
      if (c) {
        if (ttftMs === null) ttftMs = performance.now() - started;
        text += c;
      }
    }
  }
  return { error: null, text, ttftMs, totalMs: performance.now() - started, provider: servedBy };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)]);
}

async function perProviderMode(samples, providers) {
  console.log(`=== PROVIDER QUALITY (model ${MODEL}, ${samples} samples/provider, pinned, 16-turn history) ===\n`);
  console.log('provider      ok     empty leak  rep   err   medianTTFT  served-as');
  const verdicts = {};
  for (const p of providers) {
    const kinds = { ok: 0, empty: 0, leak: 0, repetition: 0, error: 0 };
    const ttfts = [];
    const served = new Set();
    for (let i = 0; i < samples; i++) {
      let out;
      try { out = await pinnedCall(p); }
      catch (e) { out = { error: String(e).slice(0, 80), text: '', ttftMs: null }; }
      if (out.error) { kinds.error++; continue; }
      kinds[classify(out.text)]++;
      if (out.ttftMs !== null) ttfts.push(out.ttftMs);
      if (out.provider) served.add(out.provider);
    }
    // The verdict that matters is the PRODUCTION checker, not the breakdown.
    const n = samples;
    const degenerate = kinds.empty + kinds.leak + kinds.repetition + kinds.error;
    verdicts[p] = { viable: n - degenerate, n };
    console.log(
      p.padEnd(13)
      + `${kinds.ok}/${n}`.padEnd(7)
      + `${kinds.empty}`.padEnd(6)
      + `${kinds.leak}`.padEnd(6)
      + `${kinds.repetition}`.padEnd(6)
      + `${kinds.error}`.padEnd(6)
      + `${median(ttfts) ?? '—'}ms`.padEnd(12)
      + [...served].join(','),
    );
    const bad = kinds.empty + kinds.leak + kinds.repetition;
    if (bad + kinds.error > 0) console.log(`              ^ NOT safe to prefer (${bad} degenerate, ${kinds.error} errors)`);
  }
  console.log('\nVerdict (via production isDegenerateReply):');
  for (const [p, v] of Object.entries(verdicts)) console.log(`  ${p.padEnd(13)} ${v.viable}/${v.n} viable`);
}

async function clientCallsMode(calls) {
  console.log(`=== PRODUCTION CLIENT CHECK (${calls} direct calls through OpenRouterTalkerClient) ===\n`);
  const client = new OpenRouterTalkerClient(resolveTalkerModelConfig());
  const messages = [
    { role: 'system', content: SYSTEM },
    ...history16(),
    { role: 'user', content: `--- WORKER STATE ---\nElapsed: 47m\nWorker: supervising two workers; waiting on the first one\n--- END STATE ---\n\nOPERATOR (out loud): ${FINAL_UTTERANCE}` },
  ];
  let degenerate = 0;
  let retries = 0;
  const providers = new Set();
  const ttfts = [];
  const totals = [];
  for (let i = 0; i < calls; i++) {
    try {
      const r = await client.completeTurn(messages);
      retries += r.retries;
      if (isDegenerateReply(r.text)) degenerate++;
      if (r.provider) providers.add(r.provider);
      if (r.ttftMs !== null) ttfts.push(r.ttftMs);
      totals.push(r.totalMs);
      console.log(`  #${i + 1} ok retries=${r.retries} provider=${r.provider ?? '?'} ttft=${Math.round(r.ttftMs ?? -1)}ms text=${JSON.stringify(r.text.slice(0, 60))}`);
    } catch (e) {
      degenerate++;
      console.log(`  #${i + 1} FAILED after bounded retry: ${String(e.message).slice(0, 140)}`);
    }
  }
  console.log(`\nDegenerate/failures: ${degenerate}/${calls}   retries: ${retries}   providers: ${[...providers].join(',') || '?'}`);
  console.log(`median TTFT ${median(ttfts)}ms   median total ${median(totals)}ms`);
}

async function main() {
  if (!API_KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }
  const clientCalls = Number(arg('--client-calls', 0));
  if (clientCalls > 0) {
    await clientCallsMode(clientCalls);
    return;
  }
  const samples = Number(arg('--samples', 4));
  const providers = (arg('--providers', null) || KNOWN_PROVIDERS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  await perProviderMode(samples, providers);
}

main().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
