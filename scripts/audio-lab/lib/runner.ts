/**
 * Scenario execution for the product-player lane.
 *
 * One attempt = one capsule + one real Chrome + one lab static server, with
 * each scenario recorded as its own capture (its own raw PCM and WAV), measured
 * against the exact fixture bytes the player received.
 *
 * Ordering matters and is deliberate: the recorder starts BEFORE the intent is
 * submitted (so leading silence is retained and a missing onset is visible),
 * and it stops only after the arbiter has settled. Every scenario also runs a
 * negative control pass first in its own capture, so a scenario can never pass
 * merely because the measurement chain is deaf.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AudioLabCapsule } from './capsule.js';
import {
  DEFAULT_TOLERANCES,
  evaluate,
  measure,
  type AssertionResult,
  type Measurement,
  type OracleTolerances,
  type SourceChunk,
  type Verdict,
} from './oracle.js';
import { decodeToMonoF32, probeAudio } from './audio-io.js';
import { resampleLinear } from './dsp.js';
import type { FixtureManifest } from './fixtures.js';
import { ProductLane, type TtsRequestRecord } from './product-lane.js';

export interface ScenarioContext {
  page: LabPage;
  lane: ProductLane;
  capsule: AudioLabCapsule;
  fixtures: FixtureManifest;
  log: (message: string) => void;
}

/** The subset of the Playwright page API the lab uses. Kept structural so the
 *  lab's own tests can exercise the runner without a browser. */
export interface LabPage {
  click(selector: string): Promise<void>;
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  bringToFront?(): Promise<void>;
  waitForTimeout?(ms: number): Promise<void>;
}

export interface ScenarioOutcome {
  assertions: (measurement: Measurement) => AssertionResult[];
  evidence?: Record<string, unknown>;
}

export interface Scenario {
  id: string;
  title: string;
  required: boolean;
  /** Corpus index this scenario reads from. */
  corpus: number;
  /**
   * Time-compression factor of the SOURCE before comparison.
   *
   * The speed lane renders at playbackRate 1.25, which shortens the audio by
   * 1.25x AND shifts its pitch. The oracle therefore has to compare against a
   * correspondingly compressed source, and uses envelope scoring (see
   * OracleTolerances.chunkScoring) because the pitch shift destroys waveform
   * correlation.
   */
  sourceTimeScale?: number;
  /** Override the oracle's candidate scoring for this scenario. */
  scoring?: 'waveform' | 'envelope';
  /** Drive the UI and capture. The returned assertions are run on the
   *  measurement of the scenario capture. */
  run: (context: ScenarioContext) => Promise<ScenarioOutcome>;
}

export interface ScenarioResult {
  id: string;
  title: string;
  required: boolean;
  status: 'passed' | 'failed' | 'indeterminate' | 'not_run';
  assertions: AssertionResult[];
  reasons: string[];
  measurement: Measurement | null;
  evidence: Record<string, unknown>;
  capturePath: string | null;
  controlStatus: 'passed' | 'failed' | 'indeterminate' | 'not_run';
  requests: TtsRequestRecord[];
}

export interface BuildSourceOptions {
  /** Chunk texts in intent order. */
  chunkTexts: string[];
  requests: TtsRequestRecord[];
  fixtures: FixtureManifest;
  analysisRate: number;
  /** Time-compress the source to match a non-1.0 playback rate. */
  sourceTimeScale?: number;
}

/**
 * Build the oracle's source chunks.
 *
 * The order is the INTENT's chunk order (what the arbiter scheduled), and the
 * bytes are the ones the player actually received for each chunk text. Using
 * intent order rather than request order matters: one-ahead prefetching issues
 * requests out of order, and a report that followed request order would
 * describe a sequence the listener never heard.
 */
export async function buildSourceChunks(options: BuildSourceOptions): Promise<SourceChunk[]> {
  const byText = new Map<string, { mp3Path: string; sha256: string }>();
  for (const chunk of options.fixtures.chunks) {
    byText.set(chunk.text, { mp3Path: chunk.mp3Path, sha256: chunk.sha256 });
  }
  const chunks: SourceChunk[] = [];
  for (let index = 0; index < options.chunkTexts.length; index += 1) {
    const text = options.chunkTexts[index];
    const fixture = byText.get(text);
    if (!fixture) throw new Error(`No fixture for chunk text: ${JSON.stringify(text)}`);
    const raw = await decodeToMonoF32(fixture.mp3Path, options.analysisRate);
    // resampleLinear(x, rate, rate/scale) yields a source of length
    // x.length/scale, i.e. compressed by `scale` — the same time base the
    // browser produces when it plays the buffer at that rate.
    const decoded =
      options.sourceTimeScale && options.sourceTimeScale !== 1
        ? resampleLinear(raw, options.analysisRate, options.analysisRate / options.sourceTimeScale)
        : raw;
    const request = options.requests.find((entry) => entry.text === text);
    chunks.push({
      id: `chunk-${String(index).padStart(2, '0')}`,
      text,
      samples: decoded,
      encodedHash: request?.sha256 ?? fixture.sha256,
    });
  }
  return chunks;
}

/**
 * Ask the REAL product chunker (running in the browser) how it splits a
 * message, and require it to agree with the chunk list the scenario assumes.
 *
 * The lab does not fork `chunkIntoSentences` into Node: a fork would drift and
 * the scenario would then be describing a sequence the product never plays.
 * Disagreement is a lab error and must fail loudly.
 */
export async function verifyChunking(
  page: LabPage,
  message: string,
  expected: string[]
): Promise<{ ok: boolean; actual: string[] }> {
  const actual = await page.evaluate((text: string) => {
    const api = (globalThis as unknown as { __labProduct?: { chunk(text: string): string[] } }).__labProduct;
    if (!api) throw new Error('lab page did not expose __labProduct');
    return api.chunk(text);
  }, message);
  const normalised = actual.map((entry) => entry.trim());
  const wanted = expected.map((entry) => entry.trim());
  return { ok: JSON.stringify(normalised) === JSON.stringify(wanted), actual: normalised };
}

export interface RunScenarioOptions {
  scenario: Scenario;
  capsule: AudioLabCapsule;
  lane: ProductLane;
  page: LabPage;
  fixtures: FixtureManifest;
  log: (message: string) => void;
  /** Capture window tail after the drive settles, ms. */
  settleMs?: number;
  tolerances?: OracleTolerances;
}

/** Run one scenario: negative control, drive, capture, measure, assert. */
export async function runScenario(options: RunScenarioOptions): Promise<ScenarioResult> {
  const { scenario, capsule, lane, page, fixtures, log } = options;
  const tolerances = options.tolerances ?? DEFAULT_TOLERANCES;
  const settleMs = options.settleMs ?? 1200;
  const controlLabel = `${scenario.id}-control`;
  const captureLabel = scenario.id;

  // ---- negative control in its OWN capture -------------------------------
  await capsule.beginMeasurementCapture(controlLabel);
  await page.evaluate(() => {
    const api = (globalThis as unknown as { __labProduct?: { idle(): void } }).__labProduct;
    api?.idle();
  });
  await new Promise((resolve) => setTimeout(resolve, controlMs(scenario)));
  const control = await capsule.finishMeasurementCapture();
  const controlSamples = await decodeToMonoF32(control.wavPath, tolerances.analysisRate);
  const controlPeak = peakOf(controlSamples);
  const controlStatus: ScenarioResult['controlStatus'] = controlPeak < 0.01 ? 'passed' : 'failed';

  // ---- scenario capture --------------------------------------------------
  await capsule.beginMeasurementCapture(captureLabel);
  let outcome: ScenarioOutcome;
  try {
    outcome = await scenario.run({ page, lane, capsule, fixtures, log });
  } catch (error) {
    // Stop the recorder so a mid-drive failure still yields the partial audio
    // that explains it, rather than an unflushed file.
    await capsule.finishMeasurementCapture().catch(() => undefined);
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const capture = await capsule.finishMeasurementCapture();

  const probe = await probeAudio(capture.wavPath);
  if (probe.sampleRate !== capsule.pulse.config.sampleRate) {
    return {
      id: scenario.id,
      title: scenario.title,
      required: scenario.required,
      status: 'indeterminate',
      assertions: [],
      reasons: [
        `recording sample rate ${probe.sampleRate} != sink rate ${capsule.pulse.config.sampleRate}`,
      ],
      measurement: null,
      evidence: { controlPeak, ...(outcome.evidence ?? {}) },
      capturePath: capture.wavPath,
      controlStatus,
      requests: lane.requests.slice(),
    };
  }

  const chunkTexts = (outcome.evidence?.chunkTexts as string[] | undefined) ?? [];
  const source = await buildSourceChunks({
    chunkTexts,
    requests: lane.requests,
    fixtures,
    analysisRate: tolerances.analysisRate,
    sourceTimeScale: scenario.sourceTimeScale,
  });
  const output = await decodeToMonoF32(capture.wavPath, tolerances.analysisRate);
  const effectiveTolerances: OracleTolerances =
    scenario.scoring && scenario.scoring !== tolerances.chunkScoring
      ? { ...tolerances, chunkScoring: scenario.scoring }
      : tolerances;
  const measurement = measure(source, output, tolerances.analysisRate, effectiveTolerances);
  // The PRODUCT's own speech diagnostics. Recorded alongside the audio so a
  // verdict can be read together with what the scheduler believed it was doing.
  const productTelemetry = await readProductTelemetry(page);
  const verdict: Verdict = evaluate(measurement, (m) => [
    ...(controlStatus === 'passed'
      ? []
      : [
          {
            id: 'control.negative-silence',
            ok: false,
            detail: `negative control captured energy (peak ${controlPeak.toFixed(4)}); the measurement chain is not trustworthy`,
          },
        ]),
    ...outcome.assertions(m),
  ]);

  return {
    id: scenario.id,
    title: scenario.title,
    required: scenario.required,
    status: verdict.status,
    assertions: verdict.assertions,
    reasons: verdict.reasons,
    measurement,
    evidence: {
      controlPeak,
      controlSeconds: controlSamples.length / tolerances.analysisRate,
      captureSeconds: probe.durationSec,
      captureSha256: capture.rawSha256,
      captureRawBytes: capture.rawBytes,
      productTelemetry,
      chunkScoring: effectiveTolerances.chunkScoring,
      sourceTimeScale: scenario.sourceTimeScale ?? 1,
      audibleMs: measurement.audibleMs,
      ...(outcome.evidence ?? {}),
    },
    capturePath: capture.wavPath,
    controlStatus,
    requests: lane.requests.slice(),
  };
}

/** Read the product's own speech diagnostics ring from the page, bounded. */
async function readProductTelemetry(page: LabPage): Promise<Array<Record<string, unknown>>> {
  try {
    return await page.evaluate(() => {
      const api = (
        globalThis as unknown as { __labProduct?: { productTelemetry?(): Array<Record<string, unknown>> } }
      ).__labProduct;
      return api?.productTelemetry?.() ?? [];
    });
  } catch {
    return [];
  }
}

function controlMs(scenario: Scenario): number {
  // The control must be long enough to catch a leak from a previous scenario
  // but short enough not to dominate a soak.
  return scenario.id === 'idle-resume' ? 1500 : 900;
}

function peakOf(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i]);
    if (value > max) max = value;
  }
  return max;
}

export interface ScenarioRunReport {
  scenarioId: string;
  status: ScenarioResult['status'];
  assertions: AssertionResult[];
  reasons: string[];
  measurement: Measurement | null;
  evidence: Record<string, unknown>;
  requests: TtsRequestRecord[];
  capturePath: string | null;
}

export function toReport(result: ScenarioResult): ScenarioRunReport {
  return {
    scenarioId: result.id,
    status: result.status,
    assertions: result.assertions,
    reasons: result.reasons,
    measurement: result.measurement,
    evidence: result.evidence,
    requests: result.requests,
    capturePath: result.capturePath,
  };
}

/** Write the per-scenario JSON next to its capture. */
export function writeScenarioResult(attemptDir: string, result: ScenarioResult): string {
  const dir = path.join(attemptDir, 'scenarios');
  const file = path.join(dir, `${result.id}.json`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(toReport(result), null, 2)}\n`);
  return file;
}
