#!/usr/bin/env npx tsx
/**
 * P20 live validation: a mid-session "what happened earlier?" question is
 * answered from the worker session's REAL history — and an over-window
 * question still defers honestly through the ask-the-worker offer.
 *
 * Constructs the REAL integration graph in this process, exactly like
 * scripts/talker-live-validate.ts:
 *   real PiService + real MultiSessionManager (as connection.ts constructs it),
 *   real TalkerSessionRegistry wired with that manager,
 *   real OpenRouter talker model (TALKER_API_KEY / OPENROUTER_API_KEY).
 *
 * Scenario (the P20 outcome, end to end):
 *   1. create a disposable Pi session (isolated SESSION_DIR — nothing lands in
 *      the operator's session store) and give the worker TWO distinctive,
 *      unguessable facts in separate real turns (release codename AMBER-SEVEN);
 *   2. pad with short turns until the early facts fall OUTSIDE the talker's
 *      bounded history window (SESSION_HISTORY_LIMITS.entries = 12 messages);
 *   3. NOW attach the talker — mid-session, the operator's primary use case —
 *      and ask: "What has happened earlier in this session?"
 *      PASS: the reply quotes the facts it can see from the real history, and
 *      no relay is proposed (askWorkerOffer unset; nothing released).
 *   4. ask about the FIRST codename — genuinely outside the bounded window.
 *      PASS: the talker defers honestly; the harness honours the offer; the
 *      relay candidate is the operator's own question, word for word.
 *
 * Isolation: disposable tmp dirs for SESSION_DIR / SESSION_REGISTRY_PATH /
 * CLAUDE_SESSION_DIR / ANTIGRAVITY_SESSION_DIR. No production pi-web-ui
 * process, socket, or session store is touched. Auth is read-only shared
 * (~/.pi/agent), exactly like every disposable validation run.
 *
 * Usage:
 *   source ~/.bashrc && env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS \
 *     npx tsx scripts/talker-history-live-validate.ts [--keep]
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
const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talker-history-live-'));
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

/** Facts planted in the EARLY turns (they will fall outside the window). */
const EARLY_CODENAME = 'CODEWORD-KILO-FORTRESS';
/** Facts planted just before the attach (inside the window). */
const LATE_CODENAME = 'CODEWORD-AMBER-SEVEN';

const EARLY_FACT_PROMPT =
  `Reply with exactly this and nothing else: ${EARLY_CODENAME} is the old release codename.`;
const LATE_FACT_PROMPT =
  `Reply with exactly this and nothing else: ${LATE_CODENAME} is the new release codename.`;
function fillerPrompt(i: number): string {
  return `Reply with exactly this and nothing else: PADDER-${i}-OK`;
}

const MID_SESSION_QUESTION = 'What is the new release codename from earlier in this session?';
const OVER_WINDOW_QUESTION = 'What was the first release codename from the very beginning of this session?';

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
const { SESSION_HISTORY_LIMITS } = await import('../server/src/talker/state-view.js');

// ── Build the real integration graph (what the server builds) ─────────────
const piService = getPiService();
await piService.initialize();
const manager = new MultiSessionManager(piService, () => {}, {
  enableMemoryMonitoring: false,
  cleanupIntervalMs: 60_000,
});
const registry = new TalkerSessionRegistry({ multiSessionManager: manager });
log('real graph constructed: PiService + MultiSessionManager + TalkerSessionRegistry (default deliveries)');

// ── Disposable Pi worker session, seeded with REAL earlier turns ──────────
const worker = await manager.createAndSubscribe('talker-history-live', workspaceDir);
const sessionPath = worker.sessionPath;
log(`worker session created: ${sessionPath}`);

async function runTurn(prompt: string): Promise<void> {
  await manager.prompt(sessionPath, prompt);
  await waitFor(() => manager.getSessionStatus(sessionPath)?.status === 'idle', 120_000, `idle after: ${prompt.slice(0, 40)}`);
}

// Seed: 1 early fact + enough filler turns that the early fact falls outside
// the talker's bounded window (entries cap on conversation messages).
const FILLER_TURNS = SESSION_HISTORY_LIMITS.entries; // 8 messages → comfortably pushes the early pair out
log(`seeding: 1 early fact + ${FILLER_TURNS} filler turns (window holds ${SESSION_HISTORY_LIMITS.entries} messages)`);
await runTurn(EARLY_FACT_PROMPT);
log(`worker seeded with early fact: ${EARLY_CODENAME}`);
for (let i = 1; i <= FILLER_TURNS; i++) {
  await runTurn(fillerPrompt(i));
}
// One late fact that MUST still be inside the window.
await runTurn(LATE_FACT_PROMPT);

const messages = manager.getAgentSession(sessionPath)?.messages ?? [];
const conversationMessages = messages.filter((m: { role?: string }) => m.role === 'user' || m.role === 'assistant');
log(`session now holds ${messages.length} messages (${conversationMessages.length} conversation) — attaching the talker MID-SESSION`);

if (conversationMessages.length <= SESSION_HISTORY_LIMITS.entries) {
  fail(`fixture too short: ${conversationMessages.length} conversation messages must exceed the ${SESSION_HISTORY_LIMITS.entries}-message window`);
}

// ── 1. The mid-session question ───────────────────────────────────────────
const midTurn = await registry.handleOperatorTurn({ workerSessionId: sessionPath, utterance: MID_SESSION_QUESTION, runtime: 'pi' });
log(`talker (mid-session): "${midTurn.reply.replace(/\s+/g, ' ').slice(0, 220)}"`);
log(`askWorkerOffer on the mid-session turn: ${midTurn.turn?.askWorkerOffer ?? 'unset'} — answering AND offering for the pre-window stretch are both honest`);
if ((midTurn.turn?.released ?? null) !== null) fail('mid-session question released something — gate breach');
if (!/AMBER(-| )?SEVEN/i.test(midTurn.reply)) {
  fail(`the answer does not quote the real recent history (${LATE_CODENAME}) — the talker deferred instead of answering; reply: ${JSON.stringify(midTurn.reply)}`);
}
log(`PASS 1: answered from the session's real history — quotes ${LATE_CODENAME}; nothing was sent`);

// ── 2. The over-window question ───────────────────────────────────────────
const oldTurn = await registry.handleOperatorTurn({ workerSessionId: sessionPath, utterance: OVER_WINDOW_QUESTION, runtime: 'pi' });
log(`talker (over-window): "${oldTurn.reply.replace(/\s+/g, ' ').slice(0, 220)}"`);
if (!oldTurn.turn?.askWorkerOffer) {
  fail(`the over-window question did not defer to the ask-the-worker offer; reply: ${JSON.stringify(oldTurn.reply)}`);
}
if ((oldTurn.turn?.released ?? null) !== null) fail('over-window question released something — gate breach');
if (/\[\[ask-worker\]\]/.test(oldTurn.reply)) fail('the protocol tag leaked into speech');
const talker = registry.get(sessionPath, 'pi');
const draft = talker?.proposals.snapshotDraft();
const parts = draft?.utterances.map(u => u.text) ?? [];
if (!parts.includes(OVER_WINDOW_QUESTION)) {
  fail(`relay candidate is not the operator's verbatim question: ${JSON.stringify(draft?.utterances)}`);
}
log('PASS 2: over-window question deferred honestly — offer fired, candidate is the operator\'s verbatim words, nothing sent');

console.log('✅ LIVE-VALIDATED — P20 mid-session history view, end to end on a real Pi worker');
console.log(`   window             : SESSION_HISTORY_LIMITS = ${JSON.stringify(SESSION_HISTORY_LIMITS)}`);
console.log(`   session size       : ${conversationMessages.length} conversation messages`);
console.log(`   mid-session answer : quoted ${LATE_CODENAME} from the real history (askWorkerOffer=${midTurn.turn?.askWorkerOffer ?? 'unset'})`);
console.log(`   over-window        : deferred; askWorkerOffer=true; relay candidate verbatim (draft holds ${parts.length} part(s))`);
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
