/**
 * Regenerate the committed Command Code effort table.
 *
 * Probes each advertised model with the provider-free invalid-effort trick:
 * `cmd -p --effort __pi_web_ui_capability_probe__` is rejected by the CLI's
 * argument validation before any provider contact, so the probe costs nothing
 * and bills nothing. The rejection text lists the supported values.
 *
 * Usage: npm run commandcode:refresh-models
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXECUTABLE_PATH = process.env.COMMAND_CODE_EXECUTABLE_PATH ?? '/root/.npm-global/bin/cmd';
const OUTPUT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src', 'command-code', 'command-code-model-efforts.ts');
const EFFORT_ENUM = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PROBE_VALUE = '__pi_web_ui_capability_probe__';
const PROBE_TIMEOUT_MS = 15_000;

function run(args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXECUTABLE_PATH, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

function parseVersion(stdout: string): string {
  const match = stdout.trim().match(/v?(\d+(?:\.\d+){2})/);
  return match?.[1] ?? 'unknown';
}

function parseAdvertisedIds(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^cmd\s+--model\b/i.test(trimmed)) continue;
    const match = trimmed.match(/^([a-z0-9][a-z0-9._/-]{0,255})[ ]{2,}\S/u);
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** Parse the CLI's "supported values" rejection into an effort list. */
function parseSupportedEfforts(stdout: string, stderr: string): { levels: string[]; noAdjustable: boolean } {
  const diagnostics = `${stdout}\n${stderr}`;
  if (/no adjustable .*effort|effort not supported|does not support .*effort/i.test(diagnostics)) {
    return { levels: [], noAdjustable: true };
  }
  const match = diagnostics.match(/supported(?:\s+values?)?:\s*([^.!?\r\n]+)/i);
  if (!match) return { levels: [], noAdjustable: false };
  const values = match[1]
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/^or\s+/, '').replace(/^['"`]+|['"`]+$/g, ''))
    .filter(Boolean);
  const levels = [...new Set(values.filter((value) => (EFFORT_ENUM as readonly string[]).includes(value)))];
  const unknown = values.filter((value) => !(EFFORT_ENUM as readonly string[]).includes(value));
  if (unknown.length > 0) {
    console.warn(`  ! unrecognised effort values in CLI output (${unknown.join(', ')}); ignoring them`);
  }
  return { levels, noAdjustable: false };
}

async function probeEfforts(model: string): Promise<{ effortLevels: string[]; defaultEffort?: string }> {
  const probe = await run([
    '-p', '--output-format', 'json', '--model', model, '--max-turns', '1',
    '--trust', '--skip-onboarding', '--no-auto-update', '--effort', PROBE_VALUE,
  ]);
  const parsed = parseSupportedEfforts(probe.stdout, probe.stderr);
  if (parsed.levels.length === 0 && !parsed.noAdjustable) {
    console.warn(`  ? inconclusive probe for ${model} (exit ${probe.exitCode}); recording no selector`);
  }
  const defaultEffort = parsed.levels.includes('medium') ? 'medium' : parsed.levels[0];
  return {
    effortLevels: parsed.levels,
    ...(parsed.levels.length > 0 && defaultEffort ? { defaultEffort } : {}),
  };
}

async function main(): Promise<void> {
  console.log(`Command Code effort table generator (${EXECUTABLE_PATH})`);
  const versionProbe = await run(['--no-auto-update', '--version']);
  const version = parseVersion(versionProbe.stdout);
  const modelsProbe = await run(['--no-auto-update', '--list-models']);
  const models = parseAdvertisedIds(modelsProbe.stdout);
  if (models.length === 0) {
    console.error('--list-models produced no model ids; refusing to write an empty table.');
    process.exitCode = 1;
    return;
  }
  console.log(`CLI version ${version}; ${models.length} advertised models`);

  const table: Record<string, { effortLevels: string[]; defaultEffort?: string }> = {};
  for (const model of models) {
    process.stdout.write(`  ${model} ... `);
    table[model] = await probeEfforts(model);
    const entry = table[model];
    console.log(entry.effortLevels.length > 0 ? `${entry.effortLevels.join('/')} (default ${entry.defaultEffort ?? '-'})` : 'no selector');
  }

  const generatedAt = new Date().toISOString();
  const entryLines = Object.entries(table).map(([model, entry]) =>
    `  ${JSON.stringify(model)}: { "effortLevels": ${JSON.stringify(entry.effortLevels)}${entry.defaultEffort !== undefined ? `, "defaultEffort": ${JSON.stringify(entry.defaultEffort)}` : ''} },`);
  const body = [
    '// Generated by `npm run commandcode:refresh-models` — do not edit by hand.',
    `// CLI version at generation time: ${version}. Generated at: ${generatedAt}.`,
    'export const COMMAND_CODE_EFFORT_TABLE_GENERATED_AT = ' + JSON.stringify(generatedAt) + ';',
    'export const COMMAND_CODE_EFFORT_TABLE_CLI_VERSION = ' + JSON.stringify(version) + ';',
    'export const COMMAND_CODE_EFFORT_TABLE: Record<string, { effortLevels: string[]; defaultEffort?: string }> = {',
    ...entryLines,
    '};',
    '',
  ].join('\n');
  await writeFile(OUTPUT_PATH, body, 'utf8');
  const withSelector = Object.values(table).filter((entry) => entry.effortLevels.length > 0).length;
  console.log(`Wrote ${OUTPUT_PATH}: ${models.length} models, ${withSelector} with an effort selector.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
