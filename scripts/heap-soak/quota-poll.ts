import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { parseProviderUsage, type ZaiQuotaReading } from '../../server/src/live-validation/heap-soak/zai-quota.js';

const execFile = promisify(execFileCb);

export const QUOTA_INJECT_ENV_KEY = 'HEAP_SOAK_INJECT_QUOTA_SEQUENCE';

let injectedSequence: ZaiQuotaReading[] | undefined;

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
 *
 * `startIndex` is caller-owned and must be persisted by the caller (see
 * supervisor.ts's `quotaInjectedIndex` in run-state) — this module used to
 * keep the index in a plain module-level variable, which reset to 0 on every
 * process restart. That silently replayed the sequence from the start after
 * a `systemctl kill` of the supervisor, observed live: a restart landing
 * right after a 'throttled' reading, followed by a fresh index-0 (baseline
 * 'normal'-level) reading, produced a direct throttled->normal transition
 * that silently skipped the 'paused' state the sequence was designed to
 * exercise. Returning `nextIndex` alongside the reading makes the position
 * restart-safe when the caller persists it.
 */
export async function pollZaiQuota(startIndex = 0): Promise<{ reading: ZaiQuotaReading; nextIndex: number }> {
  const injected = loadInjectedSequence();
  if (injected && injected.length > 0) {
    const reading = injected[Math.min(startIndex, injected.length - 1)];
    return { reading, nextIndex: startIndex + 1 };
  }
  const { stdout } = await execFile('npm', ['--prefix', '/root/agent-os', 'run', '-s', 'agent-os', '--', 'provider-usage', '--providers', 'zai-glm', '--json'], { timeout: 30_000 });
  const reading = parseProviderUsage(stdout);
  if (!reading) throw new Error(`provider-usage returned no parseable zai-glm row: ${stdout.slice(0, 300)}`);
  return { reading, nextIndex: startIndex }; // real polls carry no sequence position
}
