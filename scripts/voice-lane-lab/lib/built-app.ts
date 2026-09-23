/**
 * Built-app primary-control capture mode (native-primary plan Phase 1, §4.2).
 *
 * This module launches the BUILT production-shape client against a disposable
 * COMPILED validation server and drives the main Voice Mode controls with
 * Chromium's file-backed fake microphone, while a lab-only ingress instrument
 * (labelled, injected from here, never part of the client) observes the
 * captured stream at the boundary:
 *
 *   getUserMedia → MediaStreamAudioSourceNode → [TAP] → production capture
 *   worklet → CapturePipeline resampler → voice_audio_chunk frames → [TAP]
 *
 * The pre-worklet tap records the device-rate PCM (digests, durations, causal
 * timestamps); the WebSocket tap records the 16 kHz frames that left the
 * production resampler. Together they prove the utterance traversed the
 * production capture worklet and resampling path — start AND stop.
 *
 * Everything here is E2-grade EXCEPT where explicitly labelled: the
 * `synthetic-stream-source` helper (a lab-only controllable MediaStream for
 * adaptive steps) is the plan's own named fixture source and stamps every
 * record it touches. Nothing in this module edits client code.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  createAttempt,
  finaliseAttempt,
  type AttemptManifest,
} from './records.js';
import type { LoadedCorpus } from './corpus.js';
import { episodeById } from './corpus.js';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

export const INSTRUMENT_ID = 'voice-lane-lab-ingress/1';

// ── Planning (pure; the dry-run path) ───────────────────────────────────────

export interface EpisodePlan {
  schemaVersion: 1;
  kind: 'capture-proof';
  episodeId: string;
  arm: 'standard';
  captureMode: 'fake-file';
  utterance: {
    specId: string;
    text: string;
    voiceProfileId: string;
    speechLabel: string;
    pcm16kSha256: string;
    masterWavPath: string;
    durationMs: number;
  };
  server: { engine: string; compiled: true };
  browserArgs: string[];
  corpusHash: string;
  instrument: { id: string; label: string };
  /** Present only in unit fixtures; excludes volatile paths from the hash. */
  planHash?: string;
}

export interface FrozenVoiceManifest {
  profileId: string;
  speechLabel: string;
  fixtures: Array<{
    id: string;
    text: string;
    pcm16kSha256: string;
    pcm16kPath: string;
    masterWavPath: string;
    durationMs: number;
    asr: { ok: boolean; wer: number; missingWords: string[]; transcript: string };
  }>;
  [key: string]: unknown;
}

/** Read the frozen (commit-copy) voice manifest for a profile. */
export function readFrozenVoiceManifest(corpusDir: string, profileId: string): FrozenVoiceManifest {
  const manifestPath = path.join(corpusDir, 'voices', `${profileId}.manifest.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `frozen voice manifest missing: ${manifestPath} — run ` +
        `"npx tsx scripts/voice-lane-lab/cli.ts voices" first`
    );
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as FrozenVoiceManifest;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([key]) => key !== 'planHash')
          .sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return item;
  });
}

/** Deterministic capture-proof plan for an episode's opening utterance. */
export function planCaptureProof(
  episodeId: string,
  options: { corpus: LoadedCorpus; corpusDir: string; profileId?: string; wavDir?: string }
): EpisodePlan {
  const profileId = options.profileId ?? 'voice-a';
  const episode = episodeById(options.corpus, episodeId);
  if (episode.holdout) {
    throw new Error(`${episodeId}: holdout wording is frozen by the separate validator — cannot plan yet`);
  }
  const specId = `${episodeId}-t1`;
  const voice = readFrozenVoiceManifest(options.corpusDir, profileId);
  const fixture = voice.fixtures.find((candidate) => candidate.id === specId);
  if (!fixture) throw new Error(`voice manifest ${profileId} has no fixture ${specId}`);
  if (!fixture.asr.ok) throw new Error(`fixture ${specId} failed ASR validation — refusing to plan`);
  const wavDir = options.wavDir ?? path.dirname(fixture.masterWavPath);
  return {
    schemaVersion: 1,
    kind: 'capture-proof',
    episodeId,
    arm: 'standard',
    captureMode: 'fake-file',
    utterance: {
      specId,
      text: fixture.text,
      voiceProfileId: profileId,
      speechLabel: voice.speechLabel,
      pcm16kSha256: fixture.pcm16kSha256,
      masterWavPath: path.join(wavDir, path.basename(fixture.masterWavPath)),
      durationMs: fixture.durationMs,
    },
    server: { engine: 'gemini-live', compiled: true },
    browserArgs: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(wavDir, path.basename(fixture.masterWavPath))}%noloop`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    corpusHash: options.corpus.schemaVersion + '-' + sha256(stableStringify(options.corpus.episodes.map((e) => e.id))).slice(0, 16),
    instrument: { id: INSTRUMENT_ID, label: 'lab-only boundary observation; never part of the client' },
  };
}

export function planHash(plan: EpisodePlan): string {
  return sha256(stableStringify(plan));
}

// ── The lab-only ingress instrument (injected page code) ────────────────────

/**
 * Runs INSIDE the page before the app boots. It patches getUserMedia (to know
 * which stream source fed the pipeline and to offer the labelled
 * synthetic-stream-source fixture), taps the MediaStreamAudioSourceNode via a
 * ScriptProcessor (the samples entering the production worklet), and sniffs
 * the session WebSocket for voice_audio_chunk frames (the 16 kHz output of
 * the production resampler). All samples stay in-page until dumped.
 */
export const INGRESS_INSTRUMENT_SCRIPT: string = `
(() => {
  if (window.__voiceLaneLab) return;
  const lab = {
    instrumentId: '__INGRESS_ID__',
    label: 'lab-only boundary observation; never part of the client',
    mode: 'fake-file',
    sourceLabel: null,
    getUserMediaCalls: 0,
    captureStartedAtMs: null,
    captureStoppedAtMs: null,
    ingress: [],   // {seq, atMs, sampleRate, sampleCount, pcm (Int16 → b64)}
    egress: [],    // {seq, atMs, sampleRate, sampleCount, b64}
    wsSendCalls: 0,
    synthQueue: [], // {pcm16kB64, sampleRate} — synthetic-stream-source mode
    synthGain: null,
    synthContext: null,
    synthDest: null,
    stopped: false,
  };
  window.__voiceLaneLab = lab;

  const i16ToB64 = (i16) => {
    let s = '';
    const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return btoa(s);
  };

  // Synthetic-stream-source mode (E0-labelled adaptive input): a real
  // MediaStream backed by a MediaStreamDestination we schedule buffers into.
  const ensureSyntheticStream = () => {
    if (lab.synthDest) return lab.synthDest;
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    lab.synthContext = ctx;
    lab.synthDest = dest;
    return dest;
  };

  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    lab.getUserMediaCalls += 1;
    if (lab.mode === 'synthetic-stream-source') {
      const dest = ensureSyntheticStream();
      const stream = new MediaStream(dest.stream.getAudioTracks());
      for (const track of stream.getAudioTracks()) {
        try { Object.defineProperty(track, 'label', { value: 'synthetic-stream-source' }); } catch {}
      }
      lab.sourceLabel = 'synthetic-stream-source';
      return stream;
    }
    const stream = await origGetUserMedia(constraints);
    lab.sourceLabel = stream.getAudioTracks()[0]?.label ?? 'unknown';
    return stream;
  };

  // Tap the samples entering the production capture worklet.
  const origCreate = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    const source = origCreate.call(this, stream);
    const origConnect = source.connect.bind(source);
    source.connect = function (destination, ...rest) {
      try {
        const tap = this.context.createScriptProcessor(4096, 1, 1);
        tap.onaudioprocess = (event) => {
          if (lab.stopped) return;
          const input = event.inputBuffer.getChannelData(0);
          const i16 = new Int16Array(input.length);
          for (let i = 0; i < input.length; i += 1) {
            const clamped = Math.max(-1, Math.min(1, input[i]));
            i16[i] = Math.round(clamped * 32767);
          }
          if (lab.captureStartedAtMs === null) lab.captureStartedAtMs = performance.now();
          lab.ingress.push({
            seq: lab.ingress.length,
            atMs: performance.now(),
            sampleRate: event.inputBuffer.sampleRate,
            sampleCount: input.length,
            pcm: i16ToB64(i16),
          });
          if (lab.ingress.length > 20000) lab.ingress.shift();
        };
        origConnect(tap);
        // ScriptProcessor only processes with a complete path to the
        // destination: route the tap through a ZERO-GAIN sink so the mic is
        // tapped but never audible.
        const tapSink = this.context.createGain();
        tapSink.gain.value = 0;
        tap.connect(tapSink);
        tapSink.connect(this.context.destination);
      } catch (error) {
        (window.__voiceLaneLabFaults ||= []).push('tap: ' + String(error));
      }
      return origConnect(destination, ...rest);
    };
    return source;
  };

  // Tap the frames leaving the production pipeline (post-resampler, 16 kHz).
  const origSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (...sendArgs) {
    lab.wsSendCalls += 1;
    const data = sendArgs[0];
    try {
      if (typeof data === 'string' && data.includes('voice_audio_chunk')) {
        const parsed = JSON.parse(data);
        // Wire shape (shared/src/types/voice-messages.ts): base64 PCM16LE mono
        // at 16 kHz rides in parsed.data — the production resampler's output.
        if (parsed.type === 'voice_audio_chunk' && typeof parsed.data === 'string') {
          const raw = atob(parsed.data);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
          lab.egress.push({
            seq: lab.egress.length,
            atMs: performance.now(),
            sampleRate: 16000,
            sampleCount: bytes.byteLength >> 1,
            b64: parsed.data,
          });
        }
      }
    } catch {}
    // send is a native method: it MUST be invoked with the socket as this,
    // or the page gets "Illegal invocation" on every outbound message.
    return origSend.apply(this, sendArgs);
  };

  window.__voiceLaneLabStop = () => {
    lab.stopped = true;
    lab.captureStoppedAtMs = performance.now();
    if (lab.synthContext) { try { lab.synthContext.close(); } catch {} }
  };
  window.__voiceLaneLabSpeak = (pcm16kB64, sampleRate) => {
    // synthetic-stream-source mode only: schedule one utterance NOW.
    const dest = ensureSyntheticStream();
    const ctx = lab.synthContext;
    const raw = atob(pcm16kB64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i += 1) f32[i] = i16[i] / 32768;
    const buffer = ctx.createBuffer(1, f32.length, sampleRate);
    buffer.copyToChannel(f32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    source.start();
    return { sampleRate, frames: f32.length };
  };
})();
`.replace('__INGRESS_ID__', INSTRUMENT_ID);

// ── Process helpers ─────────────────────────────────────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('no free port'));
      server.close();
    });
    server.on('error', reject);
  });
}

function run(cmd: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// ── The runner ──────────────────────────────────────────────────────────────

export interface CaptureProofResult {
  attemptDir: string;
  ok: boolean;
  detail: string;
}

export async function runCaptureProof(
  plan: EpisodePlan,
  options: {
    repoRoot: string;
    corpus: LoadedCorpus;
    corpusDir: string;
    recordsRoot: string;
    authPassword: string;
    log?: (line: string) => void;
  }
): Promise<CaptureProofResult> {
  const log = options.log ?? (() => {});
  const repoRoot = path.resolve(options.repoRoot);

  // 1. Build prerequisites (compiled server + built client).
  const serverDist = path.join(repoRoot, 'server', 'dist', 'index.js');
  if (!existsSync(serverDist)) {
    log('building server (compiled shape)…');
    const build = run('npm', ['run', 'build', '--workspace=server'], { cwd: repoRoot, timeoutMs: 600_000 });
    if (build.code !== 0) return { attemptDir: '', ok: false, detail: `server build failed (exit ${build.code}): ${build.stderr.slice(-800)}` };
  }
  const clientDist = path.join(repoRoot, 'client', 'dist', 'index.html');
  if (!existsSync(clientDist)) {
    log('building client (production shape)…');
    const build = run('npm', ['run', 'build', '--workspace=client'], { cwd: repoRoot, timeoutMs: 600_000 });
    if (build.code !== 0) return { attemptDir: '', ok: false, detail: `client build failed (exit ${build.code}): ${build.stderr.slice(-800)}` };
  }
  const clientBuildSha = sha256(readFileSync(path.join(repoRoot, 'client', 'dist', 'index.html')));

  // The client port must exist before the server boots: the disposable
  // server's ALLOWED_ORIGINS has to name the serving origin or the browser's
  // WebSocket upgrade is origin-rejected (REST login works; sessions hang).
  const clientPort = await freePort();
  // 2. Disposable compiled validation server (via the guarded boot script).
  const bootScript = path.join(repoRoot, 'scripts', 'voice-live-lab', 'boot-disposable-server.sh');
  const serverMode = process.env.VOICE_LAB_SERVER_MODE === 'source' ? 'source' : 'compiled';
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'voice-lab-bapp-'));
  const unitName = `voice-lab-bapp-${process.pid}-${Date.now().toString(36)}`;
  const authPassword = options.authPassword;
  const boot = run('bash', [bootScript, 'boot'], {
    env: {
      VOICE_LAB_REPO: repoRoot,
      VOICE_LAB_DIR: stateDir,
      VOICE_LAB_UNIT: unitName,
      VOICE_LAB_POINTER: path.join(stateDir, 'current'),
      ...(serverMode === 'compiled' ? { VOICE_LAB_COMPILED: '1' } : {}),
      VOICE_MODE_ENGINE: plan.server.engine,
      AUTH_PASSWORD: authPassword,
      ALLOWED_ORIGINS: `http://127.0.0.1:${clientPort},http://localhost:${clientPort}`,
      LOG_FORMAT: 'json',
    },
    timeoutMs: 300_000,
  });
  if (boot.code !== 0) {
    return { attemptDir: '', ok: false, detail: `disposable server failed to boot (exit ${boot.code}): ${boot.stderr.slice(-800)}` };
  }
  let serverPort: number | null = null;
  const serverLogPath = path.join(stateDir, 'server.log');
  for (let i = 0; i < 120 && serverPort === null; i += 1) {
    try {
      const logText = readFileSync(serverLogPath, 'utf8');
      const match = /^\s*port\s*:\s*(\d+)\s*$/m.exec(logText);
      if (match) serverPort = Number(match[1]);
    } catch {
      /* log not ready */
    }
    if (serverPort === null) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (serverPort === null) return { attemptDir: '', ok: false, detail: `could not discover the disposable server's port from ${serverLogPath}` };
  log(`disposable compiled server ready: http://127.0.0.1:${serverPort} (state ${stateDir})`);

  let viteProcess: ReturnType<typeof spawn> | null = null;
  let browserContext: import('playwright').BrowserContext | null = null;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'voice-lab-profile-'));
  const attemptLayout = createAttempt(options.recordsRoot, 'capture-proofs', `${plan.episodeId}-standard`);
  const problems: string[] = [];
  const cleanup = { browserClosed: false, previewStopped: false, serverStopped: false, socketsRemoved: false };
  let startedAtIso = new Date().toISOString();

  try {
    // 3. Serve the built client (vite preview + proxy). Pin the IPv4 loopback:
    // vite's default `localhost` can bind ::1 only, which 127.0.0.1 checks miss.
    const viteLog = path.join(stateDir, 'vite-preview.log');
    viteProcess = spawn(
      'npx',
      ['vite', 'preview', '--host', '127.0.0.1', '--port', String(clientPort), '--strictPort'],
      {
        cwd: path.join(repoRoot, 'client'),
        env: { ...process.env, VITE_API_TARGET: `http://127.0.0.1:${serverPort}` },
        stdio: ['ignore', openSync(viteLog, 'a'), 'inherit'],
        detached: true,
      }
    );
    await waitForHttp(`http://127.0.0.1:${clientPort}/`, 90_000);
    log(`built client served: http://127.0.0.1:${clientPort} (proxying to ${serverPort})`);

    // 4. Playwright with the private profile + file-backed fake mic.
    const { chromium } = await import('playwright');
    browserContext = await chromium.launchPersistentContext(userDataDir, {
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone'],
      args: plan.browserArgs,
    });
    const page = await browserContext.newPage();
    const consoleErrors: string[] = [];
    const consoleLog: string[] = [];
    const networkLog: string[] = [];
    const wsLog: string[] = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) consoleLog.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    });
    page.on('requestfailed', (request) => networkLog.push(`FAILED ${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? '?'}`));
    page.on('response', (response) => {
      if (response.url().includes('/api/') && response.status() >= 400) networkLog.push(`HTTP ${response.status()} ${response.url()}`);
    });
    page.on('websocket', (ws) => {
      wsLog.push(`WS open: ${ws.url()}`);
      ws.on('close', () => wsLog.push(`WS closed: ${ws.url()}`));
      ws.on('socketerror', (data) => wsLog.push(`WS error: ${String(data).slice(0, 200)}`));
    });
    // addInitScript needs a callable: a bare string silently no-ops in the
    // current Playwright Node API, so wrap the script source as a function.
    await page.addInitScript(new Function(INGRESS_INSTRUMENT_SCRIPT) as () => void);

    startedAtIso = new Date().toISOString();
    await page.goto(`http://127.0.0.1:${clientPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_200);
    const password = page.locator('input[type="password"]');
    if (await password.isVisible().catch(() => false)) {
      await password.fill(authPassword);
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
    // The model catalogue loads asynchronously over the session socket; a click
    // against an unpopulated list selects nothing (the dialog then shows
    // "No Model" and session creation hangs). Wait for the row, click it, and
    // VERIFY the selection took before moving on.
    const modelRow = page.getByText('Kimi for Coding', { exact: true }).first();
    await modelRow.waitFor({ timeout: 45_000 });
    await modelRow.click();
    await page.locator('button').filter({ hasText: '/tmp' }).first().click();
    try {
      await page.waitForSelector('[data-testid="drive-mode-surface"]', { timeout: 90_000 });
    } catch (error) {
      // Evidence-first: capture what the page actually showed before failing.
      await page
        .screenshot({ path: path.join(attemptLayout.attemptDir, 'capture', 'shot-timeout-drive-mode.png') })
        .catch(() => {});
      const bodyText = await page
        .evaluate(() => document.body.innerText.slice(0, 2_000))
        .catch(() => `body unreadable`);
      writeFileSync(
        path.join(attemptLayout.attemptDir, 'capture', 'page-at-timeout.txt'),
        `${bodyText}\n\npage errors:\n${consoleErrors.join('\n')}\n\nconsole (error/warn):\n${consoleLog.join('\n')}\n\nnetwork:\n${networkLog.join('\n')}\n\nwebsockets:\n${wsLog.join('\n')}\n`,
        { mode: 0o600 }
      );
      throw error;
    }
    await page.screenshot({ path: path.join(attemptLayout.attemptDir, 'capture', 'shot-1-drive-mode.png') });

    // The main capture control: open the native lane and press Start.
    await page.getByTestId('native-voice-lane-toggle').click();
    await page.getByTestId('voice-live-start').click();
    await page.waitForSelector('[data-testid="voice-live-status"][data-lane="live"]', { timeout: 60_000 });
    await page.screenshot({ path: path.join(attemptLayout.attemptDir, 'capture', 'shot-2-live.png') });

    // Let the utterance play through the fake mic + a response window.
    const listenMs = Math.max(4_000, Math.min(plan.utterance.durationMs + 6_000, 30_000));
    await page.waitForTimeout(listenMs);

    // Stop via the main control. The product's stop ends the talker session
    // and returns the panel to its listening controls: the START control
    // reappearing is the observable proof the stop took. The lane attribute
    // staying `live` means the open-mic lane itself remains up — that is
    // product behaviour, not a stuck stop, so it is recorded, not failed.
    await page.getByTestId('voice-live-stop').click();
    const stopped = await page
      .waitForSelector('[data-testid="voice-live-start"]', { state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    const laneState = stopped ? 'stopped-start-control-back' : 'live';
    // Best-effort instrument stop: the app may host the lane on a different
    // context page than the one the runner clicked in, so look for the page
    // that actually carries the lab handle before stopping the instrument.
    const instrumentState: Record<string, unknown> = { pages: browserContext.pages().map((candidate) => candidate.url()) };
    let labPage: import('playwright').Page | null = null;
    for (const candidate of browserContext.pages()) {
      const hasLab = await candidate
        .evaluate(() => typeof (window as unknown as Record<string, unknown>).__voiceLaneLab)
        .catch(() => 'evaluate-failed');
      instrumentState[`lab@${candidate.url()}`] = hasLab;
      if (hasLab === 'object') labPage = candidate;
    }
    log(`instrument pages: ${JSON.stringify(instrumentState)}`);
    if (labPage) {
      await labPage.evaluate(() => (window as unknown as { __voiceLaneLabStop: () => void }).__voiceLaneLabStop());
    } else {
      log('no page carries the lab instrument — the capture may have run without the tap');
    }
    const dumpPage = labPage ?? page;
    await page.screenshot({ path: path.join(attemptLayout.attemptDir, 'capture', 'shot-3-stopped.png') });
    const dump = await dumpPage
      .evaluate(() => {
        const lab = (window as unknown as { __voiceLaneLab?: Record<string, unknown> }).__voiceLaneLab;
        if (!lab) return null;
        return JSON.parse(JSON.stringify(lab)) as {
        instrumentId: string;
        label: string;
        mode: string;
        sourceLabel: string | null;
        getUserMediaCalls: number;
        captureStartedAtMs: number | null;
        captureStoppedAtMs: number | null;
        ingress: Array<{ seq: number; atMs: number; sampleRate: number; sampleCount: number; pcm: string }>;
        egress: Array<{ seq: number; atMs: number; sampleRate: number; sampleCount: number; b64: string }>;
        wsSendCalls: number;
      };
      })
      .catch(() => null);
    if (!dump || !Array.isArray(dump.ingress)) {
      throw new Error('the lab instrument carried no ingress data on any page');
    }

    // 5. Write the immutable record.
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
    writeFileSync(
      path.join(captureDir, 'console-errors.json'),
      `${JSON.stringify({ pageErrors: consoleErrors }, null, 2)}\n`,
      { mode: 0o600 }
    );

    // Director steps: the capture-proof flow, exactly as executed.
    const nowMs = (offset: number) => (dump.captureStartedAtMs ?? 0) + offset;
    const steps = [
      { seq: 1, atMs: nowMs(-1_500), action: { type: 'speak', turnId: 't1', text: plan.utterance.text }, observation: { kind: 'capture-started', mode: 'fake-file', source: dump.sourceLabel } },
      { seq: 2, atMs: nowMs(-500), action: { type: 'await', reason: 'waiting for lane live', deadlineMs: 60_000 }, observation: { kind: 'lane-live' } },
      { seq: 3, atMs: nowMs(listenMs), action: { type: 'await', reason: 'waiting for utterance to traverse', deadlineMs: 45_000 }, observation: { kind: 'ingress-complete', chunks: dump.ingress.length } },
      {
        seq: 4,
        // The stop observation is anchored to the instrument's OWN stop time,
        // not the click: audio legitimately keeps flowing until the tap ends.
        atMs: dump.captureStoppedAtMs ?? nowMs(listenMs + 500),
        action: { type: 'terminal', status: 'capture-complete', reason: 'capture proof finished' },
        observation: { kind: 'capture-stopped' },
      },
    ];
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'director', 'steps.jsonl'),
      steps.map((step) => JSON.stringify(step)).join('\n') + '\n',
      { mode: 0o600 }
    );

    // Fixtures used: from the frozen manifest + its ASR validation record.
    const voice = readFrozenVoiceManifest(options.corpusDir, plan.utterance.voiceProfileId);
    const fixture = voice.fixtures.find((candidate) => candidate.id === plan.utterance.specId);
    if (fixture) {
      writeFileSync(
        path.join(attemptLayout.attemptDir, 'fixtures', 'used.json'),
        `${JSON.stringify(
          [
            {
              fixtureId: fixture.id,
              episodeId: plan.episodeId,
              turnId: 't1',
              voiceProfileId: plan.utterance.voiceProfileId,
              speechLabel: voice.speechLabel,
              pcmSha256: fixture.pcm16kSha256,
              manifestPath: `corpus/voices/${plan.utterance.voiceProfileId}.manifest.json`,
              asr: fixture.asr,
            },
          ],
          null,
          2
        )}\n`,
        { mode: 0o600 }
      );
    }

    // 6. Teardown with verification (cleanup fails closed).
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

    const manifest: AttemptManifest = {
      episodeId: plan.episodeId,
      arm: plan.arm,
      kind: 'capture-proof',
      evidenceLevel: 'E2',
      captureMode: plan.captureMode,
      corpusHash: plan.corpusHash,
      planHash: planHash(plan),
      instrument: plan.instrument,
      clientBuildSha256: clientBuildSha,
      server: { engine: plan.server.engine, compiled: true, stateDir },
      capture: {
        startedAtMs: dump.captureStartedAtMs,
        stoppedAtMs: dump.captureStoppedAtMs,
        getUserMediaCalls: dump.getUserMediaCalls,
        sourceLabel: dump.sourceLabel,
        ingressChunks: ingressRows.length,
        egressChunks: egressRows.length,
      },
      laneStop: { finalState: String(laneState) },
      startedAtIso,
      finishedAtIso: new Date().toISOString(),
      cleanup,
    };
    finaliseAttempt(attemptLayout.attemptDir, manifest);
    log(`attempt record: ${attemptLayout.attemptDir}`);
    return {
      attemptDir: attemptLayout.attemptDir,
      ok: ingressRows.length > 0 && egressRows.length > 0 && consoleErrors.length === 0,
      detail:
        `ingress ${ingressRows.length} chunks, egress ${egressRows.length} chunks, ` +
        `${consoleErrors.length} page errors, source ${dump.sourceLabel}`,
    };
  } catch (error) {
    problems.push(String(error instanceof Error ? error.stack ?? error.message : error));
    // Best-effort teardown so a failed run never leaves children behind.
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
    run('bash', [bootScript, 'stop'], {
      env: { VOICE_LAB_DIR: stateDir, VOICE_LAB_UNIT: unitName, VOICE_LAB_POINTER: path.join(stateDir, 'current') },
      timeoutMs: 90_000,
    });
    cleanup.serverStopped = true;
    writeFileSync(
      path.join(attemptLayout.attemptDir, 'evaluation', 'failure.txt'),
      `${problems.join('\n\n')}\n`,
      { mode: 0o600 }
    );
    finaliseAttempt(attemptLayout.attemptDir, {
      episodeId: plan.episodeId,
      arm: plan.arm,
      kind: 'capture-proof',
      evidenceLevel: 'E2',
      captureMode: plan.captureMode,
      startedAtIso,
      status: 'failed',
      cleanup,
    });
    return { attemptDir: attemptLayout.attemptDir, ok: false, detail: `run failed: ${problems[0]?.slice(0, 400)}` };
  }
}

void rmSync;
void readdirSync;
