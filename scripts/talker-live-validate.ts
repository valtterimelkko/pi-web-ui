#!/usr/bin/env npx tsx
/**
 * H6 live validation: the talker integration against a REAL busy Pi worker.
 *
 * Constructs the REAL integration graph in this process — the same objects the
 * running server builds:
 *   real PiService + real MultiSessionManager (as connection.ts constructs it),
 *   real TalkerSessionRegistry wired with that manager,
 *   real createDefaultDeliveries (pi adapter from the same manager),
 *   real OpenRouter talker model (TALKER_API_KEY / OPENROUTER_API_KEY).
 *
 * Scenario (the H6 outcome, end to end):
 *   1. create a disposable Pi session (isolated SESSION_DIR — nothing lands in
 *      the operator's session store) and start a SLOW multi-step task;
 *   2. conversational turn — the talker answers from a fresh state view;
 *   3. instruction turn — the talker proposes; the transcript must NOT yet
 *      contain the instruction (nothing is sent);
 *   4. confirm turn — the gate releases the operator's VERBATIM utterance
 *      through the pi delivery adapter (mid-run steer) and speaks the fixed
 *      acknowledgement;
 *   5. read the session transcript: the steered user message must equal the
 *      operator's utterance BYTE-FOR-BYTE, and must have arrived while the
 *      worker was busy (before the slow task finished).
 *
 * Isolation: disposable tmp dirs for SESSION_DIR / SESSION_REGISTRY_PATH /
 * CLAUDE_SESSION_DIR / ANTIGRAVITY_SESSION_DIR. No production pi-web-ui
 * process, socket, or session store is touched. Auth is read-only shared
 * (~/.pi/agent), exactly like every disposable validation run.
 *
 * Usage:
 *   env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS npx tsx scripts/talker-live-validate.ts \
 *     [--keep]   # keep the temp dir for forensics
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}

function fail(msg: string): never {
  console.error(`❌ FAIL — ${msg}`);
  process.exit(1);
}

// ── Isolation FIRST (before any server module reads config) ───────────────
const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talker-live-'));
const piSessionsDir = path.join(validationDir, 'pi-sessions');
fs.mkdirSync(piSessionsDir, { recursive: true });
process.env.SESSION_DIR = piSessionsDir;
process.env.SESSION_REGISTRY_PATH = path.join(validationDir, 'session-registry.json');
process.env.CLAUDE_SESSION_DIR = path.join(validationDir, 'claude-sessions');
process.env.ANTIGRAVITY_SESSION_DIR = path.join(validationDir, 'antigravity-sessions');
const workspaceDir = path.join(validationDir, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });
log(`isolation dir: ${validationDir}`);

if (!process.env.TALKER_API_KEY && !process.env.OPENROUTER_API_KEY) {
  fail('talker model key missing: source ~/.bashrc (TALKER_API_KEY / OPENROUTER_API_KEY)');
}

const OPERATOR_STATUS_QUESTION = 'how is the worker doing right now?';
const OPERATOR_INSTRUCTION =
  'Please tell the worker to reply with exactly TALKER-RELAY-OK once it finishes the current task.';
const OPERATOR_CONFIRMATION = 'yes, go ahead';
const SLOW_PROMPT =
  'Run exactly 4 Bash calls strictly one at a time (never batch them), each running: sleep 15 . ' +
  'Only after all four have finished, reply with exactly: SLOW-TASK-DONE';

interface UserMessageRecord { role: string; text: string; timestamp: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => (typeof p === 'string' ? p : isRecord(p) && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function readUserMessages(sessionFile: string): UserMessageRecord[] {
  const out: UserMessageRecord[] = [];
  for (const line of fs.readFileSync(sessionFile, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue;
    const msg = entry.message;
    if (msg.role !== 'user') continue;
    out.push({ role: 'user', text: textFromContent(msg.content), timestamp: String(entry.timestamp ?? '') });
  }
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  fail(`timeout waiting for ${label}`);
}

async function main(): Promise<void> {
const { getPiService } = await import('../server/src/pi/index.js');
const { MultiSessionManager } = await import('../server/src/pi/multi-session-manager.js');
const { TalkerSessionRegistry } = await import('../server/src/talker/session-registry.js');

// ── Build the real integration graph (what the server builds) ─────────────
const piService = getPiService();
await piService.initialize();
const manager = new MultiSessionManager(piService, () => {}, {
  enableMemoryMonitoring: false,
  cleanupIntervalMs: 60_000,
});
// The registry's DEFAULT deliveries path — createDefaultDeliveries({ multiSessionManager })
// — is exercised, i.e. the production pi adapter wired from this manager instance.
const registry = new TalkerSessionRegistry({ multiSessionManager: manager });
log('real graph constructed: PiService + MultiSessionManager + TalkerSessionRegistry (default deliveries)');

// ── Disposable Pi worker session ──────────────────────────────────────────
const worker = await manager.createAndSubscribe('talker-live-operator', workspaceDir);
const sessionPath = worker.sessionPath;
log(`worker session created: ${sessionPath}`);

// 1. Make the worker BUSY on a slow multi-step task.
  const promptPromise = manager.prompt(sessionPath, SLOW_PROMPT).catch(err => {
    log(`worker prompt resolved/errored: ${err instanceof Error ? err.message : String(err)}`);
  });
  await waitFor(() => {
    const status = manager.getSessionStatus(sessionPath)?.status;
    return status === 'busy' || status === 'streaming';
  }, 60_000, 'worker to become busy');
  log(`worker is BUSY (status=${manager.getSessionStatus(sessionPath)?.status}) — slow task running`);

  // 2. Conversational turn — fresh state view.
  const statusTurn = await registry.handleOperatorTurn({ workerSessionId: sessionPath, utterance: OPERATOR_STATUS_QUESTION });
  log(`talker (status question): "${statusTurn.reply.replace(/\s+/g, ' ').slice(0, 160)}"`);
  if (!statusTurn.turn?.modelCalled) fail('status question did not reach the talker model');

  // 3. Instruction turn — propose; NOTHING may be sent.
  const proposeTurn = await registry.handleOperatorTurn({ workerSessionId: sessionPath, utterance: OPERATOR_INSTRUCTION });
  if ((proposeTurn.turn?.released ?? null) !== null) fail('instruction turn released — gate breach');
  let userMessages = readUserMessages(sessionPath);
  if (userMessages.some(m => m.text.includes('TALKER-RELAY-OK'))) {
    fail('instruction text reached the worker BEFORE confirmation — gate breach');
  }
  log(`talker (proposal): "${proposeTurn.reply.replace(/\s+/g, ' ').slice(0, 160)}"`);
  log('verified: transcript contains NO relay text before confirmation (nothing was sent)');

  // 4. Confirm turn — the gate releases the operator's verbatim words.
  const confirmTurn = await registry.handleOperatorTurn({ workerSessionId: sessionPath, utterance: OPERATOR_CONFIRMATION });
  const released = confirmTurn.turn?.released ?? null;
  if (!released || released.text !== OPERATOR_INSTRUCTION) fail('confirm turn did not release the verbatim instruction');
  if (released.delivery.outcome !== 'delivered') {
    fail(`delivery did not report delivered: ${JSON.stringify(released.delivery)}`);
  }
  if (confirmTurn.reply !== 'sending that now') fail(`unexpected ack: ${confirmTurn.reply}`);
  log(`gate released via mechanism=${released.delivery.mechanism} (disclosure=${released.delivery.disclosure ?? 'none'})`);
  log(`ack spoken: "${confirmTurn.reply}"`);

  // 5. Worker-received proof: transcript user message equals the utterance byte-for-byte.
  await promptPromise;
  await waitFor(() => manager.getSessionStatus(sessionPath)?.status === 'idle', 120_000, 'worker to go idle');

  userMessages = readUserMessages(sessionPath);
  const received = userMessages.filter(m => m.text.includes('TALKER-RELAY-OK'));
  if (received.length === 0) fail('relayed instruction never appeared in the worker transcript');
  const exact = received.find(m => m.text === OPERATOR_INSTRUCTION);
  log('── worker-received user messages containing the relay ──');
  for (const m of received) {
    log(`  [${m.timestamp}] ${JSON.stringify(m.text)}`);
  }
  if (!exact) fail(`byte-for-byte mismatch: operator sent ${JSON.stringify(OPERATOR_INSTRUCTION)}`);

  // Ordering proof (structured): the steered user message must arrive MID-RUN —
  // i.e. the run continued after it (assistant/tool activity following the steer
  // entry) and the run's final assistant text is the relayed acknowledgement.
  // (The slow-task PROMPT itself contains the done marker, so marker-grepping
  // is meaningless here; the steer legitimately redirects how the run ends.)
  interface EntryRecord { role: string; text: string }
  const entries: EntryRecord[] = [];
  for (const line of fs.readFileSync(sessionPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e: unknown = JSON.parse(line);
      if (!isRecord(e) || e.type !== 'message' || !isRecord(e.message)) continue;
      entries.push({ role: String(e.message.role), text: textFromContent(e.message.content) });
    } catch { /* skip */ }
  }
  const steerEntryIdx = entries.findIndex(e => e.role === 'user' && e.text === OPERATOR_INSTRUCTION);
  const lastAssistantIdx = entries.map(e => e.role).lastIndexOf('assistant');
  const finalAssistant = entries[lastAssistantIdx]?.text ?? '';
  log(`entry order: steer-user@${steerEntryIdx}, last-assistant@${lastAssistantIdx} (run continued after steer: ${lastAssistantIdx > steerEntryIdx})`);
  log(`final assistant text: ${JSON.stringify(finalAssistant.slice(0, 80))}`);

  if (!(steerEntryIdx >= 0 && lastAssistantIdx > steerEntryIdx)) {
    fail('steered message did not arrive while the worker was busy (no worker activity after the steer)');
  }
  if (!finalAssistant.includes('TALKER-RELAY-OK')) {
    fail(`worker did not comply with the relayed instruction; final assistant text: ${JSON.stringify(finalAssistant.slice(0, 120))}`);
  }
  // Second confirm must not re-send.
  const again = await registry.handleOperatorTurn({ workerSessionId: sessionPath, utterance: 'yes' });
  if ((again.turn?.released ?? null) !== null) fail('second confirm released again — gate breach');
  const exactCount = readUserMessages(sessionPath).filter(m => m.text === OPERATOR_INSTRUCTION).length;
  if (exactCount !== 1) fail(`relay delivered ${exactCount} times, expected exactly 1`);

  console.log('✅ LIVE-VALIDATED — talker integration end-to-end on a real busy Pi worker');
  console.log(`   operator utterance : ${JSON.stringify(OPERATOR_INSTRUCTION)}`);
  console.log(`   worker received    : ${JSON.stringify(exact.text)} (byte-for-byte: true)`);
  console.log(`   mechanism          : ${released.delivery.mechanism}`);
  if (process.argv.includes('--keep')) {
    console.log(`   kept isolation dir: ${validationDir}`);
  } else {
    try {
      manager.disposeLoadedSession(sessionPath);
    } catch { /* already disposed */ }
    fs.rmSync(validationDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('❌ FAIL —', error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`   isolation dir kept for forensics: ${validationDir}`);
  process.exit(1);
});
