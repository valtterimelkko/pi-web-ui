# H5 — Reliable Gemma delivery: provider preference + degenerate-output guard

You are a child worker. Complete this end-to-end, then report back. Do not ask the operator anything — if you hit a genuine blocker, stop and report it.

## Why: a measured inference-provider defect

The selected talker model (`google/gemma-4-26b-a4b-it`) is served by **11 OpenRouter inference providers**, and **several serve it broken**. Failure modes are provider-specific and differ between providers:

| Failure mode | Providers that do it |
|---|---|
| **Thought-channel leak** — raw `<\|channel>thought\n<channel\|>` markers returned in the content field | Makora (0/6 ok), SiliconFlow (0/6), Google itself (2/6), Cloudflare |
| **Empty content** — HTTP 200, valid completion, no text | Venice (1/6), Parasail (1/6), NextBit (4/6) |
| **Runaway repetition** — e.g. `"thought"` repeated | DekaLLM (4/6) |

**Measured rates** (identical request, 16-turn history, 6 samples each, reasoning off):

```
Darkbloom   6/6  median 1481ms      DeepInfra  6/6  median  776ms
Novita      5/6  median  614ms      DekaLLM    4/6  median  695ms
NextBit     4/6  median  318ms      Google     2/6  median  675ms
Cloudflare  1/6  Venice 1/6  Parasail 1/6  Makora 0/6  SiliconFlow 0/6
```

**This is an inference-provider defect, not a model defect and not a harness defect.** A zero-history request is always clean; the leak appears once there is assistant history, and the same prompt/model returns good output on a good provider.

**Do not** "fix" this by stripping channel markers from the text: the reply is *entirely* channel noise, so stripping leaves an empty string. Detection is for **retrying**, not for salvaging.

## The fix (three parts — all three are required)

**1. Provider preference.** Ask OpenRouter to prefer providers that serve the model correctly, while still allowing fallbacks (the operator does **not** want a single-provider dependency, and providers change):

```json
"provider": { "order": ["deepinfra", "darkbloom", "novita"], "allow_fallbacks": true }
```

Preference alone was **14/15** viable — good, not sufficient.

**2. A general degenerate-output check** that catches all three failure modes above and does not depend on which provider was used:

```ts
function isDegenerateReply(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true;                                    // empty
  if (/<\|channel>|<channel\|>/.test(t)) return true;      // thought-channel leak
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 8 && new Set(words).size / words.length < 0.3) return true;  // runaway repetition
  if (words.length >= 8 && words.filter(w => w === 'thought').length / words.length > 0.4) return true;
  return false;
}
```

**3. One bounded retry** when the reply is degenerate. Retrying while still preferring the good providers is what closes the remaining gap.

**Measured result of all three together (n=15):**

| Strategy | Viable | Retries | Median | Max |
|---|---|---|---|---|
| Preference only | 14/15 | — | 410 ms | 1383 ms |
| **Preference + 1 retry** | **15/15** | 1 | **438 ms** | **1049 ms** |
| No preference + 1 retry | 13/15 | 12 | 973 ms | 2027 ms |

Note the third row: **relying on the guard alone is worse on every axis** — 12 of 15 requests needed a retry. The preference list is what keeps the retry tax at ~1 in 15.

If the reply is *still* degenerate after one retry, do **not** retry further and do **not** invent a reply: return an honest failure the talker surface can speak. The operator explicitly does **not** want a fallback model at this stage.

## Scope and paths

**Owned:**
- `server/src/talker/model-client.ts` — the provider preference, the degenerate check, the bounded retry.
- `server/tests/unit/talker/model-client.test.ts` — new tests.
- Optionally a small script recording the provider-quality measurement (the probe that produced the table) so it can be re-run when the provider set changes.

**Do not touch:** `session-registry.ts`, `connection.ts` (another child's just-committed work), or the other talker modules. If you find a defect outside your files, report it.

**Do not commit or push.** Leave work in the tree for parent review.

## Method — TDD

1. **RED first** for each of the three parts:
   - the request body omits the provider preference today;
   - a channel-leak reply, an empty reply and a repetition reply each produce a bad turn today (no retry);
   - a *good* reply must NOT be retried (this is a regression guard against retry storms — assert the call count).
2. Implement, then make it green.
3. **Prove the retry is bounded**: a persistently-degenerate provider must produce exactly 2 calls, then an honest failure — never a loop.
4. **Prove good replies are untouched**: one call, no retry, when the reply is fine.
5. **Live-validate**: run `npx tsx scripts/talker-harness.ts --runs 3 --pushback-runs 3` against a real model and report the numbers, plus at least 10 direct calls through the new client checking the degenerate rate is 0 and recording how many retries occurred. Use `OPENROUTER_API_KEY` from `~/.bashrc`. **Never production.**
6. Run the full talker suite (`npx vitest run server/tests/unit/talker/ --reporter=basic`) — it must stay green.

## Environment

- Repo: `/root/pi-web-ui` (main tree). Clean at the parent's last commit; verify `git status --short` first.
- Checks: `npm run typecheck` (exit 0), `npm run lint` (exit 0; ~1700 pre-existing warnings are normal).
- A child shell may leak `OPENCODE_ENABLED`/`PI_MAX_SESSIONS` and cause unrelated failures — rule those out with `env -u OPENCODE_ENABLED -u PI_MAX_SESSIONS` before reporting a regression.

## Stop and report if

- The preference list measurably underperforms (re-run the provider measurement and report the new numbers rather than assuming mine hold).
- The retry cannot be bounded cleanly, or good replies start being retried.
- Any change appears to require touching the gate or another module's contract.

## Hand-back format (report exactly this)

1. **Status**: complete / partial / blocked.
2. **What you changed** — files and the exact shape of preference + detection + retry.
3. **RED→GREEN evidence** — each of the three parts, failing first.
4. **Bounded-retry evidence** — the persistently-degenerate case, with the exact call count.
5. **Good-reply evidence** — one call, no retry (call-count assertion).
6. **Live numbers** — harness runs, plus your own degenerate rate and retry count over ≥10 direct calls.
7. **Checks run** — exact commands with exit status.
8. **What you could NOT do** and why.
9. **Any finding that contradicts this brief** — state it; do not silently adapt.
