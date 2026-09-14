/**
 * External recording import.
 *
 * The operator's laptop is the only place the original defect was observed, so
 * the lab must be able to take a recording from there and analyse it with the
 * same oracle. The rules that keep this honest:
 *
 *   - The ORIGINAL is never modified. We validate it read-only and analyse a
 *     private copy inside the attempt directory.
 *   - With expected text and timing the comparison is a real measurement; the
 *     verdict can be passed or failed.
 *   - WITHOUT expected text or timing there is nothing to align against, so the
 *     attribution is reported as UNKNOWN. The lab does not invent alignment
 *     certainty it does not have, and a bare energy report is never dressed up
 *     as a speech verdict.
 *
 * Imported audio is private input: it stays on the host, is never uploaded, and
 * only bounded windows are copied into the attempt record.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertSafeLabRoot,
  createRunLayout,
  nextAttempt,
  sha256File,
} from './layout.js';
import { decodeToMonoF32, validateImport } from './audio-io.js';
import {
  DEFAULT_TOLERANCES,
  completenessAssertions,
  evaluate,
  measure,
  type Measurement,
  type SourceChunk,
} from './oracle.js';
import { buildFixtures, allFixtureSpecs, corpusHash, loadFixtureManifest } from './fixtures.js';
import { probeAudio } from './audio-io.js';

/** Upper bound on an imported file. A real laptop recording is tens of MB at
 *  most; anything far larger is a mistake or an attack, not evidence. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024;

export interface ImportOptions {
  root: string;
  inputPath: string;
  /** Expected text, split into the chunks that were spoken. */
  expectedText?: string;
  /** Optional "mm:ss.mmm,mm:ss.mmm;..." timing metadata for the chunks. */
  times?: string;
  label?: string;
  log?: (message: string) => void;
}

export interface ImportOutcome {
  verdict: 'passed' | 'failed' | 'indeterminate';
  reasons: string[];
  attemptDir: string;
  probe: Awaited<ReturnType<typeof validateImport>>;
  measurement: Measurement | null;
  attribution: 'measured' | 'unknown';
}

export interface TimingSpan {
  startMs: number;
  endMs: number;
}

/** Parse `start,end;start,end` timing metadata in seconds or mm:ss.mmm. */
export function parseTimes(spec: string): TimingSpan[] {
  const spans: TimingSpan[] = [];
  for (const part of spec.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [start, end] = trimmed.split(',').map((entry) => entry.trim());
    const parseOne = (value: string): number => {
      if (value.includes(':')) {
        const [minutes, rest] = value.split(':');
        return (Number.parseFloat(minutes) * 60 + Number.parseFloat(rest)) * 1000;
      }
      const numeric = Number.parseFloat(value);
      // Values under 1000 with a decimal are seconds; large integers are ms.
      return value.includes('.') || numeric < 1000 ? numeric * 1000 : numeric;
    };
    if (!start || !end) continue;
    spans.push({ startMs: parseOne(start), endMs: parseOne(end) });
  }
  return spans;
}

/** Split expected text the same way the product does, for alignment. */
export function splitExpectedText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.!?…])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function importExternalRecording(options: ImportOptions): Promise<ImportOutcome> {
  const log = options.log ?? (() => {});
  const root = assertSafeLabRoot(options.root);
  if (!existsSync(options.inputPath)) throw new Error(`Imported recording not found: ${options.inputPath}`);
  const originalHash = sha256File(options.inputPath);
  const sizeBytes = statSync(options.inputPath).size;
  const probe = await validateImport(options.inputPath, MAX_IMPORT_BYTES);
  log(
    `[import] ${path.basename(options.inputPath)}: ${probe.codec}, ${probe.sampleRate} Hz, ${probe.channels} ch, ${probe.durationSec.toFixed(2)} s, ${(sizeBytes / 1024).toFixed(0)} KiB, sha256 ${originalHash.slice(0, 16)}…`
  );

  const label = options.label ?? `import-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const attempt = nextAttempt(root, label);
  const layout = createRunLayout(root, label, attempt);
  mkdirSync(path.join(layout.attemptDir, 'import'), { recursive: true, mode: 0o700 });

  // Analyse a private COPY: the operator's original is never read after this
  // point and never modified.
  const copyPath = path.join(layout.attemptDir, 'import', `original-copy.${path.extname(options.inputPath).replace('.', '') || 'bin'}`);
  copyFileSync(options.inputPath, copyPath);
  const copyHash = sha256File(copyPath);

  writeFileSync(
    path.join(layout.attemptDir, 'import', 'provenance.json'),
    `${JSON.stringify(
      {
        originalPath: options.inputPath,
        originalSha256: originalHash,
        originalBytes: sizeBytes,
        copyPath: path.relative(layout.attemptDir, copyPath),
        copySha256: copyHash,
        probe,
        expectedTextProvided: Boolean(options.expectedText),
        timingProvided: Boolean(options.times),
        importedAt: new Date().toISOString(),
        privacyNote:
          'Original preserved read-only; analysis uses a private copy. Nothing is uploaded. Only bounded windows may be copied into clips.',
      },
      null,
      2
    )}\n`
  );

  const expectedChunks = options.expectedText ? splitExpectedText(options.expectedText) : [];
  const spans = options.times ? parseTimes(options.times) : [];

  if (expectedChunks.length === 0) {
    // No reference: report the observed facts and refuse to score speech.
    const samples = await decodeToMonoF32(copyPath, DEFAULT_TOLERANCES.analysisRate);
    let peakValue = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peakValue) peakValue = value;
    }
    const reasons = [
      'no expected text or timing metadata was supplied, so no speech alignment is possible; attribution is UNKNOWN',
      `observed: ${probe.durationSec.toFixed(2)} s of ${probe.codec}, peak ${(20 * Math.log10(Math.max(peakValue, 1e-12))).toFixed(1)} dBFS`,
    ];
    writeFileSync(
      path.join(layout.attemptDir, 'import', 'result.json'),
      `${JSON.stringify({ status: 'indeterminate', attribution: 'unknown', reasons, peak: peakValue }, null, 2)}\n`
    );
    return { verdict: 'indeterminate', reasons, attemptDir: layout.attemptDir, probe, measurement: null, attribution: 'unknown' };
  }

  // With text we need the reference audio for those chunks. Use the cached
  // corpus when the text matches it, otherwise the operator must supply the
  // per-chunk audio, which the lab cannot synthesise faithfully on their
  // behalf (a different voice would invalidate the comparison).
  const fixtures =
    loadFixtureManifest(root, corpusHash(allFixtureSpecs(), 'local', 'M1')) ??
    (await buildFixtures({ root, specs: allFixtureSpecs(), provider: 'local', log }));
  const byText = new Map(fixtures.chunks.map((chunk) => [chunk.text, chunk]));
  const missing = expectedChunks.filter((text) => !byText.has(text));
  if (missing.length > 0) {
    const reasons = [
      `${missing.length} expected chunk(s) have no matching reference audio in the corpus, so alignment cannot be attempted: ${missing
        .map((text) => JSON.stringify(text.slice(0, 40)))
        .join(', ')}`,
    ];
    writeFileSync(
      path.join(layout.attemptDir, 'import', 'result.json'),
      `${JSON.stringify({ status: 'indeterminate', attribution: 'unknown', reasons }, null, 2)}\n`
    );
    return { verdict: 'indeterminate', reasons, attemptDir: layout.attemptDir, probe, measurement: null, attribution: 'unknown' };
  }

  const source: SourceChunk[] = [];
  for (let index = 0; index < expectedChunks.length; index += 1) {
    const fixture = byText.get(expectedChunks[index]) as { mp3Path: string; sha256: string };
    source.push({
      id: `chunk-${String(index).padStart(2, '0')}`,
      text: expectedChunks[index],
      samples: await decodeToMonoF32(fixture.mp3Path, DEFAULT_TOLERANCES.analysisRate),
      encodedHash: fixture.sha256,
    });
  }

  let output = await decodeToMonoF32(copyPath, DEFAULT_TOLERANCES.analysisRate);
  if (spans.length > 0) {
    // Timing metadata narrows the analysed window, which is the difference
    // between "the words are in here somewhere" and "the words are HERE".
    const rate = DEFAULT_TOLERANCES.analysisRate;
    output = output.subarray(
      Math.max(0, Math.round((spans[0].startMs / 1000) * rate)),
      Math.min(output.length, Math.round((spans[spans.length - 1].endMs / 1000) * rate))
    );
  }

  const measurement = measure(source, output, DEFAULT_TOLERANCES.analysisRate, DEFAULT_TOLERANCES);
  const verdict = evaluate(measurement, (m) => completenessAssertions(m));
  writeFileSync(
    path.join(layout.attemptDir, 'import', 'result.json'),
    `${JSON.stringify(
      {
        status: verdict.status,
        attribution: 'measured',
        reasons: verdict.reasons,
        assertions: verdict.assertions,
        measurement,
        expectedChunks,
        timingSpans: spans,
      },
      null,
      2
    )}\n`
  );
  return {
    verdict: verdict.status,
    reasons: verdict.reasons,
    attemptDir: layout.attemptDir,
    probe,
    measurement,
    attribution: 'measured',
  };
}

export { probeAudio };
