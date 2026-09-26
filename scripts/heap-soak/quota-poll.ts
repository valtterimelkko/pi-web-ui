import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { parseProviderUsage, type ZaiQuotaReading } from '../../server/src/live-validation/heap-soak/zai-quota.js';

const execFile = promisify(execFileCb);

export const QUOTA_INJECT_ENV_KEY = 'HEAP_SOAK_INJECT_QUOTA_SEQUENCE';

let injectedSequence: ZaiQuotaReading[] | undefined;
let injectedIndex = 0;

function loadInjectedSequence(): ZaiQuotaReading[] | undefined {
  if (injectedSequence) return injectedSequence;
  const raw = process.env[QUOTA_INJECT_ENV_KEY];
  if (!raw) return undefined;
  injectedSequence = JSON.parse(raw) as ZaiQuotaReading[];
  return injectedSequence;
}

/**
 * Poll `agent-os provider-usage --providers zai-glm --json` (read-only, spends
 * no tokens). In Gate 1, `HEAP_SOAK_INJECT_QUOTA_SEQUENCE` (a JSON array of
 * readings) substitutes this real call so the state machine can be driven
 * deterministically through normal -> throttled -> paused -> normal; each
 * call advances one step and holds on the last entry once exhausted.
 */
export async function pollZaiQuota(): Promise<ZaiQuotaReading> {
  const injected = loadInjectedSequence();
  if (injected && injected.length > 0) {
    const reading = injected[Math.min(injectedIndex, injected.length - 1)];
    injectedIndex += 1;
    return reading;
  }
  const { stdout } = await execFile('npm', ['--prefix', '/root/agent-os', 'run', '-s', 'agent-os', '--', 'provider-usage', '--providers', 'zai-glm', '--json'], { timeout: 30_000 });
  const reading = parseProviderUsage(stdout);
  if (!reading) throw new Error(`provider-usage returned no parseable zai-glm row: ${stdout.slice(0, 300)}`);
  return reading;
}
