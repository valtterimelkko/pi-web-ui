// The SHIPPED wiring unit + shipped registry + the real session resolver, worker session absent from memory.
import { getSessionRegistry } from '/root/pi-web-ui/server/dist/session-registry.js';
import { config } from '/root/pi-web-ui/server/dist/config.js';
import { TalkerSessionRegistry } from '/root/pi-web-ui/server/dist/talker/session-registry.js';
import { createWorkerBriefSource } from '/root/pi-web-ui/server/dist/websocket/worker-brief-source.js';
import { planWorkerBrief } from '/root/pi-web-ui/server/dist/voice/worker-brief.js';

const SESSION_ID = '01a0a575-7d40-7494-847d-2f42042c7759';
const registry = new TalkerSessionRegistry({
  multiSessionManager: { getSessionStatus: () => ({ status: 'idle', messageCount: 540 }), getAgentSession: () => undefined },
  resolveWorkerSession: async (id) => {
    const entry = await getSessionRegistry(config.sessionRegistryPath).get(id);
    return entry ? { path: entry.path, cwd: entry.cwd } : undefined;
  },
});
const brief = await createWorkerBriefSource({ talkerSessionRegistry: registry })(SESSION_ID);
const entries = brief.entries ?? [];
const plan = planWorkerBrief({ entries, total: brief.total ?? entries.length, acknowledgedEntries: 0 });
console.log(`WIRING: activity="${brief.activity}" entries=${entries.length} total=${brief.total} mode=${plan.mode} chars=${plan.lines.join('\n').length}`);
process.exit(entries.length > 0 ? 0 : 1);
