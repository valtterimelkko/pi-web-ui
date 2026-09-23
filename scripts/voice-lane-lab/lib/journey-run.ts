import { talkerActivityCount } from './talker-quiescence.js';
/**
 * The `primary-mic` browser journey runner (child J; plan §4.2, §11 Phase 2).
 *
 * One command drives the BUILT production-shape app against a disposable
 * compiled validation server with `VOICE_MODE_ENGINE=gemini-live`, verifies
 * the served build and native provider activity, and drives the MAIN controls
 * (`drive-mic`, the proposal card, spoken approval) with observed microphone
 * speech: the opening utterance rides Chromium's file-backed fake capture
 * through the real pipeline; every later director utterance uses the labelled
 * `synthetic-stream-source` helper feeding the UNCHANGED product capture
 * pipeline. Per attempt it writes an immutable E2 record (L's record system).
 *
 * Exit semantics live in the CLI: 0 pass / 1 demonstrated failure / 2
 * incomplete-invalid. Missing credentials (the child server env) or absent
 * ingress evidence are exit 2 — never a green skip. The VERDICT itself comes
 * from the offline verifier; this runner never self-scores.
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  INGRESS_INSTRUMENT_SCRIPT,
  SYNTHETIC_TTS_LABEL,
  TTS_SHIM_SCRIPT,
  ensureBuiltAppFresh,
  freePort,
  run,
  waitForHttp,
} from './built-app.js';
import { createAttempt, finaliseAttempt, type AttemptManifest } from './records.js';
import { episodeById, type LoadedCorpus } from './corpus.js';
import { EpisodeDirector, type DirectorObservation, type DirectorAction } from './director.js';
import { journeyPlanHash, type JourneyPlan, type JourneyTurn } from './journey-plan.js';
import {
  BUSY_DRIVE_PROMPT,
  driveWorkerBusy,
  journeyRequiresBusyDrive,
  journeyRequiresSecondWorker,
  prepareTwoWorkerSessions,
  setSessionDisplayName,
  type BusyDriveRecord,
  type PreparedWorkerSession,
} from './worker-prep.js';
import { decodeWav, encodeWavPcm16 } from '../../audio-lab/lib/wav.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export interface JourneyRunOptions {
  repoRoot: string;
  corpus: LoadedCorpus;
  corpusDir: string;
  recordsRoot: string;
  campaignId: string;
  authPassword: string;
  /** Arm-selection env passed to the child server (arm selection as data). */
  serverEnv: Record<string, string>;
  /** Override for tests; defaults to the plan's attempt deadline. */
  attemptDeadlineMs?: number;
  log?: (line: string) => void;
}

export type JourneyOutcome = 'pass' | 'fail' | 'incomplete' | 'not-run';

export interface JourneyRunResult {
  attemptDir: string;
  outcome: JourneyOutcome;
  /** Coarse runner-side outcome only — the verdict is the verifier's. */
  detail: string;
  reason?: string;
}

// ── Page-side observation helpers ───────────────────────────────────────────

interface WireFrameRow {
  seq: number;
  atMs: number;
  direction: 'inbound' | 'outbound';
  type: string;
  frame: Record<string, unknown>;
}

interface LabDump {
  mode: string;
  sourceLabel: string | null;
  getUserMediaCalls: number;
  captureStartedAtMs: number | null;
  captureStoppedAtMs: number | null;
  ingressCount: number;
  egressCount: number;
  wireFrames: WireFrameRow[];
  speakLog: Array<{ atMs: number; sampleRate: number; frames: number }>;
  ingress: Array<{ seq: number; atMs: number; sampleRate: number; sampleCount: number; pcm: string }>;
  egress: Array<{ seq: number; atMs: number; sampleRate: number; sampleCount: number; b64: string }>;
  wsSendCalls: number;
}

/**
 * Wait until the talker's own audio has been quiet for `quietMs` (fix-loop pass
 * 8, C01). A real operator does not confirm over the assistant's speech, and a
 * confirmation spoken inside the echo window is dropped as echo
 * (`talker_audio_window`) so the release never fires. Quiescence is observed
 * from the lab's own egress counter — the model audio the server sent the lane,
 * a signal independent of the child's cooperation — never from a fixed sleep.
 */
async function waitForTalkerQuiet(labPage: LabPage, quietMs = 2_000, timeoutMs = 25_000): Promise<void> {
  if (!labPage.current) return;
  const started = Date.now();
  let lastCount = -1;
  let lastChangeAt = Date.now();
  for (;;) {
    const dump = await dumpLab(labPage.current).catch(() => null);
    // W4: the talker's TEXT counts too. The et-high model emits whole text
    // turns with no audio (C01-et-high/attempt-04: transcripts 17.7-25.1 s, no
    // egress chunks 12.4-34.1 s), so an audio-only counter said "quiet" while
    // the model was still mid-turn and the confirm was dropped as echo.
    const count = dump
      ? talkerActivityCount({ egressCount: dump.egressCount, wireFrames: dump.wireFrames })
      : lastCount;
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return;
    }
    if (Date.now() - started >= timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Pull everything the instrument holds (bounded arrays) out of the page. */
async function dumpLab(page: import('playwright').Page): Promise<LabDump | null> {
  return page
    .evaluate(() => {
      const lab = (window as unknown as { __voiceLaneLab?: never }).__voiceLaneLab;
      if (!lab) return null;
      const copy = JSON.parse(JSON.stringify(lab)) as {
        mode: string;
        sourceLabel: string | null;
        getUserMediaCalls: number;
        captureStartedAtMs: number | null;
        captureStoppedAtMs: number | null;
        ingress: LabDump['ingress'];
        egress: LabDump['egress'];
        wireFrames: WireFrameRow[];
        speakLog: LabDump['speakLog'];
        wsSendCalls: number;
      };
      return {
        mode: copy.mode,
        sourceLabel: copy.sourceLabel,
        getUserMediaCalls: copy.getUserMediaCalls,
        captureStartedAtMs: copy.captureStartedAtMs,
        captureStoppedAtMs: copy.captureStoppedAtMs,
        ingressCount: copy.ingress.length,
        egressCount: copy.egress.length,
        wireFrames: copy.wireFrames,
        speakLog: copy.speakLog,
        ingress: copy.ingress,
        egress: copy.egress,
        wsSendCalls: copy.wsSendCalls,
      };
    })
    .catch(() => null);
}

type LabPage = { current: import('playwright').Page | null };

async function findLabPage(context: import('playwright').BrowserContext, labPage: LabPage): Promise<void> {
  for (const candidate of context.pages()) {
    const hasLab = await candidate
      .evaluate(() => typeof (window as unknown as Record<string, unknown>).__voiceLaneLab)
      .catch(() => 'evaluate-failed');
    if (hasLab === 'object') {
      labPage.current = candidate;
      return;
    }
  }
}

// ── Server evidence log parsing (corroboration + spoken presentation) ───────

interface EvidenceRow {
  event: string;
  atMs?: number;
  proposalId?: string;
  [key: string]: unknown;
}

/** Read new `voice-kernel {…}` evidence lines appended to the server log. */
function readServerEvidence(serverLogPath: string, offset: { bytes: number }): EvidenceRow[] {
  let buf: Buffer;
  try {
    buf = readFileSync(serverLogPath);
  } catch {
    return [];
  }
  if (buf.byteLength <= offset.bytes) return [];
  // Byte-accurate tail-follow: slice by BYTES, never by character indices —
  // talker excerpts carry multi-byte UTF-8, which desynced a String.slice
  // offset and silently skipped whole evidence lines (run 3, attempt-06).
  const fresh = buf.subarray(offset.bytes).toString('utf8');
  const lastNewline = fresh.lastIndexOf('\n');
  if (lastNewline < 0) return []; // no complete line yet; keep the offset
  const complete = fresh.slice(0, lastNewline + 1);
  offset.bytes += Buffer.byteLength(complete, 'utf8');
  const rows: EvidenceRow[] = [];
  for (const line of complete.split('\n')) {
    if (!line.includes('voice-kernel ')) continue;
    const row = parseServerEvidenceLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

// ── Internal API (worker store check, worker-session prep) ───────────────

/** One request to the disposable server's Internal API over its unix socket. */
function internalApiRequest(
  socketPath: string,
  tokenPath: string,
  apiPath: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}
): Promise<{ status: number; body: string } | null> {
  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return Promise.resolve(null);
  }
  const method = options.method ?? 'GET';
  const payload = options.body !== undefined ? JSON.stringify(options.body) : null;
  return new Promise((resolve) => {
    const request = http.request(
      {
        socketPath,
        path: apiPath,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload !== null
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload).toString() }
            : {}),
        },
        timeout: options.timeoutMs ?? 8_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(null);
    });
    request.on('error', () => resolve(null));
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/** GET a path on the disposable server's Internal API over its unix socket. */
function internalApiGet(socketPath: string, tokenPath: string, apiPath: string, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  return internalApiRequest(socketPath, tokenPath, apiPath, { method: 'GET', timeoutMs });
}


/** Map one instrument wire frame to a director observation (or none). */
export function observationFromWireFrame(
  row: WireFrameRow,
  candidateTextByIdentity: Map<string, string>
): DirectorObservation | null {
  const frame = row.frame as Record<string, unknown>;
  if (row.type === 'proposal_created' && frame.proposal && typeof frame.proposal === 'object') {
    const proposal = frame.proposal as Record<string, unknown>;
    const identity = String(proposal.proposalId ?? '');
    const original = String(proposal.original ?? '');
    const tidied = String(proposal.tidied ?? original);
    const presentedVariant = String(proposal.presentedVariant ?? 'tidied');
    candidateTextByIdentity.set(identity, presentedVariant === 'original' ? original : tidied);
    return { kind: 'candidate', payloadText: presentedVariant === 'original' ? original : tidied, identity, atMs: row.atMs };
  }
  if (row.type === 'proposal_resolved' && String(frame.outcome ?? '') === 'released') {
    return { kind: 'release', identity: String(frame.proposalId ?? ''), atMs: row.atMs };
  }
  if (row.type === 'proposal_resolved' && ['replaced', 'cancelled'].includes(String(frame.outcome ?? ''))) {
    // W4 attachment switch: the pending proposal retired by the product on a
    // worker change (cancel-before-retarget) — the C24 retirement fact.
    return { kind: 'retirement', identity: String(frame.proposalId ?? ''), outcome: String(frame.outcome ?? ''), atMs: row.atMs };
  }
  if (row.type === 'receipt_event' && frame.receipt && typeof frame.receipt === 'object') {
    const receipt = frame.receipt as Record<string, unknown>;
    if (String(receipt.outcome ?? '') === 'delivered') {
      return { kind: 'delivery', identity: String(receipt.proposalId ?? ''), atMs: row.atMs };
    }
  }
  if (row.type === 'proposal_presentation' && frame.completed === true) {
    return { kind: 'presentation', identity: String(frame.proposalId ?? ''), complete: true, atMs: row.atMs };
  }
  if (row.type === 'transcript_delta' && frame.speaker === 'talker' && frame.final === true) {
    const text = String(frame.text ?? '').trim();
    if (text) return { kind: 'response', text, atMs: row.atMs };
  }
  return null;

}

/** Map a server evidence row to a director observation (or none). */
export function observationFromEvidence(row: EvidenceRow): DirectorObservation | null {
  if (row.event === 'spoken_read_back_presented' && typeof row.proposalId === 'string') {
    return { kind: 'presentation', identity: row.proposalId, complete: true, atMs: row.atMs ?? Date.now() };
  }
  return null;
}

// ── Transport padding (from the first real run: the fake device starts
// playing at device-open, the page's capture graph consumes ~2–3 s later) ────

/**
 * Silence prepended to the opening fixture in the file-backed fake device.
 * The frozen utterance bytes are untouched and remain the provenance anchor;
 * only the DEVICE TIMELINE shifts so the production capture pipeline is
 * actually running before the words arrive.
 */
export const OPENING_PADDING_MS = 5_000;

/** Mono 16-bit PCM WAV: `paddingMs` of silence, then every fixture sample. */
export function composePaddedOpeningWav(fixtureWav: Buffer, paddingMs: number): Buffer {
  const audio = decodeWav(new Uint8Array(fixtureWav));
  const padFrames = Math.round((paddingMs / 1_000) * audio.sampleRate);
  const mono = audio.channels[0];
  const padded = new Float32Array(padFrames + mono.length);
  padded.set(mono, padFrames);
  return encodeWavPcm16({ channels: [padded], sampleRate: audio.sampleRate, frames: padded.length });
}

/**
 * One server-log line → a kernel evidence row. The production evidence sink
 * writes `voice-kernel {…}` through the central logger, so under
 * LOG_FORMAT=json the line is JSON whose `msg` embeds the JSON payload —
 * decode the outer line first, then the inner one.
 */
export function parseServerEvidenceLine(line: string): EvidenceRow | null {
  const marker = line.indexOf('voice-kernel ');
  if (marker < 0) return null;
  // Shape 1: LOG_FORMAT=json — the whole line is JSON and the payload is
  // embedded (escaped) inside the `msg` string.
  try {
    const outer = JSON.parse(line) as { msg?: unknown };
    if (typeof outer.msg === 'string') {
      const jsonStart = outer.msg.indexOf('{');
      if (jsonStart >= 0) {
        const parsed = JSON.parse(outer.msg.slice(jsonStart)) as Record<string, unknown>;
        if (parsed && typeof parsed.event === 'string') return parsed as EvidenceRow;
      }
    }
  } catch {
    /* not a JSON line: fall through */
  }
  // Shape 2: plain text logs — the payload follows the prefix verbatim.
  const jsonStart = line.indexOf('{', marker);
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
    if (parsed && typeof parsed.event === 'string') return parsed as EvidenceRow;
  } catch {
    return null;
  }
  return null;
}

/** The shim state the runner dumps out of the page at read-back time. */
interface TtsShimDump {
  label: string;
  synthReplaced: boolean;
  spoken: Array<{ seq: number; atMs: number; text: string; chars: number }>;
}

function readTtsShim(page: import('playwright').Page): Promise<TtsShimDump | null> {
  return page
    .evaluate(() => {
      const root = window as unknown as {
        __voiceTtsShim?: { label?: unknown; spoken?: Array<{ seq: number; atMs: number; text: string; chars: number }> };
        speechSynthesis?: { __voiceTtsShim?: unknown };
      };
      if (!root.__voiceTtsShim) return null;
      return {
        label: typeof root.__voiceTtsShim.label === 'string' ? root.__voiceTtsShim.label : '',
        synthReplaced: root.speechSynthesis?.__voiceTtsShim === true,
        spoken: JSON.parse(JSON.stringify(root.__voiceTtsShim.spoken ?? [])) as TtsShimDump['spoken'],
      };
    })
    .catch(() => null);
}

// ── The runner ──────────────────────────────────────────────────────────────

interface StepRow {
  seq: number;
  atMs: number;
  observation?: Record<string, unknown>;
  action: Record<string, unknown>;
}

export async function runJourney(plan: JourneyPlan, options: JourneyRunOptions): Promise<JourneyRunResult> {
  const log = options.log ?? (() => {});
  const repoRoot = path.resolve(options.repoRoot);
  const episode = episodeById(options.corpus, plan.episodeId);
  const attemptLayout = createAttempt(options.recordsRoot, options.campaignId, `${plan.episodeId}-${plan.arm}`);

  // 1. Credential preflight on the CHILD server env (arm env overrides applied).
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(options.serverEnv)) childEnv[key] = value;
  const credential = String(childEnv.GEMINI_API_KEY ?? '').trim();
  const redactedChildEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.serverEnv)) {
    redactedChildEnv[key] = key === 'GEMINI_API_KEY' ? (value.trim() ? '<redacted:set>' : '<unset>') : value;
  }
  if (!credential) {
    finaliseAttempt(attemptLayout.attemptDir, {
      episodeId: plan.episodeId,
      arm: plan.arm,
      kind: 'primary-mic-journey',
      evidenceLevel: 'E2',
      captureMode: plan.captureMode,
      startedAtIso: new Date().toISOString(),
      status: 'invalid',
      reason: 'credential-missing-child-env',
      detail:
        'GEMINI_API_KEY is absent from the child server env — the native lane cannot start. ' +
        'Missing credentials are exit 2 (incomplete-invalid), never a green skip (plan §11 G2).',
      serverEnv: redactedChildEnv,
      planHash: undefined,
    } satisfies AttemptManifest);
    log('preflight: GEMINI_API_KEY absent from the child server env — exit 2 (credential-missing-child-env)');
    return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: 'credential-missing-child-env', reason: 'credential-missing-child-env' };
  }

  const cleanup = { browserClosed: false, previewStopped: false, serverStopped: false, socketsRemoved: false };
  const startedAtIso = new Date().toISOString();
  const attemptDeadlineMs = options.attemptDeadlineMs ?? plan.attemptDeadlineMs;
  const deadlineAt = Date.now() + attemptDeadlineMs;
  const problems: string[] = [];

  // 2. Builds (compiled server + built client, production shape). Rebuilt
  //    whenever sources are newer than the dists — a stale served bundle would
  //    grade old code (fix-loop pass 2 defect).
  const freshness = ensureBuiltAppFresh({ repoRoot, log });
  if (!freshness.ok) {
    finaliseAttempt(attemptLayout.attemptDir, {
      episodeId: plan.episodeId, arm: plan.arm, kind: 'primary-mic-journey', evidenceLevel: 'E2',
      captureMode: plan.captureMode, startedAtIso, status: 'invalid', reason: 'build-failed',
      cleanup,
    } satisfies AttemptManifest);
    return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: freshness.detail };
  }
  const clientBuildSha = sha256(readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html')));

  // 3. Ports, disposable compiled server (with the arm-selection env), built-client preview.
  const clientPort = await freePort();
  const bootScript = path.join(repoRoot, 'scripts', 'voice-live-lab', 'boot-disposable-server.sh');
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'voice-lab-journey-'));
  const unitName = `voice-lab-journey-${process.pid}-${Date.now().toString(36)}`;
  const boot = run('bash', [bootScript, 'boot'], {
    env: {
      VOICE_LAB_REPO: repoRoot,
      VOICE_LAB_DIR: stateDir,
      VOICE_LAB_UNIT: unitName,
      VOICE_LAB_POINTER: path.join(stateDir, 'current'),
      VOICE_LAB_COMPILED: '1',
      VOICE_MODE_ENGINE: plan.server.engine,
      AUTH_PASSWORD: options.authPassword,
      ALLOWED_ORIGINS: `http://127.0.0.1:${clientPort},http://localhost:${clientPort}`,
      LOG_FORMAT: 'json',
      ...options.serverEnv,
    },
    timeoutMs: 300_000,
  });
  if (boot.code !== 0) {
    finaliseAttempt(attemptLayout.attemptDir, {
      episodeId: plan.episodeId, arm: plan.arm, kind: 'primary-mic-journey', evidenceLevel: 'E2',
      captureMode: plan.captureMode, startedAtIso, status: 'invalid', reason: 'server-boot-failed',
      detail: `disposable server failed to boot (exit ${boot.code}): ${boot.stderr.slice(-400)}`,
      serverEnv: redactedChildEnv,
      cleanup,
    } satisfies AttemptManifest);
    return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: 'server-boot-failed' };
  }
  let serverPort: number | null = null;
  const serverLogPath = path.join(stateDir, 'server.log');
  const serverLogOffset = { bytes: 0 };
  for (let i = 0; i < 120 && serverPort === null; i += 1) {
    try {
      const match = /^\s*port\s*:\s*(\d+)\s*$/m.exec(readFileSync(serverLogPath, 'utf8'));
      if (match) serverPort = Number(match[1]);
    } catch {
      /* log not ready */
    }
    if (serverPort === null) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (serverPort === null) {
    finaliseAttempt(attemptLayout.attemptDir, {
      episodeId: plan.episodeId, arm: plan.arm, kind: 'primary-mic-journey', evidenceLevel: 'E2',
      captureMode: plan.captureMode, startedAtIso, status: 'invalid', reason: 'server-port-undiscovered',
      serverEnv: redactedChildEnv, cleanup,
    } satisfies AttemptManifest);
    return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: 'server-port-undiscovered' };
  }
  log(`disposable compiled server ready: http://127.0.0.1:${serverPort} (engine ${plan.server.engine}, arm env ${JSON.stringify(redactedChildEnv)})`);

  let viteProcess: ReturnType<typeof import('node:child_process').spawn> | null = null;
  let browserContext: import('playwright').BrowserContext | null = null;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-lab-profile-'));
  const consoleErrors: string[] = [];
  const consoleLog: string[] = [];
  const wsLog: string[] = [];
  let laneWentLive = false;
  let syntheticModeVerified = false;
  let abortedAtDeadline = false;

  // The director: deterministic FSM over the corpus episode, real clock.
  const director = new EpisodeDirector(episode, { now: () => Date.now() });
  const steps: StepRow[] = [];
  const candidateTextByIdentity = new Map<string, string>();
  let wireFramesSeen = 0;
  const evidenceRows: EvidenceRow[] = [];
  const pendingObservations: DirectorObservation[] = [];
  let terminalAction: Extract<DirectorAction, { type: 'terminal' }> | null = null;
  const labPage: LabPage = { current: null };
  // W4: a session switch can move the product (and its instrument) to another
  // page/document. Per-page counters let the runner observe EVERY instrument
  // page and save the UNION of their wire records — no post-switch frame is
  // lost to a stale single-page cache.
  const perPageSeen = new Map<import('playwright').Page, number>();

  /** Map one instrument wire frame to a director observation (or none). */
  const observeWireFrame = (row: WireFrameRow): DirectorObservation | null =>
    observationFromWireFrame(row, candidateTextByIdentity);

  const observeEvidence = (row: EvidenceRow): DirectorObservation | null => observationFromEvidence(row);

  /** Every open page that carries the lab instrument. */
  const labPages = async (): Promise<Array<import('playwright').Page>> => {
    const pages: Array<import('playwright').Page> = [];
    for (const candidate of browserContext!.pages()) {
      const hasLab = await candidate
        .evaluate(() => typeof (window as unknown as Record<string, unknown>).__voiceLaneLab)
        .catch(() => 'evaluate-failed');
      if (hasLab === 'object') pages.push(candidate);
    }
    return pages;
  };

  /** Poll EVERY instrument page + the server evidence log; queue new observations. */
  const seenParkedItemIds = new Set<string>();
  const collectObservations = async (): Promise<void> => {
    for (const candidate of await labPages()) {
      const dump = await dumpLab(candidate);
      if (!dump) continue;
      const seen = perPageSeen.get(candidate) ?? 0;
      const fresh = dump.wireFrames.slice(seen);
      perPageSeen.set(candidate, dump.wireFrames.length);
      for (const row of fresh) {
          // parking_updated carries the lot snapshot: each NEW parked item
          // becomes one `parked` observation (W4 busy parking). Promotions and
          // removals are the product's business; the FSM never re-parks.
          if (row.type === 'parking_updated') {
            const items = Array.isArray((row.frame as { items?: unknown }).items)
              ? ((row.frame as { items: Array<{ itemId?: unknown }> }).items)
              : [];
            for (const item of items) {
              const itemId = typeof item?.itemId === 'string' ? item.itemId : '';
              if (itemId && !seenParkedItemIds.has(itemId)) {
                seenParkedItemIds.add(itemId);
                pendingObservations.push({ kind: 'parked', itemId, atMs: row.atMs });
              }
            }
            continue;
          }
          const observation = observeWireFrame(row);
          if (observation) {
            pendingObservations.push(observation);
            if (observation.kind === 'delivery' && plan.episodeId.startsWith('SOAK')) {
              probeWorkerStoreFor(observation.identity);
            }
          }
      }
    }
    for (const row of readServerEvidence(serverLogPath, serverLogOffset)) {
      evidenceRows.push(row);
      const observation = observeEvidence(row);
      if (observation) pendingObservations.push(observation);
    }
  };

  // ── W4 continuity-soak: the mid-session voice-transport reconnect ──────
  const soakEventsPath = path.join(attemptLayout.attemptDir, 'provider', 'soak-events.jsonl');
  const recordSoakEvent = (event: Record<string, unknown>): void => {
    writeFileSync(soakEventsPath, `${JSON.stringify({ atMs: Date.now(), ...event })}\n`, { flag: 'a', mode: 0o600 });
  };

  /** The attachment-switch record the manifest freezes (W4 attachment switch). */
  let attachmentSwitchRecord: { fromWorkerSessionId: string; toWorkerSessionId: string; switchedAtMs: number } | null = null;


  /** The worker store check: approved bytes must appear in the worker's persisted input. */
  const checkWorkerStore = async (approvedIdentity: string): Promise<boolean> => {
    const approvedText = candidateTextByIdentity.get(approvedIdentity);
    if (!approvedText) return false;
    const workerSessionId = evidenceRows
      .slice()
      .reverse()
      .map((row) => row.workerSessionId)
      .find((value): value is string => typeof value === 'string');
    if (!workerSessionId) return false;
    const response = await internalApiGet(
      path.join(stateDir, 'internal-api.sock'),
      path.join(stateDir, 'internal-api-token'),
      `/api/v1/sessions/${encodeURIComponent(workerSessionId)}/transcript?view=screen`,
      8_000
    );
    // Every probe is recorded — a failed store check must be explainable
    // from the record alone, not reconstructed from memory.
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'provider', 'worker-store-probes.jsonl'),
      `${JSON.stringify({ atMs: Date.now(), workerSessionId, approvedTextPrefix: approvedText.slice(0, 40), status: response?.status ?? null, bytes: response?.body.length ?? 0, matched: response ? response.body.includes(approvedText.slice(0, Math.min(40, approvedText.length))) : false })}\n`,
      { flag: 'a', mode: 0o600 }
    );
    if (!response || response.status !== 200) return false;
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'provider', 'worker-transcript-response.txt'),
      `workerSessionId: ${workerSessionId}\nHTTP ${response.status}\n\n${response.body}\n`,
      { mode: 0o600 }
    );
    return response.body.includes(approvedText.slice(0, Math.min(40, approvedText.length)));
  };

  // Soak F-1: the tail worker-store await covers only the LAST approved
  // identity, but the soak's acceptance contract requires worker-store
  // evidence for the PRE-reconnect pending proposal too. Probe each released
  // identity once, when its delivery receipt is observed.
  const storeProbedIdentities = new Set<string>();
  const probeWorkerStoreFor = (identity: string): void => {
    if (storeProbedIdentities.has(identity)) return;
    storeProbedIdentities.add(identity);
    void (async () => {
      for (let attempt = 0; attempt < 20 && !terminalAction; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const stored = await checkWorkerStore(identity).catch(() => false);
        if (stored) {
          pendingObservations.push({ kind: 'worker-store', identity, ok: true, atMs: Date.now() });
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
  };

  const screenshot = async (page: import('playwright').Page, name: string): Promise<void> => {
    await page.screenshot({ path: path.join(attemptLayout.attemptDir, 'capture', `shot-${name}.png`) }).catch(() => {});
  };

  try {
    // Built client preview with a proxy to the disposable server.
    const viteLog = path.join(stateDir, 'vite-preview.log');
    const { spawn } = await import('node:child_process');
    viteProcess = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(clientPort), '--strictPort'], {
      cwd: path.join(repoRoot, 'client'),
      env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${serverPort}` },
      stdio: ['ignore', openSync(viteLog, 'a'), 'inherit'],
      detached: true,
    });
    await waitForHttp(`http://127.0.0.1:${clientPort}/`, 90_000);
    log(`built client served: http://127.0.0.1:${clientPort} (proxying to ${serverPort})`);

    // 4. Browser: private profile, fake mic bound to the TRANSPORT-PADDED
    // opening WAV. The frozen fixture bytes are unchanged; the silence prefix
    // only shifts the device timeline so the production capture graph is
    // consuming before the words arrive (the first real run showed the page's
    // AudioContext starts ~2–3 s after device-open).
    const opening = plan.turns[0];
    const paddedWav = composePaddedOpeningWav(readFileSync(opening.masterWavPath), OPENING_PADDING_MS);
    const paddedWavPath = path.join(attemptLayout.attemptDir, 'capture', 'opening-padded.wav');
    writeFileSync(paddedWavPath, paddedWav, { mode: 0o600 });
    const browserArgs = plan.browserArgs.map((arg) =>
      arg.startsWith('--use-file-for-fake-audio-capture=') ? `--use-file-for-fake-audio-capture=${paddedWavPath}%noloop` : arg
    );
    const { chromium } = await import('playwright');
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone'],
      args: browserArgs,
    });
    const page = await browserContext.newPage();
    // Explicit --tts synthetic (child J3): the labelled read-back shim rides
    // into every page generation BEFORE app boot. Default journeys never
    // inject it — no shim unless requested.
    if (plan.tts === 'synthetic') {
      await page.addInitScript(new Function(TTS_SHIM_SCRIPT) as () => void);
    }
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) consoleLog.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on('websocket', (ws) => {
      wsLog.push(`WS open: ${ws.url()}`);
      ws.on('close', () => wsLog.push(`WS closed: ${ws.url()}`));
    });
    await page.addInitScript(new Function(INGRESS_INSTRUMENT_SCRIPT) as () => void);
    await page.goto(`http://127.0.0.1:${clientPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_200);
    const password = page.locator('input[type="password"]');
    if (await password.isVisible().catch(() => false)) {
      await password.fill(options.authPassword);
      await page.locator('button[type="submit"]').click();
      await page.waitForTimeout(3_000);
    }
    await page.evaluate(() => {
      localStorage.setItem(
        'pi-web-ui-ui-store',
        JSON.stringify({
          state: { theme: 'light', recentFolders: [{ path: '/tmp', label: 'tmp', count: 1, lastUsed: Date.now() }] },
          version: 0,
        })
      );
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_200);

    // ── W4 two-session preparation (C24): BOTH worker sessions are real and
    // prepared BEFORE the journey attaches to the first — created through the
    // Internal API's real creation path, labelled through the app's own
    // display-name preference so the product's picker rows are unambiguous.
    const needsTwoSessions = journeyRequiresSecondWorker(episode.inputTurns);
    let preparedWorkers: PreparedWorkerSession[] = [];
    if (needsTwoSessions) {
      preparedWorkers = await prepareTwoWorkerSessions((apiPath, options) =>
        internalApiRequest(path.join(stateDir, 'internal-api.sock'), path.join(stateDir, 'internal-api-token'), apiPath, options)
      );
      for (const worker of preparedWorkers) {
        const labelled = await page.evaluate(
          async (args: { apiPath: string; body: unknown }) => {
            const response = await fetch(args.apiPath, {
              method: 'POST',
              credentials: 'include',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(args.body),
            });
            return response.ok;
          },
          { apiPath: '/api/preferences/display-name', body: { sessionPath: worker.sessionPath, name: worker.displayName, updatedAt: Date.now() } }
        );
        if (!labelled) throw new Error(`worker prep: the display-name preference for ${worker.sessionPath} was refused by the server`);
      }
      // The store hydrates display names at boot: reload so the product's own
      // picker renders the prepared labels.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_200);
      if (await password.isVisible().catch(() => false)) {
        await password.fill(options.authPassword);
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(3_000);
      }
      log(`worker prep: two real worker sessions prepared (${preparedWorkers.map((worker) => worker.displayName).join(', ')})`);
    }

    // Session ids BEFORE the UI creates the journey's worker session: the
    // busy drive (C22) identifies the worker by this diff — never by guessing.
    const sessionIdsBefore: string[] = [];
    if (!needsTwoSessions) {
      const listResponse = await internalApiRequest(
        path.join(stateDir, 'internal-api.sock'),
        path.join(stateDir, 'internal-api-token'),
        '/api/v1/sessions'
      );
      if (!listResponse || listResponse.status !== 200) {
        throw new Error(`busy-drive prerequisite: the Internal API session list was unavailable (HTTP ${listResponse?.status ?? 'no response'})`);
      }
      const parsed = JSON.parse(listResponse.body) as { sessions?: Array<{ sessionId?: unknown }> };
      for (const row of parsed.sessions ?? []) {
        if (typeof row.sessionId === 'string' && row.sessionId) sessionIdsBefore.push(row.sessionId);
      }
    }

    await page.locator('button[aria-label="Enter Voice Mode"]').first().click();
    if (needsTwoSessions) {
      // The first prepared worker is the journey's opening attachment: chosen
      // through the product's own continue-session picker, never fabricated.
      await page.getByRole('button', { name: 'Continue an existing session' }).click();
      const firstRow = page.getByRole('button', { name: preparedWorkers[0]!.displayName }).first();
      await firstRow.waitFor({ timeout: 30_000 });
      await firstRow.click();
    } else {
      await page.getByRole('button', { name: 'Start a new session' }).click();
      // The worker model must be one whose provider actually completes turns
      // in the disposable env: verified by direct Internal API diagnostics,
      // openai-codex/gpt-5.6-sol (UI row 'Codex / GPT-5.6 Sol') runs the shell
      // tool and holds busy, while the kimi-coding/kimi-subscription providers
      // die in ~1 s with no output (the C22 attempts 02–04 failure). The
      // journey's frozen wording and bars do not depend on the worker model.
      const modelRow = page.getByText('Codex / GPT-5.6 Sol', { exact: true }).first();
      await modelRow.waitFor({ timeout: 45_000 });
      await modelRow.click();
      await page.locator('button').filter({ hasText: '/tmp' }).first().click();
    }
    await page.waitForSelector('[data-testid="drive-mode-surface"]', { timeout: 90_000 });
    await screenshot(page, '1-drive-mode');
    const engineBadge = await page
      .locator('[data-testid="voice-engine-badge"]')
      .evaluate((node) => ({
        engine: node.getAttribute('data-engine'),
        laneState: node.getAttribute('data-lane-state'),
        capture: node.getAttribute('data-capture'),
      }))
      .catch(() => null);

    // The seam must actually be live on the page that will speak: a requested
    // shim that did not install is a broken harness, not a silent downgrade.
    let ttsShim: TtsShimDump | null = null;
    if (plan.tts === 'synthetic') {
      ttsShim = await readTtsShim(page);
      if (!ttsShim || ttsShim.label !== SYNTHETIC_TTS_LABEL || !ttsShim.synthReplaced) {
        throw new Error(
          `the labelled ${SYNTHETIC_TTS_LABEL} shim is not installed on the live page ` +
            `(label ${ttsShim?.label ?? 'none'}, speechSynthesis replaced: ${ttsShim?.synthReplaced === true}) — refusing a synthetic-tts journey without it`
        );
      }
      log(`labelled ${SYNTHETIC_TTS_LABEL} shim installed: speechSynthesis replaced, spoken log armed`);
    }

    // ── W4 busy drive (C22): the worker is made GENUINELY busy through a real
    // Internal API prompt BEFORE the relay is spoken, so the product's own
    // parking decision sees the session mid-run. Nothing here touches the
    // product's busy flag; the runtime executes the sleep itself.
    let busyDriveRecord: BusyDriveRecord | null = null;
    if (journeyRequiresBusyDrive(episode.inputTurns)) {
      busyDriveRecord = await driveWorkerBusy((apiPath, options) =>
        internalApiRequest(path.join(stateDir, 'internal-api.sock'), path.join(stateDir, 'internal-api-token'), apiPath, options),
        sessionIdsBefore
      );
      recordSoakEvent({
        kind: 'worker-busy-drive',
        detail: `worker prompted through the Internal API; the runtime executes: ${BUSY_DRIVE_PROMPT.slice(0, 60)}…`,
        workerSessionId: busyDriveRecord.workerSessionId,
        busyObserved: busyDriveRecord.busyObserved,
        promptsSent: busyDriveRecord.promptsSent,
        busyHeldMs: busyDriveRecord.busyHeldMs,
      });
      await screenshot(page, 'worker-busy-drive');
      log(`busy drive: worker ${busyDriveRecord.workerSessionId} busy (held ${busyDriveRecord.busyHeldMs} ms, ${busyDriveRecord.promptsSent} prompt(s))`);
    }

    // ── The director loop ─────────────────────────────────────────────────
    const waitForListening = async (listening: boolean, timeoutMs: number): Promise<boolean> => {
      return page
        .waitForSelector(`[data-testid="drive-native-listening-state"][data-listening="${listening ? 'true' : 'false'}"]`, { timeout: timeoutMs })
        .then(() => true)
        .catch(() => false);
    };
    const ensureCapture = async (listening: boolean): Promise<void> => {
      const current = await page
        .locator('[data-testid="drive-native-listening-state"]')
        .getAttribute('data-listening')
        .catch(() => null);
      if ((current === 'true') === listening) return;
      await page.locator('[data-testid="drive-mic"]').first().click();
      await waitForListening(listening, 60_000);
      if (!listening) await page.waitForTimeout(800); // the stop gesture settles
    };
  /**
   * Drop the page's session transport and let the PRODUCT recover: the
   * client's session stream reconnects on its own, and the lane is re-opened
   * through the REAL main control (same lane identity → the mount revives it
   * and reopens the provider session). The reconnect is recorded, never
   * simulated: no state is rewritten and no frame is fabricated.
   */
  const executeTransportReconnect = async (): Promise<void> => {
    const wireBefore = wireFramesSeen;
    const wsBefore = wsLog.length;
    recordSoakEvent({ kind: 'transport-drop-started', detail: 'closing the page session socket(s) — a real transport drop' });
    await page
      .evaluate(() => {
        const lab = window as unknown as { __voiceLaneLab?: { sockets?: Array<{ url?: string; close?: () => void }> } };
        for (const socket of lab.__voiceLaneLab?.sockets ?? []) {
          // only the app's session socket(s) — never tooling sockets
          if (socket.url?.includes('/ws')) {
            try {
              socket.close?.();
            } catch {
              /* already closing */
            }
          }
        }
      })
      .catch(() => {});
    // 2. the product's own session-stream reconnect (exponential backoff).
    // The grace clock is running server-side (the lane detached and its
    // provider session closed at the drop; the kernel keeps pending work only
    // until the reap), so every step from here stays tight.
    let transportBack = false;
    for (let index = 0; index < 60 && !transportBack; index += 1) {
      await page.waitForTimeout(500);
      transportBack = wsLog.slice(wsBefore).some((line) => line.startsWith('WS open'));
    }
    // 3. revive the lane through a REAL product control. startLane() no-ops
    // while the client's wireState is stale-'live' (the drop is silent to the
    // client), so the lane restart goes through the capture-mode radios:
    // controller.setCaptureMode on a 'live' lane sends voice_session_stop + a
    // fresh voice_session_start — same lane id, same attachment generation —
    // which the mount answers by clearing the detach and minting a new
    // provider session WITHOUT touching the kernel's pending work. Toggle
    // open-mic → push-to-talk → open-mic so the lane ends back in open-mic.
    let modeRestarted = false;
    try {
      await page.locator('[data-testid="drive-capture-mode-push-to-talk"]').first().click({ timeout: 10_000 });
      await page.waitForTimeout(1_200);
      await page.locator('[data-testid="drive-capture-mode-open-mic"]').first().click({ timeout: 10_000 });
      await page.waitForTimeout(1_200);
      modeRestarted = true;
    } catch {
      // The controls were not reachable — the probe below reports the truth.
    }
    // 4. the lane must come back live: poll the wire for a live voice_state
    // frame that arrived AFTER the drop (seq beyond the pre-drop count).
    let laneBack = false;
    for (let index = 0; index < 60 && !laneBack; index += 1) {
      await page.waitForTimeout(500);
      await collectObservations();
      for (const labCandidate of await labPages()) {
        const dump = await dumpLab(labCandidate).catch(() => null);
        if (!dump) continue;
        laneBack = (dump.wireFrames ?? []).some(
          (row) => row.type === 'voice_state' && (row.frame as { state?: unknown }).state === 'live' && row.seq >= 0
        );
        if (laneBack) break;
      }
    }
    recordSoakEvent({
      kind: 'transport-reconnect',
      detail: modeRestarted
        ? 'session socket dropped; lane restarted through the capture-mode controls (stop + fresh start, same lane identity)'
        : 'session socket dropped and reopened; capture-mode controls unreachable — the lane restart was not driven',
      transportBack,
      laneBack,
      modeRestarted,
      socketsSeenBefore: wsBefore,
      socketsSeenAfter: wsLog.length,
    });
    await screenshot(page, 'soak-reconnect');
  };

    const speakTurn = async (turn: JourneyTurn): Promise<void> => {
      if (turn.inputMode === 'fake-file') {
        // The main control opens the lane AND starts capture; the fake device
        // begins playing the frozen opening WAV at that same gesture.
        await ensureCapture(true);
        laneWentLive = true;
        await screenshot(page, `2-live-${turn.turnId}`);
        return;
      }
      // synthetic-stream-source: flip the instrument, pause/resume listening
      // through the MAIN controls so the next getUserMedia binds the labelled
      // fixture stream, then inject the turn's PCM into the unchanged pipeline.
      if (!labPage.current) await findLabPage(browserContext!, labPage);
      const state = labPage.current ? await dumpLab(labPage.current) : null;
      if (!state || state.mode !== 'synthetic-stream-source') {
        const flipped = await page.evaluate(() => {
          const lab = window as unknown as { __voiceLaneLabUseSynthetic?: () => { ok: boolean } };
          return lab.__voiceLaneLabUseSynthetic ? lab.__voiceLaneLabUseSynthetic().ok : false;
        });
        if (!flipped) throw new Error('the lab instrument refused the synthetic-stream-source switch (not injected?)');
        await ensureCapture(false);
        await ensureCapture(true);
        await findLabPage(browserContext!, labPage);
        const after = labPage.current ? await dumpLab(labPage.current) : null;
        syntheticModeVerified = after?.sourceLabel === 'synthetic-stream-source';
        if (!syntheticModeVerified) throw new Error('the product capture pipeline did not bind the synthetic-stream-source stream');
      }
      const pcm = readFileSync(turn.pcm16kPath);
      const injected = await page.evaluate(
        (args: { b64: string; sampleRate: number }) => {
          const lab = window as unknown as { __voiceLaneLabSpeak?: (b64: string, rate: number) => { frames: number } };
          return lab.__voiceLaneLabSpeak ? lab.__voiceLaneLabSpeak(args.b64, args.sampleRate) : null;
        },
        { b64: pcm.toString('base64'), sampleRate: 16_000 }
      );
      if (!injected) throw new Error(`synthetic speak for ${turn.fixtureId} was refused by the instrument`);
      await screenshot(page, `3-spoke-${turn.turnId}`);
    };

    const fixtureFor = (turnId: string, text: string): JourneyTurn => {
      const byId = plan.turns.find((turn) => turn.turnId === turnId);
      if (byId) return byId;
      const byText = plan.turns.find((turn) => turn.text === text);
      if (byText) {
        // A director repair re-speaking known wording (repeat-identical) is a
        // LATER utterance: it rides the synthetic path even when the wording
        // is the opening's.
        return { ...byText, inputMode: 'synthetic-stream-source' as const, speakOnStart: false };
      }
      throw new Error(`no fixture for director turn ${turnId} (episode ${plan.episodeId})`);
    };

    const startedAtMs = Date.now();
    let executed = false;
    // Adaptive await cadence: observations must be seen BEFORE the phase
    // deadline fires, so polls tighten when the deadline is close (the first
    // real run lost a presentation that landed inside one 500 ms poll window).
    let awaitStartedAtMs: number | null = null;
    let awaitDeadlineMs = 0;
    let awaitReason = '';
    let sleepMs = 300;
    let lastStoreProbeMs = 0;
    for (;;) {
      if (Date.now() > deadlineAt) {
        abortedAtDeadline = true;
        terminalAction = { type: 'terminal', status: 'interaction-failure', reason: `attempt deadline ${attemptDeadlineMs} ms exceeded — model/audio connections aborted` };
        break;
      }
      await collectObservations();
      // While the FSM awaits the worker store, poll the worker's persisted
      // input (read-only Internal API) and feed the observation when the
      // approved bytes appear. The FSM's own workerStoreMs deadline governs.
      if (awaitReason === 'waiting for worker store' && plan.routesRelay && director.state.approvedIdentity && Date.now() - lastStoreProbeMs >= 1_000) {
        lastStoreProbeMs = Date.now();
        const stored = await checkWorkerStore(director.state.approvedIdentity);
        if (stored) {
          pendingObservations.push({ kind: 'worker-store', identity: director.state.approvedIdentity, ok: true, atMs: Date.now() });
        }
      }
      const observation = pendingObservations.shift();
      const observedAt = Date.now();
      const action = director.step(observation ?? undefined);
      const row: StepRow = { seq: steps.length + 1, atMs: observedAt, action: action as unknown as Record<string, unknown> };
      if (observation) row.observation = observation as unknown as Record<string, unknown>;
      steps.push(row);
      if (action.type === 'terminal') {
        terminalAction = action;
        break;
      }
      if (action.type === 'speak') {
        const turn = fixtureFor(action.turnId, action.text);
        // The recorded step's clock must match the speak: the director's speak
        // text is the frozen wording, verified here against the plan.
        if (action.text !== turn.text) throw new Error(`director/plan wording drift on turn ${action.turnId}`);
        // Confirmations are spoken only after the talker has gone quiet: the
        // echo window otherwise drops the operator's approval as echo-suspect
        // and the release never fires (fix-loop pass 8, C01).
        if (turn.kind === 'adaptive-confirm' || turn.kind === 'adaptive-steer') {
          if (!labPage.current) await findLabPage(browserContext!, labPage);
          await waitForTalkerQuiet(labPage);
        }
        await speakTurn(turn);
        executed = true;
        // Let the utterance FINISH entering the pipeline before the next step:
        // the FSM's interaction deadlines measure model latency from the end of
        // the operator's speech, not transport time (device padding + playback).
        await page.waitForTimeout((turn.inputMode === 'fake-file' ? OPENING_PADDING_MS : 0) + turn.durationMs + 300);
        awaitStartedAtMs = null;
        sleepMs = 300;
      } else if (action.type === 'pace') {
        // Soak pacing: the operator stays silent for the planned interval.
        // The attempt deadline still governs — never sleep past it.
        const remaining = Math.max(0, deadlineAt - Date.now());
        await page.waitForTimeout(Math.min(action.ms, remaining));
        awaitStartedAtMs = null;
        sleepMs = 300;
      } else if (action.type === 'reconnect-transport') {
        await executeTransportReconnect();
        awaitStartedAtMs = null;
        sleepMs = 300;
      } else if (action.type === 'promote') {
        // W4 busy parking: the product's OWN promote path — the parking-lot
        // drawer's per-item promote control. No candidate is fabricated here;
        // the promoted proposal arrives as a proposal_created wire frame.
        const collapsed = page.locator('[data-testid="parking-lot-open"]');
        if (await collapsed.isVisible().catch(() => false)) await collapsed.click();
        const promoteButton = page.locator(`[data-testid="parking-promote-${action.itemId}"]`);
        await promoteButton.waitFor({ timeout: 15_000 });
        await promoteButton.click();
        await screenshot(page, `promote-${action.itemId}`);
        recordSoakEvent({ kind: 'promote', itemId: action.itemId, detail: 'promoted through the parking-lot drawer control' });
        awaitStartedAtMs = null;
        sleepMs = 300;
      } else if (action.type === 'switch-attachment') {
        // W4 attachment switch: the product's OWN switch control — the labelled
        // "Switch session" button, then the real session picker. The target is
        // a real session resolved from the Internal API (never fabricated).
        const fromWorkerSessionId = evidenceRows
          .slice()
          .reverse()
          .map((row) => row.workerSessionId)
          .find((value): value is string => typeof value === 'string') ?? 'unknown';
        const listResponse = await internalApiGet(
          path.join(stateDir, 'internal-api.sock'),
          path.join(stateDir, 'internal-api-token'),
          '/api/v1/sessions',
          8_000
        );
        let targetSessionId: string | null = null;
        let targetSessionName: string | null = null;
        // The prepared second worker (C24 prep) is the target: matched by its
        // REAL session id from the Internal API list, labelled by the display
        // name the app's own preference route set.
        const preparedSecond = preparedWorkers.find((worker) => worker.sessionId !== fromWorkerSessionId) ?? null;
        try {
          const sessions = (JSON.parse(listResponse?.body ?? '{}') as { sessions?: Array<{ sessionId?: unknown; sessionPath?: unknown }> }).sessions ?? [];
          const candidateSession =
            sessions.find((session) => typeof session.sessionId === 'string' && session.sessionId === preparedSecond?.sessionId) ??
            sessions.find(
              (session) =>
                typeof session.sessionId === 'string' &&
                session.sessionId !== fromWorkerSessionId &&
                !preparedWorkers.some((worker) => worker.sessionId === session.sessionId)
            );
          if (candidateSession) {
            targetSessionId = candidateSession.sessionId as string;
            targetSessionName = preparedSecond?.sessionId === targetSessionId ? preparedSecond.displayName : null;
          }
        } catch {
          /* no session list: the switch below fails honestly */
        }
        if (!targetSessionId || !targetSessionName) {
          throw new Error(
            'attachment switch: no second worker session exists to switch to — the harness must prepare two real worker attachments before the journey'
          );
        }
        await page.locator('[data-testid="drive-switch-session"]').first().click();
        const pickerRow = page.getByRole('button', { name: targetSessionName }).first();
        await pickerRow.waitFor({ timeout: 20_000 });
        await pickerRow.click();
        attachmentSwitchRecord = { fromWorkerSessionId, toWorkerSessionId: targetSessionId, switchedAtMs: Date.now() };
        recordSoakEvent({ kind: 'attachment-switch', fromWorkerSessionId, toWorkerSessionId: targetSessionId });
        await screenshot(page, 'attachment-switch');
        awaitStartedAtMs = null;
        sleepMs = 300;
      } else if (action.type === 'await') {
        // A NEW await phase restarts its clock; an unchanged one is ticking.
        if (action.reason !== awaitReason || awaitStartedAtMs === null) {
          awaitReason = action.reason;
          awaitDeadlineMs = action.deadlineMs;
          awaitStartedAtMs = observedAt;
        }
        const remaining = awaitDeadlineMs - (Date.now() - awaitStartedAtMs);
        sleepMs = remaining <= 2_500 ? 100 : 300;
      }
      // Observations arrive by polling; feed consecutive observations back-to-back.
      await page.waitForTimeout(observation ? 60 : sleepMs);
    }
    void executed;
    void startedAtMs;

    // Settle: give the last wire frames a moment, then collect final state.
    await page.waitForTimeout(1_500);
    await collectObservations();
    await screenshot(page, '4-terminal');

    // ── Stop through the main control; stop the instrument; dump. ────────
    await ensureCapture(false);
    const stopObserved = await page
      .locator('[data-testid="drive-native-listening-state"]')
      .getAttribute('data-listening')
      .then((value) => value === 'false')
      .catch(() => false);
    await findLabPage(browserContext!, labPage);
    if (labPage.current) {
      await labPage.current.evaluate(() => (window as unknown as { __voiceLaneLabStop: () => void }).__voiceLaneLabStop());
    }
    const dump = labPage.current ? await dumpLab(labPage.current) : null;
    if (!dump || !Array.isArray(dump.ingress)) {
      throw new Error('the lab instrument carried no data on any page');
    }
    await screenshot(page, '5-stopped');

    // ── Write the immutable record. ──────────────────────────────────────
    const captureDir = path.join(attemptLayout.attemptDir, 'capture');
    const ingressRows: Array<Record<string, unknown>> = [];
    dump.ingress.forEach((chunk, index) => {
      const pcm = Buffer.from(chunk.pcm, 'base64');
      writeFileSync(path.join(captureDir, `ingress-${index}.pcm`), pcm, { mode: 0o600 });
      ingressRows.push({
        seq: chunk.seq,
        atMs: chunk.atMs,
        sampleRate: chunk.sampleRate,
        sampleCount: chunk.sampleCount,
        declaredDurationMs: (chunk.sampleCount / chunk.sampleRate) * 1_000,
        sha256: sha256(pcm),
        pcmFile: `ingress-${index}.pcm`,
        source: dump.sourceLabel,
      });
    });
    const egressRows: Array<Record<string, unknown>> = [];
    dump.egress.forEach((chunk, index) => {
      const bytes = Buffer.from(chunk.b64, 'base64');
      writeFileSync(path.join(captureDir, `egress-${index}.pcm`), bytes, { mode: 0o600 });
      egressRows.push({
        seq: chunk.seq,
        atMs: chunk.atMs,
        sampleRate: 16_000,
        sampleCount: chunk.sampleCount,
        declaredDurationMs: (chunk.sampleCount / 16_000) * 1_000,
        sha256: sha256(bytes),
        pcmFile: `egress-${index}.pcm`,
      });
    });
    writeFileSync(path.join(captureDir, 'ingress-chunks.json'), `${JSON.stringify(ingressRows, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(path.join(captureDir, 'egress-chunks.json'), `${JSON.stringify(egressRows, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(path.join(captureDir, 'console-errors.json'), `${JSON.stringify({ pageErrors: consoleErrors, console: consoleLog, websockets: wsLog }, null, 2)}\n`, { mode: 0o600 });
    // The UNION of every instrument page's wire record: a session switch moves
    // the product (and its instrument) to another page/document, and saving a
    // single stale page would hide the post-switch frames (L5).
    const allWireFrames: Array<Record<string, unknown>> = [];
    for (const labCandidate of await labPages()) {
      const pageDump = await dumpLab(labCandidate).catch(() => null);
      if (pageDump && Array.isArray(pageDump.wireFrames)) allWireFrames.push(...(pageDump.wireFrames as unknown as Array<Record<string, unknown>>));
    }
    const wireUnion = allWireFrames.length >= dump.wireFrames.length ? allWireFrames : dump.wireFrames;
    writeFileSync(path.join(captureDir, 'wire-frames.json'), `${JSON.stringify(wireUnion, null, 2)}\n`, { mode: 0o600 });

    // Record every text the shim was asked to speak, honestly: the file is
    // written only when the shim was actually present, and its own label is
    // recorded (a foreign label is the verifier's problem, not something to
    // silently rewrite).
    if (plan.tts === 'synthetic' && labPage.current) {
      ttsShim = await readTtsShim(labPage.current);
    }
    if (plan.tts === 'synthetic' && ttsShim) {
      writeFileSync(
        path.join(captureDir, 'tts-spoken.json'),
        `${JSON.stringify(
          {
            label: ttsShim.label,
            shimVerified: ttsShim.label === SYNTHETIC_TTS_LABEL && ttsShim.synthReplaced,
            readBackAttribution: SYNTHETIC_TTS_LABEL,
            spoken: ttsShim.spoken,
          },
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
    }

    writeFileSync(
      path.join(attemptLayout.attemptDir, 'director', 'steps.jsonl'),
      steps.map((row) => JSON.stringify(row)).join('\n') + '\n',
      { mode: 0o600 }
    );

    const voice = JSON.parse(readFileSync(path.join(options.corpusDir, 'voices', `${plan.voiceProfileId}.manifest.json`), 'utf8')) as {
      speechLabel: string;
      fixtures: Array<{ id: string; asr: { ok: boolean; wer: number; missingWords: string[] } }>;
    };
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'fixtures', 'used.json'),
      `${JSON.stringify(
        plan.turns.map((turn) => {
          const fixture = voice.fixtures.find((candidate) => candidate.id === turn.fixtureId);
          return {
            fixtureId: turn.fixtureId,
            episodeId: plan.episodeId,
            turnId: turn.turnId,
            inputMode: turn.inputMode,
            voiceProfileId: plan.voiceProfileId,
            speechLabel: voice.speechLabel,
            pcmSha256: turn.pcm16kSha256,
            manifestPath: `corpus/voices/${plan.voiceProfileId}.manifest.json`,
            asr: fixture?.asr ?? { ok: false, wer: 1, missingWords: ['fixture-missing'] },
          };
        }),
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    writeFileSync(
      path.join(attemptLayout.attemptDir, 'provider', 'server-evidence.jsonl'),
      evidenceRows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      { mode: 0o600 }
    );
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'evaluation', 'speak-log.json'),
      `${JSON.stringify(
        {
          syntheticInjections: dump.speakLog,
          syntheticModeVerified,
          laneWentLive,
          engineBadge,
          ...(plan.tts === 'synthetic'
            ? {
                ttsShim: {
                  mode: 'synthetic',
                  label: ttsShim?.label ?? SYNTHETIC_TTS_LABEL,
                  shimVerified: ttsShim?.label === SYNTHETIC_TTS_LABEL && ttsShim?.synthReplaced === true,
                  spokenCount: ttsShim?.spoken.length ?? 0,
                  spokenLog: ttsShim ? 'capture/tts-spoken.json' : null,
                },
              }
            : {}),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );

    // ── Teardown with verification (fails closed). ───────────────────────
    if (browserContext) {
      await browserContext.close().catch(() => {});
      browserContext = null;
    }
    cleanup.browserClosed = true;
    if (viteProcess?.pid) {
      try {
        process.kill(-viteProcess.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      viteProcess = null;
    }
    cleanup.previewStopped = true;
    const stopResult = run('bash', [bootScript, 'stop'], {
      env: { VOICE_LAB_DIR: stateDir, VOICE_LAB_UNIT: unitName, VOICE_LAB_POINTER: path.join(stateDir, 'current') },
      timeoutMs: 90_000,
    });
    cleanup.serverStopped = stopResult.code === 0;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    cleanup.socketsRemoved = !existsSync(path.join(stateDir, 'internal-api.sock'));

    const status =
      terminalAction?.status === 'complete' ? 'complete' : terminalAction?.status === 'safety-failure' ? 'failed-safety' : terminalAction?.status === 'interaction-failure' ? 'failed-interaction' : 'failed-incomplete';
    const manifest: AttemptManifest = {
      episodeId: plan.episodeId,
      arm: plan.arm,
      kind: 'primary-mic-journey',
      evidenceLevel: 'E2',
      captureMode: plan.captureMode,
      corpusHash: plan.corpusHash,
      planHash: journeyPlanHash(plan),
      instrument: plan.instrument,
      clientBuildSha256: clientBuildSha,
      server: { engine: plan.server.engine, compiled: true, stateDir, port: serverPort },
      armSelection: {
        requested: plan.arm,
        env: redactedChildEnv,
        syntheticModeVerified,
        note: 'arm identity confirmation against the provider profile surface is child P’s integration contract; not yet present on this build',
      },
      capture: {
        startedAtMs: dump.captureStartedAtMs ?? steps[0]?.atMs ?? 0,
        stoppedAtMs: dump.captureStoppedAtMs ?? Date.now(),
        getUserMediaCalls: dump.getUserMediaCalls,
        sourceLabel: dump.sourceLabel,
        ingressChunks: ingressRows.length,
        egressChunks: egressRows.length,
        openingTransport: {
          fixturePcm16kSha256: opening.pcm16kSha256,
          fixtureMasterWav: path.basename(opening.masterWavPath),
          paddingMs: OPENING_PADDING_MS,
          paddedWavSha256: sha256(paddedWav),
          paddedWavFile: 'capture/opening-padded.wav',
          note: 'device-timeline shift only; utterance bytes unchanged',
        },
      },
      laneStop: { finalState: stopObserved ? 'stopped-start-control-back' : 'live' },
      budget: {
        attemptDeadlineMs,
        abortedAtDeadline,
        wallClockMs: Date.now() - Date.parse(startedAtIso),
        providerCalls: {
          talkerToolCalls: evidenceRows.filter((row) => row.event === 'talker_tool_call').length,
          confirmAuthorised: evidenceRows.filter((row) => row.event === 'confirm_authorised').length,
          receipts: evidenceRows.filter((row) => row.event === 'delivery_receipt').length,
        },
        meteredUsage: 'not exposed by this server build; wall-clock and kernel call counts recorded',
      },
      startedAtIso,
      finishedAtIso: new Date().toISOString(),
      cleanup,
      terminal: terminalAction,
      turnModes: plan.turns.map((turn) => ({ turnId: turn.turnId, inputMode: turn.inputMode, fixtureId: turn.fixtureId })),
      // W4 soak: the record declares its soak contract for the verifier, which
      // adjudicates against its own FIXED bars (the manifest can only tighten).
      ...(plan.soak ? { soak: plan.soak } : {}),
      // W4 busy drive (C22): the real Internal API prompt that made the worker
      // genuinely busy before the relay — recorded, never implied.
      ...(busyDriveRecord ? { workerBusyDrive: { ...busyDriveRecord, prompt: BUSY_DRIVE_PROMPT } } : {}),
      // W4 two-session prep (C24): the real sessions created before the journey.
      ...(preparedWorkers.length > 0
        ? { preparedWorkers: preparedWorkers.map((worker) => ({ sessionId: worker.sessionId, sessionPath: worker.sessionPath, displayName: worker.displayName })) }
        : {}),
      // W4 attachment switch: freeze the observed from/to worker identities.
      ...(attachmentSwitchRecord ? { attachmentSwitch: attachmentSwitchRecord } : {}),
      // Child J3: the manifest carries the shim marker (captureMode already
      // does, from the plan) plus the honest seam description. evidenceLevel
      // stays E2 — a shim read-back is never a rendered-audio claim.
      ...(plan.tts === 'synthetic'
        ? {
            tts: {
              mode: 'synthetic',
              label: ttsShim?.label ?? SYNTHETIC_TTS_LABEL,
              shimVerified: ttsShim?.label === SYNTHETIC_TTS_LABEL && ttsShim?.synthReplaced === true,
              spokenCount: ttsShim?.spoken.length ?? 0,
              spokenLog: ttsShim ? 'capture/tts-spoken.json' : null,
              readBackAttribution: SYNTHETIC_TTS_LABEL,
              renderedAudioClaimed: false,
              note: 'labelled lab shim; the verifier checks every spoken text against the proposal retained bytes — never a rendered-audio (E2R/E3) claim',
            },
          }
        : {}),
    };
    finaliseAttempt(attemptLayout.attemptDir, manifest);
    log(`attempt record: ${attemptLayout.attemptDir}`);

    const hasIngress = ingressRows.length > 0;
    const hasEgress = egressRows.length > 0;
    if (status === 'complete' && hasIngress && hasEgress && !abortedAtDeadline) {
      return { attemptDir: attemptLayout.attemptDir, outcome: 'pass', detail: `ingress ${ingressRows.length}, egress ${egressRows.length} chunks; terminal complete` };
    }
    if (status.startsWith('failed') && status !== 'failed-incomplete') {
      return { attemptDir: attemptLayout.attemptDir, outcome: 'fail', detail: terminalAction?.reason ?? status };
    }
    return {
      attemptDir: attemptLayout.attemptDir,
      outcome: 'incomplete',
      detail: !hasIngress || !hasEgress ? 'absent ingress/egress evidence — exit 2, never a green skip' : status,
      reason: !hasIngress || !hasEgress ? 'absent-ingress-evidence' : status,
    };
  } catch (error) {
    problems.push(String(error instanceof Error ? error.stack ?? error.message : error));
    if (browserContext) await browserContext.close().catch(() => {});
    cleanup.browserClosed = true;
    if (viteProcess?.pid) {
      try {
        process.kill(-viteProcess.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    cleanup.previewStopped = true;
    const stopResult = run('bash', [bootScript, 'stop'], {
      env: { VOICE_LAB_DIR: stateDir, VOICE_LAB_UNIT: unitName, VOICE_LAB_POINTER: path.join(stateDir, 'current') },
      timeoutMs: 90_000,
    });
    cleanup.serverStopped = stopResult.code === 0;
    writeFileSync(path.join(attemptLayout.attemptDir, 'evaluation', 'failure.txt'), `${problems.join('\n\n')}\n`, { mode: 0o600 });
    finaliseAttempt(attemptLayout.attemptDir, {
      episodeId: plan.episodeId,
      arm: plan.arm,
      kind: 'primary-mic-journey',
      evidenceLevel: 'E2',
      captureMode: plan.captureMode,
      startedAtIso,
      status: 'failed',
      cleanup,
    } satisfies AttemptManifest);
    return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: `run failed: ${problems[0]?.slice(0, 400)}`, reason: 'run-failed' };
  }
}
