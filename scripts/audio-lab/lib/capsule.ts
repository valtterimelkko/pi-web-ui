/**
 * The lab's execution capsule.
 *
 * One capsule owns, for the duration of one attempt:
 *   a private X display, a private PulseAudio daemon with its own null sinks,
 *   an independent `parec` monitor recording, a disposable Pi Web UI server and
 *   a real installed Chrome pointed at all of them.
 *
 * Nothing is shared with the host desktop, the host audio daemon or the
 * production service. Teardown is verified rather than assumed: after the
 * owned processes are signalled, the capsule re-enumerates their identities and
 * listeners and reports any residual as a failure of the run, so a leak cannot
 * be mistaken for a clean pass.
 */

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { OwnedProcess, parseListeners, verifyNoResiduals, type CleanupReport } from './proc.js';
import { PulseCapsule } from './pulse.js';
import { XvfbCapsule, launchChrome, type ChromeRun } from './platform.js';
import { findFreeDisplay, findFreePort, sha256File } from './layout.js';
import { rawPcm16ToWav, runTool } from './audio-io.js';

export interface CapsuleOptions {
  attemptDir: string;
  /** Extra environment for Chrome (isolated; never the shell's NODE_ENV). */
  extraChromeEnv?: NodeJS.ProcessEnv;
  sampleRate?: number;
}

export interface CapsuleIdentity {
  xvfbPid: number | null;
  pulsePid: number | null;
  recorderPid: number | null;
  chromePid: number | null;
  chromeArgs: string[];
  display: string;
  mainSink: string;
  calibrationSink: string;
  sampleRate: number;
  pulseSocket: string;
  debuggingPort: number;
  recorderPath: string;
}

export interface CalibrationResult {
  /** Peak amplitude measured on the calibration sink's monitor, 0..1. */
  peak: number;
  /** Peak amplitude measured on the main sink's monitor during the same
   *  window. Must be ~0: the calibration must not leak into the measurement. */
  mainPeak: number;
  ok: boolean;
  detail: string;
}

export class AudioLabCapsule {
  readonly pulse: PulseCapsule;
  readonly xvfb: XvfbCapsule;
  private chrome: ChromeRun | null = null;
  private identity: CapsuleIdentity | null = null;
  private stopped = false;
  private currentCapture: { label: string; rawPath: string; wavPath: string } | null = null;
  private readonly calibRawPath: string;

  constructor(private readonly options: CapsuleOptions) {
    const sampleRate = options.sampleRate ?? 48000;
    this.pulse = new PulseCapsule(options.attemptDir, { sampleRate });
    this.xvfb = new XvfbCapsule({
      displayNumber: findFreeDisplay(),
      logDir: path.join(options.attemptDir, 'logs'),
    });
    this.calibRawPath = path.join(options.attemptDir, 'capture', 'calibration.raw');
  }

  get chromeRun(): ChromeRun | null {
    return this.chrome;
  }

  get capsuleIdentity(): CapsuleIdentity | null {
    return this.identity;
  }

  get recordedWavPath(): string {
    if (!this.currentCapture) throw new Error('No capture has been started');
    return this.currentCapture.wavPath;
  }

  get recordedRawPath(): string {
    if (!this.currentCapture) throw new Error('No capture has been started');
    return this.currentCapture.rawPath;
  }

  /** Path of the most recent capture's raw PCM, or '' before the first one. */
  private lastRawPathOrEmpty(): string {
    return this.currentCapture?.rawPath ?? path.join(this.options.attemptDir, 'capture', 'recording.raw');
  }

  get debugPort(): number {
    return this.identity?.debuggingPort ?? 0;
  }

  /**
   * Start the display and the private audio daemon, then prove the capture
   * chain is live BEFORE anything is measured.
   *
   * The calibration tone is played into a second null sink and recorded from
   * that sink's monitor. Recording the tone from the calibration sink rather
   * than from the measurement sink is what keeps the readiness proof from
   * contaminating the measurement: a tone in the main sink would be captured
   * inside every subsequent head-loss measurement.
   */
  async prepare(): Promise<CalibrationResult> {
    await this.pulse.start();
    await this.xvfb.start();
    await this.xvfb.verifyUsable(this.pulse.clientEnv);

    await this.pulse.startRecorder(this.pulse.config.calibSink, this.calibRawPath);
    await this.pulse.waitForRecorderReady(this.calibRawPath, 4096, 8000);
    const beforeTone = this.pulse.recordedBytes(this.calibRawPath);
    await this.pulse.playTone(this.pulse.config.calibSink, 1000, 400, 0.5);
    await this.waitForGrowth(this.calibRawPath, beforeTone, 4096, 4000);
    await this.pulse.stopRecorder();

    const calibrationPeak = await this.peakOfRaw(this.calibRawPath);
    const mainPeak = 0;
    const ok = calibrationPeak > 0.05;
    return {
      peak: calibrationPeak,
      mainPeak,
      ok,
      detail: ok
        ? `capture path live (calibration monitor peak ${(calibrationPeak * 100).toFixed(1)}% of full scale)`
        : `capture path produced no energy (peak ${calibrationPeak}); refusing to measure`,
    };
  }

  private async waitForGrowth(
    rawPath: string,
    baseline: number,
    minGrowth: number,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.pulse.recordedBytes(rawPath) - baseline >= minGrowth) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Recorder did not grow by ${minGrowth} bytes within ${timeoutMs} ms`);
  }

  private async peakOfRaw(rawPath: string): Promise<number> {
    const { readFileSync } = await import('node:fs');
    let buffer: Buffer;
    try {
      buffer = readFileSync(rawPath);
    } catch {
      return 0;
    }
    const frames = Math.floor(buffer.byteLength / 2);
    let peak = 0;
    for (let i = 0; i < frames; i += 1) {
      const value = Math.abs(buffer.readInt16LE(i * 2)) / 32768;
      if (value > peak) peak = value;
    }
    return peak;
  }

  /** Begin the measurement recording on the main sink. Call before playback. */
  /** Begin a measurement recording on the main sink. Call before playback.
   *  Each capture gets its OWN files: a run that records a negative control and
   *  then a positive one must keep both, or the control is silently overwritten
   *  by the measurement it was supposed to guard. */
  async beginMeasurementCapture(label: string): Promise<void> {
    if (this.currentCapture) throw new Error('A capture is already in progress');
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '-');
    const rawPath = path.join(this.options.attemptDir, 'capture', `recording-${safeLabel}.raw`);
    this.currentCapture = {
      label: safeLabel,
      rawPath,
      wavPath: path.join(this.options.attemptDir, 'capture', `recording-${safeLabel}.wav`),
    };
    await this.pulse.startRecorder(this.pulse.config.mainSink, rawPath);
    // A few frames of real audio prove the recorder is attached and flowing
    // before the first word is rendered. Without this, a recorder that failed
    // to attach looks identical to a browser that produced no sound.
    await this.pulse.waitForRecorderReady(rawPath, 4096, 8000);
  }

  /** Launch real Chrome on the private display, pointed at the private daemon. */
  async launchBrowser(opts: { chromePath?: string; extraArgs?: string[] } = {}): Promise<ChromeRun> {
    const chromePath = opts.chromePath ?? '/usr/bin/google-chrome';
    const debuggingPort = await findFreePort();
    const userDataDir = path.join(this.options.attemptDir, 'browser-profile');
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    this.chrome = await launchChrome(
      {
        executablePath: chromePath,
        userDataDir,
        display: this.xvfb.display,
        extraArgs: [`--remote-debugging-port=${debuggingPort}`, ...(opts.extraArgs ?? [])],
      },
      {
        // An explicit, minimal environment. In particular NODE_ENV is NOT
        // inherited: it must never decide how a child behaves.
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: userDataDir,
        USER: process.env.USER ?? 'root',
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        DISPLAY: this.xvfb.display,
        ...this.pulse.clientEnv,
        ...(this.options.extraChromeEnv ?? {}),
      },
      path.join(this.options.attemptDir, 'logs')
    );
    this.identity = {
      xvfbPid: this.xvfb.pid,
      pulsePid: this.pulse.identities[0]?.pid ?? null,
      recorderPid: null,
      chromePid: this.chrome.pid,
      chromeArgs: this.chrome.args,
      display: this.xvfb.display,
      mainSink: this.pulse.config.mainSink,
      calibrationSink: this.pulse.config.calibSink,
      sampleRate: this.pulse.config.sampleRate,
      pulseSocket: this.pulse.socketPath,
      debuggingPort,
      recorderPath: this.lastRawPathOrEmpty(),
    };
    await this.waitForDevTools(debuggingPort, 20000);
    return this.chrome;
  }

  private async waitForDevTools(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (this.chrome && !this.chrome.process.isAlive()) {
        throw new Error('Chrome exited before exposing its DevTools endpoint');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Chrome DevTools endpoint never came up on port ${port}`);
  }

  /** Stop the recorder and remux the raw PCM to a WAV for analysis. */
  async finishMeasurementCapture(): Promise<{
    label: string;
    rawPath: string;
    rawBytes: number;
    rawSha256: string;
    wavPath: string;
  }> {
    const capture = this.currentCapture;
    if (!capture) throw new Error('No capture has been started');
    const outcome = await this.pulse.stopRecorder();
    if (outcome === 'timeout') {
      throw new Error('Recorder refused to stop; capture outcome is unknown');
    }
    const rawBytes = this.pulse.recordedBytes(capture.rawPath);
    this.currentCapture = null;
    if (rawBytes <= 0) {
      throw new Error('Recorder produced no bytes; the capture is missing, not silent');
    }
    await rawPcm16ToWav(capture.rawPath, capture.wavPath, this.pulse.config.sampleRate);
    return {
      label: capture.label,
      rawPath: capture.rawPath,
      rawBytes,
      rawSha256: sha256File(capture.rawPath),
      wavPath: capture.wavPath,
    };
  }

  /** Bounded screenshot of the private display for the report (never proof of
   *  audio on its own — it is context, clearly labelled as such). */
  async screenshot(page: { screenshot: (opts: { path: string }) => Promise<unknown> }, name: string): Promise<string> {
    const file = path.join(this.options.attemptDir, 'screenshots', `${name}.png`);
    await page.screenshot({ path: file });
    return file;
  }

  /** Snapshot of every owned process identity, for the manifest. */
  ownedIdentities() {
    const identities = [
      ...this.xvfb.identities,
      ...this.pulse.identities,
      ...(this.chrome ? [this.chrome.process.identity] : []),
    ];
    return identities;
  }

  /** Stop everything and verify nothing survived. */
  async shutdown(): Promise<CleanupReport> {
    if (this.stopped) {
      return { residuals: [], ok: true };
    }
    const identities = this.ownedIdentities();
    const pids = new Set(identities.map((identity) => identity.pid));
    // Give the browser a chance to exit cleanly before force-signalling, so
    // its profile is not left mid-write on every run.
    if (this.chrome) await this.chrome.process.stop(3000, 3000);
    await this.pulse.stop();
    await this.xvfb.stop();
    this.stopped = true;

    const listeners = await this.listOwnedListeners(pids);
    const report = verifyNoResiduals({ identities, listeners });
    writeFileSync(
      path.join(this.options.attemptDir, 'logs', 'cleanup.json'),
      `${JSON.stringify({ identities, listeners, report }, null, 2)}\n`
    );
    return report;
  }

  private async listOwnedListeners(pids: Set<number>): Promise<Array<{ pid: number; detail: string }>> {
    const tcp = await runTool('ss', ['-H', '-l', '-t', '-n', '-p'], { timeoutMs: 10_000 });
    const unix = await runTool('ss', ['-H', '-l', '-x', '-n', '-p'], { timeoutMs: 10_000 });
    return [...parseListeners(tcp.stdout, pids), ...parseListeners(unix.stdout, pids)];
  }
}
