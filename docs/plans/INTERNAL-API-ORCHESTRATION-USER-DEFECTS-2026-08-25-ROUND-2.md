# Internal API orchestration — defects, round 2

_From a consuming agent's seat, 2026-08-25, after contract **1.25.0**. Round 1 is [`INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25.md`](./INTERNAL-API-ORCHESTRATION-USER-DEFECTS-2026-08-25.md); this round both confirms what 1.25.0 fixed and reports what the fix introduced._

The consuming workload was a real one: a **3½-hour MEM-4 memory-consolidation run** in `/root/agent-os`, one durable Pi child on `openai-codex/gpt-5.6-sol`, which itself dispatched four GLM harness workers. The parent was a **bare Claude Code CLI** — a harness the server cannot prompt — which is why the watch-side items below matter.

---

## Confirmed fixed in 1.25.0 — verified live, not read from the changelog

| Round-1 defect | Verification |
|---|---|
| A model request could be silently ignored while the response claimed success | `POST /sessions` now returns `modelBinding { requested, resolved, fallbackApplied }` and `resolvedModel`. Observed `{"requested":"openai-codex/gpt-5.6-sol","resolved":"openai-codex/gpt-5.6-sol","fallbackApplied":false}`. |
| A run reporting `completed` does not mean the work finished | `workState` / `cessation` now expose `turn_ended_unconfirmed` vs confirmed cessation. |
| No way to ask "is my child still working?" | `/info` now carries `busy`, derived from runtime state rather than stale registry status. |

**One nuance worth keeping.** The underlying Pi init sequence is unchanged — the on-disk session file still records two `model_change` entries 71 ms apart (`zai/glm-5.3` then `openai-codex/gpt-5.6-sol`). That is fine. The fix correctly changed what the API *reports* rather than the init order, and `modelBinding` is now the cheap, honest read. Consumers inspecting the raw file should still know the **last** entry binds.

---

## 1. `POST /sessions` now rejects a bare model id that worked at 1.24.0

**Severity: high.** The changelog states *"Everything is additive; existing consumers keep working unchanged."* That is not true for this case.

**How it was observed.** At 10:22 today, against 1.24.0, this created the working session that ran the entire MEM-4 job:

```json
{"runtime":"pi","model":"gpt-5.6-sol","thinkingLevel":"medium","cwd":"/root/agent-os"}
```

It bound correctly — `/info` reported `openai-codex/gpt-5.6-sol`, and the on-disk record showed a single clean `model_change` to that provider and id.

The identical call against 1.25.0 now returns:

```
422 MODEL_NOT_APPLIED
"Invalid model ID format: gpt-5.6-sol. Expected \"provider/model-name\""
```

Had the MEM-4 dispatch begun an hour later it would have failed at the door.

**What would fix it.** Either:

- **Resolve an unambiguous bare id** — if exactly one advertised model across enabled providers carries that `id`, bind it and report the qualified form in `resolvedModel`; if several match, `422` listing the candidates. This preserves the honesty goal (the response still states what it actually bound) without breaking working callers; or
- **Call it breaking.** If strict qualification is wanted, say so explicitly in the changelog rather than under "additive", since a consumer reading "additive" has no reason to retest.

---

## 2. `/models` does not expose the selector its own error message says it provides

**Severity: high — this is the one that will bite the next consumer.** It is also what makes defect 1 sharp rather than merely annoying.

**How it was observed.** The `422` hint reads *"Use the exact 'provider/model' selector from the models list … discovery clients already receive exact selectors."* They do not. `GET /api/v1/models` returns, per entry:

```json
{"id":"gpt-5.6-sol","displayName":"GPT-5.6 Sol","provider":"openai-codex",
 "contextWindow":372000,"reasoning":true,"thinkingLevels":["off","minimal","low","medium","high","xhigh","max"]}
```

Fields checked programmatically: no key containing `selector`. `id` and `provider` are **separate fields**. A consumer following the documented discovery flow — "read its `id`, `provider`, `thinkingLevels`" — naturally passes `id`, which is now rejected, and must infer that string concatenation with `/` is required.

**What would fix it.** Add a `selector` field to every entry in `/models`, whose value is exactly what `POST /sessions` accepts:

```json
{"id":"gpt-5.6-sol","provider":"openai-codex","selector":"openai-codex/gpt-5.6-sol", …}
```

Then the error hint becomes true, discovery clients copy rather than construct, and the orchestration guidance's "use its returned `id`" can be corrected to "use its returned `selector`". Retrofitting this makes defect 1 mostly self-correcting.

---

## 3. A watch cannot be waited on — only polled

**Severity: medium. This is a feature request, not a regression**, and it is the only part of the round-1 wake story still open.

**Context, including a correction to my own round-1 framing.** I previously treated "a bare Claude CLI has no wake path" as meaning the watch system was unavailable to such a parent. That was wrong, and the docs are right: `onFire` **delivery** cannot reach a bare CLI, but that parent can still `POST /sessions/:id/watch` with no `onFire` (a pure observer) and read it via `GET /sessions/:id/watch`, getting the server's own condition evaluation and durable ledger. Not doing so cost me three incorrect hand-rolled stuck-detectors before I got one right. The gap below is real, but narrower than round 1 implied.

**How the gap was observed.** Watching one child for 93 minutes required a 60-second poll loop — roughly 93 cycles against `/info` and `/runs/:runId`. The child finished at **13:35**; my detector reached that conclusion at **13:53**. An 18-minute lag, and only by *inferring an absence* (session quiet, every dispatched worker terminal) rather than observing an event.

**What would fix it.**

```
GET /api/v1/watches/wait?ids=<w1,w2,…>&since=<cursor>&timeout=<ms>
```

Long-poll: block until one of the named watches fires, return the fired event(s) plus a new cursor, `204` on timeout.

Why this shape rather than another delivery mode: **a bare CLI's wake primitive is "a subprocess exits."** A blocking HTTP call that returns *is* an exit. So this hands the server's full condition vocabulary to any consumer that can spawn a subprocess — Claude Code, a shell script, cron, CI — without the server needing to reach into any of them. It decouples **condition evaluation** (server-side, already built and correct) from **wake delivery** (client-side, harness-specific), which are currently welded together.

Three properties, in value order:

- **`since=<cursor>`** turns *at-most-once-if-listening* into *at-least-once-resumable*. A watcher that dies, or a parent whose usage window ends, reconnects with its last cursor and receives what it missed.
- **`ids=`** gives real fan-in in one call. Today N children means N polls; I resorted to regexing run ids out of the child's status file.
- **Blocking beats polling** on both latency and request volume — one held connection instead of ~60 requests an hour, waking in milliseconds.

`GET /sessions/:id/wait?status=idle&timeout=` already establishes the long-poll pattern; this extends it from session status to watch conditions, and from one subject to several.

**Deliberately not proposed:** `onFire.type: "exec"` or a webhook. More flexible, but it lets a watch record trigger arbitrary local execution — a real security surface. Blocking-wait keeps control client-side and is simpler to reason about.

---

## 4. Not a defect — a documentation change worth keeping

1.25.0 states plainly that *"an observed `agent_end` alone does not confirm work completion — a detached child can yield its turn awaiting a wake while its nested work continues, and the two are indistinguishable from the turn boundary."*

That is precisely the trap my first watcher fell into: it read run-terminal plus session-idle as failure, at a perfectly healthy turn boundary, while the child was mid-orchestration. Documenting it, and giving consumers `workState` as the discriminator, is the right fix. Please keep that sentence.

---

## Severity, from the consuming side

| # | Item | Severity | Why |
|---|---|---|---|
| 2 | `/models` lacks `selector` | **High** | Makes #1 unavoidable for any consumer following documented discovery |
| 1 | Bare model id now `422` | **High** | Silent break for working callers, filed under "additive" |
| 3 | No blocking wait on watches | Medium | Workable by polling; costs latency and request volume |
| 4 | `agent_end` semantics | — | Already correct; noted so it is not regressed |

## What worked well, and is worth not breaking

- `modelBinding` is exactly the right shape — it answers "what did I actually get?" in one read, and `fallbackApplied` makes a substitution impossible to miss.
- `follow_up` semantics behaved exactly as documented across a long run: queued against a busy session, and idle-promoted to `prompt` with `dispatchMode` reporting the operation actually performed.
- Durable retention held a 3½-hour child across renewals without incident.
- `GET /sessions/:id/transcript` remained the reliable inspection path throughout, as the guidance says.
