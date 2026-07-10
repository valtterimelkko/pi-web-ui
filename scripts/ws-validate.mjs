#!/usr/bin/env node
/**
 * Browser-WebSocket live validation — drive a session over the exact same
 * authenticated WebSocket path the browser UI uses (cookie login + /ws).
 *
 * This is the third live-validation option (see docs/LIVE-VALIDATION.md).
 * Use it to validate behaviours that only exist on the browser path and are
 * invisible to the Internal API:
 *   - extension slash commands and their `notification` toasts
 *   - the browser-native `compact` message (the UI intercepts `/compact`
 *     client-side and sends {type:'compact'}, not a prompt)
 *   - any WebSocket protocol message in shared/src/protocol-types.ts
 *
 * Always target a DISPOSABLE validation server (npm run validate:server),
 * never production, unless the user explicitly authorised production.
 * The validation server must be booted with a known AUTH_PASSWORD; when
 * NODE_ENV=production (common because of .env), it must be a bcrypt hash:
 *
 *   HASH=$(node -e "console.log(require('bcrypt').hashSync('validation-pass',10))")
 *   AUTH_PASSWORD="$HASH" npm run validate:server -- --dir /tmp/pi-vc --port 3093 \
 *     --claude-ws-port 43210 --claude-hook-port 43211 --opencode-port 44197
 *
 * Usage:
 *   node scripts/ws-validate.mjs --session <sessionPath> --step <step> [--text "..."]
 *     [--base http://localhost:3093] [--password validation-pass]
 *     [--origin https://tmux.letsautomate.work] [--timeout 90000]
 *
 * Steps:
 *   command  Send --text as-is (e.g. "/autocompact75"); succeeds on the first
 *            `notification` received AFTER the command was sent (session-start
 *            notifications from other extensions are recorded but ignored).
 *            Pass --expect <substring> to only accept a matching notification.
 *            Extension commands run without an LLM turn.
 *   prompt   Send --text as an LLM prompt; succeeds on `agent_end`.
 *   compact  Send the browser-native {type:'compact'} message; succeeds on a
 *            clean `compaction_end` / `compaction_result`.
 *   resume   Send --text as an LLM prompt and require the auto-compact-75
 *            resume chain: a compaction must fire during/after the run and the
 *            agent must then continue on its own (an assistant message_end
 *            after compaction_end, then agent_end). Fails fast if the run
 *            completes with no compaction. Use a session seeded past the 75%
 *            threshold and a prompt that forces tool use.
 *
 * Output: one JSON object with `verdict` ("OK ..." exit 0, otherwise exit 1)
 * and the captured `events` as evidence. Paste that JSON into your report.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const sessionPath = flag('session');
const step = flag('step');
const text = flag('text', '');
const expect = flag('expect', '');
const base = flag('base', 'http://localhost:3093');
const password = flag('password', process.env.WS_VALIDATE_PASSWORD ?? 'validation-pass');
// Origin must be in the server's allowed-origins list (see startup log line
// "Allowed origins: ..."). The production .env value is the usual default.
const origin = flag('origin', 'https://tmux.letsautomate.work');
const timeoutMs = Number(
  flag('timeout', step === 'prompt' ? '120000' : step === 'resume' ? '420000' : '90000'),
);

if (!sessionPath || !['command', 'prompt', 'compact', 'resume'].includes(step ?? '')) {
  console.error('Usage: ws-validate.mjs --session <sessionPath> --step command|prompt|compact|resume [--text "..."]');
  process.exit(2);
}
if ((step === 'command' || step === 'prompt' || step === 'resume') && !text) {
  console.error(`--text is required for step "${step}"`);
  process.exit(2);
}

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.error(
    `login failed: ${login.status} ${await login.text()} — boot the validation server with a known AUTH_PASSWORD (bcrypt hash when NODE_ENV=production; see header comment)`,
  );
  process.exit(1);
}
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, { headers: { cookie, origin } });
const events = [];
let done = false;
let sent = false;
let compactionStarted = false;
let compactionEnded = false;
let assistantAfterCompaction = false;

function finish(verdict) {
  if (done) return;
  done = true;
  console.log(JSON.stringify({ verdict, step, sessionPath, events }, null, 1));
  ws.close();
  process.exit(verdict.startsWith('OK') ? 0 : 1);
}

setTimeout(() => finish(`TIMEOUT after ${timeoutMs}ms`), timeoutMs);

ws.on('error', (e) => finish(`WS ERROR: ${e.message} — is the validation server up and the origin allowed?`));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  const t = msg.type;

  if (t === 'authenticated') {
    // Bind this client to the session, exactly like opening it in the browser.
    ws.send(JSON.stringify({ type: 'switch_session', sessionPath }));
    setTimeout(() => {
      if (step === 'compact') {
        ws.send(JSON.stringify({ type: 'compact', sessionId: sessionPath }));
      } else {
        // 'prompt' and 'resume' both send a normal prompt; they differ in
        // what event sequence counts as success.
        ws.send(JSON.stringify({ type: 'prompt', sessionId: sessionPath, message: text }));
      }
      sent = true;
    }, 1500);
    return;
  }

  if (t === 'notification') {
    events.push({ notification: msg.notification, beforeSend: !sent || undefined });
    if (!sent) return; // session-start noise from other extensions
    if (expect && !msg.notification.message.includes(expect)) return;
    if (step === 'command') finish('OK notification received');
    if (step === 'compact' && /compaction failed|summarization failed/i.test(msg.notification.message)) {
      finish(`FAILED: ${msg.notification.message}`);
    }
    return;
  }

  if (t === 'compaction_result') {
    events.push({ compaction_result: msg });
    if (step === 'compact') finish(msg.error ? `FAILED compaction_result: ${msg.error}` : 'OK compaction_result');
    return;
  }

  if (t === 'error') {
    events.push({ error: msg });
    finish(`FAILED server error: ${msg.message ?? JSON.stringify(msg)}`);
    return;
  }

  if (t === 'session_event') {
    // Pi events are forwarded with their fields directly on `event`
    // (see server/src/pi/event-forwarder.ts), not under `event.data`.
    const e = msg.event ?? {};
    const et = e.type;
    if (['compaction_start', 'compaction_end', 'agent_end', 'extension_error'].includes(et)) {
      events.push({
        event: et,
        ...(et === 'compaction_start' ? { reason: e.reason } : {}),
        ...(et === 'compaction_end'
          ? { aborted: e.aborted, errorMessage: e.errorMessage, tokensBefore: e.result?.tokensBefore }
          : {}),
      });
    }
    if (step === 'resume') {
      // Success = compaction fired during the run AND the agent continued by
      // itself afterwards (assistant output post-compaction, then agent_end).
      if (et === 'turn_end') {
        events.push({ event: et, stopReason: e.message?.stopReason });
      }
      if (et === 'message_start' && e.message?.role === 'custom') {
        events.push({ event: et, role: 'custom', customType: e.message.customType });
      }
      if (et === 'compaction_start') compactionStarted = true;
      if (et === 'compaction_end') {
        if (e.errorMessage) finish(`FAILED compaction_end: ${e.errorMessage}`);
        else compactionEnded = true;
      }
      if (et === 'message_start' && compactionEnded && e.message?.role === 'assistant') {
        assistantAfterCompaction = true;
      }
      if (et === 'agent_end') {
        const msgs = Array.isArray(e.messages) ? e.messages : [];
        const lastAssistant = [...msgs].reverse().find((m) => m?.role === 'assistant');
        const textOf = (m) => Array.isArray(m?.content)
          ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ').slice(0, 300)
          : undefined;
        events.push({
          event: et,
          lastAssistantStopReason: lastAssistant?.stopReason,
          lastAssistantText: textOf(lastAssistant),
        });
        if (compactionEnded && assistantAfterCompaction) {
          finish('OK resumed after compaction: agent continued and completed the task');
        } else if (!compactionStarted) {
          // Give compaction_start a grace window: ctx.compact() aborts the
          // run first, so this agent_end can race ahead of compaction_start.
          setTimeout(() => {
            if (!compactionStarted) {
              finish('FAILED: agent run completed without any compaction — threshold never fired');
            }
          }, 20000);
        }
        // else: this agent_end belongs to the run the compaction aborted;
        // keep waiting for the auto-resumed run.
      }
      return;
    }
    if (step === 'prompt' && et === 'agent_end') finish('OK agent_end');
    if (step === 'compact' && et === 'compaction_end') {
      finish(e.errorMessage || e.aborted
        ? `FAILED compaction_end: ${JSON.stringify({ aborted: e.aborted, errorMessage: e.errorMessage })}`
        : 'OK compaction_end');
    }
  }
});
