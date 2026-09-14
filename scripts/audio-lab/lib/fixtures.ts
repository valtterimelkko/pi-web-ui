/**
 * The lab's speech fixture corpus.
 *
 * Fixtures are REAL MP3 speech — never tones and never marker wavs standing in
 * for words, because the whole point is to measure whether the operator's words
 * survive the render. Two providers exist:
 *
 *   `local`    Supertonic (CPU ONNX) synthesised speech, encoded to MP3 by
 *              FFmpeg. No credentials, no network, so a fresh checkout can run
 *              the routine loop unattended. This is DIAGNOSTIC speech.
 *   `endpoint` the real production TTS path (`POST /api/tts` on a disposable
 *              server, using the same OpenAI model the product uses). This is
 *              what the product actually asks the speakers to say, and is the
 *              provider used for the production-path fixture corpus.
 *
 * Whichever provider produced a corpus, the manifest records it, including the
 * bytes' SHA-256. The reports therefore say which provider was used and a
 * reader can tell development speech from production-path speech — the plan
 * requires that gate to be reported, not blurred.
 *
 * The corpus is cached outside Git (real audio never enters the repository) and
 * keyed by a corpus hash over the provider configuration AND the exact texts,
 * so a changed sentence can never reuse a stale recording.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runTool, wavToMp3, probeAudio } from './audio-io.js';
import { sha256Bytes, sha256File } from './layout.js';

export const FIXTURE_SCHEMA_VERSION = 1;

export type FixtureProvider = 'local' | 'endpoint';

export interface FixtureChunkSpec {
  id: string;
  text: string;
}

export interface FixtureEntry extends FixtureChunkSpec {
  mp3Path: string;
  sha256: string;
  bytes: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  voice: string;
}

export interface FixtureManifest {
  schemaVersion: number;
  provider: FixtureProvider;
  voice: string;
  /** Production model name, or the local synthesizer identity. */
  model: string;
  corpusHash: string;
  createdAt: string;
  chunks: FixtureEntry[];
  /** True when the bytes came from the real production `/api/tts` path. */
  productionTtsPath: boolean;
}

/**
 * Diagnostic sentences. Deliberately ordinary, non-sensitive, and chosen so
 * that: openings and endings are distinct (so head/tail loss is attributable
 * to a specific chunk), pairs are easy to tell apart by ear, and one pair
 * repeats verbatim to exercise duplicate/repeat handling.
 */
export const DIAGNOSTIC_CORPUS: string[][] = [
  // Set A — the standard ordered read (used by most scenarios).
  [
    'Amber lanterns hang above the quiet harbour.',
    'Bright kettles whistle on the iron stove.',
    'Cedar shavings drift across the workshop floor.',
    'Distant thunder rolls beyond the western ridge.',
    'Elderberry cordial cools beside the open window.',
    'Frost gathers slowly on the garden gate.',
    'Gilded letters fade along the library shelf.',
    'Hazel branches tap against the attic glass.',
    'Ivory keys rest beneath a folded letter.',
    'Juniper smoke curls through the orchard wall.',
  ],
  // Set B — a short read with a verbatim repeat, for repeat/dedup scenarios.
  ['Notice this sentence carefully.', 'Notice this sentence carefully.', 'Then the reading stops here.'],
  // Set C — for pause/stop boundary work: distinct, evenly sized sentences.
  [
    'First the kettle, then the cup.',
    'Second the letter, then the seal.',
    'Third the window, then the rain.',
    'Fourth the lantern, then the dark.',
  ],
];

export function corpusHash(specs: FixtureChunkSpec[], provider: FixtureProvider, voice: string): string {
  const payload = JSON.stringify({
    schema: FIXTURE_SCHEMA_VERSION,
    provider,
    voice,
    texts: specs.map((spec) => [spec.id, spec.text]),
  });
  return sha256Bytes(Buffer.from(payload, 'utf8'));
}

export function allFixtureSpecs(corpusIndex?: number): FixtureChunkSpec[] {
  const selected = corpusIndex === undefined ? DIAGNOSTIC_CORPUS : [DIAGNOSTIC_CORPUS[corpusIndex]];
  const specs: FixtureChunkSpec[] = [];
  selected.forEach((texts, setIndex) => {
    texts.forEach((text, index) => {
      specs.push({ id: `s${setIndex}c${String(index).padStart(2, '0')}`, text });
    });
  });
  return specs;
}

export function fixtureDir(root: string, hash: string): string {
  return path.join(root, 'fixtures', hash);
}

export function manifestPath(root: string, hash: string): string {
  return path.join(fixtureDir(root, hash), 'manifest.json');
}

export function loadFixtureManifest(root: string, hash: string): FixtureManifest | null {
  const file = manifestPath(root, hash);
  if (!existsSync(file)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as FixtureManifest;
    if (manifest.schemaVersion !== FIXTURE_SCHEMA_VERSION) return null;
    if (manifest.corpusHash !== hash) return null;
    return manifest;
  } catch {
    return null;
  }
}

/** Verify every cached fixture still matches its recorded hash and is intact. */
export function verifyFixtureManifest(manifest: FixtureManifest): string[] {
  const problems: string[] = [];
  for (const chunk of manifest.chunks) {
    if (!existsSync(chunk.mp3Path)) {
      problems.push(`missing file for ${chunk.id}: ${chunk.mp3Path}`);
      continue;
    }
    const actual = sha256File(chunk.mp3Path);
    if (actual !== chunk.sha256) {
      problems.push(`hash mismatch for ${chunk.id}: expected ${chunk.sha256}, got ${actual}`);
    }
  }
  return problems;
}

export interface BuildFixturesOptions {
  root: string;
  specs: FixtureChunkSpec[];
  provider: FixtureProvider;
  voice?: string;
  /** Required for the `endpoint` provider: a logged-in disposable server. */
  endpoint?: {
    baseUrl: string;
    password: string;
  };
  /** Force a rebuild even if a valid cache exists. */
  force?: boolean;
  log?: (message: string) => void;
}

export async function buildFixtures(options: BuildFixturesOptions): Promise<FixtureManifest> {
  const voice = options.voice ?? 'M1';
  const hash = corpusHash(options.specs, options.provider, voice);
  const dir = fixtureDir(options.root, hash);
  const log = options.log ?? (() => {});

  if (!options.force) {
    const cached = loadFixtureManifest(options.root, hash);
    if (cached) {
      const problems = verifyFixtureManifest(cached);
      if (problems.length === 0) {
        log(`fixtures: reusing verified cache ${hash} (${cached.chunks.length} chunks, ${cached.provider})`);
        return cached;
      }
      log(`fixtures: cached corpus ${hash} is damaged, rebuilding (${problems.join('; ')})`);
    }
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rawDir = path.join(dir, 'raw');
  mkdirSync(rawDir, { recursive: true, mode: 0o700 });

  if (options.provider === 'local') {
    await synthesiseLocal(options.specs, rawDir, voice, dir, log);
  } else {
    if (!options.endpoint) throw new Error('The endpoint provider requires a logged-in server');
    await fetchFromEndpoint(options.specs, dir, voice, options.endpoint, log);
  }

  const chunks: FixtureEntry[] = [];
  for (const spec of options.specs) {
    const mp3Path = path.join(dir, `${spec.id}.mp3`);
    if (!existsSync(mp3Path)) throw new Error(`Fixture ${spec.id} produced no MP3`);
    const probe = await probeAudio(mp3Path);
    chunks.push({
      id: spec.id,
      text: spec.text,
      mp3Path,
      sha256: sha256File(mp3Path),
      bytes: readFileSync(mp3Path).byteLength,
      durationSec: probe.durationSec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      voice,
    });
  }

  const manifest: FixtureManifest = {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    provider: options.provider,
    voice,
    model: options.provider === 'local' ? 'supertonic-3' : 'tts-1',
    corpusHash: hash,
    createdAt: new Date().toISOString(),
    chunks,
    productionTtsPath: options.provider === 'endpoint',
  };
  writeFileSync(manifestPath(options.root, hash), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  log(
    `fixtures: built ${chunks.length} chunks via ${options.provider} (production path: ${manifest.productionTtsPath})`
  );
  return manifest;
}

/** Local CPU synthesis, then MP3 encode with the same encoder family the
 *  product's format uses. */
async function synthesiseLocal(
  specs: FixtureChunkSpec[],
  rawDir: string,
  voice: string,
  outDir: string,
  log: (message: string) => void
): Promise<void> {
  const jobPath = path.join(outDir, 'job.json');
  writeFileSync(
    jobPath,
    `${JSON.stringify(
      {
        voice,
        steps: 8,
        speed: 1.05,
        // Minimal inter-sentence silence: the lab must be able to distinguish
        // silence the SOURCE contains from silence the PLAYER inserted.
        silence: 0.05,
        model: 'supertonic-3',
        outDir: rawDir,
        texts: specs.map((spec) => ({ id: spec.id, text: spec.text })),
      },
      null,
      2
    )}\n`
  );
  const helper = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'tools', 'supertonic-batch.py');
  const result = await runTool('python3', [helper, jobPath], { timeoutMs: 1_800_000 });
  if (result.code !== 0) {
    throw new Error(`Local synthesis failed (exit ${result.code}): ${result.stderr.slice(-2000)}`);
  }
  log(`fixtures: local synthesis ${result.stdout.trim()}`);
  for (const spec of specs) {
    const wav = path.join(rawDir, `${spec.id}.wav`);
    if (!existsSync(wav)) throw new Error(`Local synthesis produced no wav for ${spec.id}`);
    await wavToMp3(wav, path.join(outDir, `${spec.id}.mp3`), '96k');
  }
}

/**
 * Fetch the fixture bytes from the real production `/api/tts` endpoint on a
 * disposable server, using the same cookie-auth the browser uses.
 *
 * This deliberately goes through HTTP rather than calling OpenAI directly:
 * the fixture then carries the product's own request shaping (model, voice,
 * format) and a transport path the lab has already exercised.
 */
async function fetchFromEndpoint(
  specs: FixtureChunkSpec[],
  outDir: string,
  voice: string,
  endpoint: { baseUrl: string; password: string },
  log: (message: string) => void
): Promise<void> {
  const loginResponse = await fetch(`${endpoint.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: endpoint.baseUrl },
    body: JSON.stringify({ password: endpoint.password }),
  });
  if (!loginResponse.ok) {
    throw new Error(`Login for fixture generation failed: HTTP ${loginResponse.status}`);
  }
  const cookie = loginResponse.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookie.map((entry) => entry.split(';')[0]).join('; ');
  if (!cookieHeader) throw new Error('Login returned no cookie; cannot fetch fixtures');

  for (const spec of specs) {
    const response = await fetch(`${endpoint.baseUrl}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, Origin: endpoint.baseUrl },
      body: JSON.stringify({ text: spec.text, voice }),
    });
    if (!response.ok) {
      throw new Error(`TTS fetch failed for ${spec.id}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error(`TTS returned zero bytes for ${spec.id}`);
    writeFileSync(path.join(outDir, `${spec.id}.mp3`), bytes, { mode: 0o600 });
  }
  log(`fixtures: fetched ${specs.length} chunks from the production TTS endpoint`);
}

export function readFixtureManifest(filePath: string): FixtureManifest {
  return JSON.parse(readFileSync(filePath, 'utf8')) as FixtureManifest;
}

export function listFixtureManifests(root: string): string[] {
  const dir = path.join(root, 'fixtures');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((entry) => path.join(dir, entry, 'manifest.json'))
    .filter((entry) => existsSync(entry));
}
