import { writeFileSync } from 'node:fs';
import { InternalApiClient } from '../../server/src/live-validation/internal-api-client.js';
import { InspectorClient } from './inspector.js';
import { getFreeDiskGB } from './disk-io.js';
import { HEAP_SAMPLE_CSV_HEADER, type HeapSample } from '../../server/src/live-validation/heap-soak/types.js';

export interface SampleContext {
  inspector: InspectorClient;
  client: InternalApiClient;
  runStartMs: number;
  phase: string;
  diskCheckPath: string;
}

/** One full sample: forced GC, post-GC memory reading, CDP round-trip lag proxy, capacity/health, disk. */
export async function takeSample(ctx: SampleContext): Promise<HeapSample> {
  await ctx.inspector.collectGarbage();
  const mem = await ctx.inspector.readMemoryUsage();
  const lagMs = await ctx.inspector.measureRoundTripMs();

  let activeTurns: number | undefined;
  let stalledRuns: number | undefined;
  let residentSessionCount: number | undefined;
  let registryEntryCount: number | undefined;
  try {
    const capacity = await ctx.client.getCapacity();
    activeTurns = capacity.activeTurns;
    stalledRuns = capacity.stalledRuns;
  } catch { /* capacity is best-effort telemetry, never fatal to a sample */ }
  try {
    const sessions = await ctx.client.listSessions();
    residentSessionCount = sessions.sessions.length;
    registryEntryCount = sessions.sessions.length;
  } catch { /* same */ }

  let freeDiskGB: number | undefined;
  try {
    freeDiskGB = await getFreeDiskGB(ctx.diskCheckPath);
  } catch { /* disk check is best-effort; the launcher's own preflight already checked once */ }

  return {
    ts: new Date().toISOString(),
    elapsedMs: Date.now() - ctx.runStartMs,
    phase: ctx.phase,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    rssBytes: mem.rss,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers ?? 0,
    eventLoopLagMsProxy: lagMs,
    activeTurns,
    stalledRuns,
    residentSessionCount,
    registryEntryCount,
    freeDiskGB,
  };
}

export function writeHeartbeat(heartbeatPath: string): void {
  writeFileSync(heartbeatPath, `${new Date().toISOString()}\n`);
}

export { HEAP_SAMPLE_CSV_HEADER };
