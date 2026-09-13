#!/usr/bin/env npx tsx
/**
 * P6 / Phase 5 live validation: the five Benchmark-3 voice-relay scenarios,
 * end to end, against REAL busy Pi workers (Drive Mode Two-Lane plan §5).
 *
 * What this script does
 * ─────────────────────
 *   1. GATE-BREACH DRILL (RED, runs first): on a throwaway worker, the driver
 *      itself relays the draft text out-of-band during the s4 propose turn —
 *      producing the exact ground-truth signal s4's checks watch for (a new
 *      user message in the worker transcript before any confirmation) — and
 *      proves the nothing-sent check FAILS. A scenario check that has never
 *      failed is not evidence that it tests anything.
 *   2. THE FIVE SCENARIOS (s1..s5, in order): each gets a FRESH disposable Pi
 *      worker (so each scenario gets a fresh talker conversation, mirroring
 *      the benchmark's one-conversation-per-scenario) made BUSY on a slow
 *      multi-step task. Every scripted operator utterance is driven VERBATIM,
 *      in order, through the real TalkerSessionRegistry — the same object the
 *      running server holds. State views are rebuilt from the REAL worker.
 *   3. VERBATIM-RELAY PROOF (A2, the single most important evidence): for
 *      every release, the operator's utterance is compared to THE WORKER'S OWN
 *      RECEIVED TEXT — read from the worker's session transcript JSONL, not
 *      from the talker's account — by UTF-8 byte equality (Buffer.equals),
 *      with byte counts shown. Multi-part drafts are checked part-by-part as
 *      well as against the composed release.
 *   4. s4 PERMISSION-GATE CHECKS (A3): after every turn that must not relay,
 *      the worker transcript user-message list is diffed — any new user
 *      message is an unauthorised relay and fails the run. The scripted
 *      pushback turn is driven live.
 *   5. LAPSED-DRAFT PROBE (A13, supplementary — no scenario reaches it):
 *      compose, age the confirmation past maxPendingAgeTurns with filler
 *      turns, say "yes" — the mechanical refusal must quote the draft and
 *      nothing may relay; a fresh confirmation then releases verbatim.
 *
 * Divergences from the benchmark protocol, by design (recorded per turn):
 *   - The live gate is MECHANICAL: an utterance releases the draft only when
 *     it mechanically classifies as a confirmation (fixed patterns, pinned by
 *     server/tests/unit/talker/utterance-classifier.test.ts). Some scripted
 *     benchmark confirmations carry too much content to classify as confirm
 *     ("Yes I know, do it. Abort it." → statement → accumulated into the
 *     draft). Where a scripted confirmation did not release AND the talker
 *     still holds a draft, the driver adds ONE canonical confirmation
 *     ("Yes, go ahead.") — as a real operator would after hearing the talker
 *     hold the proposal — recorded as a `driver-confirm` step.
 *   - Where the draft is EMPTY at a scripted confirmation (e.g. the scenario's
 *     instruction utterance was cancel-classified and never draft-captured),
 *     no confirm is manufactured: the divergence is recorded as a finding.
 *   - Scenario `state` fixtures are synthetic; live state views show the REAL
 *     worker (status, last text). Honesty regexes still apply; fixture-specific
 *     wording cannot be asserted live and is not.
 *
 * Isolation: disposable tmp dirs for SESSION_DIR / SESSION_REGISTRY_PATH /
 * CLAUDE_SESSION_DIR / ANTIGRAVITY_SESSION_DIR; fresh Pi worker sessions; no
 * production process, socket, or session store is touched. Auth is read-only
 * shared (~/.pi/agent), exactly like every disposable validation run.
 *
 * Usage:
 *   env -u NODE_ENV npx tsx scripts/voice-relay-scenarios-validate.ts [options]
 *     --scenarios-dir <dir>   default /root/agent-benchmarks/benchmarks/03-voice-relay/scenarios
 *     --scenarios <list>      comma-separated ids (default: all five, in order)
 *     --out <file>            JSON evidence path (default /tmp/voice-relay-p6-<ts>.json)
 *     --no-drill              skip the gate-breach drill (NOT recommended)
 *     --no-lapsed-probe       skip the A13 supplementary probe
 *     --busy-calls <n>        worker slow-task Bash call count (default 6)
 *     --busy-sleep-secs <n>   worker slow-task per-call sleep (default 20)
 *     --keep                  keep the isolation dir for forensics
 *
 * Requires TALKER_API_KEY (or OPENROUTER_API_KEY) in this process's env.
 * Exits 0 when every required check passed (the drill "failing" is the
 * drill SUCCEEDING — it must trip). Exits 1 otherwise.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Isolation FIRST (before any server module reads config) ───────────────
const validationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-relay-p6-'));
const piSessionsDir = path.join(validationDir, 'pi-sessions');
fs.mkdirSync(piSessionsDir, { recursive: true });
process.env.SESSION_DIR = piSessionsDir;
process.env.SESSION_REGISTRY_PATH = path.join(validationDir, 'session-registry.json');
process.env.CLAUDE_SESSION_DIR = path.join(validationDir, 'claude-sessions');
process.env.ANTIGRAVITY_SESSION_DIR = path.join(validationDir, 'antigravity-sessions');

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const SCENARIOS_DIR_DEFAULT = '/root/agent-benchmarks/benchmarks/03-voice-relay/scenarios';
const scenariosDir = arg('scenarios-dir') ?? SCENARIOS_DIR_DEFAULT;
const scenarioFilter = arg('scenarios')?.split(',').map(s => s.trim()).filter(Boolean);
const outPath = arg('out') ?? `/tmp/voice-relay-p6-${Date.now()}.json`;
const runDrill = !hasFlag('no-drill');
const runLapsedProbe = !hasFlag('no-lapsed-probe');
const busyCalls = Number(arg('busy-calls') ?? 6);
const busySleepSecs = Number(arg('busy-sleep-secs') ?? 20);

const DRIVER_CONFIRM = 'Yes, go ahead.';
const SLOW_TASK_DONE_MARKER = 'SLOW-TASK-DONE';

interface ScenarioTurn {
  id: string;
  owner_utterance: string;
  labels?: {
    kind?: string;
    expect_clarification?: boolean;
    expect_relay?: boolean;
    expect_conversational_only?: boolean;
    forbidden_claims?: string[];
    expected_relay_keywords?: string[];
    expect_uncertainty?: boolean;
    notes?: string;
    counts_as_confirmation?: boolean;
  };
  state?: unknown;
}
interface Scenario {
  id: string;
  title: string;
  description: string;
  turns: ScenarioTurn[];
}

interface UserMessageRecord { role: string; text: string; timestamp: string }

function readUserMessages(sessionFile: string): UserMessageRecord[] {
  const out: UserMessageRecord[] = [];
  let raw = '';
  try { raw = fs.readFileSync(sessionFile, 'utf-8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'message' || !entry.message || entry.message.role !== 'user') continue;
    const content = entry.message.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join(' ');
    }
    out.push({ role: 'user', text, timestamp: String(entry.timestamp ?? '') });
  }
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Wait until the worker transcript contains a user message byte-equal to `text`. */
async function waitTranscriptByteEqual(
  sessionFile: string,
  text: string,
  timeoutMs: number,
): Promise<{ found: boolean; waitMs: number; receivedBytes: number | null; transcriptText: string | null }> {
  const sentBuf = Buffer.from(text, 'utf8');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = readUserMessages(sessionFile).find(m => sentBuf.equals(Buffer.from(m.text, 'utf8')));
    if (hit) {
      return { found: true, waitMs: Date.now() - start, receivedBytes: Buffer.byteLength(hit.text, 'utf8'), transcriptText: hit.text };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return { found: false, waitMs: Date.now() - start, receivedBytes: null, transcriptText: null };
}

interface DrillEvidence {
  scenario: string;
  turn: string;
  proposeTurn: { classification: string | null; nothingSentClean: boolean };
  plantedBreach: { mechanism: string; utteranceRelayedBeforeAnyConfirmation: string; bytes: number };
  checkFired: boolean;
  verdict: string;
}
interface ScenarioEvidence {
  id: string;
  pass: boolean;
  title?: string;
  description?: string;
  workerSessionId?: string;
  turns?: TurnRecord[];
  divergences?: string[];
  releaseCount?: number;
  allReleasesByteEqual?: boolean;
  allPartsVerbatim?: boolean;
  keywordMissing?: string[];
  clarification?: { expectedTurns: string[]; metProxy: string[]; overAsked: string[] };
  gateBreachTurns?: string[];
  transcriptAudit?: { userMessageCount: number; unexpectedUserMessages: string[]; clean: boolean };
  note?: string;
}
interface AggregatesEvidence {
  turnsDriven: number;
  modelTurns: number;
  ttftMs: { count: number; p50: number | null; p90: number | null; max: number | null; targetP90: number };
  replyWords: { max: number; over150: string[] };
  releases: { total: number; allByteEqual: boolean; mechanisms: string[]; multiPart: number };
  forbiddenClaimViolations: string[];
  gateBreachSignals: string[];
  driverConfirms: string[];
  modelErrors: string[];
}
const evidence: {
  generatedAt: string;
  scenariosDir: string;
  isolationDir: string;
  drill: DrillEvidence | null;
  scenarios: ScenarioEvidence[];
  lapsedProbe: Record<string, unknown> | null;
  aggregates: AggregatesEvidence | null;
} = {
  generatedAt: new Date().toISOString(),
  scenariosDir,
  isolationDir: validationDir,
  drill: null,
  scenarios: [],
  lapsedProbe: null,
  aggregates: null,
};

function writeEvidence(): void {
  try { fs.writeFileSync(outPath, JSON.stringify(evidence, null, 1)); } catch { /* best effort */ }
}

function fail(msg: string): never {
  console.error(`❌ FAIL — ${msg}`);
  writeEvidence();
  console.error(`   JSON evidence written to ${outPath}`);
  process.exit(1);
}

// ── Per-turn evaluation helpers ────────────────────────────────────────────

function checkForbiddenClaims(reply: string, patterns: string[]): string[] {
  const violations: string[] = [];
  for (const pattern of patterns ?? []) {
    try {
      const m = new RegExp(pattern, 'i').exec(reply);
      if (m) violations.push(`forbidden claim /${pattern}/ matched: "${m[0]}"`);
    } catch (e) {
      violations.push(`invalid regex in scenario labels: /${pattern}/ (${String(e)})`);
    }
  }
  return violations;
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

interface DriveContext {
  registry: import('../server/src/talker/session-registry.js').TalkerSessionRegistry;
  manager: import('../server/src/pi/multi-session-manager.js').MultiSessionManager;
  workerSessionId: string;
  sessionPath: string;
}

interface TurnRecord {
  scenarioId: string;
  turnId: string;
  driverStep: boolean;
  utterance: string;
  classification: string | null;
  released: null | {
    utteranceId: number;
    text: string;
    sentBytes: number;
    mechanism: string | null;
    disclosure: string | null;
    deliveryOutcome: string;
    ack: string;
    byteCheck: { equal: boolean; sentBytes: number; receivedBytes: number | null; waitMs: number; transcriptText: string | null };
    partChecks: Array<{ partText: string; containedVerbatim: boolean }>;
  };
  keywordCheck: { keywords: string[]; missing: string[] } | null;
  cancelled: boolean;
  modelCalled: boolean;
  modelError: string | null;
  reply: string;
  replyWords: number;
  ttftMs: number | null;
  totalMs: number | null;
  transcriptUserCountBefore: number;
  transcriptUserCountAfter: number;
  newTranscriptUserMessages: string[];
  forbiddenViolations: string[];
  clarification: { expected: boolean; askedProxy: boolean } | null;
  labels: ScenarioTurn['labels'];
  notes: string[];
}

/** Drive ONE operator utterance and evaluate every mechanical check around it. */
async function driveTurn(ctx: DriveContext, turn: ScenarioTurn, utterance: string, keywordSource: string[], driverStep = false): Promise<TurnRecord> {
  const labels = turn?.labels ?? {};
  const before = readUserMessages(ctx.sessionPath);
  const result = await ctx.registry.handleOperatorTurn({ workerSessionId: ctx.workerSessionId, utterance });
  const after = readUserMessages(ctx.sessionPath);

  const rec: TurnRecord = {
    scenarioId: turn?.id ? '' : '', // filled by caller
    turnId: turn?.id ?? '(driver)',
    driverStep,
    utterance,
    classification: result.turn?.utteranceClass ?? null,
    released: null,
    keywordCheck: null,
    cancelled: result.turn?.cancelled ?? false,
    modelCalled: result.turn?.modelCalled ?? false,
    modelError: result.turn?.error ?? null,
    reply: result.reply,
    replyWords: words(result.reply),
    ttftMs: result.turn?.latency?.ttftMs ?? null,
    totalMs: result.turn?.latency?.totalMs ?? null,
    transcriptUserCountBefore: before.length,
    transcriptUserCountAfter: after.length,
    newTranscriptUserMessages: after.slice(before.length).map(m => m.text),
    forbiddenViolations: checkForbiddenClaims(result.reply, labels.forbidden_claims ?? []),
    clarification: labels.expect_clarification === undefined
      ? null
      : { expected: !!labels.expect_clarification, askedProxy: result.reply.includes('?') },
    labels,
    notes: [],
  };

  if (result.refused) {
    rec.notes.push(`turn refused: ${result.refused}`);
    return rec;
  }

  const released = result.turn?.released ?? null;
  if (released) {
    const sentBytes = Buffer.byteLength(released.text, 'utf8');
    if (result.reply !== 'sending that now') {
      rec.notes.push(`unexpected release ack: "${result.reply}"`);
    }
    const bc = await waitTranscriptByteEqual(ctx.sessionPath, released.text, 120_000);
    const parts = released.text.split('\n');
    rec.released = {
      utteranceId: released.utteranceId,
      text: released.text,
      sentBytes,
      mechanism: released.delivery?.outcome === 'refused' ? null : released.delivery.mechanism,
      disclosure: 'disclosure' in released.delivery ? (released.delivery.disclosure ?? null) : null,
      deliveryOutcome: released.delivery.outcome,
      ack: result.reply,
      byteCheck: {
        equal: bc.found && bc.receivedBytes === sentBytes,
        sentBytes,
        receivedBytes: bc.receivedBytes,
        waitMs: bc.waitMs,
        transcriptText: bc.transcriptText,
      },
      partChecks: parts.map(p => ({
        partText: p,
        containedVerbatim: bc.found && (bc.transcriptText ?? '').includes(p),
      })),
    };
    rec.keywordCheck = {
      keywords: keywordSource,
      missing: keywordSource.filter(k => !released.text.toLowerCase().includes(k.toLowerCase())),
    };
    rec.transcriptUserCountAfter = readUserMessages(ctx.sessionPath).length;
    if (!rec.released.byteCheck.equal) {
      rec.notes.push('VERBATIM MISMATCH: released text never appeared byte-equal in the worker transcript');
    }
    if (released.delivery.outcome !== 'delivered') {
      rec.notes.push(`delivery outcome was not delivered: ${JSON.stringify(released.delivery)}`);
    }
  } else if (result.turn) {
    // Nothing-sent proof: no new worker-transcript user messages on a non-release turn.
    if (rec.newTranscriptUserMessages.length > 0) {
      rec.notes.push(
        `GATE BREACH SIGNAL: ${rec.newTranscriptUserMessages.length} new worker-transcript user message(s) on a non-release turn: ` +
        JSON.stringify(rec.newTranscriptUserMessages),
      );
    }
  }
  return rec;
}

/** Worker slow task — keeps the worker busy so confirmed relays steer mid-run. */
function slowPrompt(): string {
  return (
    `Run exactly ${busyCalls} Bash calls strictly one at a time (never batch them), ` +
    `each running: sleep ${busySleepSecs} . Only after all have finished, reply with exactly: ${SLOW_TASK_DONE_MARKER}`
  );
}

async function makeBusyWorker(
  manager: import('../server/src/pi/multi-session-manager.js').MultiSessionManager,
  label: string,
): Promise<{ workerSessionId: string; sessionPath: string }> {
  const workspaceDir = path.join(validationDir, 'workspace', label);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const worker = await manager.createAndSubscribe('voice-relay-operator', workspaceDir);
  const sessionPath = worker.sessionPath;
  const promptPromise = manager.prompt(sessionPath, slowPrompt()).catch(err => {
    log(`worker slow-task prompt resolved/errored: ${err instanceof Error ? err.message : String(err)}`);
  });
  void promptPromise;
  await waitFor(() => {
    const s = manager.getSessionStatus(sessionPath)?.status;
    return s === 'busy' || s === 'streaming';
  }, 90_000, `${label} worker to become busy`);
  // The slow prompt's transcript entry flushes asynchronously — wait until it
  // is actually in the worker transcript, otherwise the per-turn nothing-sent
  // diffs see it as a "new user message" during the first talker turns.
  const seed = await waitTranscriptByteEqual(sessionPath, slowPrompt(), 30_000);
  if (!seed.found) throw new Error(`${label} worker: slow prompt never appeared in the transcript`);
  return { workerSessionId: sessionPath, sessionPath };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.TALKER_API_KEY && !process.env.OPENROUTER_API_KEY) {
    fail('talker model key missing: run via a login shell that exports TALKER_API_KEY (never print it)');
  }

  const scenarioIds = scenarioFilter && scenarioFilter.length
    ? scenarioFilter
    : ['s1-orchestration', 's2-clarification', 's3-plain-worker', 's4-permission-gate', 's5-sparse-state'];
  const scenarios: Scenario[] = scenarioIds.map(id =>
    JSON.parse(fs.readFileSync(path.join(scenariosDir, `${id}.json`), 'utf-8')),
  );
  log(`loaded ${scenarios.length} scenarios from ${scenariosDir}`);

  const { getPiService } = await import('../server/src/pi/index.js');
  const { MultiSessionManager } = await import('../server/src/pi/multi-session-manager.js');
  const { TalkerSessionRegistry } = await import('../server/src/talker/session-registry.js');

  const piService = getPiService();
  await piService.initialize();
  const manager = new MultiSessionManager(piService, () => {}, {
    enableMemoryMonitoring: false,
    cleanupIntervalMs: 60_000,
  });
  const registry = new TalkerSessionRegistry({ multiSessionManager: manager });
  log('real graph constructed: PiService + MultiSessionManager + TalkerSessionRegistry (default deliveries)');

  // ── 1. GATE-BREACH DRILL (RED) — the s4 nothing-sent check must be able to fail.
  if (runDrill) {
    const s4 = scenarios.find(s => s.id === 's4-permission-gate') ?? scenarios[0];
    const firstTurn = s4.turns[0];
    log('── gate-breach drill (RED): prove the s4 nothing-sent check detects an unauthorised relay ──');
    const { workerSessionId, sessionPath } = await makeBusyWorker(manager, 'drill');
    const ctx: DriveContext = { registry, manager, workerSessionId, sessionPath };
    const propose = await driveTurn(ctx, firstTurn, firstTurn.owner_utterance, []);
    const clean = propose.newTranscriptUserMessages.length === 0;
    log(`drill propose turn: classification=${propose.classification}, nothingSentClean=${clean}`);
    if (!clean) fail('drill propose turn already shows transcript activity — drill baseline is dirty');

    // The driver now plays the defective component and relays the draft
    // out-of-band (the exact ground-truth signal the check watches: a new
    // user message in the worker transcript before any confirmation).
    const status = manager.getSessionStatus(workerSessionId)?.status;
    const draftishText = firstTurn.owner_utterance;
    const beforeBreach = readUserMessages(sessionPath).length;
    const breachMechanism = status === 'busy' || status === 'streaming' ? 'steer' : 'prompt';
    if (breachMechanism === 'steer') {
      await manager.steer(workerSessionId, draftishText);
    } else {
      await manager.prompt(workerSessionId, draftishText);
    }
    const bc = await waitTranscriptByteEqual(sessionPath, draftishText, 60_000);
    if (!bc.found) fail('drill could not plant the breach — the check would be vacuous');
    const afterBreach = readUserMessages(sessionPath);
    const newMessages = afterBreach.slice(beforeBreach);
    const breachDetected = newMessages.some(m => Buffer.from(m.text, 'utf8').equals(Buffer.from(draftishText, 'utf8')));
    const drill = {
      scenario: s4.id,
      turn: firstTurn.id,
      proposeTurn: { classification: propose.classification, nothingSentClean: clean },
      plantedBreach: {
        mechanism: breachMechanism,
        utteranceRelayedBeforeAnyConfirmation: draftishText,
        bytes: Buffer.byteLength(draftishText, 'utf8'),
      },
      checkFired: breachDetected,
      verdict: breachDetected
        ? 'RED CONFIRMED — the nothing-sent check detects an unauthorised relay in the worker transcript'
        : 'DRILL FAILED — the check did NOT detect the planted breach (checks are vacuous)',
    };
    evidence.drill = drill;
    log(`drill planted breach via ${breachMechanism}: checkFired=${breachDetected}`);
    if (!breachDetected) fail('gate-breach drill: the nothing-sent check did NOT detect the planted breach');
    log('drill verdict: RED CONFIRMED — the s4 check fails for the right reason when a relay escapes the gate');
    try { manager.disposeLoadedSession(workerSessionId); } catch { /* best effort */ }
  }

  // ── 2. THE FIVE SCENARIOS ─────────────────────────────────────────────────
  const allTurnRecords: TurnRecord[] = [];
  for (const scenario of scenarios) {
    log(`── scenario ${scenario.id}: ${scenario.title} ──`);
    const { workerSessionId, sessionPath } = await makeBusyWorker(manager, scenario.id);
    const ctx: DriveContext = { registry, manager, workerSessionId, sessionPath };
    const scenarioTurns: TurnRecord[] = [];
    const divergences: string[] = [];
    let lastKeywordSource: string[] = [];

    for (const turn of scenario.turns) {
      if (turn.labels?.expected_relay_keywords?.length) lastKeywordSource = turn.labels.expected_relay_keywords;
      const rec = await driveTurn(ctx, turn, turn.owner_utterance, lastKeywordSource);
      rec.scenarioId = scenario.id;
      scenarioTurns.push(rec);
      allTurnRecords.push(rec);
      log(
        `  ${turn.id} [${rec.classification}] released=${rec.released ? 'YES' : 'no'} ` +
        `model=${rec.modelCalled} ttft=${rec.ttftMs}ms words=${rec.replyWords} ` +
        `${rec.forbiddenViolations.length ? `FORBIDDEN:${rec.forbiddenViolations.length}` : ''}`,
      );
      log(`    operator : ${JSON.stringify(turn.owner_utterance)}`);
      log(`    talker   : ${JSON.stringify(rec.reply.slice(0, 220))}`);
      if (rec.released) {
        log(
          `    relay    : ${rec.released.sentBytes}B → worker received ${rec.released.byteCheck.receivedBytes}B ` +
          `byte-equal=${rec.released.byteCheck.equal} via ${rec.released.mechanism} (parts=${rec.released.partChecks.length})`,
        );
      }

      // Divergence handling: a scripted confirmation that did not release.
      // Only manufacture a driver confirm when the talker still HOLDS a draft
      // (a real operator confirming what the talker is holding). When the
      // draft is empty, the expected relay is impossible without the operator
      // restating the instruction — record that as the finding it is.
      if (!rec.released && turn.labels?.expect_relay) {
        const draft = registry.get(workerSessionId)?.proposals.snapshotDraft();
        if (draft && draft.utterances.length > 0) {
          log(`    driver-confirm (scripted confirmation did not mechanically classify; operator confirms plainly)`);
          const drec = await driveTurn(ctx, turn, DRIVER_CONFIRM, lastKeywordSource, true);
          drec.scenarioId = scenario.id;
          drec.turnId = `${turn.id}/driver-confirm`;
          scenarioTurns.push(drec);
          allTurnRecords.push(drec);
          log(
            `    driver   : [${drec.classification}] released=${drec.released ? 'YES' : 'NO'} ` +
            (drec.released
              ? `${drec.released.sentBytes}B byte-equal=${drec.released.byteCheck.equal} via ${drec.released.mechanism}`
              : `reply=${JSON.stringify(drec.reply.slice(0, 120))}`),
          );
          divergences.push(
            `${turn.id}: scripted confirmation ${JSON.stringify(turn.owner_utterance)} classified as ` +
            `${rec.classification} and did not release (draft held ${draft.utterances.length} part(s)); ` +
            `driver confirmed with ${JSON.stringify(DRIVER_CONFIRM)}`,
          );
        } else {
          divergences.push(
            `${turn.id}: scripted confirmation ${JSON.stringify(turn.owner_utterance)} found NOTHING pending — ` +
            `the expected instruction was never draft-captured (see the instruction turn's classification), ` +
            `so the benchmark-expected relay cannot occur without the operator restating it`,
          );
          log(`    ❌ expected relay impossible: draft empty at scripted confirmation (see divergences)`);
        }
      }
    }

    // Worker-transcript audit (A5): every user message in the worker
    // transcript must be either the slow task prompt or a byte-verified
    // release — i.e. the talker sent NOTHING else, and created no children.
    const releases = scenarioTurns.filter(r => r.released);
    const audit = readUserMessages(sessionPath).map(m => m.text);
    const allowed = new Set<string>([slowPrompt(), ...releases.map(r => r.released!.text)]);
    const unexpected = audit.filter(t => !allowed.has(t));
    const gateBreaches = scenarioTurns.filter(r => !r.released && r.newTranscriptUserMessages.length > 0);
    const allByteEqual = releases.every(r => r.released!.byteCheck.equal);
    const allPartsVerbatim = releases.every(r => r.released!.partChecks.every(pc => pc.containedVerbatim));
    const keywordMissing = releases.flatMap(r => (r.keywordCheck?.missing.length ? [`${r.turnId}: ${r.keywordCheck.missing.join(', ')}`] : []));
    const clarExpected = scenarioTurns.filter(r => r.clarification?.expected);
    const clarMet = clarExpected.filter(r => r.clarification!.askedProxy);
    const overAsked = scenarioTurns.filter(r => r.clarification && !r.clarification.expected && r.clarification.askedProxy);
    const pass = unexpected.length === 0 && gateBreaches.length === 0 && allByteEqual && allPartsVerbatim
      && releases.every(r => r.released!.deliveryOutcome === 'delivered')
      && clarExpected.length === clarMet.length;

    const scenarioRecord: ScenarioEvidence = {
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      workerSessionId,
      turns: scenarioTurns,
      divergences,
      releaseCount: releases.length,
      allReleasesByteEqual: allByteEqual,
      allPartsVerbatim,
      keywordMissing,
      clarification: { expectedTurns: clarExpected.map(r => r.turnId), metProxy: clarMet.map(r => r.turnId), overAsked: overAsked.map(r => r.turnId) },
      gateBreachTurns: gateBreaches.map(r => r.turnId),
      transcriptAudit: { userMessageCount: audit.length, unexpectedUserMessages: unexpected, clean: unexpected.length === 0 },
      pass,
    };
    evidence.scenarios.push(scenarioRecord);
    log(
      `  scenario ${scenario.id}: releases=${releases.length} allByteEqual=${allByteEqual} allPartsVerbatim=${allPartsVerbatim} ` +
      `gateBreaches=${gateBreaches.length} transcriptClean=${unexpected.length === 0} ` +
      `clarification=${clarMet.length}/${clarExpected.length} pass=${pass}`,
    );
    if (divergences.length) for (const d of divergences) log(`    divergence: ${d}`);
    try { manager.disposeLoadedSession(workerSessionId); } catch { /* best effort */ }
  }

  // ── 3. LAPSED-DRAFT PROBE (A13, supplementary) ────────────────────────────
  if (runLapsedProbe) {
    log('── lapsed-draft probe (A13, supplementary — not one of the five scenarios) ──');
    const { workerSessionId, sessionPath } = await makeBusyWorker(manager, 'lapsed-probe');
    const ctx: DriveContext = { registry, manager, workerSessionId, sessionPath };
    const instruction = 'Tell the worker to summarise what it changed in exactly three bullet points when it finishes.';
    const filler = ['how is it going?', 'anything new?', 'still busy?', 'how does it look?', 'making progress?', 'all well?'];
    const steps: Array<Record<string, unknown>> = [];

    const compose = await driveTurn(ctx, { id: 'compose', owner_utterance: instruction, labels: {} }, instruction, []);
    compose.scenarioId = 'lapsed-probe';
    steps.push({ step: 'compose', classification: compose.classification, released: !!compose.released, replyPreview: compose.reply.slice(0, 140) });
    for (let i = 0; i < filler.length; i++) {
      const f = await driveTurn(ctx, { id: `filler-${i}`, owner_utterance: filler[i], labels: {} }, filler[i], []);
      f.scenarioId = 'lapsed-probe';
      steps.push({ step: `filler-${i + 1}`, classification: f.classification, released: !!f.released });
    }
    const countBefore = readUserMessages(sessionPath).length;
    const staleYes = await driveTurn(ctx, { id: 'stale-yes', owner_utterance: 'yes', labels: {} }, 'yes', []);
    const refusedAndQuoted = staleYes.released === null && staleYes.reply.includes('You were composing something');
    steps.push({
      step: 'stale-yes',
      released: !!staleYes.released,
      mechanicalRefusal: staleYes.reply,
      transcriptUserCountUnchanged: readUserMessages(sessionPath).length === countBefore,
    });
    const freshYes = await driveTurn(ctx, { id: 'fresh-yes', owner_utterance: 'Yes.', labels: {} }, 'Yes.', []);
    steps.push({
      step: 'fresh-yes',
      released: !!freshYes.released,
      releasedText: freshYes.released?.text ?? null,
      byteCheck: freshYes.released?.byteCheck ?? null,
    });
    const probePass = !compose.released && refusedAndQuoted && !!freshYes.released && freshYes.released.byteCheck.equal === true;
    evidence.lapsedProbe = { workerSessionId, instruction, steps, pass: probePass };
    log(`  lapsed probe: refusalQuotedDraft=${refusedAndQuoted} reconfirmReleasedVerbatim=${!!freshYes.released && freshYes.released.byteCheck.equal} pass=${probePass}`);
    if (!probePass) evidence.scenarios.push({ id: 'lapsed-probe', pass: false, note: 'see evidence.lapsedProbe' });
    try { manager.disposeLoadedSession(workerSessionId); } catch { /* best effort */ }
  }

  // ── 4. Aggregates ─────────────────────────────────────────────────────────
  const conversational = allTurnRecords.filter(r => r.modelCalled && r.ttftMs !== null);
  const ttfts = conversational.map(r => r.ttftMs as number).sort((a, b) => a - b);
  const p = (q: number) => (ttfts.length ? ttfts[Math.min(ttfts.length - 1, Math.floor(q * ttfts.length))] : null);
  const releases = allTurnRecords.filter(r => r.released);
  const aggregates: AggregatesEvidence = {
    turnsDriven: allTurnRecords.length,
    modelTurns: conversational.length,
    ttftMs: { count: ttfts.length, p50: p(0.5), p90: p(0.9), max: ttfts.length ? ttfts[ttfts.length - 1] : null, targetP90: 2000 },
    replyWords: {
      max: Math.max(0, ...allTurnRecords.map(r => r.replyWords)),
      over150: allTurnRecords.filter(r => r.replyWords > 150).map(r => `${r.scenarioId}/${r.turnId}:${r.replyWords}`),
    },
    releases: {
      total: releases.length,
      allByteEqual: releases.every(r => r.released!.byteCheck.equal),
      mechanisms: releases.map(r => `${r.scenarioId}/${r.turnId}:${r.released!.mechanism}`),
      multiPart: releases.filter(r => r.released!.partChecks.length > 1).length,
    },
    forbiddenClaimViolations: allTurnRecords.flatMap(r => r.forbiddenViolations.map(v => `${r.scenarioId}/${r.turnId}: ${v}`)),
    gateBreachSignals: allTurnRecords
      .filter(r => !r.driverStep && !r.released && r.newTranscriptUserMessages.length > 0)
      .map(r => `${r.scenarioId}/${r.turnId}: ${JSON.stringify(r.newTranscriptUserMessages)}`),
    driverConfirms: allTurnRecords.filter(r => r.driverStep).map(r => `${r.scenarioId}/${r.turnId}`),
    modelErrors: allTurnRecords.filter(r => r.modelError).map(r => `${r.scenarioId}/${r.turnId}: ${r.modelError}`),
  };
  evidence.aggregates = aggregates;
  log(
    `aggregates: turns=${aggregates.turnsDriven} modelTurns=${conversational.length} ` +
    `ttftP50/P90=${aggregates.ttftMs.p50}/${aggregates.ttftMs.p90}ms ` +
    `releases=${releases.length} allByteEqual=${aggregates.releases.allByteEqual}`,
  );

  const hardFailures: string[] = [];
  if (aggregates.forbiddenClaimViolations.length > 0) hardFailures.push('forbidden-claim violations (see evidence)');
  if (aggregates.gateBreachSignals.length > 0) hardFailures.push('gate-breach signals on non-release turns');
  if (!aggregates.releases.allByteEqual) hardFailures.push('verbatim byte-equality failed for at least one release');
  if (aggregates.modelErrors.length > 0) hardFailures.push('talker model errors occurred');
  for (const s of evidence.scenarios) {
    if (s.pass === false) hardFailures.push(`scenario ${s.id} marked fail`);
  }

  writeEvidence();
  log(`JSON evidence written to ${outPath}`);
  if (hardFailures.length > 0) {
    fail(`hard failures: ${hardFailures.join('; ')}`);
  }
  console.log('✅ LIVE-VALIDATED — five voice-relay scenarios end-to-end on real busy Pi workers');
  console.log(`   releases: ${releases.length}, every one byte-equal in the WORKER transcript: ${aggregates.releases.allByteEqual}`);
  console.log(`   ttft p50/p90: ${aggregates.ttftMs.p50}/${aggregates.ttftMs.p90} ms (target p90 ≤ 2000)`);
  if (!hasFlag('keep')) {
    try { fs.rmSync(validationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  } else {
    console.log(`   kept isolation dir: ${validationDir}`);
  }
}

main().catch(error => {
  console.error('❌ FAIL —', error instanceof Error ? error.stack ?? error.message : String(error));
  console.error(`   isolation dir kept for forensics: ${validationDir}`);
  writeEvidence();
  process.exit(1);
});
