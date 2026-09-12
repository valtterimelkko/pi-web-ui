/**
 * talker-h3-probe.mjs — H3 talker-retest support (plan H3, 2026-09).
 *
 * For each H3 candidate selector, confirm the selector resolves on the live
 * OpenRouter route and capture the SERVED-model identity (routing id could
 * silently differ from the upstream provider/model that actually serves the
 * call). Uses the same request shape as server/src/talker/model-client.ts
 * (non-streaming here, so the response's `model`/`provider` fields are
 * available), including the hardcoded `reasoning: { enabled: false }`, so any
 * candidate that cannot accept that setting fails here rather than mid-run.
 *
 * Read-only support script; it does not modify the talker harness.
 *
 * Usage: eval "$(grep '^export OPENROUTER_API_KEY' ~/.bashrc)" && npx tsx scripts/talker-h3-probe.mjs
 */

const CANDIDATES = [
  'google/gemma-4-26b-a4b-it',
  'google/gemini-3.6-flash',
  'deepseek/deepseek-v4.1-flash',
  'openai/gpt-4o-mini',
  'openai/gpt-5-nano',
];

const key = process.env.OPENROUTER_API_KEY || process.env.TALKER_API_KEY || '';
if (!key) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(1);
}

for (const model of CANDIDATES) {
  const started = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://pi-web-ui.local',
        'X-Title': 'pi-web-ui talker h3 probe',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 16,
        stream: false,
        temperature: 0.3,
        reasoning: { enabled: false },
      }),
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      console.log(`${model}\n  HTTP ${res.status} in ${ms}ms: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    const body = await res.json();
    console.log(
      `${model}\n` +
      `  served model: ${body.model}\n` +
      `  provider:     ${body.provider}\n` +
      `  gen id:       ${body.id}\n` +
      `  content:      ${JSON.stringify(body.choices?.[0]?.message?.content)}\n` +
      `  latency:      ${ms}ms (non-stream total)`
    );
  } catch (e) {
    console.log(`${model}\n  ERROR after ${Date.now() - started}ms: ${e.message}`);
  }
}
