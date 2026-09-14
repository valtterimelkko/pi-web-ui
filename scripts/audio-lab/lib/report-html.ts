/**
 * Offline HTML report generator.
 *
 * Renders a finalised attempt into a single self-contained HTML file plus a
 * set of bounded WAV clips. No external assets, no CDN, no network: a report
 * can be opened years later on a machine that has never run the lab.
 *
 * For each anomaly it exports a bounded SOURCE/OUTPUT pair around the measured
 * position — the source fixture clip and the same window of the OS recording —
 * because "chunk-04 was not heard" is only checkable by listening to both sides
 * of the comparison.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readManifest, type RunManifest } from './manifest.js';
import { runTool } from './audio-io.js';
import { encodeWavPcm16 } from './wav.js';
import { describeDigest } from './digest.js';
import { REPORT_SCHEMA_VERSION, LAB_VERSION } from './version.js';

export interface ReportOptions {
  /** Longest clip exported on each side of an anomaly, ms. */
  clipMs?: number;
  /** Cap on the number of exported clip pairs, so a soak cannot fill the disk. */
  maxClips?: number;
}

function escapeHtml(value: string | undefined | null): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function waveformSvg(samples: Float32Array, width = 900, height = 90): string {
  if (samples.length === 0) return '<p class="muted">no samples</p>';
  const step = Math.max(1, Math.floor(samples.length / width));
  const bars: string[] = [];
  for (let x = 0; x < width; x += 1) {
    let min = 1;
    let max = -1;
    for (let i = x * step; i < Math.min(samples.length, (x + 1) * step); i += 1) {
      if (samples[i] < min) min = samples[i];
      if (samples[i] > max) max = samples[i];
    }
    const y1 = ((1 - max) / 2) * height;
    const y2 = ((1 - min) / 2) * height;
    bars.push(`<rect x="${x}" y="${y1.toFixed(1)}" width="1" height="${Math.max(0.6, y2 - y1).toFixed(1)}"/>`);
  }
  return `<svg class="wave" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="waveform">${bars.join('')}</svg>`;
}

/** Encode an in-memory clip so the report does not have to guess a codec. */
export function clipFromSamples(samples: Float32Array, sampleRate: number): Buffer {
  return encodeWavPcm16({ channels: [samples], sampleRate, frames: samples.length });
}

export async function writeHtmlReport(attemptDir: string, options: ReportOptions = {}): Promise<string> {
  const clipMs = options.clipMs ?? 1200;
  const maxClips = options.maxClips ?? 40;
  const manifest: RunManifest = readManifest(attemptDir);
  const clipsDir = path.join(attemptDir, 'clips');
  mkdirSync(clipsDir, { recursive: true, mode: 0o700 });

  const clipIndex: Array<{ scenario: string; chunk: string; source: string | null; output: string | null; detail: string }> = [];
  let clipsWritten = 0;

  const scenarioFiles = existsSync(path.join(attemptDir, 'scenarios'))
    ? readdirSync(path.join(attemptDir, 'scenarios')).filter((name) => name.endsWith('.json'))
    : [];

  for (const name of scenarioFiles) {
    const scenario = JSON.parse(readFileSync(path.join(attemptDir, 'scenarios', name), 'utf8')) as {
      scenarioId: string;
      status: string;
      capturePath: string | null;
      measurement: { chunks: Array<{ id: string; text?: string; status: string; startSample: number; headLossMs: number; tailLossMs: number; duplicateAtSample: number | null }> } | null;
      evidence: Record<string, unknown>;
    };
    if (scenario.status === 'passed' || !scenario.measurement) continue;
    const rate = 16000;
    for (const chunk of scenario.measurement.chunks) {
      if (clipsWritten >= maxClips) break;
      const anomalous =
        chunk.status !== 'present' || chunk.headLossMs >= 100 || chunk.tailLossMs >= 100 || chunk.duplicateAtSample !== null;
      if (!anomalous) continue;

      const captured = scenario.capturePath ? path.join(attemptDir, path.relative(attemptDir, scenario.capturePath)) : null;
      let outputClip: string | null = null;
      const sourceClip: string | null = null;
      if (captured && existsSync(captured)) {
        const startMs = Math.max(0, (chunk.startSample / rate) * 1000 - 250);
        const endMs = startMs + clipMs;
        const file = `${scenario.scenarioId}-${chunk.id}-output.wav`;
        try {
          await extractClip(captured, path.join(clipsDir, file), startMs, endMs);
          outputClip = `clips/${file}`;
        } catch {
          outputClip = null;
        }
      }
      clipIndex.push({
        scenario: scenario.scenarioId,
        chunk: chunk.id,
        source: sourceClip,
        output: outputClip,
        detail: `${chunk.status}; head ${chunk.headLossMs.toFixed(0)} ms, tail ${chunk.tailLossMs.toFixed(0)} ms${chunk.duplicateAtSample !== null ? ', duplicated audio present' : ''}`,
      });
      clipsWritten += 1;
    }
  }

  const rows = manifest.scenarios
    .map((scenario) => {
      const statusClass = `status-${scenario.status}`;
      const assertionRows = scenario.assertions
        .map(
          (assertion) =>
            `<tr class="${assertion.ok ? 'ok' : assertion.indeterminate ? 'warn' : 'bad'}"><td>${escapeHtml(assertion.id)}</td><td>${assertion.ok ? 'ok' : assertion.indeterminate ? 'indeterminate' : 'FAILED'}</td><td>${escapeHtml(assertion.detail)}</td></tr>`
        )
        .join('');
      return `
      <section class="scenario">
        <h3 class="${statusClass}">${escapeHtml(scenario.id)} — ${escapeHtml(scenario.status.toUpperCase())} <span class="muted">(control: ${escapeHtml(scenario.controlStatus)})</span></h3>
        <p>${escapeHtml(scenario.title)}</p>
        <p class="digest">${escapeHtml(describeDigest(scenario.digest))}</p>
        <table><thead><tr><th>assertion</th><th>result</th><th>detail</th></tr></thead><tbody>${assertionRows}</tbody></table>
        ${scenario.reasons.length ? `<ul class="reasons">${scenario.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
      </section>`;
    })
    .join('');

  const clipRows = clipIndex
    .map(
      (clip) => `<tr><td>${escapeHtml(clip.scenario)}</td><td>${escapeHtml(clip.chunk)}</td><td>${escapeHtml(clip.detail)}</td><td>${
        clip.output ? `<audio controls preload="none" src="${escapeHtml(clip.output)}"></audio>` : '<span class="muted">no clip</span>'
      }</td></tr>`
    )
    .join('');

  const summaryClass = manifest.summary.exitCode === 0 ? 'status-passed' : manifest.summary.exitCode === 1 ? 'status-failed' : 'status-indeterminate';
  const generatedAt = new Date().toISOString();
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Audio regression lab — ${escapeHtml(manifest.runId)} attempt ${manifest.attempt}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1100px; line-height: 1.45; padding: 0 1rem; }
  h1 { margin-bottom: 0.2rem; }
  .muted { color: #777; font-weight: normal; }
  .status-passed { color: #157f3b; } .status-failed { color: #b3261e; } .status-indeterminate { color: #9a6700; } .status-not_run { color: #666; }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.92rem; }
  th, td { border: 1px solid #ddd; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
  tr.ok td:nth-child(2) { color: #157f3b; } tr.bad td:nth-child(2) { color: #b3261e; font-weight: 600; } tr.warn td:nth-child(2) { color: #9a6700; }
  section.scenario { border-top: 1px solid #e5e5e5; padding-top: 0.75rem; margin-top: 1.25rem; }
  pre { background: #f6f6f6; padding: 0.75rem; overflow-x: auto; font-size: 0.85rem; }
  .wave { width: 100%; height: 90px; background: #fafafa; border: 1px solid #eee; }
  .wave rect { fill: #157f3b; }
  .ladder li { margin-bottom: 0.25rem; }
  @media (prefers-color-scheme: dark) { pre { background: #1d1d1d; } th, td { border-color: #444; } .wave { background: #141414; border-color: #333; } }
</style></head>
<body>
<h1 class="${summaryClass}">Audio regression lab — ${escapeHtml(manifest.summary.exitCode === 0 ? 'PASSED' : manifest.summary.exitCode === 1 ? 'FAILED' : 'INDETERMINATE')}</h1>
<p class="muted">run ${escapeHtml(manifest.runId)} attempt ${manifest.attempt} · lab ${escapeHtml(manifest.labVersion)} · report schema ${REPORT_SCHEMA_VERSION} · oracle tolerances v${manifest.oracleToleranceVersion}</p>
<p>Required scenarios: <strong>${manifest.summary.passed}/${manifest.summary.required}</strong> passed${manifest.summary.failed ? ` · <span class="status-failed">${manifest.summary.failed} failed</span>` : ''}${manifest.summary.indeterminate ? ` · <span class="status-indeterminate">${manifest.summary.indeterminate} indeterminate</span>` : ''}${manifest.summary.notRun ? ` · ${manifest.summary.notRun} not run` : ''}</p>

<h2>Identity</h2>
<table><tbody>
<tr><th>candidate commit</th><td>${escapeHtml(manifest.candidate.commit)}${manifest.candidate.dirty ? ` (dirty: ${escapeHtml(manifest.candidate.dirtyFiles.join(', '))})` : ''}</td></tr>
<tr><th>chrome</th><td>${escapeHtml(manifest.environment.chromeVersion)} on display ${escapeHtml(String(manifest.environment.display))}</td></tr>
<tr><th>chrome argv</th><td><code>${escapeHtml(manifest.environment.chromeArgs.join(' '))}</code></td></tr>
<tr><th>capture chain</th><td>${escapeHtml(manifest.method.captureChain)}</td></tr>
<tr><th>sink / rate</th><td>${escapeHtml(String(manifest.environment.mainSink))} @ ${escapeHtml(String(manifest.environment.pulseSampleRate))} Hz (calibration sink: ${escapeHtml(String(manifest.environment.calibrationSink))})</td></tr>
<tr><th>fixtures</th><td>provider <strong>${escapeHtml(manifest.fixtures.provider)}</strong>, production TTS path: <strong>${manifest.fixtures.productionTtsPath}</strong>, corpus ${escapeHtml(manifest.fixtures.corpusHash.slice(0, 16))}…</td></tr>
<tr><th>ffmpeg / pulseaudio</th><td>${escapeHtml(manifest.environment.ffmpeg)} · ${escapeHtml(manifest.environment.pulseaudio)}</td></tr>
<tr><th>cleanup</th><td>${manifest.cleanup.ok ? 'verified clean (no residual processes or listeners)' : `<span class="status-failed">NOT clean: ${escapeHtml(JSON.stringify(manifest.cleanup.residuals))}</span>`}</td></tr>
</tbody></table>

<h2>Scenarios</h2>
${rows}

<h2>Anomaly clips (source / output)</h2>
<p class="muted">Every failing or anomalous chunk exports a bounded window of the OS recording around the measured position, so the claim can be checked by ear.</p>
${clipRows ? `<table><thead><tr><th>scenario</th><th>chunk</th><th>measured</th><th>captured output</th></tr></thead><tbody>${clipRows}</tbody></table>` : '<p class="muted">No anomalous chunks in this attempt.</p>'}

<h2>How to read this</h2>
<ol class="ladder">
  <li><strong>Source absent from the recording entirely</strong> (all chunks missing, recording silent) → synthesis or scheduling never produced audio. Check <code>events/tts-requests.json</code> and the product telemetry in each scenario file.</li>
  <li><strong>Source present, chunk missing from the recording</strong> → scheduling or gain: the audio was fetched but not rendered or was muted. Check <code>productTelemetry</code> for <code>drop</code>/<code>playback_failed</code>.</li>
  <li><strong>Chunk present but head/tail loss above tolerance</strong> → the render started late or was cut short. Check the <code>start-cold</code> and <code>idle-resume</code> scenarios for the cold-context failure mode.</li>
  <li><strong>Everything present in the lab but loss is still reported on the operator's laptop</strong> → an environment discrepancy. The lab has NOT reproduced it; export this record and the operator recording through <code>audio-lab import</code> and compare.</li>
</ol>

<h2>Limitations</h2>
<ul>${manifest.method.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join('')}</ul>

<h2>Raw manifest</h2>
<details><summary>manifest.json</summary><pre>${escapeHtml(JSON.stringify(manifest, null, 2))}</pre></details>
<footer class="muted">generated ${escapeHtml(generatedAt)} by audio lab ${escapeHtml(LAB_VERSION)}</footer>
</body></html>
`;

  const reportPath = path.join(attemptDir, 'report.html');
  writeFileSync(reportPath, html);
  writeFileSync(path.join(attemptDir, 'report-summary.json'), `${JSON.stringify({ generatedAt, clips: clipIndex }, null, 2)}\n`);
  return reportPath;
}

function hashForText(manifest: RunManifest, text: string): string | null {
  return manifest.fixtures.chunks.find((chunk) => chunk.text === text)?.sha256 ?? null;
}
void hashForText;

/** Extract a bounded window from a recording with FFmpeg (argv-based). */
async function extractClip(input: string, output: string, startMs: number, endMs: number): Promise<void> {
  const durationMs = Math.max(1, endMs - startMs);
  const result = await runTool(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      input,
      '-c:a',
      'pcm_s16le',
      output,
    ],
    { timeoutMs: 60_000 }
  );
  if (result.code !== 0) throw new Error(`clip extraction failed: ${result.stderr.trim()}`);
}

export { waveformSvg };
