/**
 * Registry seeding (parent amendment 2026-09-26, on by default): mimic
 * production's registry size (~1,700 entries) so the disposable server boots
 * and serves session listing under the same registry-scan cost as
 * production, rather than the near-empty registry a fresh disposable server
 * would otherwise have. Entries point at non-existent paths inside the run
 * dir — never real session files, never touching anything outside it.
 */

export interface SyntheticRegistryEntry {
  id: string;
  sdkType: 'pi';
  path: string;
  cwd: string;
  firstMessage: string;
  messageCount: number;
  createdAt: string;
  lastActivity: string;
  status: 'idle';
  origin: 'native-discovered';
}

export interface SyntheticRegistry {
  version: number;
  updatedAt: string;
  entries: SyntheticRegistryEntry[];
}

export const DEFAULT_SYNTHETIC_REGISTRY_COUNT = 1700;

/** Deterministic-shape synthetic registry (given a fixed `nowIso`) — pure, so boot/listing proofs don't need real time. */
export function buildSyntheticRegistry(runDir: string, count: number = DEFAULT_SYNTHETIC_REGISTRY_COUNT, nowIso: string = new Date().toISOString()): SyntheticRegistry {
  const entries: SyntheticRegistryEntry[] = [];
  for (let i = 0; i < count; i++) {
    const idHex = i.toString(16).padStart(8, '0');
    entries.push({
      id: `synthetic-${idHex}`,
      sdkType: 'pi',
      path: `${runDir}/synthetic-registry/session-${idHex}.jsonl`, // deliberately non-existent
      cwd: `${runDir}/synthetic-registry`,
      firstMessage: 'synthetic registry-seed entry (heap-soak fidelity — production registry size)',
      messageCount: 1,
      createdAt: nowIso,
      lastActivity: nowIso,
      status: 'idle',
      origin: 'native-discovered',
    });
  }
  return { version: 1, updatedAt: nowIso, entries };
}
