#!/usr/bin/env -S npx tsx
/**
 * Wave 1 gate: prove the real capture chain, and prove it can fail.
 *
 * Renders a tone with a REAL installed Chrome through the browser's own Web
 * Audio API into the capsule's private null sink, and records the sink monitor
 * with an independent `parec` process. Then renders NOTHING and requires the
 * same measurement to report no energy, so a passing smoke cannot be a
 * detector that always says yes.
 *
 * Usage:
 *   npx tsx scripts/audio-lab/smoke-capsule.ts [--root <dir>] [--keep]
 */

import path from 'node:path';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AudioLabCapsule } from './lib/capsule.js';
import { createRunLayout, nextAttempt } from './lib/layout.js';
import { probeAudio, decodeToMonoF32 } from './lib/audio-io.js';
import { rms, peak, estimateFundamental } from './lib/dsp.js';

/** Minimal structural type for the lab harness API exposed on the page. */
interface AudioLabWindow {
  __audioLab: {
    arm(): Promise<{ state: string; sampleRate: number }>;
    playTone(
      hz: number,
      durationMs: number,
      amplitude?: number
    ): { startedAt: number; contextState: string; sampleRate: number };
    playBytes(
      base64: string,
      playbackRate?: number
    ): Promise<{ durationSeconds: number; sampleRate: number; channels: number }>;
    stopAll(): boolean;
    setGain(value: number): number;
    state(): { contextState: string; sampleRate: number; activeCount: number };
    events(): Array<Record<string, unknown>>;
  };
}


interface ToneResult {
  label: string;
  wavPath: string;
  seconds: number;
  peak: number;
  rmsDb: number;
  /** Peak inside the window where the tone was expected. */
  windowPeak: number;
  /** Dominant frequency of the captured audio, or 0 if not periodic. */
  fundamentalHz: number;
  verdict: 'passed' | 'failed' | 'indeterminate';
  detail: string;
}

/** Host monotonic milliseconds. Correlating the capture timeline with the
 *  browser's own `performance.now()` is what lets the report say WHERE in the
 *  recording an event landed, instead of merely asserting it happened. */
function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1000000n);
}

const DEFAULT_ROOT = '/root/.pi-web-ui/operations/audio-lab-20260914/implementation/evidence';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function connectChrome(port: number) {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

/** Copy the lab-only harness page into the attempt directory and return its
 *  file URL. Serving it from the attempt directory means the exact bytes that
 *  ran are retained as evidence alongside the audio they produced.
 *
 *  `page.setContent` is NOT usable here: Chrome 152 enforces Trusted Types on
 *  the synthetic document and rejects Playwright's `document.write` with
 *  "This document requires 'TrustedHTML' assignment". A real file avoids
 *  injecting markup into a document the browser is trying to police. */
function stageHarness(attemptDir: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const target = path.join(attemptDir, 'harness');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ['harness.html', 'harness.js']) {
    copyFileSync(path.join(here, 'browser', name), path.join(target, name));
  }
  return `file://${path.join(target, 'harness.html')}`;
}

async function main(): Promise<number> {
  const root = arg('root') ?? DEFAULT_ROOT;
  const runId = arg('run-id') ?? `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const attempt = nextAttempt(root, runId);
  const layout = createRunLayout(root, runId, attempt);
  console.log(`[smoke] run ${runId} attempt ${attempt} -> ${layout.attemptDir}`);

  const capsule = new AudioLabCapsule({ attemptDir: layout.attemptDir });
  const results: ToneResult[] = [];
  let exitCode = 0;
  let cleanup: unknown = null;

  try {
    const calibration = await capsule.prepare();
    console.log(`[smoke] calibration: ${calibration.detail}`);
    if (!calibration.ok) {
      writeFileSync(
        path.join(layout.attemptDir, 'calibration.json'),
        `${JSON.stringify(calibration, null, 2)}\n`
      );
      throw new Error(`Calibration failed: ${calibration.detail}`);
    }

    const identity = await capsule.launchBrowser();
    console.log(`[smoke] chrome pid ${identity.pid} on ${capsule.identity?.display}`);
    const browser = await connectChrome(capsule.debugPort);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome exposed no browser context over CDP');
    const page = context.pages()[0] ?? (await context.newPage());
    await page.setViewportSize({ width: 1280, height: 800 });
    const harnessUrl = stageHarness(layout.attemptDir);
    await page.goto(harnessUrl, { waitUntil: 'load' });
    // Arm audio with a REAL click, then read back the context state. Autoplay
    // relaxation is deliberately not used: the lab must exercise the same
    // gesture requirement the product runs under, or it certifies a path
    // users do not actually have.
    await page.click('#arm');
    const armed = await page.evaluate(() =>
      (globalThis as unknown as AudioLabWindow).__audioLab.arm()
    );
    console.log(`[smoke] audio armed: ${JSON.stringify(armed)}`);

    // ---- negative control first: render nothing, expect no energy --------
    const negativeStart = monotonicMs();
    await capsule.beginMeasurementCapture('negative-control');
    await page.click('#silence');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const silent = await capsule.finishMeasurementCapture();
    const silentProbe = await probeAudio(silent.wavPath);
    const silentSamples = await decodeToMonoF32(silent.wavPath, 16000);
    const silentPeak = peak(silentSamples);
    results.push({
      label: 'negative-control-silence',
      wavPath: silent.wavPath,
      seconds: silentProbe.durationSec,
      peak: silentPeak,
      rmsDb: 20 * Math.log10(Math.max(rms(silentSamples), 1e-12)),
      windowPeak: silentPeak,
      fundamentalHz: 0,
      verdict: silentPeak < 0.01 ? 'passed' : 'failed',
      detail: `no playback was requested; peak ${silentPeak.toFixed(5)}`,
    });

    // ---- positive: real Chrome renders a real tone -----------------------
    await capsule.beginMeasurementCapture('chrome-tone');
    const captureStartMonotonicMs = monotonicMs();
    const toneInfo = await page.evaluate(() =>
      (globalThis as unknown as AudioLabWindow).__audioLab.playTone(660, 700, 0.6)
    );
    await new Promise((resolve) => setTimeout(resolve, 900));
    const captureStopMonotonicMs = monotonicMs();
    const captured = await capsule.finishMeasurementCapture();
    const probe = await probeAudio(captured.wavPath);
    const samples = await decodeToMonoF32(captured.wavPath, probe.sampleRate);
    const capturedPeak = peak(samples);
    // The dominant frequency is the real proof: energy alone cannot tell a
    // correct render from a resampled, duplicated or substituted one.
    const fundamental = estimateFundamental(samples, probe.sampleRate, 200, 2000);
    results.push({
      label: 'chrome-tone-660hz',
      wavPath: captured.wavPath,
      seconds: probe.durationSec,
      peak: capturedPeak,
      rmsDb: 20 * Math.log10(Math.max(rms(samples), 1e-12)),
      windowPeak: capturedPeak,
      fundamentalHz: fundamental.frequencyHz,
      verdict:
        capturedPeak > 0.05 && Math.abs(fundamental.frequencyHz - 660) <= 12 ? 'passed' : 'failed',
      detail: `real Chrome tone captured at peak ${capturedPeak.toFixed(4)}, dominant ${fundamental.frequencyHz.toFixed(1)} Hz (confidence ${fundamental.confidence.toFixed(2)})`,
    });

    const harnessEvents = await page.evaluate(() =>
      (globalThis as unknown as AudioLabWindow).__audioLab.events()
    );
    writeFileSync(
      path.join(layout.attemptDir, 'events', 'harness.json'),
      `${JSON.stringify(harnessEvents, null, 2)}\n`
    );
    // Timeline: host monotonic stamps around the capture, plus the browser's
    // own stamps. Recorded, not assumed.
    writeFileSync(
      path.join(layout.attemptDir, 'events', 'timeline.json'),
      `${JSON.stringify(
        {
          clock: 'host CLOCK_MONOTONIC (ms since arbitrary origin)',
          negativeControlStartMs: negativeStart,
          captureStartMs: captureStartMonotonicMs,
          captureStopMs: captureStopMonotonicMs,
          captureDurationMs: captureStopMonotonicMs - captureStartMonotonicMs,
          browserContextSampleRate: toneInfo.sampleRate,
          browserToneStartPerformanceMs: toneInfo.startedAt,
          sinkSampleRate: capsule.identity?.sampleRate ?? null,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      path.join(layout.attemptDir, 'browser-identity.json'),
      `${JSON.stringify({ ...capsule.capsuleIdentity, chromeArgs: capsule.chromeRun?.args ?? [] }, null, 2)}\n`
    );
    await capsule.screenshot(page, 'capsule-smoke');

    const failed = results.filter((entry) => entry.verdict !== 'passed');
    exitCode = failed.length === 0 ? 0 : 1;
    console.log(`[smoke] results: ${results.map((r) => `${r.label}=${r.verdict}`).join(', ')}`);
  } catch (error) {
    console.error(`[smoke] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 2;
  } finally {
    try {
      cleanup = await capsule.shutdown();
      const ok = (cleanup as { ok?: boolean }).ok === true;
      console.log(`[smoke] cleanup ok=${ok}: ${JSON.stringify((cleanup as { residuals?: unknown }).residuals ?? [])}`);
      if (!ok) exitCode = exitCode === 0 ? 2 : exitCode;
    } catch (error) {
      console.error(`[smoke] cleanup verification failed: ${String(error)}`);
      exitCode = 2;
    }
    writeFileSync(
      path.join(layout.attemptDir, 'smoke-result.json'),
      `${JSON.stringify({ runId, attempt, results, cleanup, exitCode, finishedAt: new Date().toISOString() }, null, 2)}\n`
    );
    mkdirSync(path.join(layout.runDir), { recursive: true });
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(2);
  });
