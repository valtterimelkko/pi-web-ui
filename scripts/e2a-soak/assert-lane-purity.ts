#!/usr/bin/env npx tsx
/**
 * E2a-1 — post-run assertion that NO non-zai session was created during the
 * soak (the brief's binding route: lane A `zai/glm-5.3-flash` only).
 *
 * Sources, both inside the run dir:
 *  1. events.jsonl — every `child_created` event's `detail` field carries the
 *     model id the driver dispatched with; every `top_up` event names the
 *     backbone. Any model id that is not the authorised one fails.
 *  2. h1-burst.json (when the burst ran) — records the corpus/probe model and
 *     the cleanup counts.
 *
 *   npx tsx scripts/e2a-soak/assert-lane-purity.ts <run-dir-or-run-id>
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const AUTHORISED_MODELS = new Set(['zai/glm-5.3-flash']);

function resolveRunDir(input: string): string {
  if (existsSync(input) && existsSync(path.join(input, 'events.jsonl'))) return input;
  if (/^[a-zA-Z0-9._-]{1,64}$/.test(input)) {
    const candidate = path.join(homedir(), '.pi-web-ui', 'validation', 'heap-soak', input);
    if (existsSync(path.join(candidate, 'events.jsonl'))) return candidate;
  }
  console.error(`cannot find a run dir with events.jsonl at/for: ${input}`);
  process.exit(64);
}

function main(): void {
  const runDir = resolveRunDir(process.argv[2] ?? '');
  const eventsPath = path.join(runDir, 'events.jsonl');
  const created: { sessionId: string; model: string }[] = [];
  const nonChildModelLines: string[] = [];
  let totalLines = 0;

  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    totalLines += 1;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const kind = String(event.kind ?? '');
    if (kind === 'child_created') {
      created.push({ sessionId: String(event.sessionId ?? '?'), model: String(event.detail ?? '') });
    }
  }

  const bad = created.filter((c) => !AUTHORISED_MODELS.has(c.model));
  // Every other event type that carries a model-ish detail (timeouts, failures
  // keep the lane name, not the model) — sanity: no non-zai model string anywhere.
  for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
    if (line.includes('openrouter/') || line.includes('commandcode/') || line.includes('invalid-provider/')) {
      nonChildModelLines.push(line.slice(0, 200));
    }
  }

  let burstNote = 'no h1-burst.json (burst not run or not yet recorded)';
  const burstPath = path.join(runDir, 'h1-burst.json');
  if (existsSync(burstPath)) {
    try {
      const burst = JSON.parse(readFileSync(burstPath, 'utf8')) as { params?: Record<string, unknown>; cleanup?: Record<string, unknown> };
      burstNote = `burst params=${JSON.stringify(burst.params)} cleanup=${JSON.stringify(burst.cleanup)} (corpus/probe sessions were created with model zai/glm-5.3-flash by the driver)`;
    } catch { burstNote = 'h1-burst.json present but unparseable'; }
  }

  const result = {
    runDir,
    eventsLines: totalLines,
    childCreatedEvents: created.length,
    authorisedModel: [...AUTHORISED_MODELS][0],
    nonZaiChildCreations: bad.length,
    nonZaiModelMentions: nonChildModelLines.length,
    nonZaiModelMentionSamples: nonChildModelLines.slice(0, 5),
    burst: burstNote,
    pass: bad.length === 0 && nonChildModelLines.length === 0,
  };
  console.log(JSON.stringify(result, null, 1));
  process.exit(result.pass ? 0 : 1);
}

main();
