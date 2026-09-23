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
  freePort,
  run,
  waitForHttp,
} from './built-app.js';
import { createAttempt, finaliseAttempt, type AttemptManifest } from './records.js';
import { episodeById, type LoadedCorpus } from './corpus.js';
import { EpisodeDirector, type DirectorObservation, type DirectorAction } from './director.js';
import { journeyPlanHash, type JourneyPlan, type JourneyTurn } from './journey-plan.js';
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

// ── Internal API (worker store check) ───────────────────────────────────────

/** GET a path on the disposable server's Internal API over its unix socket. */
function internalApiGet(socketPath: string, tokenPath: string, apiPath: string, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  let token: string;
  try {
    token = readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = http.request(
      {
        socketPath,
        path: apiPath,
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        timeout: timeoutMs,
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
    request.end();
  });
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

  // 2. Builds (compiled server + built client, production shape).
  const serverDist = path.join(repoRoot, 'server', 'dist', 'index.js');
  if (!existsSync(serverDist)) {
    log('building server (compiled shape)…');
    const build = run('npm', ['run', 'build', '--workspace=server'], { cwd: repoRoot, timeoutMs: 600_000 });
    if (build.code !== 0) {
      finaliseAttempt(attemptLayout.attemptDir, {
        episodeId: plan.episodeId, arm: plan.arm, kind: 'primary-mic-journey', evidenceLevel: 'E2',
        captureMode: plan.captureMode, startedAtIso, status: 'invalid', reason: 'server-build-failed',
        cleanup,
      } satisfies AttemptManifest);
      return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: `server build failed (exit ${build.code})` };
    }
  }
  const clientDist = path.join(repoRoot, 'client', 'dist', 'index.html');
  if (!existsSync(clientDist)) {
    log('building client (production shape)…');
    const build = run('npm', ['run', 'build', '--workspace=client'], { cwd: repoRoot, timeoutMs: 600_000 });
    if (build.code !== 0) {
      finaliseAttempt(attemptLayout.attemptDir, {
        episodeId: plan.episodeId, arm: plan.arm, kind: 'primary-mic-journey', evidenceLevel: 'E2',
        captureMode: plan.captureMode, startedAtIso, status: 'invalid', reason: 'client-build-failed',
        cleanup,
      } satisfies AttemptManifest);
      return { attemptDir: attemptLayout.attemptDir, outcome: 'incomplete', detail: `client build failed (exit ${build.code})` };
    }
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

  /** Map one instrument wire frame to a director observation (or none). */
  const observeWireFrame = (row: WireFrameRow): DirectorObservation | null =>
    observationFromWireFrame(row, candidateTextByIdentity);

  const observeEvidence = (row: EvidenceRow): DirectorObservation | null => observationFromEvidence(row);

  /** Poll the instrument + the server evidence log; queue new observations. */
  const collectObservations = async (): Promise<void> => {
    if (!labPage.current) await findLabPage(browserContext!, labPage);
    if (labPage.current) {
      const dump = await dumpLab(labPage.current);
      if (dump) {
        const fresh = dump.wireFrames.slice(wireFramesSeen);
        wireFramesSeen = dump.wireFrames.length;
        for (const row of fresh) {
          const observation = observeWireFrame(row);
          if (observation) pendingObservations.push(observation);
        }
      }
    }
    for (const row of readServerEvidence(serverLogPath, serverLogOffset)) {
      evidenceRows.push(row);
      const observation = observeEvidence(row);
      if (observation) pendingObservations.push(observation);
    }
  };

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
    if (!response || response.status !== 200) return false;
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'provider', 'worker-transcript-response.txt'),
      `workerSessionId: ${workerSessionId}\nHTTP ${response.status}\n\n${response.body}\n`,
      { mode: 0o600 }
    );
    return response.body.includes(approvedText.slice(0, Math.min(40, approvedText.length)));
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
    await page.locator('button[aria-label="Enter Voice Mode"]').first().click();
    await page.getByRole('button', { name: 'Start a new session' }).click();
    const modelRow = page.getByText('Kimi for Coding', { exact: true }).first();
    await modelRow.waitFor({ timeout: 45_000 });
    await modelRow.click();
    await page.locator('button').filter({ hasText: '/tmp' }).first().click();
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

    // ── The director loop ────────────────────────────────────────────────
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
    for (;;) {
      if (Date.now() > deadlineAt) {
        abortedAtDeadline = true;
        terminalAction = { type: 'terminal', status: 'interaction-failure', reason: `attempt deadline ${attemptDeadlineMs} ms exceeded — model/audio connections aborted` };
        break;
      }
      await collectObservations();
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
        await speakTurn(turn);
        executed = true;
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

    // The worker store check for relay episodes: the approved bytes must be
    // persisted in the worker's own session (a delivery ack is not enough).
    const approved = director.state.approvedIdentity;
    if (plan.routesRelay && approved && terminalAction?.type === 'terminal' && terminalAction.status === 'complete') {
      const storeDeadline = Date.now() + plan.deadlines.workerStoreMs;
      let stored = false;
      while (Date.now() < storeDeadline && !stored) {
        stored = await checkWorkerStore(approved);
        if (!stored) await page.waitForTimeout(1_000);
      }
      if (!stored) {
        steps.push({
          seq: steps.length + 1,
          atMs: Date.now(),
          observation: { kind: 'worker-store', identity: approved, ok: false, atMs: Date.now() },
          action: { type: 'terminal', status: 'interaction-failure', reason: 'worker store check failed: approved input was not persisted' },
        });
        terminalAction = { type: 'terminal', status: 'interaction-failure', reason: 'worker store check failed: approved input was not persisted' };
      }
    }

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
    writeFileSync(path.join(captureDir, 'wire-frames.json'), `${JSON.stringify(dump.wireFrames, null, 2)}\n`, { mode: 0o600 });

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
      `${JSON.stringify({ syntheticInjections: dump.speakLog, syntheticModeVerified, laneWentLive, engineBadge }, null, 2)}\n`,
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
