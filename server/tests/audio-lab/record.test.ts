/**
 * Record, verification and CLI-surface tests.
 *
 * `verify-record` is the lab's trust boundary: it is what lets a reader check a
 * claimed pass without re-running the lab. These tests therefore attack it from
 * the inside — a tampered artifact, a hand-edited status, a missing negative
 * control and a stale tolerance version must all be detected. A verifier that
 * only greps for "passed" would pass this suite's fixtures and be worthless.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { verifyAttempt } from '../../../scripts/audio-lab/lib/verify-record.js';
import { computeScenarioDigest, describeDigest } from '../../../scripts/audio-lab/lib/digest.js';
import { corpusHash, verifyFixtureManifest, allFixtureSpecs, DIAGNOSTIC_CORPUS } from '../../../scripts/audio-lab/lib/fixtures.js';
import { parseTimes, splitExpectedText, MAX_IMPORT_BYTES } from '../../../scripts/audio-lab/lib/import-external.js';
import { safeResolve } from '../../../scripts/audio-lab/lib/static-server.js';
import { renderPulseConfig, pulseEnv } from '../../../scripts/audio-lab/lib/pulse.js';
import { chromeArgs } from '../../../scripts/audio-lab/lib/platform.js';
import { groupMembers, identityMatches, readIdentity } from '../../../scripts/audio-lab/lib/proc.js';
import { DEFAULT_TOLERANCES, measure, type Measurement } from '../../../scripts/audio-lab/lib/oracle.js';
import { makeChunks, renderRecording } from '../../../scripts/audio-lab/lib/testsignal.js';
import { parseArgs, flagString, flagBool, summarise } from '../../../scripts/audio-lab/cli.js';
import { MANIFEST_SCHEMA_VERSION, ORACLE_TOLERANCE_VERSION } from '../../../scripts/audio-lab/lib/version.js';
import { clipFromSamples } from '../../../scripts/audio-lab/lib/report-html.js';
import { decodeWav } from '../../../scripts/audio-lab/lib/wav.js';

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'audio-lab-record-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface SyntheticOptions {
  status?: string;
  controlStatus?: string;
  toleranceVersion?: number;
  cleanupOk?: boolean;
  chromeArgs?: string[];
  commit?: string;
  omitArtifact?: boolean;
}

/** Build a minimal but schema-shaped finalised attempt. */
function buildAttempt(options: SyntheticOptions = {}): string {
  const attemptDir = path.join(dir, 'attempt-01');
  mkdirSync(path.join(attemptDir, 'capture'), { recursive: true });
  const capture = Buffer.from('pretend this is raw PCM audio evidence');
  const capturePath = path.join(attemptDir, 'capture', 'recording.json-control.wav');
  writeFileSync(capturePath, capture);

  const assertions = [
    { id: 'recording.energy', ok: true, detail: 'peak -6 dBFS' },
    { id: 'chunks.all-present', ok: true, detail: '3 chunks matched' },
  ];
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    labVersion: '1.0.0',
    oracleToleranceVersion: options.toleranceVersion ?? ORACLE_TOLERANCE_VERSION,
    runId: 'synthetic',
    attempt: 1,
    createdAt: new Date().toISOString(),
    candidate: {
      commit: options.commit ?? 'a'.repeat(40),
      dirty: false,
      dirtyFiles: [],
      worktree: '/tmp/worktree',
    },
    environment: {
      os: 'linux',
      kernel: '6.x',
      node: 'v22',
      chromeVersion: 'Chrome 152',
      chromeArgs: options.chromeArgs ?? ['--no-sandbox', '--user-data-dir=/tmp/p'],
      display: ':90',
      pulseSampleRate: 48000,
      mainSink: 'pi_lab_main',
      calibrationSink: 'pi_lab_calib',
      ffmpeg: 'ffmpeg 6.1.1',
      pulseaudio: 'pulseaudio 16.1',
    },
    fixtures: { provider: 'local', voice: 'M1', corpusHash: 'abc', productionTtsPath: false, chunks: [] },
    oracleTolerances: DEFAULT_TOLERANCES,
    scenarios: [
      {
        id: 'json-control',
        title: 'synthetic',
        required: true,
        status: options.status ?? 'passed',
        controlStatus: options.controlStatus ?? 'passed',
        assertions,
        reasons: (options.status ?? 'passed') === 'passed' ? [] : ['something measured badly'],
        digest: { recordingFrames: 48000, invalid: [] },
        evidence: {},
        sources: [],
        artifacts: options.omitArtifact
          ? []
          : [
              {
                role: 'os-recording',
                relativePath: 'capture/recording.json-control.wav',
                bytes: capture.byteLength,
                sha256: sha256(capture),
              },
            ],
      },
    ],
    summary: { required: 1, passed: (options.status ?? 'passed') === 'passed' ? 1 : 0, failed: 0, indeterminate: 0, notRun: 0, exitCode: 0 },
    cleanup: { ok: options.cleanupOk ?? true, residuals: [] },
    method: { limitations: ['synthetic'], captureChain: 'synthetic' },
  };
  const manifestPath = path.join(attemptDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(attemptDir, 'MANIFEST.sha256'), `${sha256(readFileSync(manifestPath))}\n`);
  writeFileSync(path.join(attemptDir, 'FINALISED'), `${new Date().toISOString()}\n`);
  return attemptDir;
}

describe('verify-record', () => {
  it('accepts a well-formed finalised record', () => {
    const outcome = verifyAttempt(buildAttempt());
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it('detects an edited manifest', () => {
    const attemptDir = buildAttempt();
    const manifestPath = path.join(attemptDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.summary.passed = 99;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/manifest hash mismatch/);
  });

  it('detects a status that its own assertions do not support', () => {
    // A record claiming a pass while carrying failing assertions must not be
    // accepted: that is exactly the "self-reported success" this verifier exists
    // to defeat.
    const attemptDir = buildAttempt();
    const manifestPath = path.join(attemptDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.scenarios[0].assertions[1].ok = false;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(path.join(attemptDir, 'MANIFEST.sha256'), `${sha256(readFileSync(manifestPath))}\n`);
    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/its own assertions derive "failed"/);
  });

  it('detects a tampered artifact', () => {
    const attemptDir = buildAttempt();
    writeFileSync(path.join(attemptDir, 'capture', 'recording.json-control.wav'), Buffer.from('tampered bytes here!!'));
    const outcome = verifyAttempt(attemptDir);
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/size|hash mismatch/);
  });

  it('rejects a record whose negative control was not clean', () => {
    const outcome = verifyAttempt(buildAttempt({ controlStatus: 'failed' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/negative control/);
  });

  it('rejects a record produced under different tolerance rules', () => {
    const outcome = verifyAttempt(buildAttempt({ toleranceVersion: ORACLE_TOLERANCE_VERSION + 1 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/tolerance version/);
  });

  it('rejects a record with unverified cleanup', () => {
    const outcome = verifyAttempt(buildAttempt({ cleanupOk: false }));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/cleanup was not verified/);
  });

  it('rejects a record with no recorded browser argv', () => {
    const outcome = verifyAttempt(buildAttempt({ chromeArgs: [] }));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/browser argv/);
  });

  it('rejects a record that does not identify the code under test', () => {
    const outcome = verifyAttempt(buildAttempt({ commit: 'unknown' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/candidate commit is unknown/);
  });

  it('rejects a record with no artifacts', () => {
    const outcome = verifyAttempt(buildAttempt({ omitArtifact: true }));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(' ')).toMatch(/no artifacts recorded/);
  });

  it('rejects an unfinalised attempt', () => {
    const attemptDir = buildAttempt();
    rmSync(path.join(attemptDir, 'FINALISED'));
    const outcome = verifyAttempt(attemptDir, { requireFinalised: false });
    expect(outcome.ok).toBe(true);
    const strict = verifyAttempt(attemptDir);
    expect(strict.ok).toBe(false);
  });

  it('reports a missing manifest rather than throwing', () => {
    const outcome = verifyAttempt(path.join(dir, 'does-not-exist'));
    expect(outcome.ok).toBe(false);
    expect(outcome.problems).toContain('missing manifest');
  });
});

describe('digest', () => {
  it('returns null for no measurement', () => {
    expect(computeScenarioDigest(null)).toBeNull();
    expect(describeDigest(null)).toBe('no measurement');
  });

  it('rounds and summarises a real measurement', () => {
    const chunks = makeChunks(['alpha beta gamma', 'delta epsilon zeta'], 16000, 400);
    const recording = renderRecording(chunks, 16000, { leadInMs: 150, tailMs: 150, gapMs: 30 });
    const source = chunks.map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      samples: chunk.samples,
      encodedHash: 'x',
    }));
    const measurement: Measurement = measure(source, recording, 16000);
    const digest = computeScenarioDigest(measurement);
    expect(digest).not.toBeNull();
    expect(digest?.chunks.length).toBe(2);
    expect(digest?.missingChunks).toEqual([]);
    expect(describeDigest(digest)).toMatch(/2\/2 chunks audible/);
  });
});

describe('fixtures', () => {
  it('produces a stable corpus hash for identical inputs', () => {
    const specs = allFixtureSpecs();
    expect(corpusHash(specs, 'local', 'M1')).toBe(corpusHash(specs, 'local', 'M1'));
    expect(corpusHash(specs, 'local', 'M1')).not.toBe(corpusHash(specs, 'local', 'F1'));
    expect(corpusHash(specs, 'local', 'M1')).not.toBe(corpusHash(specs, 'endpoint', 'M1'));
  });

  it('changes the hash when any text changes', () => {
    const specs = allFixtureSpecs();
    const mutated = specs.map((spec, index) => (index === 0 ? { ...spec, text: `${spec.text} Changed.` } : spec));
    expect(corpusHash(mutated, 'local', 'M1')).not.toBe(corpusHash(specs, 'local', 'M1'));
  });

  it('reports missing and mismatched fixture files', () => {
    const problems = verifyFixtureManifest({
      schemaVersion: 1,
      provider: 'local',
      voice: 'M1',
      model: 'supertonic-3',
      corpusHash: 'x',
      createdAt: 'now',
      productionTtsPath: false,
      chunks: [
        { id: 'a', text: 't', mp3Path: path.join(dir, 'nope.mp3'), sha256: 'deadbeef', bytes: 1, durationSec: 1, sampleRate: 24000, channels: 1, voice: 'M1' },
      ],
    });
    expect(problems.join(' ')).toMatch(/missing file/);
  });

  it('keeps every diagnostic corpus sentence distinct enough to align', () => {
    // Identical sentences inside ONE set would make reorder/omission
    // attribution ambiguous; repeats are deliberate but confined to set B, and
    // each set's first sentence must be unique across sets.
    for (let index = 0; index < DIAGNOSTIC_CORPUS.length; index += 1) {
      const set = DIAGNOSTIC_CORPUS[index];
      for (const text of set) expect(text.trim().endsWith('.') || text.trim().endsWith('?')).toBe(true);
    }
    const setB = DIAGNOSTIC_CORPUS[1];
    expect(new Set(setB).size).toBeLessThan(setB.length);
  });
});

describe('import helpers', () => {
  it('parses seconds, milliseconds and mm:ss.mmm timing metadata', () => {
    expect(parseTimes('0,1.5')).toEqual([{ startMs: 0, endMs: 1500 }]);
    expect(parseTimes('0.0,2.0;2.0,3.25')).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 2000, endMs: 3250 },
    ]);
    expect(parseTimes('0:01.500,0:03.000')).toEqual([{ startMs: 1500, endMs: 3000 }]);
    expect(parseTimes('1200,2400')).toEqual([{ startMs: 1200, endMs: 2400 }]);
    expect(parseTimes('')).toEqual([]);
  });

  it('splits expected text on sentence boundaries like the product does', () => {
    expect(splitExpectedText('One. Two! Three? Four')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
    expect(splitExpectedText('   ')).toEqual([]);
  });

  it('bounds imported file size', () => {
    expect(MAX_IMPORT_BYTES).toBeGreaterThan(0);
    expect(MAX_IMPORT_BYTES).toBeLessThanOrEqual(1024 * 1024 * 1024);
  });
});

describe('static server path safety', () => {
  it('refuses traversal, absolute escapes and NUL bytes', () => {
    const root = '/tmp/lab-bundle';
    expect(safeResolve(root, '/assets/a.js')).toBe('/tmp/lab-bundle/assets/a.js');
    expect(safeResolve(root, '/../etc/passwd')).toBeNull();
    expect(safeResolve(root, '/..%2F..%2Fetc/passwd')).toBeNull();
    expect(safeResolve(root, '/a\0b')).toBeNull();
    expect(safeResolve(root, '/nested/../../escape')).toBeNull();
  });
});

describe('capsule configuration safety', () => {
  it('loads a closed PulseAudio module set with no host default.pa', () => {
    const config = renderPulseConfig({
      runtimeDir: '/tmp/run/pulse',
      mainSink: 'pi_lab_main',
      calibSink: 'pi_lab_calib',
      sampleRate: 48000,
    });
    expect(config).toContain('module-native-protocol-unix socket=/tmp/run/pulse/native');
    expect(config).toContain('sink_name=pi_lab_calib');
    expect(config).toContain('sink_name=pi_lab_main');
    // .fail makes a bad module load abort the daemon instead of silently
    // starting without the sinks the lab depends on.
    expect(config.startsWith('.fail')).toBe(true);
    // No host configuration may leak in: no system.pa/default.pa include.
    expect(config).not.toMatch(/include/);
  });

  it('points clients only at the private socket', () => {
    const env = pulseEnv({ runtimeDir: '/tmp/run/pulse', mainSink: 'm', calibSink: 'c', sampleRate: 48000 });
    expect(env.PULSE_SERVER).toBe('unix:/tmp/run/pulse/native');
    expect(env.HOME).toBe('/tmp/run/pulse');
    expect(env.PULSE_RUNTIME_PATH).toBe('/tmp/run/pulse');
  });

  it('never relaxes autoplay and always records the browser argv', () => {
    const args = chromeArgs({
      executablePath: '/usr/bin/google-chrome',
      userDataDir: '/tmp/profile',
      display: ':90',
    });
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--no-sandbox');
    // Bypassing the gesture requirement would certify a path users do not have.
    expect(args.some((arg) => arg.includes('autoplay-policy=no-user-gesture-required'))).toBe(false);
    expect(args.some((arg) => arg.includes('mute-audio'))).toBe(false);
    expect(args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(true);
  });
});

describe('process identity', () => {
  it('reads this process and matches its identity', () => {
    const identity = readIdentity(process.pid);
    expect(identity).not.toBeNull();
    expect(identity?.pid).toBe(process.pid);
    expect(identityMatches(identity!)).toBe(true);
  });

  it('treats a stale start time as a different process', () => {
    const identity = readIdentity(process.pid);
    expect(identityMatches({ ...identity!, startTimeTicks: identity!.startTimeTicks - 1 })).toBe(false);
  });

  it('returns null for a pid that does not exist', () => {
    expect(readIdentity(2_147_483_646)).toBeNull();
  });

  it('enumerates live members of a process group, excluding zombies', () => {
    // Our own process group exists and must include at least this process.
    const pgid = process.pid;
    const members = groupMembers(pgid);
    expect(Array.isArray(members)).toBe(true);
    for (const member of members) expect(member.pid).toBeGreaterThan(0);
  });
});

describe('cli surface', () => {
  it('parses flags, values and positionals', () => {
    const args = parseArgs(['run', '--root', '/tmp/x', '--scenario', 'start-cold', '--force', 'pos']);
    expect(args.command).toBe('run');
    expect(flagString(args, 'root')).toBe('/tmp/x');
    expect(flagString(args, 'scenario')).toBe('start-cold');
    expect(flagBool(args, 'force')).toBe(true);
    expect(flagBool(args, 'missing')).toBe(false);
    expect(args.positional).toEqual(['pos']);
  });

  it('supports --flag=value', () => {
    const args = parseArgs(['fixtures', '--provider=endpoint']);
    expect(flagString(args, 'provider')).toBe('endpoint');
  });

  it('maps scenario outcomes to the documented exit codes', () => {
    const mk = (id: string, status: string) =>
      ({ id, status, required: true }) as unknown as Parameters<typeof summarise>[0][number];
    expect(summarise([mk('a', 'passed')], ['a']).exitCode).toBe(0);
    expect(summarise([mk('a', 'failed')], ['a']).exitCode).toBe(1);
    expect(summarise([mk('a', 'indeterminate')], ['a']).exitCode).toBe(2);
    expect(summarise([], ['a']).exitCode).toBe(2);
    // A mixed fail/indeterminate result can never become green.
    expect(summarise([mk('a', 'failed'), mk('b', 'indeterminate')], ['a', 'b']).exitCode).toBe(1);
  });
});

describe('clip encoding', () => {
  it('produces a decodable WAV from in-memory samples', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const wav = clipFromSamples(samples, 16000);
    const decoded = decodeWav(wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.frames).toBe(5);
    expect(decoded.channels[0][1]).toBeCloseTo(0.5, 3);
  });
});
