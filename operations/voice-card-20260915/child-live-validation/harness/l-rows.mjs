#!/usr/bin/env node
/**
 * W2b — live validation of the confirmation-card contract on a DISPOSABLE server.
 *
 * Drives `talker_turn` over the real browser WebSocket seam exactly as the
 * browser does (cookie login → /ws → talker_turn), against a disposable
 * `npm run validate:server` instance whose talker is pointed at the local
 * deterministic stub (harness/talker-stub.mjs). No hosted model is called by
 * the talker on this lane.
 *
 * Rows L1–L7 of the W2b brief. Raw frames are recorded for every row; the bytes
 * behind each verdict are in the row's `frames`.
 *
 * Usage:
 *   node l-rows.mjs --base http://localhost:43167 --origin https://pi.letsautomate.work \
 *     --password validation-pass --out <evidence.json> [--model <selector>] [--rows L1,L2]
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

const base = flag('base', 'http://localhost:43167');
const origin = flag('origin', 'https://pi.letsautomate.work');
const password = flag('password', process.env.WS_VALIDATE_PASSWORD ?? 'validation-pass');
const outPath = flag('out', '/tmp/w2b-rows.json');
const workerModel = flag('model', undefined);
const only = (flag('rows', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const timeoutMs = Number(flag('timeout', '60000'));

// The two utterances the brief names, byte-exact.
const UTTERANCE_NEWLINE = 'Proceed.\n';
const UTTERANCE_TIDY = 'Um, tell the worker to rerun the suite';
const CONFIRM = 'yes, go ahead';
const META_SEND_QUESTION = 'did you send it?';
const CANCEL = 'no, cancel that';

const rows = [];
const allFrames = [];
let ws = null;
const waiters = [];

function send(obj, tag) {
  const frame = JSON.stringify(obj);
  allFrames.push({ tag, dir: 'sent', frame });
  ws.send(frame);
}

function frameFor(msg, tag) {
  allFrames.push({ tag, dir: 'recv', frame: JSON.stringify(msg) });
}

function waitFor(pred, label, ms = timeoutMs) {
  return new Promise((resolve, reject) => {
    const existing = pendingFrames.find((f) => { try { return pred(f); } catch { return false; } });
    if (existing) { resolve(existing); return; }
    const w = { pred, resolve, label };
    waiters.push(w);
    setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i !== -1) waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, ms);
  });
}
const pendingFrames = [];

let reqSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One talker_turn over the wire; returns { result, error, sentFrame, received } */
async function talkerTurn(utterance, opts = {}) {
  const requestId = opts.requestId ?? `r${++reqSeq}`;
  const outbound = {
    type: 'talker_turn',
    workerSessionId: opts.workerSessionId,
    utterance,
    runtime: 'pi',
    requestId,
    ...(opts.releaseVariant !== undefined ? { releaseVariant: opts.releaseVariant } : {}),
  };
  pendingFrames.length = 0;
  send(outbound, opts.tag ?? requestId);
  const wantResult = opts.waitForResult !== false;
  let result = null;
  let error = null;
  if (wantResult) {
    // Both waiters race; the loser's timeout rejection is swallowed so it can
    // never become an unhandled rejection.
    const settled = await Promise.race([
      waitFor((m) => m.type === 'talker_turn_result' && m.requestId === requestId, `result ${requestId}`)
        .then((m) => ({ kind: 'result', m }))
        .catch(() => null),
      waitFor((m) => m.type === 'error' && m.requestId === requestId, `error ${requestId}`)
        .then((m) => ({ kind: 'error', m }))
        .catch(() => null),
    ]);
    if (!settled) throw new Error(`no talker_turn_result and no error frame for ${requestId}`);
    if (settled.kind === 'result') result = settled.m;
    else error = settled.m;
    if (opts.settleMs) await sleep(opts.settleMs);
  }
  return { requestId, outbound, result, error };
}

async function makeWorkerSession(label) {
  const requestId = `ns-${label}`;
  send({ type: 'new_session', requestId, ...(workerModel ? { model: workerModel } : {}) }, requestId);
  const created = await waitFor((m) => m.type === 'session_created' && m.requestId === requestId, `session_created ${label}`, 120000);
  // The pi branch of `new_session` ignores its `model` field (connection.ts
  // createAndSubscribe takes no model), so the model must be applied through
  // the browser's own set_model message and confirmed by `model_changed`.
  if (workerModel) {
    send({ type: 'set_model', modelId: workerModel }, `set_model-${label}`);
    const changed = await waitFor((m) => m.type === 'model_changed' && m.modelId !== undefined, `model_changed ${label}`, 60000);
    created.modelChangedTo = changed.modelId;
  }
  return created;
}

/** Read the worker transcript for a delivered user message with EXACTLY these bytes. */
function transcriptHasExactBytes(sessionPath, expected) {
  try {
    if (!sessionPath || !fs.existsSync(sessionPath)) return { found: false, detail: 'session file not found' };
    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean);
    const userTexts = [];
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== 'message' || e?.message?.role !== 'user') continue;
      const c = e.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '';
      userTexts.push(text);
    }
    return { found: userTexts.includes(expected), detail: `user messages=${userTexts.length}`, userTexts };
  } catch (err) {
    return { found: false, detail: `read error: ${err?.message ?? err}` };
  }
}

async function waitForExactBytes(sessionPath, expected, ms = 25000) {
  const deadline = Date.now() + ms;
  let last = { found: false, detail: 'not checked' };
  for (;;) {
    last = transcriptHasExactBytes(sessionPath, expected);
    if (last.found || Date.now() > deadline) return last;
    await sleep(500);
  }
}

function record({ row, drove, expected, observed, verdict, frames }) {
  rows.push({ row, drove, expected, observed, verdict, frames });
  console.log(`${verdict === 'PASS' ? '✅' : verdict === 'FAIL' ? '❌' : '⚠️ '} [${row}] ${observed}`);
}

const j = (v) => JSON.stringify(v);

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
    pendingFrames.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      let matched = false;
      try { matched = waiters[i].pred(msg); } catch { matched = false; }
      if (matched) {
        const w = waiters.splice(i, 1)[0];
        i--;
        w.resolve(msg);
      }
    }
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  await waitFor((m) => m.type === 'authenticated', 'authenticated');

  const workerModelReported = [];

  // ── L1 — the operator's own reported case: an utterance ending in a newline ──
  if (!only.length || only.includes('L1')) {
    const s = await makeWorkerSession('L1');
    workerModelReported.push({ row: 'L1', session: s.sessionPath ?? s.sessionId, model: s.model ?? null });
    const t = await talkerTurn(UTTERANCE_NEWLINE, { workerSessionId: s.sessionPath, tag: 'L1' });
    const r = t.result;
    const p = r?.proposal;
    const rawKeys = r ? Object.keys(r) : [];
    const proposalKeys = p ? Object.keys(p) : [];
    const ok =
      r?.phase === 'proposed'
      && p?.text === 'Proceed.'
      && p?.cleaned === false
      && !proposalKeys.includes('removed')
      && !proposalKeys.includes('original');
    record({
      row: 'L1',
      drove: `talker_turn {utterance: ${j(UTTERANCE_NEWLINE)}} on a fresh pi worker session`,
      expected: 'phase=proposed; proposal.text="Proceed."; cleaned=false; NO removed key; NO original key',
      observed: `phase=${j(r?.phase)} proposal=${j(p)} resultKeys=${j(rawKeys)}`,
      verdict: ok ? 'PASS' : 'FAIL',
      frames: [t.outbound, r],
    });
  }

  // ── L2 + L3 — visible tidy, then the default confirm ──────────────────────
  let l2Proposal = null;
  if (!only.length || only.includes('L2') || only.includes('L3')) {
    const s = await makeWorkerSession('L2L3');
    workerModelReported.push({ row: 'L2/L3', session: s.sessionPath ?? s.sessionId, model: s.model ?? null });
    const t2 = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: s.sessionPath, tag: 'L2' });
    l2Proposal = t2.result?.proposal ?? null;
    const p = l2Proposal;
    const ok2 =
      t2.result?.phase === 'proposed'
      && p?.cleaned === true
      && typeof p?.removed === 'string'
      && p.removed.length > 0
      && p.removed !== UTTERANCE_TIDY
      && !p.removed.includes(UTTERANCE_TIDY)
      && p?.original === UTTERANCE_TIDY;
    record({
      row: 'L2',
      drove: `talker_turn {utterance: ${j(UTTERANCE_TIDY)}} on a fresh pi worker session`,
      expected: 'phase=proposed; cleaned=true; removed = fragments only (never the whole utterance); original = the raw utterance',
      observed: `proposal=${j(p)} (removed is a fragment subset: ${typeof p?.removed === 'string' && !p.removed.includes(UTTERANCE_TIDY)})`,
      verdict: ok2 ? 'PASS' : 'FAIL',
      frames: [t2.outbound, t2.result],
    });

    if (!only.length || only.includes('L3')) {
      const t3 = await talkerTurn(CONFIRM, { workerSessionId: s.sessionPath, tag: 'L3' });
      const released = t3.result?.released ?? null;
      const delivery = released?.delivery ?? null;
      const landed = await waitForExactBytes(s.sessionPath, released?.text ?? '\u0000none');
      const ok3 =
        t3.result?.phase === 'released'
        && released?.text === (p?.text ?? null)
        && (delivery?.outcome === 'delivered' || delivery?.outcome === 'queued')
        && landed.found === true;
      record({
        row: 'L3',
        drove: `talker_turn {utterance: ${j(CONFIRM)}} (default confirm) after L2`,
        expected: 'phase=released; released.text byte-identical to L2 proposal.text; the delivery adapter reports the same bytes and the worker transcript holds exactly those bytes',
        observed: `phase=${j(t3.result?.phase)} released.text=${j(released?.text)} proposal.text=${j(p?.text)} delivery=${j(delivery)} transcript=${j(landed)}`,
        verdict: ok3 ? 'PASS' : 'FAIL',
        frames: [t3.outbound, t3.result],
      });
    }
  }

  // ── L4 — original-variant confirm after a fresh L2 utterance ──────────────
  if (!only.length || only.includes('L4')) {
    const s = await makeWorkerSession('L4');
    workerModelReported.push({ row: 'L4', session: s.sessionPath ?? s.sessionId, model: s.model ?? null });
    const t2 = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: s.sessionPath, tag: 'L4-proposal' });
    const p = t2.result?.proposal ?? null;
    const t4 = await talkerTurn(CONFIRM, { workerSessionId: s.sessionPath, releaseVariant: 'original', tag: 'L4-confirm' });
    const released = t4.result?.released ?? null;
    const landed = await waitForExactBytes(s.sessionPath, released?.text ?? '\u0000none');
    const ok4 = t4.result?.phase === 'released' && p?.original !== undefined && released?.text === p.original
      && released?.text !== p.text && landed.found === true;
    record({
      row: 'L4',
      drove: `talker_turn {utterance: ${j(UTTERANCE_TIDY)}} then talker_turn {utterance: ${j(CONFIRM)}, releaseVariant: "original"}`,
      expected: 'phase=released; released.text byte-identical to that turn\'s proposal.original (and NOT proposal.text); the transcript holds those bytes',
      observed: `proposal.original=${j(p?.original)} proposal.text=${j(p?.text)} released.text=${j(released?.text)} delivery=${j(released?.delivery)} transcript=${j(landed)}`,
      verdict: ok4 ? 'PASS' : 'FAIL',
      frames: [t2.outbound, t2.result, t4.outbound, t4.result],
    });
  }

  // ── L5 — a NON-confirm utterance carrying releaseVariant must not release ──
  if (!only.length || only.includes('L5')) {
    // L5a: fresh session, statement + variant → drafts as usual, releases nothing.
    const sA = await makeWorkerSession('L5a');
    const tA = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: sA.sessionPath, releaseVariant: 'original', tag: 'L5a' });
    // Control: identical utterance with no variant, fresh session.
    const sB = await makeWorkerSession('L5a-control');
    const tB = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: sB.sessionPath, tag: 'L5a-control' });
    const pA = tA.result?.proposal ?? null;
    const pB = tB.result?.proposal ?? null;
    const okA =
      tA.result?.phase === 'proposed'
      && !tA.result?.released
      && tA.result?.cancelled === false
      && j(pA) === j(pB);
    record({
      row: 'L5a',
      drove: `statement ${j(UTTERANCE_TIDY)} WITH releaseVariant "original" on a fresh session; control: the same utterance WITHOUT the variant on another fresh session`,
      expected: 'phase=proposed (never released); released null; the draft payload is unchanged by the variant (identical to the control)',
      observed: `variantTurn phase=${j(tA.result?.phase)} released=${j(tA.result?.released)} proposal(A)=${j(pA)}; control phase=${j(tB.result?.phase)} proposal(B)=${j(pB)} identical=${j(pA) === j(pB)}`,
      verdict: okA ? 'PASS' : 'FAIL',
      frames: [tA.outbound, tA.result, tB.outbound, tB.result],
    });

    // L5b: an ALREADY-HELD draft + a non-confirm meta question carrying the
    // variant → nothing released, draft untouched, and the draft still
    // releases normally afterwards.
    const sC = await makeWorkerSession('L5b');
    const t1 = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: sC.sessionPath, tag: 'L5b-draft' });
    const before = t1.result?.proposal ?? null;
    const t2 = await talkerTurn(META_SEND_QUESTION, { workerSessionId: sC.sessionPath, releaseVariant: 'original', tag: 'L5b-mid' });
    const after = t2.result?.proposal ?? null;
    const t3 = await talkerTurn(CONFIRM, { workerSessionId: sC.sessionPath, tag: 'L5b-late-confirm' });
    const okB =
      t1.result?.phase === 'proposed'
      && t2.result?.phase === 'proposed'
      && !t2.result?.released
      && j(before) === j(after)
      && t3.result?.phase === 'released'
      && t3.result?.released?.text === before?.text;
    record({
      row: 'L5b',
      drove: `draft held, then ${j(META_SEND_QUESTION)} WITH releaseVariant "original", then a plain default confirm`,
      expected: 'the variant-carrying non-confirm turn releases nothing and leaves the draft byte-identical; the later default confirm still releases the draft',
      observed: `midTurn phase=${j(t2.result?.phase)} released=${j(t2.result?.released)} draftBefore=${j(before)} draftAfter=${j(after)} identical=${j(before) === j(after)}; laterConfirm phase=${j(t3.result?.phase)} released.text=${j(t3.result?.released?.text)}`,
      verdict: okB ? 'PASS' : 'FAIL',
      frames: [t1.outbound, t1.result, t2.outbound, t2.result, t3.outbound, t3.result],
    });
  }

  // ── L6 — an invalid variant fails the message schema, and nothing is emitted ──
  if (!only.length || only.includes('L6')) {
    const s = await makeWorkerSession('L6');
    const t = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: s.sessionPath, releaseVariant: 'raw', tag: 'L6' });
    const resultSeen = t.result !== null;
    const ok6 = t.error?.code === 'INVALID_MESSAGE' && resultSeen === false;
    record({
      row: 'L6',
      drove: `talker_turn {utterance: ${j(UTTERANCE_TIDY)}, releaseVariant: "raw"} (invalid enum)`,
      expected: 'an error frame with code INVALID_MESSAGE; NO talker_turn_result for that requestId',
      observed: `error=${j(t.error)} talker_turn_result seen=${resultSeen}`,
      verdict: ok6 ? 'PASS' : 'FAIL',
      frames: [t.outbound, t.error ?? t.result],
    });
    // A valid variant on the same path is accepted (the schema is not
    // over-restrictive) — proves the L6 failure is about the value, not the field.
    const tValid = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: s.sessionPath, releaseVariant: 'tidied', tag: 'L6-control' });
    record({
      row: 'L6-control',
      drove: `talker_turn {utterance: ${j(UTTERANCE_TIDY)}, releaseVariant: "tidied"} (valid enum, same field)`,
      expected: 'accepted on the wire (proposed), proving the field itself is valid',
      observed: `phase=${j(tValid.result?.phase)} error=${j(tValid.error)}`,
      verdict: tValid.result?.phase === 'proposed' && !tValid.error ? 'PASS' : 'FAIL',
      frames: [tValid.outbound, tValid.result ?? tValid.error],
    });
  }

  // ── L7 — a LAPSED draft refuses the original variant exactly as before ─────
  if (!only.length || only.includes('L7')) {
    const MAX_PENDING_AGE_TURNS = 6; // server/src/talker/talker.ts default
    const sV = await makeWorkerSession('L7-variant');
    const tDraft = await talkerTurn(UTTERANCE_TIDY, { workerSessionId: sV.sessionPath, tag: 'L7-draft' });
    for (let i = 0; i < MAX_PENDING_AGE_TURNS; i += 1) {
      await talkerTurn(META_SEND_QUESTION, { workerSessionId: sV.sessionPath, tag: `L7-age-${i + 1}` });
    }
    const tVariant = await talkerTurn(CONFIRM, { workerSessionId: sV.sessionPath, releaseVariant: 'original', tag: 'L7-confirm-original' });
    // Control: the same lapse with the DEFAULT variant — the refusal must be the
    // same, i.e. the variant does not widen the gate.
    const sT = await makeWorkerSession('L7-control');
    await talkerTurn(UTTERANCE_TIDY, { workerSessionId: sT.sessionPath, tag: 'L7-control-draft' });
    for (let i = 0; i < MAX_PENDING_AGE_TURNS; i += 1) {
      await talkerTurn(META_SEND_QUESTION, { workerSessionId: sT.sessionPath, tag: `L7-control-age-${i + 1}` });
    }
    const tControl = await talkerTurn(CONFIRM, { workerSessionId: sT.sessionPath, tag: 'L7-control-confirm' });
    const refusalShape = (m) => m?.result?.released === null
      && m?.result?.cancelled === false
      && typeof m?.result?.reply === 'string'
      && m.result.reply.startsWith('You were composing something');
    const ok7 =
      refusalShape(tVariant)
      && refusalShape(tControl)
      && tVariant.result?.reply === tControl.result?.reply
      && tVariant.result?.phase !== 'released';
    record({
      row: 'L7',
      drove: `${MAX_PENDING_AGE_TURNS} non-draft-touching turns after the draft, then a confirm WITH releaseVariant "original"; control: the same lapse with the default variant`,
      expected: 'the existing re-confirmation refusal (release refused, draft intact, reply quotes the held draft) — identical with and without the variant',
      observed: `variant: phase=${j(tVariant.result?.phase)} released=${j(tVariant.result?.released)} reply=${j((tVariant.result?.reply ?? '').slice(0, 90))}; control: phase=${j(tControl.result?.phase)} released=${j(tControl.result?.released)} sameReply=${tVariant.result?.reply === tControl.result?.reply}`,
      verdict: ok7 ? 'PASS' : 'FAIL',
      frames: [tDraft.outbound, tDraft.result, tVariant.outbound, tVariant.result, tControl.outbound, tControl.result],
    });
  }

  ws.close();
  const fails = rows.filter((r) => r.verdict === 'FAIL');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    at: new Date().toISOString(),
    base,
    origin,
    workerModel: workerModel ?? '(server default)',
    workerModelReported,
    rows,
    frames: allFrames,
  }, null, 2));
  console.log(`\nrows: ${rows.length}, PASS: ${rows.length - fails.length}, FAIL: ${fails.length} → ${outPath}`);
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('W2b L-ROWS FAILED:', err?.message ?? err);
  try {
    fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), error: String(err?.message ?? err), rows, frames: allFrames }, null, 2));
  } catch { /* best effort */ }
  process.exit(2);
});
