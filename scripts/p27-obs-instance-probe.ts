import { getRecentVoiceTurns, getVoiceLaneBindings } from '../server/src/talker/observability.js';

async function main(): Promise<void> {
  const { TalkerSessionRegistry } = await import('../server/src/talker/session-registry.js');
  const { createNullDelivery } = await import('../server/src/talker/delivery.js');
  const d = createNullDelivery();
  const registry = new TalkerSessionRegistry({
    multiSessionManager: { resolveSessionRef: (x) => x, getSessionStatus: () => undefined } as never,
    modelClient: { completeTurn: async () => ({ text: 'ok', ttftMs: 1, totalMs: 1 }) },
    deliveries: { pi: d, claude: d, antigravity: d },
  });
  const r = await registry.handleOperatorTurn({ workerSessionId: 'probe-lane', utterance: 'hello there' });
  console.log('turn reply:', r.reply);
  console.log('lanes read via STATIC import:', JSON.stringify(getVoiceLaneBindings()));
  console.log('recent read via STATIC import:', getRecentVoiceTurns(5).length);
  const obs = await import('../server/src/talker/observability.js');
  console.log('same module instance?', obs.getVoiceLaneBindings === getVoiceLaneBindings);
  console.log('lanes read via DYNAMIC import:', JSON.stringify(obs.getVoiceLaneBindings()));
  console.log('recent read via DYNAMIC import:', obs.getRecentVoiceTurns(5).length);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
