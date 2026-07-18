# TDD Plan — Enrich Pi SDK Subagent Cards (model + tool-usage summary)

> Historical execution plan. The live-card work shipped in `f5fc841` / `61126aa`.
>
> **Status:** implemented and archived. The 2026-07-10 replay follow-up also
> shipped: reopened Pi sessions restore only compact `subagent` /
> `evaluated_subagent` cards using `SubagentToolSummary`; inner transcripts,
> commands, and final reports are not replayed. For current behaviour, inspect
> [`EVENT-PIPELINE.md`](./EVENT-PIPELINE.md) and
> [`CODEBASE-MAP.md`](./CODEBASE-MAP.md). The executor checklist below is
> historical evidence, not a request to repeat the implementation.

---

## 0. TL;DR for the executor

Pi SDK subagents render as a **thin nameplate** in the web UI (agent name + a ✓) with
no model and no stats, while the CLI is verbose. The rich data **already exists** in the
Pi `toolResult.details` object; the client throws it away one line before the card sees it.

You will:
1. Add a **pure, shared** summarizer that turns Pi `details` into a **compact**
   `SubagentToolSummary` (model, per-tool counts, turns, tokens, cost).
2. Plumb **only that compact summary** to the client (never the raw inner transcript).
3. Teach `SubagentToolCard` to render the summary (collapsed = model + one-line tool
   summary; expanded = per-agent breakdown).
4. Keep the `shared/src/screen-view.ts` projection + its conformance tests in sync.

This is **plumbing + one pure function + rendering**, TDD throughout. Scope is tight.
Read the memory note `subagent-card-details-gap` and `screen-view-observability-feature`
before starting.

---

## 1. Root cause (verified against the real session)

- The frontend routes `subagent`/`Agent`/`Task` tools to
  `client/src/components/Tools/SubagentToolCard.tsx`.
- That card only shows stats **if** it can `JSON.parse` the tool **result text** into
  `{ tasks | chain | summary, totalUsage }` (`parseSubagentResult`). **Pi SDK never emits
  that shape.** The existing `client/tests/unit/components/Tools/SubagentToolCard.test.tsx`
  is written entirely against that synthetic legacy shape — i.e. the card is tested against
  a format nothing in this product produces.
- Pi SDK's real subagent `toolResult` is:
  ```
  role: "toolResult", toolName: "subagent",
  content: [{ type: "text", text: "<subagent's final markdown answer>" }],  // <- all the card gets
  details: { mode, agentScope, projectAgentsDir, results: [ … ] }           // <- the rich data
  ```
- The client drops `details` in `client/src/store/sessionStore.ts` at the two
  `tool_execution_end` handlers (live ≈ line 1602, replay ≈ line 2115) via
  `extractToolResultText(result)` (keeps only `content[].text`). The client
  `Message.toolResult` type is `{ output, isError }` — there is **no field** for a summary.

**Ground-truth session used for fixtures (real, on this box):**
`~/.pi/agent/sessions/--root-agent-os--/2026-07-03T21-59-33-537Z_019f29fe-83a1-7bf2-a21d-fe10363ccce5.jsonl`
(483 entries; 4 `subagent` + 2 `evaluated_subagent` calls).

---

## 2. The two real `details` shapes (both must be handled)

### 2a. `subagent` tool → `details`
```jsonc
{
  "mode": "single",           // or "parallel" | "chain"
  "agentScope": "user",
  "projectAgentsDir": null,
  "results": [
    {
      "agent": "codescout",
      "agentSource": "user",
      "task": "<delegated task text>",
      "exitCode": 0,
      "messages": [ /* FULL inner transcript: user/assistant/toolResult msgs */ ]
    }
  ]
}
```
Each inner `assistant` message carries `provider`, `model`, `usage` (`{input, output,
cacheRead, cacheWrite}`) and content blocks of type `toolCall` (with `.name`). Everything
you need is derivable from `results[].messages[]`.

### 2b. `evaluated_subagent` tool → `details`
```jsonc
{
  "run_id": "sa_…",
  "agent": "reviewer",
  "round": 1,
  "timedOut": false,
  "hadFinalOutput": true,
  "exitCode": 0,
  "usage": { "input": 203879, "output": 7127, "cacheRead": 882176, "cacheWrite": 0, "cost": 1.674293, "turns": 19 }
}
```
No inner `messages` → **no model, no tool breakdown**. Only usage/turns/cost. The summarizer
and card must degrade gracefully (omit model + tool breakdown, still show turns/tokens/cost).

### 2c. Exact assertion targets (from the real file — your tests MUST match these)
| call | agent | model | tool breakdown (name:count) | turns | in / out tokens |
|---|---|---|---|---|---|
| subagent #1 | `codescout` | `github-copilot/gpt-5.4-mini` | read:26, grep:16, find:3, ls:1 (total 46) | 13 | 100770 / 15350 |
| subagent #2 | `reviewer` | `openai-codex/gpt-5.5` | read:13, grep:9, bash:4, find:1 (total 27) | 25 | 91061 / 6921 |
| evaluated_subagent #1 | `reviewer` | *(none)* | *(none)* | 19 | 203879 / 7127; cacheRead 882176; cost 1.674293 |

> "turns" = count of inner `assistant` messages for the `subagent` shape; for
> `evaluated_subagent` use `usage.turns` verbatim.

---

## 3. Data contract (the compact summary — the ONLY thing that crosses the wire)

Create a new shared module `shared/src/subagent-summary.ts` (pure, no I/O). Export:

```ts
export interface SubagentAgentSummary {
  agent: string;                 // "codescout"
  model?: string;                // "github-copilot/gpt-5.4-mini" (provider/model); undefined if unknown
  task?: string;                 // delegated task; TRUNCATE to <= 300 chars in the summarizer
  exitCode?: number;
  timedOut?: boolean;
  turns: number;
  toolCalls: number;             // total inner tool calls
  toolBreakdown: Array<{ name: string; count: number }>; // sorted count desc, then name asc
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface SubagentToolSummary {
  mode: string;                  // details.mode, or "evaluated" for evaluated_subagent
  kind: 'subagent' | 'evaluated_subagent';
  agents: SubagentAgentSummary[];
  totals: {                      // aggregate across agents
    agentCount: number;
    toolCalls: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd?: number;
  };
}

/** Pure. Returns null when details is absent/unrecognized (card falls back to legacy/plain). */
export function summarizeSubagentDetails(
  toolName: string,
  details: unknown,
): SubagentToolSummary | null;
```

**Size discipline (non-negotiable):** the summary must NOT contain any inner-message text,
transcript, or the subagent's final answer beyond the already-present `output`. It carries
counts/totals only. This is the whole point — see the payload-bloat trade-off. A unit test
must assert the serialized summary for the real `codescout` call is `< 2 KB`.

Wire it into `shared/src/index.ts` exports. Add the `summary?` field to the client tool-result
shape (see §5).

---

## 4. Phase 0 — Reproduce & trace FIRST (mandatory; no code changes yet)

The executor must not touch product code until this is written up in the PR/commit body or a
scratch note, because the plumbing target depends on it.

**0.1** Extract the three real `details` objects from the ground-truth file (2c) into JSON
fixtures under `shared/src/__fixtures__/subagent-details/` (`subagent-codescout.json`,
`subagent-reviewer.json`, `evaluated-reviewer.json`). Use a throwaway node script; do **not**
commit the script. These fixtures ARE committed (they contain only this box's own dev session
data about code structure — verify they contain no secrets/tokens/credentials before adding;
if any inner message text looks sensitive, trim `messages[].content` text to empty strings —
the summarizer never reads text, only block types/usage/model, so trimming text is safe and
preferred).

**0.2** Trace and DOCUMENT the exact runtime path by which a subagent card reaches the screen
in **real usage**, distinguishing:
   - **Live** (active session): `tool_execution_end` → server forward → `sessionStore` live
     handler (≈1602) → `SubagentToolCard`.
   - **Reload** (`switch_session`): `server/src/websocket/connection.ts` `loadSessionMessages`
     (≈1881) currently emits **only `text`/`thinking`** blocks and skips tool blocks entirely.
     Confirm whether a reopened Pi session shows subagent cards at all.

   Record the finding. If reload shows **no** tool cards, then **reload persistence is OUT OF
   SCOPE** for this plan (see §7) and all browser validation must be done on a **live/active**
   session, not a reload. Do not silently "fix" the reload path.

**0.3** Confirm the live `tool_execution_end` SDK event's `result` actually carries `details`
(the persisted file proves the same object is written, but verify on the live event). If it
does not, STOP and report — the whole approach depends on it.

**Gate:** Phase 0 findings written down. No product code changed yet.

---

## 5. Phase 1–3 — TDD implementation (strict red→green→refactor)

Each numbered item is one TDD cycle: **write a failing test first, watch it fail for the right
reason, make it pass with the minimal change, refactor.** Do not batch multiple behaviors into
one untested commit.

### Phase 1 — Shared summarizer (`shared/src/subagent-summary.ts` + `.test.ts`)
1.1 `summarizeSubagentDetails('subagent', codescoutDetails)` → assert model, `toolBreakdown`
    (exact counts from 2c, sorted), `toolCalls === 46`, `turns === 13`, tokens 100770/15350.
1.2 Same for the `reviewer` subagent fixture (2c row 2).
1.3 `summarizeSubagentDetails('evaluated_subagent', evaluatedDetails)` → `kind: 'evaluated_subagent'`,
    `model` undefined, `toolBreakdown` empty, `turns === 19`, tokens 203879/7127, `cacheReadTokens
    === 882176`, `costUsd === 1.674293`.
1.4 `totals` aggregation across a synthetic multi-`results` (`mode:'parallel'`) fixture.
1.5 Edge cases (each its own test, all must return `null` or degrade, never throw):
    `details` undefined; `details` `{}`; `results: []`; a `result` with `messages: []`;
    an assistant message with no `usage`; unknown `toolName`; `cost: 0` (must serialize as `0`,
    not dropped); task text > 300 chars (assert truncated).
1.6 **Size test:** `JSON.stringify(summarizeSubagentDetails('subagent', codescoutDetails)).length < 2048`.

### Phase 2 — Server plumbing (attach compact summary; never raw details)
2.1 Find the **exact** point where the Pi `tool_execution_end` result is serialized toward the
    client for the **live** path (per Phase 0.2 — likely `server/src/pi/event-forwarder.ts`
    `mapEventToMessage` `tool_execution_end`, and/or the `MultiSessionManager` forward). Write a
    server unit test that feeds a `tool_execution_end` event whose `result.details` is the real
    `codescout` fixture and asserts the forwarded message contains a `resultSummary`
    (`SubagentToolSummary`) computed via `summarizeSubagentDetails`, **and that it does NOT
    contain `result.details.results[].messages`** (bloat guard). Then implement.
2.2 Non-subagent tools: assert the forwarded message has **no** `resultSummary` (feature is
    scoped to subagent/evaluated_subagent tool names only). Regression guard.
2.3 Confirm no other runtime (Claude/OpenCode/Antigravity) path is altered — add/keep a test
    that a Claude `Task` tool result is forwarded unchanged (fallback path).

### Phase 3 — Client render (`SubagentToolCard` + `sessionStore` type)
3.1 Extend the client tool-result type in `client/src/store/sessionStore.ts` to
    `toolResult?: { output: string; isError: boolean; summary?: SubagentToolSummary }` and
    populate `summary` from the forwarded `resultSummary` in **both** `tool_execution_end`
    handlers (live ≈1602 and replay ≈2115). Do not otherwise change `extractToolResultText`.
3.2 `SubagentToolCard.test.tsx`: add tests using the **new** `summary` prop (real shapes), NOT
    the legacy JSON. Collapsed state asserts: agent name, **model string visible**, and a
    one-line tool summary (e.g. `46 tools · 13 turns · 116k tok`). Keep at least one legacy-shape
    test passing (backwards-compat / other runtimes) OR delete the legacy path only if Phase 0
    proves nothing produces it — if you delete, say so explicitly and update tests.
3.3 Expanded state asserts the per-agent `toolBreakdown` (e.g. `read ×26`, `grep ×16`) and
    per-agent model + tokens.
3.4 `evaluated_subagent` render: model + breakdown omitted, turns/tokens/cost shown, no crash.
3.5 Graceful fallback: `summary` absent AND legacy JSON absent → renders today's plain header
    (no regression, no throw).

### Phase 3.6 — Screen-view sync (REQUIRED, not optional)
`shared/src/screen-view.ts` is the declared single source of truth for "what the user sees",
enforced by `client/tests/unit/components/Chat/screen-view-conformance.test.tsx` and
`shared/src/screen-view.test.ts` + `server/tests/**/internal-api-screen-view.test.ts`.
3.6.1 Run those three suites; if the enriched card changes what a subagent item shows, update
      the projection so a subagent `ScreenItem` carries the same compact summary (or its
      one-line text), and update the tests. The agent's `view=screen` output MUST stay faithful
      to the UI. Do not leave the conformance test red or the projection stale.

---

## 6. TDD & code-quality rules (the executor WILL be audited on these)

- **Red before green, every cycle.** For each behavior: commit-or-note the failing test output
  first, then the implementation. No implementation-without-a-failing-test. Reviewer may ask you
  to reproduce a red run.
- **No skipping.** Zero new `it.skip` / `test.skip` / `.only`. If a test is hard, that is signal,
  not license to skip. The server baseline is **0 failures** (memory `pre-existing-sse-test-hang`)
  — keep it at 0.
- **Real data, not synthetic-only.** The summarizer's correctness tests must use the fixtures
  extracted from the real session (2c numbers). Synthetic fixtures are allowed only for
  aggregation/edge cases.
- **Minimal diff.** Touch only: `shared/src/subagent-summary.ts` (+test +fixtures +index export),
  the one server forward point (+test), `sessionStore.ts` type + two handlers, `SubagentToolCard.tsx`
  (+test), and `screen-view.ts` (+tests) if 3.6 requires. No drive-by refactors, no reformatting
  unrelated code, no dependency changes.
- **No `any` leakage / typed shapes.** New shared types are exported and used; validate `details`
  defensively (it is untyped SDK data) — never assume shape without guarding.
- **Security invariants unchanged.** No new REST route here; if you add one for a deep transcript
  (out of scope, don't), it needs `cookieAuthMiddleware` + Zod. Do not weaken auth/CSRF/origin.
- **No secrets / no strays.** The repo is permanently public. Fixtures must contain no tokens,
  cookies, or credentials (see 0.1 — prefer trimming inner message text to empty). Never `git add`
  throwaway scripts, `.env*`, `*.bak`, or another agent's files.

---

## 7. Scope

**In scope:** the live-path compact summary → enriched `SubagentToolCard` for Pi
`subagent` + `evaluated_subagent`, plus screen-view sync.

**Out of scope (do NOT do without a new plan):**
- General tool-card replay for every Pi tool. The 2026-07-10 follow-up deliberately restores
  **only** compact `subagent` / `evaluated_subagent` cards; extending this to other tool families
  remains a separate design task.
- Shipping the raw inner transcript over the wire, or a deep "inner transcript" lazy endpoint.
- Live per-tool streaming of the subagent's inner activity (would require bridging the SDK's
  nested event stream — large, higher-risk).
- Changing Claude/OpenCode/Antigravity subagent rendering.

---

## 8. Live-validation protocol (prod + internal API + Playwright — you have permission)

Two independent proofs are required; **both** must pass. Save all evidence under a gitignored
scratch dir (e.g. `/tmp/.../scratchpad/subagent-validate/`) — do **not** commit evidence.

### 8.1 Deterministic server proof (primary correctness)
Add a **server integration test** (`server/tests/integration/`) that reads the real session file
`~/.pi/agent/sessions/--root-agent-os--/…019f29fe….jsonl`, pulls each subagent/evaluated_subagent
`toolResult.details`, runs it through the **actual forward/serialize path**, and asserts the emitted
`resultSummary` matches the 2c table exactly (model strings, tool counts, turns, tokens, cost).
This is the anti-regression backbone: real bytes, exact numbers.

### 8.2 Browser end-to-end proof (must be on a LIVE session, per Phase 0.2)
Because reload drops tool cards, validate on an **active** session:
1. Boot a browser-ready validation server per memory `webui-live-validation-mechanics`
   (`NODE_ENV=production`, bcrypt `AUTH_PASSWORD`, `ALLOWED_ORIGINS` including the browser origin),
   OR drive prod on `127.0.0.1:3456` via a minted JWT per `webui-live-validation-mechanics`
   ("Driving PROD directly"). Isolate writable dirs when using a disposable server.
2. Via the **Internal API** (`pi-web-ui-internal-api-orchestration` skill; Unix socket + Bearer
   token at `~/.pi-web-ui/internal-api.sock` / `internal-api-token`), create a Pi session and send
   a prompt that dispatches a **real subagent** (e.g. the user-scoped `codescout` or `reviewer`
   agent). If dispatching a real subagent is impractical in the environment, that is a blocker to
   report — not a reason to skip; coordinate a model/agent that works.
3. In **Playwright**, open that live session in the browser and capture the WS frames
   (native `page.on('websocket', …)`, `frame.payload` per `webui-live-validation-mechanics`).
   Prove: the `tool_execution_end` frame for the subagent carries `resultSummary` with a real
   `model` and non-empty `toolBreakdown`, and carries **no** inner `messages` (bloat guard).
4. Screenshot the rendered `SubagentToolCard` showing **model + one-line tool summary collapsed**,
   and the **per-tool breakdown when expanded**. Save both PNGs as evidence.
5. Clean up: delete the test session file and any opt-in/registry entries you created (memory
   `webui-live-validation-mechanics` cleanup notes). Kill only your own tracked `$!` PID — never a
   broad `pkill` (memory `prod-deploy-topology`); never touch the `pi-claude-channel` bun process
   or the systemd `pi-web-ui.service`.

### 8.3 Optional cross-check
`GET /api/v1/sessions/:id/transcript?view=screen&expand=tools` on a **registered** session that
made a subagent call should reflect the summary (per 3.6). (Note: the ground-truth `agent-os`
session is not in this box's registry → screen-view 404s for it; use a session you created.)

---

## 9. Definition of Done (HARD GATE)

Do not report success until **all** of these are literally true and you can point to the artifact:

- [ ] Phase 0 findings written (live vs reload path; live event carries `details`).
- [ ] `shared/src/subagent-summary.ts` + `.test.ts` + committed fixtures; all summarizer tests
      green including the size (<2 KB) and every §5 edge case.
- [ ] Server forward point emits `resultSummary` for subagent/evaluated_subagent only, strips
      inner `messages`; server test proves it; non-subagent + other-runtime regression tests green.
- [ ] `sessionStore` type extended; both handlers populate `summary`; card renders model +
      one-line summary collapsed and per-tool breakdown expanded; `evaluated_subagent` degrades;
      fallback path intact. All `SubagentToolCard.test.tsx` green.
- [ ] Screen-view projection + conformance/screen-view/internal-api-screen-view tests green
      (updated if the card changed the surface).
- [ ] **`npm run lint`** — clean (0 errors).
- [ ] **`npm run typecheck`** — clean.
- [ ] **`npm run build`** — succeeds.
- [ ] **`npm test`** and the relevant workspace suites — **0 failures**, no new skips
      (client Tools + Chat, shared, server unit + integration). Paste the summary lines.
- [ ] **`npm run docs:check-agent-guides`** — passes (you edited docs).
- [ ] §8.1 deterministic server proof green against the **real** file (exact 2c numbers).
- [ ] §8.2 browser proof: WS-frame capture + two screenshots saved; live session cleaned up.
- [ ] `git status --short` shows **only your intended files**; no `.env*`, `*.bak`, throwaway
      scripts, evidence PNGs, or the other agent's files staged. `git diff --cached --stat`
      reviewed. No secrets.
- [ ] A short evidence summary (numbers matched, screenshots, gate outputs) in the PR/commit body.

**Anti-early-victory rule:** "typecheck + tests pass" is **necessary, not sufficient**. The
feature is done only when §8.2 shows the real model + tool summary rendering in a browser and
§8.1 matches the real numbers. If you cannot produce the browser evidence, the task is **blocked,
not done** — say so.

---

## 10. Guardrails recap

- Another agent is working in this repo. Commit **only** the files this plan creates/edits.
  Before committing: `git status --short`, add files **explicitly by path** (never `git add -A`/`.`),
  and confirm nothing else rides along.
- Follow `CLAUDE.md` required workflow (TDD, minimal diffs, run validation before finishing).
- Prod is real (`pi-web-ui.service`, port 3456). Isolate app-state dirs for disposable servers;
  clean up prod side effects; never broad-`pkill`; never kill `pi-claude-channel`.
