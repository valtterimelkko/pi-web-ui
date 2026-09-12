#!/usr/bin/env node
/**
 * gemma-degeneracy-probe.mjs — measure Gemma's output-instability rate directly.
 *
 * The question: H3 and H4 independently saw empty replies and "thought" repetition
 * loops. Is that reproducible, at what rate, and does it depend on a parameter we
 * control (temperature / max_tokens / reasoning field)?
 *
 * Method: hold the prompt fixed (the real production system prompt + one realistic
 * state view) and vary one thing at a time, N samples each. Classify each reply as
 * ok / empty / repetition, and report the rate per condition.
 *
 * Usage: node scripts/gemma-degeneracy-probe.mjs [--samples 8]
 */

import fs from 'node:fs';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemma-4-26b-a4b-it';
const API_KEY = process.env.OPENROUTER_API_KEY;

const SYSTEM = fs.readFileSync(
  new globalThis.URL('./talker-prompts/v3-harness.txt', import.meta.url),
  'utf8',
).trim();

const STATE = `--- WORKER STATE ---
Elapsed: 47m
Worker: supervising two workers; waiting on the first one
Recent activity: watching worker 1 | board updated
Workers: worker 1 (transfer handler): running, 47m, last edit src/routes.py | worker 2 (queue + runner): phases 1-2 committed, phase 3 held
Pending: phase 3 held for the operator
Worker last said: Both are running. Worker 1 is in the transfer handler; worker 2 is held at phase 3.
--- END STATE ---`;

const UTTERANCE = 'Right, so — tell the worker to hold phase 3 until my review, not just until worker 1 finishes.';
const TURN = `${STATE}\n\nOPERATOR (out loud): ${UTTERANCE}`;

function classify(text) {
  const t = (text ?? '').trim();
  if (t.length === 0) return 'empty';
  // runaway repetition: one token repeated many times, or very low unique-word ratio
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 12) {
    const unique = new Set(words).size;
    if (unique / words.length < 0.22) return 'repetition';
    const first = words[0];
    if (words.filter(w => w === first).length / words.length > 0.5) return 'repetition';
  }
  return 'ok';
}

async function call({ temperature, maxTokens, reasoning, extraBody = {} }) {
  const started = performance.now();
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: TURN },
    ],
    stream: true,
    temperature,
    max_tokens: maxTokens,
    ...(reasoning ? { reasoning } : {}),
  };
  // `__pad` is probe-only filler: prepend it to the system message rather than
  // sending an unknown body field the provider would reject.
  if (extraBody.__pad) {
    body.messages[0] = { role: 'system', content: extraBody.__pad + '\n\n' + body.messages[0].content };
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://pi-web-ui.local',
      'X-Title': 'gemma-degeneracy-probe',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    return { error: `HTTP ${res.status}: ${t.slice(0, 200)}`, text: '', ttftMs: null, totalMs: null, provider: null, usage: null };
  }

  let text = '';
  let buffer = '';
  let ttftMs = null;
  let provider = res.headers.get('x-provider') ?? null;
  let usage = null;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
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
      if (j.provider) provider = j.provider;
      if (j.usage) usage = j.usage;
      const delta = j.choices?.[0]?.delta;
      const c = delta?.content;
      if (c) {
        if (ttftMs === null) ttftMs = performance.now() - started;
        text += c;
      }
    }
  }
  return { text, ttftMs, totalMs: performance.now() - started, provider, usage, error: null };
}

function summarise(label, samples) {
  const kinds = { ok: 0, empty: 0, repetition: 0, error: 0 };
  const ttfts = [];
  const providers = new Set();
  for (const s of samples) {
    if (s.error) { kinds.error++; continue; }
    kinds[classify(s.text)]++;
    if (s.ttftMs) ttfts.push(s.ttftMs);
    if (s.provider) providers.add(s.provider);
  }
  const n = samples.length;
  const pct = (v) => `${((v / n) * 100).toFixed(0)}%`;
  const med = ttfts.length ? Math.round(ttfts.sort((a, b) => a - b)[Math.floor(ttfts.length / 2)]) : null;
  console.log(`  ${label.padEnd(34)} ok=${kinds.ok}/${n} (${pct(kinds.ok)})  empty=${kinds.empty} (${pct(kinds.empty)})  rep=${kinds.repetition} (${pct(kinds.repetition)})  err=${kinds.error}  medianTTFT=${med}ms  providers=${[...providers].join(',') || 'n/a'}`);
  return { label, kinds, n, med };
}

async function main() {
  const samples = Number(process.argv.includes('--samples') ? process.argv[process.argv.indexOf('--samples') + 1] : 8);
  if (!API_KEY) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

  console.log(`=== GEMMA DEGENERACY PROBE (model ${MODEL}, ${samples} samples/condition) ===\n`);

  // H4's degeneracy appeared on LONG-CONTEXT turns, so the hypothesis under test
  // is context length rather than any parameter we control. PAD adds filler to the
  // system prompt to simulate a long conversation's templated prompt size.
  const PAD = 'You are a careful assistant. '.repeat(Number(process.argv.includes('--pad') ? process.argv[process.argv.indexOf('--pad') + 1] : 0));
  const conds = [
    { label: 'production shape (off, temp .3)', opts: { temperature: 0.3, maxTokens: 400, reasoning: { enabled: false } } },
  ];
  for (const pad of [200, 600, 1500]) {
    conds.push({ label: `off + ${pad} filler lines`, opts: { temperature: 0.3, maxTokens: 400, reasoning: { enabled: false }, extraBody: { __pad: PAD.repeat(pad) } } });
  }
  const conditions = conds;

  const results = [];
  for (const c of conditions) {
    const out = [];
    for (let i = 0; i < samples; i++) {
      try { out.push(await call(c.opts)); }
      catch (e) { out.push({ error: String(e).slice(0, 120), text: '' }); }
    }
    results.push(summarise(c.label, out));
    // show a sample of any failure so the shape is visible
    const bad = out.find(s => !s.error && classify(s.text) !== 'ok');
    if (bad) console.log(`      e.g. [${classify(bad.text)}] ${JSON.stringify((bad.text || '(empty)').slice(0, 90))}`);
  }

  console.log('\n=== VERDICT ===');
  const prod = results[0];
  const unstable = prod.kinds.empty + prod.kinds.repetition + prod.kinds.error;
  console.log(`production shape instability: ${unstable}/${prod.n} (${((unstable / prod.n) * 100).toFixed(0)}%)`);
  const best = results.filter(r => r.kinds.error === 0).sort((a, b) => (a.kinds.empty + a.kinds.repetition) - (b.kinds.empty + b.kinds.repetition))[0];
  if (best) console.log(`most stable condition: ${best.label} (${best.kinds.empty + best.kinds.repetition} failures)`);
}

main().catch(e => { console.error('probe failed:', e.message); process.exit(1); });
