#!/usr/bin/env node
/**
 * Digest behaviour probe — does the talker stop narrating routine housekeeping?
 *
 * Operator, 2026-09-16: "the talker summarising me what the worker has captured
 * … is not useful" — the spoken digest narrated the memory-capture housekeeping
 * a routine Agent OS injection produces, and the substantive work took several
 * turns to get out of it.
 *
 * The fix is prompt-level (scripts/talker-prompts/digest.txt + the talker's own
 * system prompt), so it can only be judged against a real model. This probe
 * sends the SAME worker turns through the real `talker_digest` seam on a
 * disposable server and records what comes back, so the before/after is
 * evidence rather than assertion.
 *
 * Usage:
 *   node digest-probe.mjs --label before|after [--out <json>]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const OPS = process.env.VOICE_RELAY_OPS ?? '/root/pi-web-ui/operations/voice-relay-20260916';
const base = flag('base', 'http://127.0.0.1:3531');
const origin = flag('origin', 'http://127.0.0.1:3532');
const password = flag('password', 'voice-lab-pass');
const label = flag('label', 'after');
const outPath = flag('out', path.join(OPS, 'evidence', 'digest-probe.json'));
const timeoutMs = Number(flag('timeout', '120000'));

// The four shapes that matter. The first is the operator's complaint verbatim
// in structure: a routine capture turn that says nothing about the real work.
const CASES = [
  {
    id: 'housekeeping-only',
    kind: 'summary',
    text: [
      'Agent OS session-end memory capture (automated delivery by the D3 write lane). Run your agent os capture skill now and submit the outcome.',
      'Ran the agent-os capture skill. Two candidates were extracted and written as pending: cand-3v2h6l8qnb (parallel bash tool calls are a validated pattern) and cand-3v2kditwcp (the lane cap of three is deliberate). Evidence written to evidence/manual/captures/capture-3v2cf21gnj.md. Nothing was promoted; both await owner review.',
    ].join('\n'),
  },
  {
    id: 'headlines-housekeeping',
    kind: 'headlines',
    text: 'Agent OS session-end memory capture. Ran the capture skill; one pending candidate created (cand-9f2a); evidence saved to evidence/manual/captures/capture-9f2a.md. Nothing promoted.',
  },
  {
    id: 'housekeeping-then-work',
    kind: 'summary',
    text: [
      'Agent OS session-end memory capture — ran the capture skill, one candidate pending, evidence saved.',
      'Then I fixed the relay: the delivery now loads an idle worker before prompting, added four tests, and re-ran the suite (4500 passing). One decision is waiting on you: whether the reading level should apply to all lanes.',
    ].join('\n'),
  },
  {
    id: 'plain-work',
    kind: 'summary',
    text: 'Ported the restart guard to the weekly catalogue script and wired it into the wrapper. Full server suite green (4500 tests). Nothing waiting on you.',
  },
];

const report = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : { runs: {} };
const write = () => {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
};

let ws = null;
let reqSeq = 0;
const frames = [];
const waiters = [];

function waitFor(pred, labelText, ms = timeoutMs) {
  const hit = frames.find((f) => { try { return pred(f); } catch { return false; } });
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${labelText}`));
    }, ms);
  });
}

async function main() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie, Origin: origin } });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    frames.push(msg);
    for (let i = 0; i < waiters.length; i += 1) {
      let matched = false;
      try { matched = waiters[i].pred(msg); } catch { matched = false; }
      if (matched) {
        const w = waiters.splice(i, 1)[0];
        i -= 1;
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await waitFor((m) => m.type === 'authenticated', 'authenticated');

  const results = {};
  for (const c of CASES) {
    const requestId = `d${++reqSeq}-${c.id}`;
    ws.send(JSON.stringify({
      type: 'talker_digest',
      requestId,
      workerSessionId: 'digest-probe',
      runtime: 'pi',
      kind: c.kind,
      text: c.text,
    }));
    const msg = await waitFor((m) => m.type === 'talker_digest_result' && m.requestId === requestId, `digest ${c.id}`).catch(() => null);
    results[c.id] = { kind: c.kind, digest: msg?.digest ?? null, raw: msg ?? null };
    console.log(`[${label}] ${c.id} → ${JSON.stringify(results[c.id].digest)?.slice(0, 400)}`);
  }

  report.runs[label] = { at: new Date().toISOString(), results };
  write();
  ws.close();
  console.log(`\n=== ${outPath} (run: ${label})`);
}

main().catch((err) => {
  report.runs[`${label}-FATAL`] = String(err?.stack ?? err);
  write();
  process.exit(1);
});
