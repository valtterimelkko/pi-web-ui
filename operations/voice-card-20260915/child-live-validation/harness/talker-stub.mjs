#!/usr/bin/env node
/**
 * W2b — deterministic local talker stub (zero cost, byte-deterministic).
 *
 * The talker client (server/src/talker/model-client.ts) is OpenAI-compatible and
 * env-configured (TALKER_BASE_URL / TALKER_API_KEY / TALKER_MODEL), and it
 * consumes an SSE stream. This stub answers POST /v1/chat/completions with a
 * fixed, non-marker reply and records every request body verbatim, so the
 * disposable server never touches a hosted model on this lane.
 *
 * Usage: node talker-stub.mjs --port 3917 --log <file.jsonl>
 */
import http from 'node:http';
import fs from 'node:fs';

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const port = Number(flag('port', '3917'));
const logPath = flag('log', '/tmp/w2b-talker-stub.jsonl');
// Fixed, non-marker reply: no [[to-talker]], no [[ask-worker]] — a statement
// turn therefore joins the draft, which is exactly the surface under test.
const REPLY = flag('reply', 'Noted — I am holding that for your go-ahead.');

let seq = 0;
fs.mkdirSync(logPath.replace(/\/[^/]+$/, ''), { recursive: true });

function sse(text) {
  // Chunked in two deltas so the client's streaming reader is exercised, then
  // a terminal finish chunk with usage — the shape a real OpenAI-compatible
  // endpoint sends and the shape pi's agent loop expects when the SAME stub is
  // used as a worker model (zero hosted calls anywhere on this lane).
  const mid = Math.ceil(text.length / 2);
  const parts = [text.slice(0, mid), text.slice(mid)].filter(Boolean);
  const frames = [
    `data: ${JSON.stringify({ id: 'stub', provider: 'local-stub', choices: [{ delta: { role: 'assistant', content: parts[0] ?? '' } }] })}\n\n`,
    ...parts.slice(1).map((part) =>
      `data: ${JSON.stringify({ id: 'stub', provider: 'local-stub', choices: [{ delta: { content: part } }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ id: 'stub', provider: 'local-stub', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
  ];
  return frames.join('') + 'data: [DONE]\n\n';
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seq += 1;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* keep raw */ }
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const record = {
      seq,
      at: new Date().toISOString(),
      auth: req.headers.authorization ?? null,
      model: parsed?.model ?? null,
      stream: parsed?.stream ?? null,
      messageCount: messages.length,
      lastUserContent: typeof lastUser?.content === 'string' ? lastUser.content : lastUser?.content ?? null,
      reply: REPLY,
    };
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-provider': 'local-stub',
    });
    res.end(sse(REPLY));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ event: 'talker-stub-listening', port, logPath, reply: REPLY }));
});
