#!/usr/bin/env node
/**
 * Fault-injection WebSocket proxy for the talker transport probe (RED run).
 *
 * Sits between scripts/ws-validate.mjs (--step talker, via --ws-url) and the
 * disposable validation server and DROPS the first N server→client frames of
 * a given message type (default: talker_turn_result). This simulates the
 * exact failure mode the probe exists to catch — a silent transport drop —
 * so the probe's failure path can be shown failing for the RIGHT reason
 * before the clean run is attempted.
 *
 * Usage:
 *   node scripts/talker-drop-proxy.mjs <upstreamBase> [listenPort] [dropType] [maxDrops]
 *   e.g. node scripts/talker-drop-proxy.mjs http://localhost:3097 3098 talker_turn_result 1
 *
 * Login HTTP still goes straight to the upstream (the probe's --base); only
 * the /ws upgrade + frames pass through here. Evidence of each drop is logged
 * to stderr.
 */
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');

const upstreamBase = process.argv[2] ?? 'http://localhost:3097';
const listenPort = Number(process.argv[3] ?? 3098);
const dropType = process.argv[4] ?? 'talker_turn_result';
const maxDrops = Number(process.argv[5] ?? 1);
const upstreamWsUrl = upstreamBase.replace(/^http/, 'ws') + '/ws';

let drops = 0;

const server = http.createServer((req, res) => {
  // Best-effort HTTP passthrough (not used by the probe, but keeps the
  // proxy honest if something does hit it).
  const up = http.request(
    upstreamBase + req.url,
    { method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end('proxy upstream error');
  });
  req.pipe(up);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (client, req) => {
  const upstream = new WebSocket(upstreamWsUrl, {
    headers: {
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      ...(req.headers.origin ? { origin: req.headers.origin } : {}),
    },
  });

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
  });

  upstream.on('message', (data) => {
    let dropped = false;
    if (drops < maxDrops) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === dropType) {
          dropped = true;
          drops += 1;
          console.error(`[drop-proxy] DROPPED server→client frame #${drops} of type ${dropType}: ${data.toString().slice(0, 200)}`);
        }
      } catch {
        // non-JSON frame — pass through untouched
      }
    }
    if (!dropped && client.readyState === WebSocket.OPEN) client.send(data);
  });

  const teardown = () => {
    try { client.close(); } catch { /* already closed */ }
  };
  upstream.on('error', (e) => {
    console.error(`[drop-proxy] upstream error: ${e.message}`);
    teardown();
  });
  upstream.on('close', teardown);
  client.on('error', () => upstream.close());
  client.on('close', () => upstream.close());
});

server.listen(listenPort, '127.0.0.1', () => {
  console.error(`[drop-proxy] ws://127.0.0.1:${listenPort}/ws → ${upstreamWsUrl} (dropping first ${maxDrops} ${dropType} frames)`);
});
