/**
 * Refresh the Devin model catalogue probe — devin-parity lane A1.
 *
 * Runs `devin models list --format json` with the D2 allow-listed environment
 * and prints a catalogue summary: family/variant counts, the Free-tier ids
 * (informational — owner ruling 01, 2026-11-08: there is NO allow-list, every
 * catalogue model is usable everywhere), and the CLI version. It never edits
 * any committed file: the catalogue is served live from the CLI by the
 * service (60s cache), so drift self-corrects on the next list.
 *
 * Usage: npm run devin:refresh-models
 * Env: DEVIN_EXECUTABLE_PATH (default /root/.local/bin/devin), DEVIN_HOME
 * (default the real home — the CLI reads its own credentials).
 */
import { spawn } from 'node:child_process';
import { parseDevinModelsJson, toDevinCatalogEntries, devinPricingFromVariant } from '../server/src/devin/devin-models.js';

const EXECUTABLE_PATH = process.env.DEVIN_EXECUTABLE_PATH ?? '/root/.local/bin/devin';
const DEVIN_HOME = process.env.DEVIN_HOME;
const LIST_TIMEOUT_MS = 30_000;

function run(args: string[], timeoutMs = LIST_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'LANG', 'TERM'] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
    env.HOME = DEVIN_HOME ?? process.env.HOME ?? '';
    const child = spawn(EXECUTABLE_PATH, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
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

async function main(): Promise<void> {
  const version = await run(['--version']);
  const cliVersion = version.stdout.trim() || `probe failed (${version.exitCode})`;

  const listed = await run(['models', 'list', '--format', 'json']);
  if (listed.exitCode !== 0 || !listed.stdout.trim()) {
    console.error(`devin models list failed (exit ${listed.exitCode}): ${listed.stderr.slice(0, 400)}`);
    process.exit(1);
  }
  const parsed = parseDevinModelsJson(listed.stdout);
  const entries = toDevinCatalogEntries(parsed.families);
  const variants = parsed.families.flatMap((f) => f.variants);
  const free = variants.filter((v) => devinPricingFromVariant(v).free).map((v) => v.model_uid);
  const withLevels = entries.filter((m) => m.thinkingLevels.length > 0).length;

  console.log(`devin CLI:            ${cliVersion}`);
  console.log(`families:             ${parsed.families.length}`);
  console.log(`models (variants):    ${entries.length}`);
  console.log(`with thinking levels: ${withLevels}`);
  console.log(`free tier ids:        ${free.length > 0 ? free.join(', ') : '(none reported)'}`);
  console.log('');
  console.log('No allow-list to update (owner ruling 01: every catalogue model is');
  console.log('usable via the Internal API and the browser picker). The server');
  console.log('serves the catalogue live from the CLI with a 60s cache, so this');
  console.log('script is an observational probe, not a writer.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
