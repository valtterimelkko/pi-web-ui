// Verify the SHIPPED artifact, not the TS source: server/dist + the real session registry.
import { getSessionRegistry } from '/root/pi-web-ui/server/dist/session-registry.js';
import { config } from '/root/pi-web-ui/server/dist/config.js';
import { TalkerSessionRegistry } from '/root/pi-web-ui/server/dist/talker/session-registry.js';
import { planWorkerBrief } from '/root/pi-web-ui/server/dist/voice/worker-brief.js';

const SESSION_ID = '01a0a575-7d40-7494-847d-2f42042c7759';
const registry = new TalkerSessionRegistry({
  multiSessionManager: {
    getSessionStatus: () => ({ status: 'idle', messageCount: 540 }),
    getAgentSession: () => undefined,
  },
  resolveWorkerSession: async (id) => {
    const entry = await getSessionRegistry(config.sessionRegistryPath).get(id);
    return entry ? { path: entry.path, cwd: entry.cwd } : undefined;
  },
});
const snapshot = await registry.workerStateSnapshot(SESSION_ID, 'pi', { historyTail: 2_000 });
const entries = snapshot.recentHistory ?? [];
const plan = planWorkerBrief({ entries, total: snapshot.historyTotal ?? entries.length, acknowledgedEntries: 0 });
console.log(`DIST: entries=${entries.length} total=${snapshot.historyTotal} mode=${plan.mode} chars=${plan.lines.join('\n').length}`);
process.exit(entries.length > 0 ? 0 : 1);
