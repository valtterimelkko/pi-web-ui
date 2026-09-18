/** Scratch check: the operator's real session, through the shipped reader + policy. */
import { readSessionFileHistory } from '/root/pi-web-ui/server/src/talker/session-file-history.js';
import { planWorkerBrief, searchWorkerHistory } from '/root/pi-web-ui/server/src/voice/worker-brief.js';

const PATH = '/root/.pi/agent/sessions/--root-si--/2026-09-15T14-25-35-552Z_01a0a575-7d40-7494-847d-2f42042c7759.jsonl';

async function main() {
  const started = Date.now();
  const history = await readSessionFileHistory(PATH, { maxEntries: 2000 });
  const readMs = Date.now() - started;
  console.log(`file read: ${history.total} conversation messages, kept ${history.entries.length}, ${readMs} ms`);

  const plan = planWorkerBrief({ entries: history.entries, total: history.total, acknowledgedEntries: 0 });
  const note = plan.lines.join('\n');
  console.log(`brief: mode=${plan.mode} chars=${note.length}`);
  console.log('--- first 3 lines ---');
  console.log(plan.lines.slice(0, 3).join('\n'));
  console.log('--- last 2 lines ---');
  console.log(plan.lines.slice(-2).join('\n'));

  const found = searchWorkerHistory(history.entries, 'voice lane capture worklet', { limit: 3 });
  console.log(`retrieval: matches=${found.matches} searched=${found.searched} chars=${found.text.length}`);

  const cached = Date.now();
  await readSessionFileHistory(PATH, { maxEntries: 2000 });
  console.log(`second identical read: ${Date.now() - cached} ms (module does not cache; the registry does)`);
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
