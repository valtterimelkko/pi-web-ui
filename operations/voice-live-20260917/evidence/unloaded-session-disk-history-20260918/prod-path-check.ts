/**
 * Scratch: the PRODUCTION path for the operator's session, minus the browser.
 * Real session registry resolver + real TalkerSessionRegistry snapshot + the real
 * brief policy. The only stand-in is the MultiSessionManager (unloaded session).
 */
import { getSessionRegistry } from '/root/pi-web-ui/server/src/session-registry.js';
import { config } from '/root/pi-web-ui/server/src/config.js';
import { TalkerSessionRegistry } from '/root/pi-web-ui/server/src/talker/session-registry.js';
import { planWorkerBrief } from '/root/pi-web-ui/server/src/voice/worker-brief.js';

const SESSION_ID = '01a0a575-7d40-7494-847d-2f42042c7759';

async function main() {
  const registry = new TalkerSessionRegistry({
    multiSessionManager: {
      getSessionStatus: () => ({ status: 'idle', messageCount: 540 }),
      getAgentSession: () => undefined, // NOT loaded in memory: the operator's case
    } as never,
    deliveries: undefined as never,
    // EXACTLY the production wiring in connection.ts
    resolveWorkerSession: async (sessionId: string) => {
      const entry = await getSessionRegistry(config.sessionRegistryPath).get(sessionId);
      return entry ? { path: entry.path, cwd: entry.cwd } : undefined;
    },
  });

  const snapshot = await registry.workerStateSnapshot(SESSION_ID, 'pi', { historyTail: 2_000 });
  const entries = snapshot.recentHistory ?? [];
  console.log(`resolve+snapshot: activity="${snapshot.activity}" entries=${entries.length} total=${snapshot.historyTotal}`);

  const plan = planWorkerBrief({ entries, total: snapshot.historyTotal ?? entries.length, acknowledgedEntries: 0 });
  const note = plan.lines.join('\n');
  console.log(`brief: mode=${plan.mode} chars=${note.length}`);
  console.log(`first line: ${plan.lines[0]}`);
  console.log(`contains real work: ${/workshop|deck|voice|slide|outline/i.test(note)}`);
  process.exit(entries.length > 0 ? 0 : 1);
}
main().catch((e) => { console.error('FAILED', e); process.exit(2); });
