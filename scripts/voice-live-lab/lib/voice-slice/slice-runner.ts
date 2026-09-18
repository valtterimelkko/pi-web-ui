/**
 * Voice Mode vertical slice (plan Phase 5 / Track F) — the runner.
 *
 * What this executes, end to end, against REAL components:
 *
 *   - a disposable Pi Web UI server (this repo, ephemeral port, isolated
 *     state dir, outside the production cgroup) with the Phase-5 voice mount;
 *   - a REAL disposable Pi worker session created through that server's
 *     Internal API;
 *   - a REAL Gemini Live operator loop: scripted utterances are synthesised to
 *     genuine speech (Supertonic), streamed as the contract's `voice_audio_chunk`
 *     frames over the authenticated `/ws` path, and the server's replies,
 *     proposals, parking updates and receipts are read off the same wire;
 *   - the talker's own mechanical classifier (server side), the four-object
 *     kernel (server side) and the real Pi delivery adapter.
 *
 * The three Phase-5 scenarios:
 *   S1 Thinking together — four conversational turns, no proposal/offer/steer,
 *                          worker never interrupted;
 *   S2 Directed steer     — a directed instruction becomes a proposal, a
 *                          tampered confirmation is refused (negative control),
 *                          a spoken "yes" delivers the exact bytes and the
 *                          `receipt_event { outcome: "delivered" }` fires;
 *   S3 Parking & surface  — two items flagged while the worker is busy both
 *                          park, one is promoted after the worker turn
 *                          completes and delivered, the second stays parked.
 *
 * Every assertion reads real artefacts (the wire frames, the worker session's
 * own store, the server's structured `voice-kernel` log lines). A missing
 * artefact FAILS the scenario — the suite cannot pass by measuring nothing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createHttpTier3Api, type Tier3ApiClient } from '../tier3-tools.js';
import { proposalHash } from '../../../../server/src/talker/proposal-store.js';
import { normaliseRelayText } from '../../../../server/src/talker/relay-normalise.js';
import {
  bootDisposableServer,
  waitForHealth,
  type DisposableServer,
} from './disposable-server.js';
import { login, SLICE_ORIGIN, VoiceWireClient } from './ws-client.js';
import { prepareOperatorAudio, type OperatorFixtureSet, type OperatorUtterance } from './operator-audio.js';

export const SLICE_LANE_ID = 'voice-slice-lane';
export const SLICE_ATTACHMENT_GENERATION = 1;

const WORKER_MODEL_DEFAULT = 'google/gemini-3.8-flash';
/**
 * The worker's slow turn must be REAL (a real bash sleep, a real busy state)
 * and BOUNDED: the operator's steers arrive mid-turn, so without the explicit
 * "do not act on them yet" the flash worker chases them into an unbounded chain
 * of work and the turn never ends in the run window. The steered text is still
 * delivered and persisted — only the worker's reaction is bounded.
 */
const SLOW_WORKER_PROMPT =
  'Use the bash tool to run exactly this command and wait for it to finish: sleep 45. ' +
  'If other messages arrive while it runs, acknowledge them but do not act on them yet. ' +
  'When the command finishes, reply with exactly: WORKER-SLOW-DONE and then stop.';

interface Check {
  name: string;
  passed: boolean;
  details?: string;
}

interface ScenarioRecord {
  id: string;
  name: string;
  passed: boolean;
  checks: Check[];
  notes: string[];
}

class CheckList {
  readonly checks: Check[] = [];
  readonly notes: string[] = [];

  check(name: string, passed: boolean, details?: string): boolean {
    this.checks.push({ name, passed, ...(details !== undefined ? { details } : {}) });
    return passed;
  }

  note(message: string): void {
    this.notes.push(message);
  }

  get passed(): boolean {
    return this.checks.length > 0 && this.checks.every((check) => check.passed);
  }
}

// ── Kernel-log parsing and the gate-leak / fidelity audits ──────────────────

export interface KernelLogEvent {
  event: string;
  [key: string]: unknown;
}

/** Extract the structured `voice-kernel {...}` lines from a JSON-format server log. */
export function parseKernelEvents(logText: string): KernelLogEvent[] {
  const events: KernelLogEvent[] = [];
  for (const line of logText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let record: { msg?: unknown };
    try {
      record = JSON.parse(trimmed) as { msg?: unknown };
    } catch {
      continue;
    }
    if (typeof record.msg !== 'string' || !record.msg.startsWith('voice-kernel ')) continue;
    try {
      events.push(JSON.parse(record.msg.slice('voice-kernel '.length)) as KernelLogEvent);
    } catch {
      /* a malformed evidence line is skipped; the audits below will notice a gap */
    }
  }
  return events;
}

export interface GateLeakAudit {
  ok: boolean;
  checks: Check[];
}

/**
 * Read a text field that the kernel log may carry EITHER in full (pre-L1
 * evidence) or as a scrubbed excerpt with a truncation flag (L1 hygiene: full
 * instruction text is never logged). Returns null when the log carries none.
 */
function readTextField(
  event: KernelLogEvent | undefined,
  base: string
): { text: string; truncated: boolean } | null {
  if (event === undefined) return null;
  const full = event[base];
  if (typeof full === 'string') return { text: full, truncated: false };
  const excerpt = event[`${base}Excerpt`];
  if (typeof excerpt === 'string') {
    return { text: excerpt, truncated: event[`${base}Truncated`] === true };
  }
  return null;
}

/**
 * Two logged fields that describe the SAME underlying bytes:
 *  - both truncated  → they came from one sink with one limit, so they must be
 *    byte-identical; a truncated excerpt that merely STARTS the same way as a
 *    longer truncated excerpt is not evidence of the same bytes (an extension
 *    like "check the tes" + "EXTRA" must never pass — found by the independent
 *    verifier's adversarial probe, 2026-09-18);
 *  - both full        → equality;
 *  - exactly one truncated → the truncated side must be a prefix of the full
 *    side (the only mixed case a version change can legitimately produce).
 */
function excerptMatches(
  a: { text: string; truncated: boolean } | null,
  b: { text: string; truncated: boolean } | null
): boolean {
  if (a === null || b === null) return false;
  if (a.text === b.text) return true;
  if (a.truncated && b.truncated) return false;
  if (!a.truncated && !b.truncated) return false;
  const [truncatedSide, fullSide] = a.truncated ? [a, b] : [b, a];
  return (
    truncatedSide.text.length > 0 &&
    truncatedSide.text.length <= fullSide.text.length &&
    fullSide.text.startsWith(truncatedSide.text)
  );
}

/**
 * The negative gate: NOTHING reaches the worker without a logged proposal id
 * and a matching SHA. Every `delivery_attempt` must be preceded by a
 * `confirm_authorised` for the same proposal, the same idempotency key and the
 * same SHA, carrying byte-identical text. The two counts must agree exactly.
 *
 * The log carries scrubbed excerpts (post-L1), so the digest is recomputed
 * strictly only when both fields are untruncated; a truncated excerpt falls
 * back to the SHA chain plus excerpt equality and SAYS SO — a logged excerpt is
 * never silently treated as the whole text.
 */
export function auditGateLeak(events: KernelLogEvent[]): GateLeakAudit {
  const checks: Check[] = [];
  const creations = events.filter((event) => event.event === 'proposal_created');
  const deliveries = events.filter((event) => event.event === 'delivery_attempt');
  const authorisations = events.filter((event) => event.event === 'confirm_authorised');
  checks.push({
    name: 'delivery count equals authorised count',
    passed: deliveries.length === authorisations.length,
    details: `deliveries=${deliveries.length} authorisations=${authorisations.length}`,
  });

  // Every delivery must name a proposal the kernel created, carry the SAME sha
  // that its authorisation carried, and carry bytes the kernel's own digest
  // formula reproduces from the retained proposal.
  let unverifiable = 0;
  let notRecomputable = 0;
  const unverifiableDetails: string[] = [];
  for (const delivery of deliveries) {
    const creation = creations.find((candidate) => candidate.proposalId === delivery.proposalId);
    const authorisation = authorisations.find(
      (candidate) => candidate.idempotencyKey === delivery.idempotencyKey
    );
    const tidiedField = readTextField(creation, 'tidied');
    const originalField = readTextField(creation, 'original') ?? tidiedField;
    const variant = typeof authorisation?.variant === 'string' ? authorisation.variant : 'tidied';
    const expectedField = variant === 'original' ? originalField : tidiedField;
    const deliveryBytes = readTextField(delivery, 'bytes');
    const authorisationBytes = readTextField(authorisation, 'bytes');

    const reasons: string[] = [];
    if (creation === undefined) reasons.push('no-creation');
    if (authorisation === undefined) reasons.push('no-authorisation');
    if (typeof delivery.proposalId !== 'string' || delivery.proposalId.length === 0) {
      reasons.push('no-proposal-id');
    }
    if (creation !== undefined) {
      if (
        delivery.sha256 !== creation.sha256 ||
        (authorisation !== undefined && authorisation.sha256 !== creation.sha256)
      ) {
        reasons.push('sha-chain-mismatch');
      }
      const recomputable =
        tidiedField !== null &&
        originalField !== null &&
        !tidiedField.truncated &&
        !originalField.truncated;
      if (!recomputable) {
        // Never a silent pass: the digest genuinely cannot be recomputed from a
        // scrubbed excerpt. The SHA chain above and the excerpt equality below
        // still bind the delivery to its proposal, and the check SAYS SO — a
        // logged excerpt is never treated as the whole text.
        notRecomputable += 1;
      } else if (
        proposalHash(
          tidiedField.text,
          originalField.text !== tidiedField.text ? originalField.text : undefined
        ) !== creation.sha256
      ) {
        reasons.push('digest-mismatch');
      }
    }
    if (!excerptMatches(deliveryBytes, expectedField)) reasons.push('bytes-mismatch');
    if (!excerptMatches(deliveryBytes, authorisationBytes)) reasons.push('authorised-bytes-mismatch');
    const ok = reasons.length === 0;
    if (!ok) {
      unverifiable += 1;
      unverifiableDetails.push(
        `proposal=${String(delivery.proposalId)} key=${String(delivery.idempotencyKey)} ` +
          `reasons=${reasons.join(',')}`
      );
    }
  }
  checks.push({
    name: 'every delivery carries a proposal id and a SHA matching its authorised bytes',
    passed: unverifiable === 0,
    details:
      (unverifiable === 0 ? `${deliveries.length} deliveries verified` : unverifiableDetails.join('; ')) +
      (notRecomputable > 0 ? ` digest=not-recomputable(${notRecomputable})` : ''),
  });

  // Positional check: the authorisation precedes its delivery in log order.
  let outOfOrder = 0;
  for (const delivery of deliveries) {
    const at = events.indexOf(delivery);
    const authorised = authorisations.some(
      (auth) =>
        events.indexOf(auth) < at &&
        auth.proposalId === delivery.proposalId &&
        auth.idempotencyKey === delivery.idempotencyKey &&
        auth.sha256 === delivery.sha256 &&
        excerptMatches(readTextField(auth, 'bytes'), readTextField(delivery, 'bytes'))
    );
    if (!authorised) outOfOrder += 1;
  }
  checks.push({
    name: 'each delivery is preceded by its own authorised confirmation',
    passed: outOfOrder === 0,
    details: outOfOrder === 0 ? 'log order verified' : `${outOfOrder} deliveries lack a matching prior authorisation`,
  });

  return { ok: checks.every((check) => check.passed), checks };
}



/**
 * Read what the worker session actually holds. The Pi session's own JSONL store
 * is the primary source (it is what the runtime wrote, not a projection); the
 * Internal API transcript and info are the secondary sources.
 */
async function readWorkerMessages(
  api: Tier3ApiClient,
  stateDir: string,
  sessionId: string
): Promise<{ text: string; transcriptLines: string[]; sessionPath: string | null; messageCount: number | null }> {
  let sessionPath: string | null = null;
  let messageCount: number | null = null;
  try {
    const info = await api.childInfo(sessionId);
    sessionPath = info.sessionPath ?? null;
    messageCount = info.messageCount ?? null;
  } catch {
    /* the transcript route below still reports something */
  }
  if (!sessionPath) {
    sessionPath = findSessionPathInStateDir(stateDir, sessionId);
  }
  const texts = sessionPath ? readWorkerInbox(sessionPath) : [];
  const transcriptLines = await api.transcriptTail(sessionId, 200).catch(() => [] as string[]);
  return {
    text: [...texts, ...transcriptLines].join('\n'),
    transcriptLines,
    sessionPath,
    messageCount,
  };
}

/** Poll the worker store until it contains `text` (or the budget lapses). */
async function waitForWorkerStoreText(
  api: Tier3ApiClient,
  stateDir: string,
  sessionId: string,
  text: string,
  timeoutMs: number
): Promise<Awaited<ReturnType<typeof readWorkerMessages>>> {
  const deadline = Date.now() + timeoutMs;
  let store = await readWorkerMessages(api, stateDir, sessionId);
  while (!(text.length > 0 && store.text.includes(text)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    store = await readWorkerMessages(api, stateDir, sessionId);
  }
  return store;
}

/** Find a session file by id in the disposable state dir's pi-sessions folder. */
function findSessionPathInStateDir(stateDir: string, sessionId: string): string | null {
  try {
    const dir = path.join(stateDir, 'pi-sessions');
    const entry = readdirSync(dir).find((name) => name.includes(sessionId));
    return entry ? path.join(dir, entry) : null;
  } catch {
    return null;
  }
}

export interface ByteFidelityAudit {
  ok: boolean;
  checks: Check[];
  verified: Array<{
    proposalId: string;
    sha256: string;
    tidied: string;
    deliveredBytes: string;
    workerReceived: boolean;
  }>;
}

/**
 * 100 % byte fidelity, proven by inspection: for every delivered proposal, the
 * kernel's own digest formula over the retained bytes reproduces the SHA the
 * confirmation authorised, the delivered bytes are byte-identical to the
 * proposal's tidied variant, and the worker session's own store contains those
 * exact bytes.
 */
export function auditByteFidelity(
  events: KernelLogEvent[],
  workerInbox: string[]
): ByteFidelityAudit {
  const checks: Check[] = [];
  const verified: ByteFidelityAudit['verified'] = [];
  const creations = events.filter((event) => event.event === 'proposal_created');
  const deliveries = events.filter((event) => event.event === 'delivery_attempt');

  let digestMismatch = 0;
  let digestNotRecomputable = 0;
  let byteMismatch = 0;
  let notDelivered = 0;
  for (const creation of creations) {
    const proposalId = String(creation.proposalId);
    const settled = deliveries.filter((delivery) => delivery.proposalId === proposalId);
    if (settled.length === 0) {
      // A proposal that was never delivered (superseded/cancelled) has no
      // delivery to prove; it is not a fidelity failure.
      continue;
    }
    const tidiedField = readTextField(creation, 'tidied');
    const originalField = readTextField(creation, 'original') ?? tidiedField;
    const tidied = tidiedField?.text ?? '';
    const original = originalField?.text ?? tidied;
    for (const delivery of settled) {
      const deliveredField = readTextField(delivery, 'bytes');
      const deliveredBytes = deliveredField?.text ?? '';
      const recomputable =
        tidiedField !== null &&
        originalField !== null &&
        !tidiedField.truncated &&
        !originalField.truncated;
      if (!recomputable) {
        // The excerpt cannot reproduce the digest. Reported, never guessed.
        digestNotRecomputable += 1;
      } else {
        const expectedDigest = proposalHash(tidied, original !== tidied ? original : undefined);
        if (expectedDigest !== creation.sha256) digestMismatch += 1;
      }
      if (deliveredField !== null && tidiedField !== null && !excerptMatches(deliveredField, tidiedField)) {
        byteMismatch += 1;
      }
      const received = workerInbox.some((entry) => entry.includes(tidied));
      if (!received) notDelivered += 1;
      verified.push({
        proposalId,
        sha256: String(creation.sha256),
        tidied,
        deliveredBytes,
        workerReceived: received,
      });
    }
  }

  checks.push({
    name: 'the kernel digest over the retained bytes reproduces the confirmed SHA',
    passed: digestMismatch === 0 && verified.length > 0,
    details:
      `proposals delivered=${verified.length} mismatches=${digestMismatch}` +
      (digestNotRecomputable > 0 ? ` digest=not-recomputable(${digestNotRecomputable} truncated excerpt(s))` : ''),
  });
  checks.push({
    name: 'delivered bytes are byte-identical to the confirmed proposal bytes',
    passed: byteMismatch === 0 && verified.length > 0,
    details: `mismatches=${byteMismatch}`,
  });
  checks.push({
    name: 'the worker session store contains the exact delivered bytes',
    passed: notDelivered === 0 && verified.length > 0,
    details: `delivered proposals not found in the worker store=${notDelivered}`,
  });
  return { ok: checks.every((check) => check.passed), checks, verified };
}

export interface WorkerStoreCoverageAudit {
  ok: boolean;
  checks: Check[];
  /** Store instructions that are neither a delivery nor a declared non-gate message. */
  unauthorised: string[];
  /** Unauthorised texts that CONTAIN a delivery: the extra bytes are the concern. */
  wrapped: string[];
}

/**
 * The converse of the byte-fidelity audit (review R, Gate-5 coverage limit 2).
 *
 * The fidelity checks prove `delivered ⊆ worker store`; this proves
 * `store ⊆ delivered` — every instruction the worker actually received is
 * byte-equal to an authorised delivery. The single exception is the harness's
 * own slow-worker baseline, which the runner injects through the Internal API
 * by design to make the worker genuinely busy; it is **named explicitly** here
 * and can never pass by accident.
 *
 * Failure direction is the point: a store text that is not accounted for — a
 * near miss, or a message that CONTAINS a delivery plus extra bytes — fails the
 * gate and is reported with the offending text, so the plan's wording ("ANY
 * instruction reaching the worker without a logged proposal ID fails the
 * gate") is proven rather than implied.
 */
export function auditWorkerStoreCoverage(
  workerInstructions: string[],
  deliveredBytes: string[],
  allowlistedNonGateInstructions: readonly string[] = []
): WorkerStoreCoverageAudit {
  const delivered = deliveredBytes.filter((bytes) => bytes.length > 0);
  const allowed = new Set(allowlistedNonGateInstructions);
  const unauthorised: string[] = [];
  const wrapped: string[] = [];
  for (const text of workerInstructions) {
    if (delivered.includes(text) || allowed.has(text)) continue;
    if (delivered.some((bytes) => text.includes(bytes))) wrapped.push(text);
    unauthorised.push(text);
  }
  const checks: Check[] = [
    {
      name: 'every instruction in the worker store is an authorised delivery (or the named harness baseline)',
      passed: unauthorised.length === 0 && workerInstructions.length > 0,
      details:
        `store instructions=${workerInstructions.length} unauthorised=${unauthorised.length} wrapped=${wrapped.length}` +
        (unauthorised.length > 0 ? ` first=${JSON.stringify(unauthorised[0]?.slice(0, 80))}` : ''),
    },
  ];
  return { ok: checks.every((check) => check.passed), checks, unauthorised, wrapped };
}

// ── The runner ──────────────────────────────────────────────────────────────

export interface VerticalSliceOptions {
  repoRoot: string;
  evidenceDir: string;
  log: (line: string) => void;
  workerModel?: string;
  keepState?: boolean;
  fixtureCacheDir?: string;
}

export interface VerticalSliceResult {
  ok: boolean;
  exitCode: number;
  lanesStarted: boolean;
  scenarios: ScenarioRecord[];
  negativeControl: NegativeControlRecord;
  gateLeak: GateLeakAudit;
  byteFidelity: ByteFidelityAudit;
  workerStoreCoverage: WorkerStoreCoverageAudit;
  evidencePaths: string[];
  failures: string[];
  worker: {
    sessionId: string | null;
    messageCount: number | null;
    inboxTexts: string[];
  };
  fixtures: Array<{ id: string; text: string; sha256: string; durationMs: number; rms: number }>;
}

export async function runVerticalSlice(options: VerticalSliceOptions): Promise<VerticalSliceResult> {
  const log = options.log;
  const evidenceDir = path.resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  const failures: string[] = [];
  const scenarios: ScenarioRecord[] = [];
  let server: DisposableServer | null = null;
  let client: VoiceWireClient | null = null;
  let api: Tier3ApiClient | null = null;
  let workerSessionId: string | null = null;
  let fixtures: OperatorFixtureSet | null = null;
  let workerInbox: string[] = [];
  /** Guards the one teardown: every exit path (including early failures) runs it. */
  let tornDown = false;
  const evidencePaths: string[] = [];

  const finish = async (
    result: Omit<VerticalSliceResult, 'evidencePaths' | 'failures' | 'scenarios' | 'worker' | 'fixtures' | 'ok' | 'exitCode'>,
    scenarioList: ScenarioRecord[]
  ): Promise<VerticalSliceResult> => {
    // EVERY exit path tears down the disposable server. An early failure return
    // (e.g. the lane start refused) previously left the spawned server alive and
    // the process hung until an external timeout killed it (observed: a 25-minute
    // stale run). Idempotent so the normal-path teardown still owns the message.
    if (!tornDown) {
      tornDown = true;
      try {
        client?.close();
      } catch {
        /* a closed socket must never mask the result */
      }
      if (server) {
        await server.stop().catch(() => {
          /* teardown failure must never mask the gate result */
        });
      }
    }
    const ok = failures.length === 0 && scenarioList.length === 3 && scenarioList.every((scenario) => scenario.passed);
    if (!ok) {
      // FAIL-CLOSED VISIBILITY: a gate that exits non-zero must say why, on
      // stdout, for a human and for a bare CLI shell — not only inside the
      // JSON record (a thrown error would otherwise exit 1 with no output).
      const passed = scenarioList.filter((scenario) => scenario.passed).length;
      log(
        `vertical slice: FAILED — ${passed}/${scenarioList.length || 3} scenarios passed, ${failures.length} failure(s)`
      );
      for (const scenario of scenarioList) {
        log(`  [${scenario.passed ? 'PASS' : 'FAIL'}] ${scenario.id} ${scenario.name}`);
        for (const check of scenario.checks) {
          if (!check.passed) log(`      x ${check.name}${check.details ? ` — ${check.details}` : ''}`);
        }
      }
      for (const failure of failures) log(`  failure: ${failure}`);
    }
    return {
      ...result,
      ok,
      exitCode: ok ? 0 : 1,
      scenarios: scenarioList,
      failures,
      evidencePaths,
      worker: {
        sessionId: workerSessionId,
        messageCount: null,
        inboxTexts: workerInbox,
      },
      fixtures: [],
    };
  };

  try {
    // ── Preflight ───────────────────────────────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !apiKey.trim()) {
      failures.push('GEMINI_API_KEY is not set: a measured operator loop must never run unlabelled.');
      return finish(
        {
          lanesStarted: false,
          negativeControl: { attempted: false, refused: false, refusalCode: null, deliveredNothing: true, instructionTextRefused: false, instructionTextRefusalCode: null, details: [] },
          gateLeak: { ok: false, checks: [] },
          byteFidelity: { ok: false, checks: [], verified: [] },
          workerStoreCoverage: { ok: false, checks: [], unauthorised: [], wrapped: [] },
        },
        scenarios
      );
    }

    // ── Boot the disposable server (this repo) ──────────────────────────────
    server = await bootDisposableServer({
      repoRoot: options.repoRoot,
      env: {
        GEMINI_API_KEY: apiKey,
        LOG_FORMAT: 'json',
        // GATE REPRODUCIBILITY: the disposable server refuses the `/ws`
        // upgrade unless its allowed origins include the origin this client
        // sends. A bare CLI shell carries no ALLOWED_ORIGINS, so the server
        // would fall back to localhost defaults and reject every voice frame
        // with a 403 before the lane starts. The slice states its own origin
        // explicitly, so the gate reproduces from any shell.
        ALLOWED_ORIGINS: SLICE_ORIGIN,
        // The slice exists to exercise the LIVE engine end to end. Track H's
        // rollout flag defaults to `cascade`, so without this the disposable
        // server would serve the cascade and every lane start would be refused
        // with `voice_provider_unavailable` (observed 2026-09-18: the gate was
        // silently misconfigured the moment the flag landed on master).
        VOICE_MODE_ENGINE: 'gemini-live',
        // A disposable login; NODE_ENV=test, so a plaintext value is accepted.
        AUTH_PASSWORD: 'voice-slice-disposable',
      },
      log: (line) => log(line),
    });
    await waitForHealth(server.httpPort);
    const session = await login(server.httpPort, server.authPassword);

    // ── Real operator audio fixtures ────────────────────────────────────────
    fixtures = await prepareOperatorAudio({
      outDir: path.join(server.stateDir, 'operator-audio'),
      ...(options.fixtureCacheDir ? { cacheDir: options.fixtureCacheDir } : {}),
      log: (line) => log(line),
    });
    if (fixtures.fixtures.size !== 10) {
      failures.push(`expected 10 operator fixtures, synthesised ${fixtures.fixtures.size}`);
    }

    // ── Real disposable Pi worker session ───────────────────────────────────
    api = createHttpTier3Api({ socketPath: server.socketPath, tokenPath: server.tokenPath });
    const workspaceDir = path.join(server.stateDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const created = await api.createSession({
      runtime: 'pi',
      cwd: workspaceDir,
      model: options.workerModel ?? WORKER_MODEL_DEFAULT,
      thinkingLevel: 'low',
      source: 'voice-vertical-slice',
      label: 'voice-slice-worker',
    } as never);
    workerSessionId = created.sessionId;
    log(`worker session created: ${workerSessionId} (model=${created.model ?? options.workerModel ?? WORKER_MODEL_DEFAULT})`);

    // ── The authenticated voice wire ────────────────────────────────────────
    client = await VoiceWireClient.connect(server.httpPort, session, (line) => log(line));
    const lane = { laneId: SLICE_LANE_ID, attachmentGeneration: SLICE_ATTACHMENT_GENERATION };
    client.sendVoice({
      type: 'voice_session_start',
      version: 1,
      ...lane,
      workerSessionId,
      runtime: 'pi',
      captureMode: 'push-to-talk',
      readingLevel: 'verbatim',
    } as never);
    const live = await client.waitFor({
      label: 'voice lane live',
      timeoutMs: 60_000,
      predicate: (frame) =>
        (frame.type === 'voice_state' && (frame as { state?: string }).state === 'live') ||
        frame.type === 'voice_error',
    });
    if (live.type === 'voice_error') {
      failures.push(`voice lane failed to start: ${JSON.stringify(live)}`);
      return finish(
        {
          lanesStarted: false,
          negativeControl: { attempted: false, refused: false, refusalCode: null, deliveredNothing: true, instructionTextRefused: false, instructionTextRefusalCode: null, details: [] },
          gateLeak: { ok: false, checks: [] },
          byteFidelity: { ok: false, checks: [], verified: [] },
          workerStoreCoverage: { ok: false, checks: [], unauthorised: [], wrapped: [] },
        },
        scenarios
      );
    }
    log('voice lane live');

    const wire = new SliceWire(client, lane, fixtures, log);

    // ── S1: thinking together (4 turns, no offer, no interruption) ──────────
    const s1 = await runScenario1(wire, api, workerSessionId, server.stateDir);
    scenarios.push(s1);

    // ── S2: directed steer + tampered-confirmation control ──────────────────
    const s2 = await runScenario2(wire, api, workerSessionId, server.stateDir);
    scenarios.push(s2.record);

    // ── S3: parking & surface ───────────────────────────────────────────────
    const s3 = await runScenario3(wire, api, workerSessionId, server.stateDir);
    scenarios.push(s3);

    // ── Facts from the worker session itself ────────────────────────────────
    const info = await api.childInfo(workerSessionId);
    const store = await readWorkerMessages(api, server.stateDir, workerSessionId);
    workerInbox = readWorkerInbox(store.sessionPath ?? '');
    log(`worker session: status=${info.status} busy=${info.busy} messages=${store.messageCount ?? 'n/a'}`);
    log(
      `worker store: path=${store.sessionPath ?? 'none'} messages=${workerInbox.length} transcriptLines=${store.transcriptLines.length}`
    );

    // ── Audits on the real server log ───────────────────────────────────────
    const serverLog = readFileSync(server.logPath, 'utf8');
    const kernelEvents = parseKernelEvents(serverLog);
    log(`voice-kernel evidence lines: ${kernelEvents.length}`);
    const gateLeak = auditGateLeak(kernelEvents);
    const byteFidelity = auditByteFidelity(kernelEvents, store.text.split('\n'));
    // The converse direction (review R, Gate-5 coverage limit 2): every user
    // instruction in the worker's own store must be an authorised delivery, or
    // the one baseline this runner injects directly to make the worker busy.
    const workerStoreCoverage = auditWorkerStoreCoverage(
      workerInbox,
      // The PROPOSAL's own bytes for each delivered variant (creation-derived),
      // never the delivery frame's own claim about what it carried.
      byteFidelity.verified.map((entry) => entry.tidied),
      [SLOW_WORKER_PROMPT]
    );
    for (const check of [...gateLeak.checks, ...byteFidelity.checks, ...workerStoreCoverage.checks]) {
      if (!check.passed) failures.push(`audit: ${check.name} — ${check.details ?? ''}`);
    }

    // ── Evidence ────────────────────────────────────────────────────────────
    const record = {
      schema: 'voice-vertical-slice/1',
      createdAt: new Date().toISOString(),
      repoRoot: options.repoRoot,
      server: {
        stateDir: server.stateDir,
        logPath: server.logPath,
        httpPort: server.httpPort,
        socketPath: server.socketPath,
      },
      worker: {
        sessionId: workerSessionId,
        model: created.model ?? null,
        status: info.status,
        busy: info.busy,
        messageCount: info.messageCount ?? store.messageCount ?? null,
        transcriptLines: store.transcriptLines,
      },
      lane,
      scenarios,
      negativeControl: s2.negativeControl,
      gateLeak,
      byteFidelity,
      fixtures: [...fixtures.fixtures.values()].map((fixture) => ({
        id: fixture.id,
        text: fixture.text,
        durationMs: fixture.durationMs,
        rms: fixture.rms,
        sha256: fixture.pcmSha256,
      })),
      wireFrames: wire.redactedFrames(),
      failures,
      workerStoreCoverage,
    };
    evidencePaths.push(writeEvidence(evidenceDir, 'slice-run.json', record));
    evidencePaths.push(writeEvidence(evidenceDir, 'negative-control.json', record.negativeControl));
    evidencePaths.push(writeEvidence(evidenceDir, 'server-log-kernel-events.json', kernelEvents));
    evidencePaths.push(
      writeEvidence(
        evidenceDir,
        'gate-leak-audit.json',
        { ok: gateLeak.ok, checks: gateLeak.checks }
      )
    );
    evidencePaths.push(
      writeEvidence(
        evidenceDir,
        'byte-fidelity-audit.json',
        { ok: byteFidelity.ok, checks: byteFidelity.checks, verified: byteFidelity.verified }
      )
    );
    evidencePaths.push(
      writeEvidence(
        evidenceDir,
        'worker-store-coverage.json',
        {
          ok: workerStoreCoverage.ok,
          checks: workerStoreCoverage.checks,
          unauthorised: workerStoreCoverage.unauthorised,
          wrapped: workerStoreCoverage.wrapped,
          allowlisted: ['SLOW_WORKER_PROMPT (injected directly to make the worker genuinely busy)'],
        }
      )
    );
    evidencePaths.push(
      writeEvidence(
        evidenceDir,
        'server-kernel-log.txt',
        kernelEvents.map((event) => JSON.stringify(event)).join('\n') + '\n'
      )
    );
    // The worker session's own store, copied verbatim: the primary evidence
    // that the delivered bytes reached the worker. The disposable state dir is
    // kept for inspection; this snapshot makes the record self-contained.
    if (store.sessionPath && existsSync(store.sessionPath)) {
      evidencePaths.push(
        writeEvidence(evidenceDir, 'worker-session-store.jsonl', readFileSync(store.sessionPath, 'utf8'))
      );
    } else {
      evidencePaths.push(
        writeEvidence(evidenceDir, 'worker-session-store.jsonl', '# worker store could not be read\n')
      );
    }

    const summary = renderSummary(scenarios, s2.negativeControl, gateLeak, byteFidelity, workerStoreCoverage, failures);
    evidencePaths.push(writeEvidence(evidenceDir, 'run-summary.txt', summary));
    for (const line of summary.split('\n')) log(line);

    // ── Cleanup ─────────────────────────────────────────────────────────────
    // The worker session is NOT deleted: the disposable server is about to be
    // stopped, and its store is the primary fidelity evidence. Nothing here
    // touches production state.
    client.close();
    await server.stop();
    tornDown = true;
    log(`disposable state dir kept for inspection: ${server.stateDir}`);

    const okResult = await finish(
      {
        lanesStarted: true,
        negativeControl: s2.negativeControl,
        gateLeak,
        byteFidelity,
      },
      scenarios
    );
    okResult.worker.messageCount = info.messageCount ?? null;
    okResult.fixtures = [...fixtures.fixtures.values()].map((fixture) => ({
      id: fixture.id,
      text: fixture.text,
      sha256: fixture.pcmSha256,
      durationMs: fixture.durationMs,
      rms: fixture.rms,
    }));
    return okResult;
  } catch (error) {
    failures.push(`runner error: ${error instanceof Error ? error.message : String(error)}`);
    try {
      client?.close();
    } catch {
      /* ignore */
    }
    if (server) {
      await server.stop().catch(() => {
        /* ignore */
      });
      tornDown = true;
    }
    return finish(
      {
        lanesStarted: false,
        negativeControl: { attempted: false, refused: false, refusalCode: null, deliveredNothing: true, instructionTextRefused: false, instructionTextRefusalCode: null, details: [] },
        gateLeak: { ok: false, checks: [] },
        byteFidelity: { ok: false, checks: [], verified: [] },
        workerStoreCoverage: { ok: false, checks: [], unauthorised: [], wrapped: [] },
      },
      scenarios
    );
  }
}

// ── The wire helper ─────────────────────────────────────────────────────────

class SliceWire {
  constructor(
    readonly client: VoiceWireClient,
    readonly lane: { laneId: string; attachmentGeneration: number },
    readonly fixtures: OperatorFixtureSet,
    readonly log: (line: string) => void
  ) {}

  utterance(id: string): OperatorUtterance {
    const fixture = this.fixtures.fixtures.get(id);
    if (!fixture) throw new Error(`no operator fixture '${id}'`);
    return fixture;
  }

  /** Stream one real spoken utterance: activity markers + 20 ms PCM frames. */
  async speak(id: string): Promise<void> {
    const fixture = this.utterance(id);
    const envelope = { version: 1 as const, ...this.lane };
    this.client.sendVoice({
      type: 'voice_activity_state',
      ...envelope,
      state: 'speech_start',
      atMs: Date.now(),
    } as never);
    const chunkBytes = 640; // 20 ms of 16 kHz PCM16
    for (let offset = 0; offset < fixture.pcm.byteLength; offset += chunkBytes) {
      const slice = fixture.pcm.subarray(offset, Math.min(offset + chunkBytes, fixture.pcm.byteLength));
      this.client.sendVoice({
        type: 'voice_audio_chunk',
        ...envelope,
        seq: this.client.nextAudioSeq(),
        mimeType: 'audio/pcm;rate=16000',
        data: slice.toString('base64'),
        durationMs: (slice.byteLength / 2 / 16_000) * 1000,
        capturedAtMs: Date.now(),
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.client.sendVoice({
      type: 'voice_activity_state',
      ...envelope,
      state: 'speech_end',
      atMs: Date.now(),
    } as never);
  }

  /** Wait for the talker to finish its reply to the utterance just spoken. */
  async waitForTalkerReply(mark: number, timeoutMs: number, label: string): Promise<string | null> {
    try {
      const frame = await this.client.waitForNew(mark, {
        label,
        timeoutMs,
        predicate: (candidate) =>
          candidate.type === 'transcript_delta' &&
          (candidate as { speaker?: string }).speaker === 'talker' &&
          (candidate as { final?: boolean }).final === true,
      });
      const text = String((frame as { text?: unknown }).text ?? '');
      return text;
    } catch {
      return null;
    }
  }

  count(type: string): number {
    return this.client.framesOfType(type).length;
  }

  /** The most recent FINAL operator transcript, for failure diagnostics. */
  lastOperatorUtterance(): string {
    const finals = this.client
      .framesOfType('transcript_delta')
      .filter((frame) => frame.speaker === 'operator' && frame.final === true);
    return String(finals.at(-1)?.text ?? '');
  }

  redactedFrames(): Array<{ atMs: number; direction: string; type: string; frame: Record<string, unknown> }> {
    return this.client.received.map((record) => ({
      atMs: record.atMs,
      direction: record.direction,
      type: String(record.frame.type ?? 'unknown'),
      frame: redactAudio(record.frame) as Record<string, unknown>,
    }));
  }
}

function redactAudio(frame: Record<string, unknown>): Record<string, unknown> {
  if (typeof frame.data !== 'string') return frame;
  return { ...frame, data: `<redacted ${frame.data.length} base64 chars>` };
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function runScenario1(
  wire: SliceWire,
  api: Tier3ApiClient,
  workerSessionId: string,
  stateDir: string
): Promise<ScenarioRecord> {
  const checks = new CheckList();
  const turnIds = ['s1-turn1', 's1-turn2', 's1-turn3', 's1-turn4'];
  const beforeProposals = wire.count('proposal_created');
  const beforeParking = wire.count('parking_updated');
  const beforeReceipts = wire.count('receipt_event');
  const beforeAudioOut = wire.count('voice_audio_chunk');

  let replies = 0;
  for (const turnId of turnIds) {
    const mark = wire.client.mark();
    await wire.speak(turnId);
    const reply = await wire.waitForTalkerReply(mark, 60_000, `talker reply for ${turnId}`);
    if (reply !== null) {
      replies += 1;
      checks.note(`turn ${turnId}: talker replied "${reply.slice(0, 120)}"`);
    } else {
      checks.note(`turn ${turnId}: no final talker transcript observed`);
    }
  }

  const afterProposals = wire.count('proposal_created');
  const afterParking = wire.count('parking_updated');
  const afterReceipts = wire.count('receipt_event');
  const audioOut = wire.count('voice_audio_chunk') - beforeAudioOut;

  const info = await api.childInfo(workerSessionId);
  const store = await readWorkerMessages(api, stateDir, workerSessionId);

  checks.check('four operator turns produced talker replies', replies >= 3, `replies=${replies}/4`);
  checks.check('the talker actually spoke (audio out) during S1', audioOut > 0, `voice_audio_chunk frames=${audioOut}`);
  checks.check(
    'thinking together generated no proposal',
    afterProposals === beforeProposals,
    `proposal_created before=${beforeProposals} after=${afterProposals}`
  );
  checks.check(
    'thinking together generated no parking update',
    afterParking === beforeParking,
    `parking_updated before=${beforeParking} after=${afterParking}`
  );
  checks.check(
    'thinking together generated no delivery receipt',
    afterReceipts === beforeReceipts,
    `receipt_event before=${beforeReceipts} after=${afterReceipts}`
  );
  checks.check('the worker was never interrupted (idle, no turn)', info.busy === false, `busy=${info.busy} status=${info.status}`);
  checks.check(
    'the worker session has received no message at all',
    (info.messageCount ?? store.messageCount ?? 0) === 0 && store.text.trim() === '',
    `messageCount=${info.messageCount} storeMessages=${store.text.split('\n').filter(Boolean).length} transcriptLines=${store.transcriptLines.length}`
  );

  return {
    id: 'S1',
    name: 'Thinking together (4 turns, no offer/steer, worker untouched)',
    passed: checks.passed,
    checks: checks.checks,
    notes: checks.notes,
  };
}

interface NegativeControlRecord {
  attempted: boolean;
  refused: boolean;
  refusalCode: string | null;
  deliveredNothing: boolean;
  /** The structural control: a confirm frame carrying instruction text. */
  instructionTextRefused: boolean;
  instructionTextRefusalCode: string | null;
  details: string[];
}

async function runScenario2(
  wire: SliceWire,
  api: Tier3ApiClient,
  workerSessionId: string,
  stateDir: string
): Promise<{ record: ScenarioRecord; negativeControl: NegativeControlRecord }> {
  const checks = new CheckList();
  const control: NegativeControlRecord = {
    attempted: false,
    refused: false,
    refusalCode: null,
    deliveredNothing: true,
    instructionTextRefused: false,
    instructionTextRefusalCode: null,
    details: [],
  };

  // 1. The directed instruction becomes a proposal while the worker is idle.
  const directMark = wire.client.mark();
  await wire.speak('s2-direct');
  await wire.waitForTalkerReply(directMark, 60_000, 'talker reply to the directed instruction');
  let proposalFrame: Record<string, unknown> | null = null;
  try {
    proposalFrame = await wire.client.waitForNew(directMark, {
      label: 'proposal_created for the directed instruction',
      timeoutMs: 30_000,
      predicate: (frame) => frame.type === 'proposal_created',
    });
  } catch {
    proposalFrame = null;
  }
  const proposal = (proposalFrame as { proposal?: Record<string, unknown> } | null)?.proposal ?? null;
  checks.check('a proposal appears for the directed instruction', proposal !== null, proposal === null ? 'no proposal_created frame' : 'proposal received');

  const tidied = typeof proposal?.tidied === 'string' ? proposal.tidied : '';
  const normalisedTidied = normaliseRelayText(tidied).text.toLowerCase();
  checks.check(
    'the proposal carries the operator instruction (tidied bytes)',
    /check/.test(normalisedTidied) && /test/.test(normalisedTidied),
    `tidied="${tidied}"`
  );
  checks.check(
    'the proposal is a directed promotion with an identity',
    proposal?.promotionRoute === 'directed' && typeof proposal?.sha256 === 'string' && proposal.sha256.length === 64,
    `route=${String(proposal?.promotionRoute)} sha256len=${typeof proposal?.sha256 === 'string' ? proposal.sha256.length : 'n/a'}`
  );
  if (proposal === null) {
    // Without a proposal the remaining checks cannot be evaluated honestly;
    // the scenario fails with the checks recorded so far.
    checks.check('proposal identity available for the steer', false, 'no proposal');
    return {
      record: {
        id: 'S2',
        name: 'Directed steer (proposal → tampered refusal → spoken confirm → exact bytes)',
        passed: false,
        checks: checks.checks,
        notes: checks.notes,
      },
      negativeControl: control,
    };
  }

  const proposalId = String(proposal.proposalId);
  const proposalVersion = Number(proposal.version);

  // 2. The surface's read-back report (a precondition of confirmation).
  wire.client.sendVoice({
    type: 'proposal_presentation',
    version: 1,
    ...wire.lane,
    proposalId,
    presentedVariant: 'tidied',
    completed: true,
  } as never);

  // 3. NEGATIVE CONTROL: a tampered confirmation (wrong SHA echo) must be
  //    refused and must deliver nothing.
  const tamperedMark = wire.client.mark();
  const receiptsBefore = wire.count('receipt_event');
  wire.client.sendVoice({
    type: 'proposal_confirm',
    version: 1,
    ...wire.lane,
    proposalId,
    variant: 'tidied',
    idempotencyKey: 'slice-negative-control-tampered',
    proposalRef: { version: proposalVersion, sha256: '00'.repeat(32) },
  } as never);
  control.attempted = true;
  let refusal: Record<string, unknown> | null = null;
  try {
    refusal = await wire.client.waitForNew(tamperedMark, {
      label: 'voice_error for the tampered confirmation',
      timeoutMs: 15_000,
      predicate: (frame) => frame.type === 'voice_error',
    });
  } catch {
    refusal = null;
  }
  control.refusalCode = typeof refusal?.code === 'string' ? refusal.code : null;
  control.refused = control.refusalCode === 'voice_proposal_stale';
  const receiptsAfter = wire.count('receipt_event');
  control.deliveredNothing = receiptsAfter === receiptsBefore;
  control.details.push(`tampered confirm → ${control.refusalCode ?? 'no refusal'}`);
  control.details.push(`receipts before=${receiptsBefore} after=${receiptsAfter}`);
  checks.check(
    'negative control: a tampered confirmation is refused with voice_proposal_stale',
    control.refused,
    `code=${control.refusalCode}`
  );
  checks.check('negative control: the tampered confirmation delivered nothing', control.deliveredNothing, `receipts ${receiptsBefore}→${receiptsAfter}`);

  // 4. Make the worker busy, so the confirmed relay is a real mid-run steer.
  await startSlowWorkerTurn(wire, api, workerSessionId);
  const busy = await waitForWorkerBusy(api, workerSessionId, 30_000);
  checks.check('the worker is mid-run when the operator confirms', busy, `busy=${busy}`);

  // 5. The spoken confirmation releases the proposal. The live provider's ASR
  // may mishear the first attempt (observed 2026-09-18: "Yes, send that." →
  // "Yes and that.", a statement, so nothing was released and nothing was
  // wrong — the classifier refused to treat it as a confirmation). A human
  // repeats themselves: the beat is retried once with a second phrase, and the
  // check says which attempt (if any) landed.
  const attemptReceipt = async (fixture: string, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    const mark = wire.client.mark();
    await wire.speak(fixture);
    try {
      return await wire.client.waitForNew(mark, {
        label: `receipt_event after ${fixture}`,
        timeoutMs,
        predicate: (candidate) => candidate.type === 'receipt_event',
      });
    } catch {
      return null;
    }
  };
  const firstAttempt = await attemptReceipt('s2-confirm', 25_000);
  const receiptFrame = firstAttempt ?? (await attemptReceipt('s2-confirm-retry', 30_000));
  const confirmAttempt =
    firstAttempt !== null ? 's2-confirm' : receiptFrame !== null ? 's2-confirm-retry' : 'both attempts';
  const receipt = (receiptFrame as { receipt?: Record<string, unknown> } | null)?.receipt ?? null;
  checks.check(
    'the spoken confirmation produced a delivery receipt',
    receipt !== null,
    receipt === null ? `no receipt_event (${confirmAttempt} failed)` : `receipt received (${confirmAttempt})`
  );
  checks.check(
    'the receipt says delivered (the out-of-band chime condition)',
    receipt?.outcome === 'delivered',
    `outcome=${String(receipt?.outcome)} reason=${String(receipt?.reason ?? '')}`
  );
  checks.check(
    'the delivered receipt names the same proposal',
    receipt?.proposalId === proposalId,
    `receipt.proposalId=${String(receipt?.proposalId)} proposalId=${proposalId}`
  );
  checks.check(
    'the delivery was a mid-run steer',
    receipt?.mechanism === 'steer',
    `mechanism=${String(receipt?.mechanism)} disclosure=${String(receipt?.disclosure ?? '')}`
  );

  // The structural half of the negative control: an instruction-bearing confirm
  // frame is refused by the contract's own guard before anything is acted on.
  const textMark = wire.client.mark();
  wire.client.sendVoice({
    type: 'proposal_confirm',
    version: 1,
    ...wire.lane,
    proposalId,
    variant: 'tidied',
    idempotencyKey: 'slice-negative-control-text',
    text: 'rm -rf everything',
  } as never);
  let textRefusal: Record<string, unknown> | null = null;
  try {
    textRefusal = await wire.client.waitForNew(textMark, {
      label: 'voice_error for an instruction-bearing confirm',
      timeoutMs: 15_000,
      predicate: (frame) => frame.type === 'voice_error',
    });
  } catch {
    textRefusal = null;
  }
  control.instructionTextRefusalCode = typeof textRefusal?.code === 'string' ? textRefusal.code : null;
  control.instructionTextRefused = control.instructionTextRefusalCode === 'voice_client_text_forbidden';
  control.details.push(`instruction-text confirm → ${control.instructionTextRefusalCode ?? 'no refusal'}`);
  checks.check(
    'negative control: a confirm frame carrying instruction text is refused',
    control.instructionTextRefused,
    `code=${control.instructionTextRefusalCode}`
  );

  // 6. The worker store must hold exactly the confirmed bytes. A mid-run steer
  //    is persisted by the runtime at the next turn boundary, so the store is
  //    polled briefly rather than read once.
  const store = await waitForWorkerStoreText(api, stateDir, workerSessionId, tidied, 45_000);
  checks.check(
    'the worker received the exact proposal bytes',
    tidied.length > 0 && store.text.includes(tidied),
    `looking for "${tidied}" in the worker store (${store.sessionPath ?? 'no store'}, ${store.transcriptLines.length} transcript lines)`
  );

  return {
    record: {
      id: 'S2',
      name: 'Directed steer (proposal → tampered refusal → spoken confirm → exact bytes)',
      passed: checks.passed,
      checks: checks.checks,
      notes: checks.notes,
    },
    negativeControl: control,
  };
}

async function runScenario3(
  wire: SliceWire,
  api: Tier3ApiClient,
  workerSessionId: string,
  stateDir: string
): Promise<ScenarioRecord> {
  const checks = new CheckList();

  // 1. The worker must be mid-run: flagging while it is busy is what parks.
  await startSlowWorkerTurn(wire, api, workerSessionId);
  const busy = await waitForWorkerBusy(api, workerSessionId, 30_000);
  checks.check('the worker is mid-run while the two items are flagged', busy, `busy=${busy}`);

  const flagMark1 = wire.client.mark();
  await wire.speak('s3-flag1');
  let parked1: Record<string, unknown> | null = null;
  try {
    parked1 = await wire.client.waitForNew(flagMark1, {
      label: 'parking_updated (first flag)',
      timeoutMs: 40_000,
      predicate: (frame) =>
        frame.type === 'parking_updated' && (frame as { operation?: string }).operation === 'added',
    });
  } catch {
    parked1 = null;
  }
  const items1 = ((parked1 as { items?: unknown[] } | null)?.items ?? []) as Array<Record<string, unknown>>;
  checks.check('the first flagged item parks', parked1 !== null && items1.length === 1, `items=${items1.length}`);

  const flagMark2 = wire.client.mark();
  await wire.speak('s3-flag2');
  let parked2: Record<string, unknown> | null = null;
  try {
    parked2 = await wire.client.waitForNew(flagMark2, {
      label: 'parking_updated (second flag)',
      timeoutMs: 40_000,
      predicate: (frame) =>
        frame.type === 'parking_updated' && (frame as { operation?: string }).operation === 'added',
    });
  } catch {
    parked2 = null;
  }
  const items2 = ((parked2 as { items?: unknown[] } | null)?.items ?? []) as Array<Record<string, unknown>>;
  checks.check(
    'the second flagged item parks as well',
    parked2 !== null && items2.length === 2,
    `items=${items2.length} (last operator utterance: "${wire.lastOperatorUtterance()}")`
  );
  const parkedTexts = items2.map((item) => String(item.text ?? ''));
  checks.check(
    'both parked items carry the operator instruction text',
    parkedTexts.some((text) => /log/i.test(text)) && parkedTexts.some((text) => /change\s*log/i.test(text)),
    `parked="${parkedTexts.join(' | ')}"`
  );

  // ── Wait for the worker turn to complete before promoting ──
  // (The instruction parks because the worker is BUSY; a turn that has already
  // finished is itself the completion the scenario waits for.)
  const busyAfterFlags = (await api.childInfo(workerSessionId)).busy;
  const idle = busyAfterFlags
    ? await api.awaitWatch(workerSessionId, { condition: 'idle', timeoutS: 240 }).catch(() => ({ fired: false, timedOut: true, atMs: 0 }))
    : { fired: true, timedOut: false, atMs: 0 };
  checks.check(
    'the worker turn completes before the promotion',
    idle.fired,
    `fired=${idle.fired} timedOut=${idle.timedOut} wasBusy=${busyAfterFlags}`
  );

  const firstItemId = String(items2[0]?.itemId ?? '');
  const firstItemText = String(items2[0]?.text ?? '');
  const secondItemId = String(items2[1]?.itemId ?? '');

  // 3. Promote exactly one item.
  const promoteMark = wire.client.mark();
  wire.client.sendVoice({
    type: 'parking_promote',
    version: 1,
    ...wire.lane,
    itemId: firstItemId,
  } as never);
  let promoted: Record<string, unknown> | null = null;
  try {
    promoted = await wire.client.waitForNew(promoteMark, {
      label: 'proposal_created for the promoted item',
      timeoutMs: 30_000,
      predicate: (frame) => frame.type === 'proposal_created',
    });
  } catch {
    promoted = null;
  }
  const promotedProposal = (promoted as { proposal?: Record<string, unknown> } | null)?.proposal ?? null;
  checks.check('promoting the parked item creates a proposal', promotedProposal !== null, 'proposal_created received');
  checks.check(
    'the promoted proposal is a parked-item promotion of that item, carrying its bytes',
    promotedProposal?.promotionRoute === 'parked_item' &&
      promotedProposal?.sourceItemId === firstItemId &&
      promotedProposal?.tidied === firstItemText,
    `route=${String(promotedProposal?.promotionRoute)} sourceItemId=${String(promotedProposal?.sourceItemId)} tidied="${String(promotedProposal?.tidied ?? '')}"`
  );

  // 4. Confirm the promoted proposal (the frame path) and observe the receipt.
  wire.client.sendVoice({
    type: 'proposal_presentation',
    version: 1,
    ...wire.lane,
    proposalId: String(promotedProposal?.proposalId ?? ''),
    presentedVariant: 'tidied',
    completed: true,
  } as never);
  const confirmMark = wire.client.mark();
  wire.client.sendVoice({
    type: 'proposal_confirm',
    version: 1,
    ...wire.lane,
    proposalId: String(promotedProposal?.proposalId ?? ''),
    variant: 'tidied',
    idempotencyKey: `slice-s3-confirm-${Date.now().toString(36)}`,
    proposalRef: {
      version: Number(promotedProposal?.version ?? -1),
      sha256: String(promotedProposal?.sha256 ?? ''),
    },
  } as never);
  let receiptFrame3: Record<string, unknown> | null = null;
  try {
    receiptFrame3 = await wire.client.waitForNew(confirmMark, {
      label: 'receipt_event for the promoted item',
      timeoutMs: 90_000,
      predicate: (frame) => frame.type === 'receipt_event',
    });
  } catch {
    receiptFrame3 = null;
  }
  const receipt3 = (receiptFrame3 as { receipt?: Record<string, unknown> } | null)?.receipt ?? null;
  checks.check('the promoted item is delivered on confirmation', receipt3?.outcome === 'delivered', `outcome=${String(receipt3?.outcome)}`);

  // 5. The parking lot must now hold exactly the second item.
  const listMark = wire.client.mark();
  wire.client.sendVoice({ type: 'parking_list', version: 1, ...wire.lane } as never);
  let listed: Record<string, unknown> | null = null;
  try {
    listed = await wire.client.waitForNew(listMark, {
      label: 'parking_updated (listed)',
      timeoutMs: 15_000,
      predicate: (frame) =>
        frame.type === 'parking_updated' && (frame as { operation?: string }).operation === 'listed',
    });
  } catch {
    listed = null;
  }
  const remaining = ((listed as { items?: unknown[] } | null)?.items ?? []) as Array<Record<string, unknown>>;
  checks.check(
    'the second item remains safely parked',
    remaining.length === 1 && String(remaining[0]?.itemId ?? '') === secondItemId,
    `remaining=${remaining.map((item) => item.itemId).join(',')} expected=${secondItemId}`
  );

  // 6. The worker store must hold the promoted bytes (delivered as a prompt).
  const store = await waitForWorkerStoreText(api, stateDir, workerSessionId, firstItemText, 60_000);
  checks.check(
    'the worker received the exact promoted bytes',
    firstItemText.length > 0 && store.text.includes(firstItemText),
    `looking for "${firstItemText}" in the worker store (${store.sessionPath ?? 'no store'}, ${store.transcriptLines.length} transcript lines)`
  );

  return {
    id: 'S3',
    name: 'Parking & surface (two parked while busy, one promoted after the turn, one still parked)',
    passed: checks.passed,
    checks: checks.checks,
    notes: checks.notes,
  };
}

// ── Worker helpers ──────────────────────────────────────────────────────────

async function startSlowWorkerTurn(wire: SliceWire, api: Tier3ApiClient, workerSessionId: string): Promise<void> {
  const info = await api.childInfo(workerSessionId);
  if (info.busy) return;
  await api.prompt(workerSessionId, SLOW_WORKER_PROMPT, 'prompt');
  wire.log('slow worker turn dispatched');
}

async function waitForWorkerBusy(api: Tier3ApiClient, workerSessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await api.childInfo(workerSessionId);
    if (info.busy) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Read the worker session's own store: every user text the worker received. */
export function readWorkerInbox(sessionPath: string): string[] {
  if (!sessionPath || !existsSync(sessionPath)) return [];
  const text: string[] = [];
  for (const line of readFileSync(sessionPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(trimmed) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    if (typeof content === 'string') {
      text.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : ''))
        .filter((part) => part !== '');
      if (parts.length > 0) text.push(parts.join('\n'));
    }
  }
  return text;
}

// ── Evidence rendering ──────────────────────────────────────────────────────

/**
 * Credential-shaped values, redacted from every evidence file.
 *
 * WHY: the evidence copies the worker session's own store verbatim, and a Pi
 * worker can run a shell command whose output includes its environment — the
 * disposable server's process environment carries provider credentials, so a
 * worker's `env` dump puts real keys inside a tool result. The runner must
 * never write credentials into a repository. The live gate is NOT affected:
 * redaction happens only on the way to disk, never on the strings the audits
 * compare; the audits use the in-memory values, not the written evidence.
 */
export function redactSecrets(text: string): string {
  const redacted = text
    .replace(/AIza[0-9A-Za-z_-]{30,}/g, '<redacted-google-key>')
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, '<redacted-openrouter-key>')
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/g, '<redacted-api-key>')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted-github-token>')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted-slack-token>')
    .replace(/([A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z_]*=)([^\s"'|\\=]{6,})/g, '$1<redacted>')
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1<redacted>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>');
  return redacted;
}

function writeEvidence(dir: string, name: string, payload: unknown): string {
  const target = path.join(dir, name);
  const text = typeof payload === 'string' ? payload : `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(target, redactSecrets(text), { mode: 0o600 });
  return target;
}

function renderSummary(
  scenarios: ScenarioRecord[],
  control: NegativeControlRecord,
  gateLeak: GateLeakAudit,
  fidelity: ByteFidelityAudit,
  coverage: WorkerStoreCoverageAudit,
  failures: string[]
): string {
  const lines: string[] = [];
  lines.push(`Vertical slice: ${scenarios.filter((scenario) => scenario.passed).length}/3 scenarios passed`);
  for (const scenario of scenarios) {
    lines.push(`  [${scenario.passed ? 'PASS' : 'FAIL'}] ${scenario.id} ${scenario.name}`);
    for (const check of scenario.checks) {
      lines.push(`      ${check.passed ? '✓' : '✗'} ${check.name}${check.details ? ` — ${check.details}` : ''}`);
    }
  }
  lines.push(
    `  negative control: attempted=${control.attempted} refused=${control.refused} code=${control.refusalCode ?? 'n/a'} deliveredNothing=${control.deliveredNothing}`
  );
  lines.push(`  gate leak: ${gateLeak.ok ? 'clean' : 'VIOLATED'}`);
  for (const check of gateLeak.checks) lines.push(`      ${check.passed ? '✓' : '✗'} ${check.name}${check.details ? ` — ${check.details}` : ''}`);
  lines.push(`  byte fidelity: ${fidelity.ok ? '100%' : 'FAILED'}`);
  for (const check of fidelity.checks) lines.push(`      ${check.passed ? '✓' : '✗'} ${check.name}${check.details ? ` — ${check.details}` : ''}`);
  lines.push(`  worker-store coverage (store ⊆ delivered): ${coverage.ok ? 'clean' : 'VIOLATED'}`);
  for (const check of coverage.checks) lines.push(`      ${check.passed ? '✓' : '✗'} ${check.name}${check.details ? ` — ${check.details}` : ''}`);
  if (failures.length > 0) {
    lines.push('failures:');
    for (const failure of failures) lines.push(`  - ${failure}`);
  }
  return `${lines.join('\n')}\n`;
}
