# Pi Codex compaction session-ID patch

> Why this repo patches its embedded Pi SDK after install, every layer that keeps that fix alive, and what to do when any of it breaks. If you are an agent dispatched because "compaction broke" or "the postinstall patch failed", this is your runbook.

## The defect (upstream Pi, present in 0.80.5)

All Pi compaction paths — manual `/compact`, extension-triggered `ctx.compact()`, and native automatic compaction — converge on `compact()` in `dist/core/compaction/compaction.js`. In pi-coding-agent 0.80.5, `AgentSession` calls it **without** `sessionManager.getSessionId()`, so `createSummarizationOptions()` builds stream options with no `sessionId`, while ordinary agent turns always carry one.

The OpenAI-Codex adapter (`pi-ai`, `openai-codex-responses.js`) uses `options.sessionId` for the WebSocket request identity, the `session-id` / `x-client-request-id` headers, and `prompt_cache_key`. A summarization request without it goes out with a fresh random identity, and the Codex backend can then fail model-alias resolution. Observed failure (2026-07-09, production session `019f48aa-9021-760b-9f8e-486e10158ad1`):

```
Summarization failed: Codex error: Model not found gpt-5.6-luna-free-1p-codexswic-ev3
```

`gpt-5.6-terra` tolerated sessionless requests; `gpt-5.6-luna` did not. The omission itself is model-agnostic; only the visible symptom is backend-dependent. Do not "fix" this by switching models.

## The fix

Thread the session ID through the compaction call chain so summary requests match normal turns: `AgentSession` → `compact()` → `generateSummary()` / `generateTurnPrefixSummary()` → `createSummarizationOptions()` → `options.sessionId`. No behaviour change for providers that ignore `options.sessionId`.

Upstream status: unfixed as of pi-coding-agent 0.80.5 / upstream `main` on 2026-07-10. Issue draft (operator files it manually): `/root/pi-enhancement/auto-compact-75/upstream-issue-draft.md`.

## The layers that keep the fix alive

Two independent Pi installs need the fix, and each has its own repair mechanism:

| Install | Fixed by | Reapplied when |
|---|---|---|
| **This repo's embedded SDK** (`node_modules/@earendil-works/pi-coding-agent`) | `scripts/patch-pi-codex-compaction-session-id.mjs` | Every `npm install` (postinstall hook in `package.json`) |
| **Global CLI** (`$(npm root -g)/@earendil-works/pi-coding-agent`) | `/root/pi-enhancement/scripts/patch-pi-compaction-session-id.mjs` (same replacements, takes a target dir) | `pi-update` wrapper, **and** auto-heal by the `auto-compact-75` extension (below) — plain `pi update` wipes the patch |

### The postinstall patch script (this repo)

`scripts/patch-pi-codex-compaction-session-id.mjs` classifies the installed SDK before touching anything:

- **unpatched 0.80.5 shape** → applies the patch
- **already patched** → no-op success
- **upstream ships its own sessionId propagation** → no-op success with a retirement notice (`npm install` is never blocked by upstream fixing the bug)
- **unrecognised drift** → throws, `npm install` fails loudly, files untouched — this is intentional: a silent unpatched install would mean silent Codex compaction breakage later

**Workspace caveat (observed on the 0.80.6 bump):** a *targeted* install such as `npm install @earendil-works/pi-coding-agent@<ver>` (with or without `--workspace=…`) does **not** reliably run the root postinstall in this workspace setup — the SDK was replaced but left unpatched. A plain full `npm install` does run it. After any SDK version bump: run `node scripts/patch-pi-codex-compaction-session-id.mjs` manually and then `npx vitest run server/tests/unit/pi-codex-compaction-session-id.test.ts` before restarting the service.

Regression tests:

- `server/tests/unit/pi-codex-compaction-session-id.test.ts` — asserts the *installed* SDK actually propagates the session ID. When upstream ships its own fix in a different shape, this test fails on the next dependency bump: that failure is the signal to retire the patch script, the postinstall hook, this doc's patch layers, and the extension's arity probe.
- `server/tests/unit/pi-codex-compaction-patch-script.test.ts` — fixture-based test of all four classifier behaviours.

### The auto-heal extension (outside this repo, but load-bearing for Pi sessions here)

`~/.pi/agent/extensions/auto-compact-75/` (source + tests: `/root/pi-enhancement/auto-compact-75/`) is loaded by **both** the global CLI and this repo's embedded SDK. Besides triggering compaction at a model-relative 75%, it:

- probes at `session_start` whether the running SDK propagates the session ID (arity check: exported `compact.length >= 10`);
- if not, runs the pi-enhancement patcher against the SDK install resolved from `process.argv[1]` (works for the CLI and for this server) and emits a warning notification that the **already-running process still uses unpatched code** until restarted;
- exposes `/autocompact75` (status: resolved SDK path, threshold, context usage, integrity verdict) and `/autocompact75 compact` (trigger compaction through the exact `ctx.compact()` path the 75% trigger uses — also the only way to compact a Pi session via the Internal API, since the browser's `/compact` is a client-side WebSocket message);
- auto-resumes the agent after a mid-task 75% compaction: `ctx.compact()` aborts any in-flight run and never restarts it (unlike native auto-compaction, which continues via `agent.continue()`), so when the compacted turn ended with tool calls the extension queues a resume message (`pi.sendMessage(..., { triggerTurn: true })`) and the agent proceeds with the task on its own. Details + tests: `/root/pi-enhancement/auto-compact-75/README.md`. Live-validate with `scripts/ws-validate.mjs --step resume` ([`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md)).

## Failure modes — none of them silent

| What breaks | How it surfaces | What to do |
|---|---|---|
| Upstream 0.80.x refactors the compaction source without fixing it | `npm install` here fails loudly in postinstall; CLI-side auto-heal warns every session start ("Auto-repair failed: Refusing to patch …") | Update the replacement snippets in both patch scripts to the new shape (keep them equivalent), re-run both repos' tests |
| Upstream ships its own fix | Postinstall prints a retirement notice; `pi-codex-compaction-session-id.test.ts` fails on the dependency bump; extension probe may warn spuriously if the new signature keeps arity < 10 | Retire: postinstall hook + patch script + both regression tests here; patcher + `pi-update` in pi-enhancement; arity probe + auto-heal in the extension |
| `pi update` replaces the global CLI | First pi start after the update: extension notification says it auto-repaired and asks for a restart | Restart pi; nothing else |
| Extension missing/broken (not loaded) | No 75% compaction and no integrity warnings; native auto-compaction still works at ~95% (`compaction.enabled` must stay `true` in `~/.pi/agent/settings.json` — it also gates overflow recovery) | Redeploy from `/root/pi-enhancement/auto-compact-75/`, run its tests |
| Codex compaction fails anyway | `Summarization failed: …` in the session; `/autocompact75` shows `SDK integrity: PROBLEM` | Run `/autocompact75` in the affected runtime, check which install it resolved, run the matching patcher manually, restart |

## How to verify end-to-end (10 minutes)

1. `node -e "import('<sdk>/dist/core/compaction/compaction.js').then(m=>console.log(m.compact.length))"` → must print `10` for both installs.
2. `PI_OFFLINE=1 pi --no-session --no-tools --no-skills -p '/autocompact75'` → `SDK integrity: OK`.
3. Full browser-path proof (extension command + real Codex compaction): follow **Option 3** in [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) — create a Pi session on a disposable server, `--step command --text "/autocompact75"`, two small prompts, then `--step command --text "/autocompact75 compact"` and check the session JSONL for a `"type":"compaction"` entry. Validated 2026-07-10 on gpt-5.6-terra, -luna, and -sol.

## History

- 2026-07-09 — Luna compaction failure diagnosed; embedded SDK patched (`026c651`), full server suite + real cloned-session compaction verified.
- 2026-07-09 — Patch script made upstream-aware; fixture tests added (`c4a7128`). Global CLI patched; `pi-update` wrapper + extension integrity probe added (pi-enhancement).
- 2026-07-10 — Extension auto-heal after `pi update`; `/autocompact75 compact`; live-validated across all three Codex 5.6 models over the browser WebSocket path.
