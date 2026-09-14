/**
 * Audio regression lab CLI.
 *
 * Subcommands:
 *   doctor          check the host can actually run the lab, and say what is missing
 *   fixtures        build or verify the speech fixture corpus
 *   run             run the required scenario matrix in the product-player lane
 *   app             run the authenticated full-application lane
 *   soak            repeat runs / long-horizon soak with resource sampling
 *   verify-record   re-check a finalised attempt offline (hashes + consistency)
 *   report          regenerate the HTML report from a finalised attempt
 *   import          import an operator-supplied recording for analysis
 *
 * The CLI is intentionally the ONLY entrypoint: an operator (or another agent)
 * must be able to run the whole lab without knowing the internal module layout.
 */

import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AudioLabCapsule } from './lib/capsule.js';
import {
  assertSafeLabRoot,
  createRunLayout,
  directorySizeBytes,
  findFreePort,
  nextAttempt,
  sha256File,
} from './lib/layout.js';
import { buildFixtures, allFixtureSpecs, DIAGNOSTIC_CORPUS, loadFixtureManifest, verifyFixtureManifest, corpusHash } from './lib/fixtures.js';
import { ProductLane } from './lib/product-lane.js';
import { PRODUCT_LANE_SCENARIOS, scenarioById } from './lib/scenarios.js';
import { runScenario, verifyChunking, type LabPage, type ScenarioResult } from './lib/runner.js';
import { runTool } from './lib/audio-io.js';
import { writeManifest } from './lib/manifest.js';
import { writeHtmlReport } from './lib/report-html.js';
import { verifyRecord } from './lib/verify-record.js';
import { importExternalRecording } from './lib/import-external.js';
import { LAB_VERSION } from './lib/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, '..', '..');

export interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
  positional: string[];
}

/**
 * Flags that never take a value.
 *
 * Without this set, `--force positional` is ambiguous and is parsed as
 * `--force=positional`, which silently swallows a positional argument. Listing
 * the boolean flags is the only unambiguous option short of a full grammar.
 */
export const BOOLEAN_FLAGS = new Set(['force', 'keep', 'help', 'json', 'quiet']);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name.includes('=')) {
      const [key, value] = name.split('=');
      flags.set(key, value);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags, positional };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

const DEFAULT_ROOT = '/root/.pi-web-ui/audio-lab';
const DEFAULT_EVIDENCE_ROOT = '/root/.pi-web-ui/operations/audio-lab-20260914/implementation/evidence';

function resolveRoot(args: ParsedArgs): string {
  const root = flagString(args, 'root') ?? process.env.AUDIO_LAB_ROOT ?? DEFAULT_ROOT;
  return assertSafeLabRoot(root);
}

async function commandDoctor(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  log(`# Audio lab doctor\n\nlab version: ${LAB_VERSION}\nroot: ${root}\n`);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  for (const binary of ['google-chrome', 'Xvfb', 'xdpyinfo', 'pulseaudio', 'pactl', 'parec', 'pacat', 'ffmpeg', 'ffprobe', 'python3', 'ss']) {
    const result = await runTool('sh', ['-c', `command -v ${binary}`], { timeoutMs: 10_000 });
    checks.push({
      name: `binary:${binary}`,
      ok: result.code === 0 && result.stdout.trim().length > 0,
      detail: result.stdout.trim() || 'not found on PATH',
    });
  }

  const chromeVersion = await runTool('google-chrome', ['--version'], { timeoutMs: 20_000 });
  checks.push({
    name: 'chrome:version',
    ok: chromeVersion.code === 0,
    detail: chromeVersion.stdout.trim() || chromeVersion.stderr.trim(),
  });

  const pulseVersion = await runTool('pulseaudio', ['--version'], { timeoutMs: 20_000 });
  checks.push({ name: 'pulseaudio:version', ok: pulseVersion.code === 0, detail: pulseVersion.stdout.trim() });

  const bundle = labBundleDir(root);
  checks.push({
    name: 'lab-bundle',
    ok: existsSync(path.join(bundle, 'scripts/audio-lab/browser/lab.html')),
    detail: bundle,
  });

  const fixtures = loadFixtureManifest(root, corpusHash(allFixtureSpecs(), 'local', 'M1'));
  checks.push({
    name: 'fixtures:local',
    ok: fixtures !== null && verifyFixtureManifest(fixtures).length === 0,
    detail: fixtures ? `${fixtures.chunks.length} chunks` : 'not built (run: npm run audio-lab:fixtures)',
  });
  const endpointFixtures = loadFixtureManifest(root, corpusHash(allFixtureSpecs(), 'endpoint', 'alloy'));
  checks.push({
    name: 'fixtures:production-tts',
    ok: endpointFixtures !== null,
    detail: endpointFixtures
      ? `${endpointFixtures.chunks.length} chunks from the real /api/tts path`
      : 'not built (production-TTS gate unmet until built with --provider endpoint)',
  });

  // A real end-to-end probe: a private display, daemon and recorder must work.
  const probeDir = path.join(root, 'doctor-probe');
  mkdirSync(probeDir, { recursive: true, mode: 0o700 });
  let capsule: AudioLabCapsule | null = null;
  try {
    capsule = new AudioLabCapsule({ attemptDir: probeDir });
    const calibration = await capsule.prepare();
    checks.push({ name: 'capture:chain', ok: calibration.ok, detail: calibration.detail });
  } catch (error) {
    checks.push({
      name: 'capture:chain',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (capsule) {
      const cleanup = await capsule.shutdown();
      checks.push({
        name: 'capture:cleanup',
        ok: cleanup.ok,
        detail: cleanup.ok ? 'no residuals' : JSON.stringify(cleanup.residuals),
      });
    }
  }

  const disk = await runTool('df', ['-Pk', root], { timeoutMs: 10_000 });
  const freeMb = Number.parseInt(disk.stdout.split('\n')[1]?.split(/\s+/)[3] ?? '0', 10) / 1024;
  checks.push({ name: 'disk:free-mb', ok: freeMb > 512, detail: `${freeMb.toFixed(0)} MB free` });

  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
    log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(28)} ${check.detail}`);
  }
  log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed === 0 ? 0 : 2;
}

function labBundleDir(root: string): string {
  return path.join(root, 'lab-bundle');
}

async function commandFixtures(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const provider = (flagString(args, 'provider') ?? 'local') as 'local' | 'endpoint';
  const voice = flagString(args, 'voice') ?? (provider === 'endpoint' ? 'alloy' : 'M1');
  const setIndex = flagString(args, 'corpus');
  const specs = allFixtureSpecs(setIndex === undefined ? undefined : Number.parseInt(setIndex, 10));

  const endpointBase = flagString(args, 'endpoint-base');
  const endpointPassword = flagString(args, 'endpoint-password');
  const manifest = await buildFixtures({
    root,
    specs,
    provider,
    voice,
    force: flagBool(args, 'force'),
    endpoint:
      provider === 'endpoint' && endpointBase
        ? { baseUrl: endpointBase, password: endpointPassword ?? '' }
        : undefined,
    log,
  });
  log(`\nmanifest: ${path.join(root, 'fixtures', manifest.corpusHash, 'manifest.json')}`);
  log(`production TTS path: ${manifest.productionTtsPath}`);
  return 0;
}

async function buildLabBundle(root: string): Promise<string> {
  const out = labBundleDir(root);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const result = await runTool(
    'npx',
    ['vite', 'build', '--config', path.join('scripts', 'audio-lab', 'browser', 'lab.vite.config.ts')],
    { cwd: REPOSITORY_ROOT, timeoutMs: 300_000, env: { ...process.env, AUDIO_LAB_BUNDLE_OUT: out, NODE_ENV: 'development' } }
  );
  if (result.code !== 0) {
    throw new Error(`Lab bundle build failed (exit ${result.code}):\n${result.stderr.slice(-3000)}`);
  }
  return out;
}

async function connectChrome(port: number): Promise<unknown> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

export interface LaneOptions {
  root: string;
  scenarioIds: string[];
  fixturesProvider: 'local' | 'endpoint';
  fixturesVoice: string;
  keepShell: boolean;
  label: string;
}

async function runProductLane(options: LaneOptions): Promise<{ results: ScenarioResult[]; attemptDir: string; runId: string }> {
  const root = options.root;
  const fixtures =
    loadFixtureManifest(root, corpusHash(allFixtureSpecs(), options.fixturesProvider, options.fixturesVoice)) ??
    (await buildFixtures({
      root,
      specs: allFixtureSpecs(),
      provider: options.fixturesProvider,
      voice: options.fixturesVoice,
      log,
    }));

  const bundleDir = existsSync(path.join(labBundleDir(root), 'scripts/audio-lab/browser/lab.html'))
    ? labBundleDir(root)
    : await buildLabBundle(root);

  const runId = options.label;
  const attempt = nextAttempt(root, runId);
  const layout = createRunLayout(root, runId, attempt);
  log(`[run] ${runId} attempt ${attempt} -> ${layout.attemptDir}`);

  const capsule = new AudioLabCapsule({ attemptDir: layout.attemptDir });
  const results: ScenarioResult[] = [];
  let cleanup: unknown = null;

  try {
    const calibration = await capsule.prepare();
    log(`[run] calibration: ${calibration.detail}`);
    if (!calibration.ok) throw new Error(`Calibration failed: ${calibration.detail}`);

    await capsule.launchBrowser();
    const { chromium } = await import('playwright');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${capsule.debugPort}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome exposed no browser context over CDP');
    const page = (context.pages()[0] ?? (await context.newPage())) as unknown as LabPage;
    await page.setViewportSize({ width: 1280, height: 800 });

    const lane = new ProductLane({
      bundleDir,
      fixtures,
      attemptDir: layout.attemptDir,
    });
    await lane.start(page);
    await page.goto(lane.pageUrl, { waitUntil: 'load' });
    // Arm audio with a REAL click, exactly as a user must.
    await page.click('#arm');
    const armed = await page.evaluate(() => {
      const api = (
        globalThis as unknown as { __labProduct: { contextState(): { state: string; sampleRate: number } } }
      ).__labProduct;
      return api.contextState();
    });
    log(`[run] armed: ${JSON.stringify(armed)}`);

    // Verify the corpus matches the product's own chunker before measuring.
    for (let index = 0; index < DIAGNOSTIC_CORPUS.length; index += 1) {
      const texts = DIAGNOSTIC_CORPUS[index];
      const check = await verifyChunking(page, texts.join(' '), texts);
      if (!check.ok) {
        throw new Error(
          `lab corpus ${index} does not match the product chunker: expected ${texts.length} chunks, got ${JSON.stringify(check.actual)}`
        );
      }
    }
    log('[run] corpus verified against the real product chunker');

    for (const scenarioId of options.scenarioIds) {
      const scenario = scenarioById(scenarioId);
      if (!scenario) {
        log(`[run] SKIP unknown scenario ${scenarioId}`);
        continue;
      }
      log(`[run] scenario ${scenario.id}: ${scenario.title}`);
      const started = Date.now();
      const result = await runScenario({
        scenario,
        capsule,
        lane,
        page,
        fixtures,
        log: (message) => log(`      ${message}`),
      });
      result.evidence.durationMs = Date.now() - started;
      results.push(result);
      const { mkdirSync: mk } = await import('node:fs');
      mk(path.join(layout.attemptDir, 'scenarios'), { recursive: true, mode: 0o700 });
      writeFileSync(
        path.join(layout.attemptDir, 'scenarios', `${result.id}.json`),
        `${JSON.stringify(result, null, 2)}\n`
      );
      log(`[run] scenario ${scenario.id}: ${result.status}${result.reasons.length ? ` (${result.reasons[0]})` : ''}`);
    }

    lane.writeRequestLog();
    await page.screenshot({ path: path.join(layout.attemptDir, 'screenshots', 'final.png') });
    writeFileSync(
      path.join(layout.attemptDir, 'events', 'lane.json'),
      `${JSON.stringify(
        {
          bundleDir,
          pageUrl: lane.pageUrl,
          fixtures: {
            provider: fixtures.provider,
            voice: fixtures.voice,
            corpusHash: fixtures.corpusHash,
            productionTtsPath: fixtures.productionTtsPath,
            chunkHashes: fixtures.chunks.map((chunk) => ({ id: chunk.id, text: chunk.text, sha256: chunk.sha256 })),
          },
          requests: lane.requests,
          injections: lane.injectionLog,
        },
        null,
        2
      )}\n`
    );
    await lane.stop();
  } finally {
    cleanup = await capsule.shutdown();
    const cleanupOk = (cleanup as { ok?: boolean }).ok === true;
    log(`[run] cleanup ok=${cleanupOk}`);
  }

  const manifestPath = writeManifest({
    attemptDir: layout.attemptDir,
    runId,
    attempt,
    results,
    capsuleIdentity: capsule.capsuleIdentity,
    cleanup,
    labVersion: LAB_VERSION,
    fixturesProvider: options.fixturesProvider,
  });
  log(`[run] manifest: ${manifestPath}`);
  const reportPath = await writeHtmlReport(layout.attemptDir);
  log(`[run] report: ${reportPath}`);

  return { results, attemptDir: layout.attemptDir, runId };
}

async function commandRun(args: ParsedArgs): Promise<number> {
  const root = resolveRoot(args);
  const only = flagString(args, 'scenario');
  const scenarioIds = only
    ? only.split(',').map((entry) => entry.trim())
    : PRODUCT_LANE_SCENARIOS.map((scenario) => scenario.id);
  const label = flagString(args, 'label') ?? `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const { results } = await runProductLane({
    root,
    scenarioIds,
    fixturesProvider: (flagString(args, 'provider') ?? 'local') as 'local' | 'endpoint',
    fixturesVoice: flagString(args, 'voice') ?? 'M1',
    keepShell: flagBool(args, 'keep'),
    label,
  });

  const requiredIds = PRODUCT_LANE_SCENARIOS.filter((scenario) => scenario.required).map((scenario) => scenario.id);
  const summary = summarise(results, requiredIds);
  log(`\n[run] ${summary.line}`);
  return summary.exitCode;
}

export function summarise(
  results: ScenarioResult[],
  requiredIds: string[]
): { line: string; exitCode: number; failed: string[]; indeterminate: string[]; notRun: string[] } {
  const byId = new Map(results.map((result) => [result.id, result]));
  const failed: string[] = [];
  const indeterminate: string[] = [];
  const notRun: string[] = [];
  let passed = 0;
  for (const id of requiredIds) {
    const result = byId.get(id);
    if (!result) {
      notRun.push(id);
      continue;
    }
    if (result.status === 'passed') passed += 1;
    else if (result.status === 'failed') failed.push(id);
    else indeterminate.push(id);
  }
  // Exit codes: 0 all required proof passed; 1 demonstrated regression;
  // 2 missing/invalid proof. A mixed fail/indeterminate cannot become green.
  const exitCode = failed.length > 0 ? 1 : indeterminate.length > 0 || notRun.length > 0 ? 2 : 0;
  const line = `${passed}/${requiredIds.length} required scenarios passed` +
    `${failed.length ? `, failed: ${failed.join(', ')}` : ''}` +
    `${indeterminate.length ? `, indeterminate: ${indeterminate.join(', ')}` : ''}` +
    `${notRun.length ? `, not run: ${notRun.join(', ')}` : ''} (exit ${exitCode})`;
  return { line, exitCode, failed, indeterminate, notRun };
}

async function commandVerifyRecord(args: ParsedArgs): Promise<number> {
  const attemptDir = args.positional[0] ?? flagString(args, 'attempt');
  if (!attemptDir) {
    log('usage: verify-record <attempt-dir>');
    return 2;
  }
  const result = await verifyRecord(attemptDir);
  for (const line of result.lines) log(line);
  log(result.ok ? '\nRECORD VERIFIED' : '\nRECORD INVALID');
  return result.ok ? 0 : 2;
}

async function commandReport(args: ParsedArgs): Promise<number> {
  const attemptDir = args.positional[0] ?? flagString(args, 'attempt');
  if (!attemptDir) {
    log('usage: report <attempt-dir>');
    return 2;
  }
  const file = await writeHtmlReport(attemptDir);
  log(`report: ${file}`);
  return 0;
}

async function commandSoak(args: ParsedArgs): Promise<number> {
  const repetitions = Number.parseInt(flagString(args, 'repeat') ?? '1', 10);
  const minutes = flagString(args, 'minutes');
  const root = resolveRoot(args);
  const label = flagString(args, 'label') ?? `soak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const scenarioIds = (flagString(args, 'scenario') ?? 'chunk-joins')
    .split(',')
    .map((entry) => entry.trim());

  const outcomes: Array<{ index: number; status: string; chunkStarts: number; diskMb: number; elapsedMs: number }> = [];
  const deadline = minutes ? Date.now() + Number.parseFloat(minutes) * 60_000 : null;
  let index = 0;
  let exitCode = 0;
  while (true) {
    index += 1;
    const started = Date.now();
    log(`[soak] pass ${index}${deadline ? ` (until ${new Date(deadline).toISOString()})` : ''}`);
    const { results, attemptDir } = await runProductLane({
      root,
      scenarioIds,
      fixturesProvider: (flagString(args, 'provider') ?? 'local') as 'local' | 'endpoint',
      fixturesVoice: flagString(args, 'voice') ?? 'M1',
      keepShell: true,
      label: `${label}-pass${String(index).padStart(2, '0')}`,
    });
    const chunkStarts = results.reduce(
      (sum, result) =>
        sum + (result.measurement ? result.measurement.chunks.filter((chunk) => chunk.status === 'present').length : 0),
      0
    );
    const status = summarise(results, PRODUCT_LANE_SCENARIOS.filter((s) => s.required).map((s) => s.id)).exitCode === 0
      ? 'passed'
      : results.some((result) => result.status === 'failed')
        ? 'failed'
        : 'indeterminate';
    outcomes.push({
      index,
      status,
      chunkStarts,
      diskMb: directorySizeBytes(attemptDir) / (1024 * 1024),
      elapsedMs: Date.now() - started,
    });
    log(`[soak] pass ${index}: ${status}, ${chunkStarts} chunk starts, ${(outcomes[outcomes.length - 1].elapsedMs / 1000).toFixed(0)} s`);
    if (status !== 'passed') exitCode = exitCode === 0 ? 1 : exitCode;
    if (!deadline && index >= repetitions) break;
    if (deadline && Date.now() >= deadline) break;
    if (index > 200) break;
  }
  writeFileSync(
    path.join(root, `${label}-soak.json`),
    `${JSON.stringify({ label, scenarioIds, outcomes, finishedAt: new Date().toISOString() }, null, 2)}\n`
  );
  const totalChunkStarts = outcomes.reduce((sum, entry) => sum + entry.chunkStarts, 0);
  log(`[soak] ${outcomes.length} passes, ${totalChunkStarts} chunk starts total`);
  return exitCode;
}

async function commandImport(args: ParsedArgs): Promise<number> {
  const input = args.positional[0] ?? flagString(args, 'input');
  if (!input) {
    log('usage: import <recording> [--text "expected text"] [--root <dir>] [--label <id>]');
    return 2;
  }
  const root = resolveRoot(args);
  const outcome = await importExternalRecording({
    root,
    inputPath: input,
    expectedText: flagString(args, 'text'),
    times: flagString(args, 'times'),
    label: flagString(args, 'label'),
    log,
  });
  log(`\n[import] ${outcome.verdict}${outcome.reasons.length ? `: ${outcome.reasons.join('; ')}` : ''}`);
  log(`[import] attempt: ${outcome.attemptDir}`);
  return outcome.verdict === 'passed' ? 0 : outcome.verdict === 'failed' ? 1 : 2;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'doctor':
      return commandDoctor(args);
    case 'fixtures':
      return commandFixtures(args);
    case 'run':
      return commandRun(args);
    case 'soak':
      return commandSoak(args);
    case 'verify-record':
      return commandVerifyRecord(args);
    case 'report':
      return commandReport(args);
    case 'import':
      return commandImport(args);
    case 'build-bundle': {
      const root = resolveRoot(args);
      const dir = await buildLabBundle(root);
      log(`bundle: ${dir}`);
      return 0;
    }
    default:
      log(`Audio lab ${LAB_VERSION}

usage: audio-lab <command> [options]

commands:
  doctor                                  check the host and report what is missing
  fixtures  [--provider local|endpoint]   build/verify the speech fixture corpus
  run       [--scenario id,...] [--root]  run the scenario matrix in the product lane
  soak      [--minutes N|--repeat N]      repeat or long-horizon soak with disk sampling
  verify-record <attempt-dir>             re-check a finalised attempt offline
  report    <attempt-dir>                 regenerate the HTML report
  import    <recording> [--text ...]      import an operator-supplied recording
  build-bundle                            build the lab product-player page

env:
  AUDIO_LAB_ROOT   lab working root (default ${DEFAULT_ROOT})
  evidence root    ${DEFAULT_EVIDENCE_ROOT}`);
      return 2;
  }
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 2;
    });
}

export { REPOSITORY_ROOT, DEFAULT_ROOT, DEFAULT_EVIDENCE_ROOT, labBundleDir, runProductLane };
export { existsSync, readFileSync, writeFileSync, mkdirSync, findFreePort, sha256File, runTool };
