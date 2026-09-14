/**
 * Run manifest: the durable, immutable evidence contract (plan §3.4).
 *
 * One JSON document per attempt, frozen at finalisation. It records identity
 * (candidate commit, browser argv, tool versions), provenance (fixture provider
 * and per-chunk hashes), the frozen oracle tolerances, every scenario's verdict
 * with the assertions that produced it, the artifact hashes, and the teardown
 * disposition — so a reader can re-check the conclusion offline without the
 * lab, the browser or the network.
 *
 * It deliberately does NOT embed raw audio, cookies, transcripts or env dumps:
 * the media stays in the attempt directory beside the manifest, referenced by
 * hash.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_TOLERANCES } from './oracle.js';
import { computeScenarioDigest, type ScenarioDigest } from './digest.js';
import { MANIFEST_SCHEMA_VERSION, ORACLE_TOLERANCE_VERSION } from './version.js';
import { sha256Bytes, sha256File } from './layout.js';
import { runTool } from './audio-io.js';
import type { ScenarioResult } from './runner.js';

export interface ScenarioManifestEntry {
  id: string;
  title: string;
  required: boolean;
  status: ScenarioResult['status'];
  controlStatus: ScenarioResult['controlStatus'];
  assertions: ScenarioResult['assertions'];
  reasons: string[];
  /** Compact measurement summary; the full measurement lives beside it. */
  /** null when the scenario produced no measurement at all. */
  digest: ScenarioDigest | null;
  evidence: Record<string, unknown>;
  /** Fixture bytes the player actually received, by hash. */
  sources: Array<{ chunkId: string; text: string; encodedHash: string }>;
  artifacts: Array<{ role: string; relativePath: string; bytes: number; sha256: string | null }>;
}

export interface RunManifest {
  schemaVersion: number;
  labVersion: string;
  oracleToleranceVersion: number;
  runId: string;
  attempt: number;
  createdAt: string;
  candidate: {
    commit: string;
    dirty: boolean;
    dirtyFiles: string[];
    worktree: string;
  };
  environment: {
    os: string;
    kernel: string;
    node: string;
    chromeVersion: string;
    chromeArgs: string[];
    display: string | null;
    pulseSampleRate: number | null;
    mainSink: string | null;
    calibrationSink: string | null;
    ffmpeg: string;
    pulseaudio: string;
  };
  fixtures: {
    provider: string;
    voice: string;
    corpusHash: string;
    productionTtsPath: boolean;
    chunks: Array<{ id: string; text: string; sha256: string; durationSec: number }>;
  };
  oracleTolerances: typeof DEFAULT_TOLERANCES;
  scenarios: ScenarioManifestEntry[];
  summary: {
    required: number;
    passed: number;
    failed: number;
    indeterminate: number;
    notRun: number;
    exitCode: number;
  };
  cleanup: {
    ok: boolean;
    residuals: unknown;
  };
  method: {
    /** Explicitly documented limitations, so a green run is not over-read. */
    limitations: string[];
    captureChain: string;
  };
}

export interface WriteManifestOptions {
  attemptDir: string;
  runId: string;
  attempt: number;
  results: ScenarioResult[];
  capsuleIdentity: {
    display: string;
    chromeArgs: string[];
    sampleRate: number;
    mainSink: string;
    calibrationSink: string;
  } | null;
  cleanup: unknown;
  labVersion: string;
  fixturesProvider: string;
}

async function gitIdentityAsync(): Promise<RunManifest['candidate']> {
  const head = await runTool('git', ['rev-parse', 'HEAD'], { timeoutMs: 15_000 });
  const status = await runTool('git', ['status', '--porcelain'], { timeoutMs: 15_000 });
  const dirtyFiles = status.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // Generated lab scratch is not a candidate change; listing it would make
    // every manifest look dirty and hide a real uncommitted change.
    .filter((line) => !line.includes('.audio-lab-tmp') && !line.includes('lab-bundle'));
  return {
    commit: head.stdout.trim() || 'unknown',
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    worktree: process.cwd(),
  };
}

async function toolVersionsAsync(): Promise<{ ffmpeg: string; pulseaudio: string }> {
  const ffmpeg = await runTool('ffmpeg', ['-version'], { timeoutMs: 15_000 });
  const pulse = await runTool('pulseaudio', ['--version'], { timeoutMs: 15_000 });
  return {
    ffmpeg: ffmpeg.stdout.split('\n')[0]?.trim() ?? 'unknown',
    pulseaudio: pulse.stdout.trim() || pulse.stderr.trim() || 'unknown',
  };
}

function relative(attemptDir: string, filePath: string): string {
  return path.relative(attemptDir, filePath).split(path.sep).join('/');
}

function artifact(attemptDir: string, role: string, filePath: string | null): ScenarioManifestEntry['artifacts'][number] | null {
  if (!filePath || !existsSync(filePath)) return null;
  let bytes = 0;
  try {
    bytes = statSync(filePath).size;
  } catch {
    return null;
  }
  return { role, relativePath: relative(attemptDir, filePath), bytes, sha256: sha256File(filePath) };
}

export function writeManifest(options: WriteManifestOptions): string {
  const manifestPath = path.join(options.attemptDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    throw new Error(`Refusing to overwrite an immutable manifest: ${manifestPath}`);
  }
  const candidate = readGitSync();
  const tools = readToolsSync();

  const scenarios: ScenarioManifestEntry[] = options.results.map((result) => {
    const artifacts = [
      artifact(options.attemptDir, 'os-recording', result.capturePath),
      artifact(
        options.attemptDir,
        'os-recording-raw',
        result.capturePath ? result.capturePath.replace(/\.wav$/, '.raw') : null
      ),
      artifact(options.attemptDir, 'scenario-json', path.join(options.attemptDir, 'scenarios', `${result.id}.json`)),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return {
      id: result.id,
      title: result.title,
      required: result.required,
      status: result.status,
      controlStatus: result.controlStatus,
      assertions: result.assertions,
      reasons: result.reasons,
      digest: computeScenarioDigest(result.measurement),
      evidence: result.evidence,
      sources: (result.measurement?.chunks ?? []).map((chunk, index) => ({
        chunkId: chunk.id,
        text: (result.evidence.chunkTexts as string[] | undefined)?.[index] ?? '',
        encodedHash: '',
      })),
      artifacts,
    };
  });

  const required = scenarios.filter((entry) => entry.required);
  const passed = required.filter((entry) => entry.status === 'passed').length;
  const failed = required.filter((entry) => entry.status === 'failed').length;
  const indeterminate = required.filter((entry) => entry.status === 'indeterminate').length;
  const notRun = required.filter((entry) => entry.status === 'not_run').length;
  const exitCode = failed > 0 ? 1 : indeterminate > 0 || notRun > 0 ? 2 : 0;

  const fixturesChunks =
    (options.results[0]?.evidence.chunkTexts as string[] | undefined)?.map((text, index) => ({
      id: `chunk-${String(index).padStart(2, '0')}`,
      text,
      sha256: options.results[0]?.requests.find((request) => request.text === text)?.sha256 ?? '',
      durationSec: options.results[0]?.measurement?.chunks[index]?.durationMs
        ? (options.results[0].measurement.chunks[index].durationMs as number) / 1000
        : 0,
    })) ?? [];

  const manifest: RunManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    labVersion: options.labVersion,
    oracleToleranceVersion: ORACLE_TOLERANCE_VERSION,
    runId: options.runId,
    attempt: options.attempt,
    createdAt: new Date().toISOString(),
    candidate,
    environment: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      kernel: os.release(),
      node: process.version,
      chromeVersion: readChromeVersionSync(),
      chromeArgs: options.capsuleIdentity?.chromeArgs ?? [],
      display: options.capsuleIdentity?.display ?? null,
      pulseSampleRate: options.capsuleIdentity?.sampleRate ?? null,
      mainSink: options.capsuleIdentity?.mainSink ?? null,
      calibrationSink: options.capsuleIdentity?.calibrationSink ?? null,
      ffmpeg: tools.ffmpeg,
      pulseaudio: tools.pulseaudio,
    },
    fixtures: {
      provider: options.fixturesProvider,
      voice: (options.results[0]?.evidence.voice as string | undefined) ?? 'unknown',
      corpusHash: (options.results[0]?.evidence.corpusHash as string | undefined) ?? 'unknown',
      productionTtsPath: Boolean(options.results[0]?.evidence.productionTtsPath),
      chunks: fixturesChunks,
    },
    oracleTolerances: DEFAULT_TOLERANCES,
    scenarios,
    summary: {
      required: required.length,
      passed,
      failed,
      indeterminate,
      notRun,
      exitCode,
    },
    cleanup: {
      ok: (options.cleanup as { ok?: boolean } | null)?.ok === true,
      residuals: (options.cleanup as { residuals?: unknown } | null)?.residuals ?? null,
    },
    method: {
      limitations: [
        'The capture is the OS-rendered output of a dedicated virtual null sink, not a physical speaker. It cannot certify a headset, Bluetooth route, a different OS or a different browser build.',
        'Product-player-lane scenarios drive the real product read-aloud player and arbiter with lab-supplied text; they are not proof that the model chose those words.',
        'Microphone capture in the product lane uses a synthetic audio device; it exercises the browser capture machinery but is not microphone-hardware proof.',
        'A passing run means no measured head/tail loss, omission, duplication, reorder, unintended gap or gain loss ABOVE the frozen tolerances. It does not claim phoneme-level fidelity.',
      ],
      captureChain:
        'real Chrome (private Xvfb display) -> product AudioContext -> private PulseAudio null sink -> independent parec monitor -> raw PCM -> FFmpeg remux -> oracle',
    },
  };

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  // The manifest's own digest is written alongside, but NOT inside, the
  // manifest: a document cannot contain its own hash.
  writeFileSync(path.join(options.attemptDir, 'MANIFEST.sha256'), `${sha256File(manifestPath)}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(options.attemptDir, 'FINALISED'), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return manifestPath;
}

/** Git identity read synchronously (used from the sync manifest writer). */
function readGitSync(): RunManifest['candidate'] {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    const dirtyFiles = status
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.includes('.audio-lab-tmp') && !line.includes('lab-bundle'));
    return { commit, dirty: dirtyFiles.length > 0, dirtyFiles, worktree: process.cwd() };
  } catch {
    return { commit: 'unknown', dirty: false, dirtyFiles: [], worktree: process.cwd() };
  }
}

function readToolsSync(): { ffmpeg: string; pulseaudio: string } {
  const read = (command: string, args: string[]): string => {
    try {
      return execFileSync(command, args, { encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  };
  return {
    ffmpeg: read('ffmpeg', ['-version']).split('\n')[0] ?? 'unknown',
    pulseaudio: read('pulseaudio', ['--version']),
  };
}

function readChromeVersionSync(): string {
  try {
    return execFileSync('google-chrome', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function readManifest(attemptDir: string): RunManifest {
  return JSON.parse(readFileSync(path.join(attemptDir, 'manifest.json'), 'utf8')) as RunManifest;
}

export function manifestSha256(attemptDir: string): string {
  return readFileSync(path.join(attemptDir, 'MANIFEST.sha256'), 'utf8').trim();
}

export function digestOf(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value)));
}

export { gitIdentityAsync, toolVersionsAsync };
