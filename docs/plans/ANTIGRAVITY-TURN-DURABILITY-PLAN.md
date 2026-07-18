# Execution Plan — Antigravity Turn Durability & Failure Visibility

> **Status:** implemented and archived across `6af05f1`, `df4ab8c`,
> `7da6821`, `142ec23`, `352197e`, and `dbc3e47`. Current runtime behaviour is
> documented in [`../ANTIGRAVITY-INTEGRATION.md`](../ANTIGRAVITY-INTEGRATION.md),
> [`../EVENT-PIPELINE.md`](../EVENT-PIPELINE.md), and
> [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md). The execution checklist
> below is historical evidence, not an outstanding implementation request.
>
> **Audience:** an execution agent implementing this fix end-to-end.
> **Author:** analysis/review agent (will validate the executor's result at the end).
> **Branch policy:** work on the **current branch** (do **not** create a new branch). Commit and push when done.
> **Original handoff status:** analysis complete, no code written yet.

---

## 0. Required skill signpost (read this first)

Before doing any runtime/live validation, **load and use this skill by full name**:

> **`pi-web-ui-internal-api-orchestration`**

Do not assume a path for it — invoke it by that exact full name and your harness will resolve it. This skill is how you spin up a disposable validation server and live-validate the Antigravity runtime through the Internal API (Unix socket). It is your **second validation channel** (see §6). The first channel is unit tests (TDD).

You should also skim these repo docs before starting:
- `docs/ANTIGRAVITY-INTEGRATION.md` (runtime overview, subprocess-per-turn model, known limitations)
- `docs/EVENT-PIPELINE.md` (the NormalizedEvent contract — rule 3: `agent_end` must always fire)
- `docs/LIVE-VALIDATION.md` (live validation mechanics)
- `CLAUDE.md` / `AGENTS.md` (required workflow + non-negotiable rules)

---

## 1. Why we are doing this (root-cause summary)

A real production Antigravity session (`de8baa02-cd87-4bc2-9da7-0da519a7a5ff`) was investigated. The user sent a prompt, refreshed mid-turn, and the prompt vanished and no response ever appeared. The turn's agy subprocess **timed out after exactly 10 minutes** (`Print mode: timed out after 2991 polls (printed=8)`), the model never flushed a final answer, and the server fell into its error path. The session ended with `status: error`, `messageCount: 0`, `firstMessage: ""`, **no `.jsonl` history file at all**, and the Telegram notification said *"No message body — open the session to see what it said."*

Three distinct root causes were confirmed:

### RC1 — In-flight turns are not durable ("prompt disappears on refresh")
In `server/src/antigravity/antigravity-service.ts` → `runPromptAsync()`, the user prompt is emitted only as **ephemeral live WebSocket events**. It is persisted to the JSONL store (`appendTurn`) **only at the very end, on the success path**. Antigravity is subprocess-per-turn with up to a 10-minute window. Any refresh before completion triggers `replayAntigravityHistory()` (in `server/src/websocket/connection.ts`), which reads the **empty** store → the user sees nothing. The prompt was never anywhere durable.

### RC2 — The error/timeout path persists nothing and emits no body ("blank screen, no response ever" + "No message body" notification)
The `catch` branch in `runPromptAsync()` emits only a bare `agent_end {result:null}`. It does **not** emit assistant `message_*` events and does **not** call `appendTurn`. So a failed/timed-out turn is **permanently invisible** on replay, and because the notification layer (`server/src/notifications/notification-manager.ts` + `notification-formatter.ts`, `FALLBACK_BODY`) builds its body from **accumulated assistant text**, an empty assistant turn produces the *"No message body"* fallback.

### RC3 — agy timed out and partial output was discarded, plus a silent model downgrade
- The model was stored as `antigravity/Gemini 3.5 Flash (High)`. agy logged: *"model antigravity/Gemini 3.5 Flash (High) is not recognized… Propagating selected model override to backend: label='Gemini 3.5 Flash (Medium)'"*. **The `antigravity/` prefix made agy silently fall back to Flash Medium** — the user picked High and got Medium.
- On timeout/non-zero exit, `runAgy()` throws everything away and the user never learns whether it timed out or errored.

---

## 2. The fix at a glance

| Fix | Targets | One-liner |
|---|---|---|
| **A** | RC1 + RC2 | Durable turn lifecycle: persist the turn at **prompt start** as `running`, finalize to `done` or `error` on completion; emit assistant `message_*` (with error/partial body) even on the error path. |
| **B** | RC2/RC3 | Make `runAgy()` surface a structured outcome (partial stdout + reason) instead of throwing the data away, so error turns carry a real reason ("timed out after 10m"). |
| **C** | RC3 | Normalize the agy model id (strip a leading `antigravity/` or any `provider/` prefix) before passing `--model`, so High runs as High. |

**Design principle:** the user prompt must become durable the instant it is accepted, and **every** turn — success, error, or timeout — must leave exactly one replayable, finalized record with a non-empty body. Replay + the live subscriber fan-out already work on the success path; we are closing the durability and error-path gaps, not rewriting routing.

---

## 3. TDD is mandatory — workflow for every change

For **each** sub-change below, follow this loop (per `CLAUDE.md`):

1. **Write/extend the failing test first** in the matching file under `server/tests/unit/antigravity/`.
2. Run that test file, confirm it **fails for the right reason**.
3. Implement the minimal change.
4. Re-run the test file, confirm it **passes**.
5. Keep diffs minimal; match surrounding code style.

After all sub-changes, run the **full validation gate** (§6) — both validation channels.

Existing test files you will extend (do not create parallel ones):
- `server/tests/unit/antigravity/antigravity-session-store.test.ts`
- `server/tests/unit/antigravity/antigravity-history-replay.test.ts`
- `server/tests/unit/antigravity/antigravity-service.test.ts`
- `server/tests/unit/antigravity/antigravity-api-observer.test.ts`
- `server/tests/unit/antigravity/antigravity-session-subscribers.test.ts`

---

## 4. File-by-file implementation

### 4.1 Store schema + lifecycle — `server/src/antigravity/antigravity-session-store.ts`

**Goal:** support a turn that starts as `running` and is later finalized, without breaking the existing append-only readers or the `rawStdoutLength` offset accounting.

Changes:
1. Extend `AntigravityTurn`:
   ```ts
   export type AntigravityTurnStatus = 'running' | 'done' | 'error';

   export interface AntigravityTurn {
     turnId: string;
     prompt: string;
     response: string;            // '' while running; final text or error note when finalized
     model: string;
     conversationId: string | null;
     timestamp: number;
     status?: AntigravityTurnStatus; // undefined === legacy 'done' (back-compat, see below)
     error?: string;                 // present when status === 'error'
     rawStdoutLength?: number;       // only set when status === 'done'
   }
   ```
2. Add a **`startTurn(sessionId, { turnId, prompt, model, conversationId, timestamp })`** that appends a line with `status: 'running'`, `response: ''`. (Or reuse `appendTurn` with `status:'running'`; pick one and be consistent. Prefer an explicit `startTurn` for readability.)
3. Add **`finalizeTurn(sessionId, turnId, patch)`** that loads the JSONL, finds the line with the matching `turnId`, merges the patch (`status`, `response`, `error`, `rawStdoutLength`, updated `conversationId`), and **rewrites the whole file** atomically (write to a temp file + rename, to avoid a torn file on crash). If the `turnId` is not found (defensive), append it as a finalized line.
4. **Back-compat:** treat a turn with **no `status` field as `'done'`** everywhere (legacy `.jsonl` files predate this change — see the existing files in `~/.pi-web-ui/antigravity-sessions/`). Add a tiny helper `isDone(turn)` → `turn.status === undefined || turn.status === 'done'`.
5. **Fix `priorStdoutLength()`** — it must consider **only `done` turns** (a `running` or `error` turn has no valid `rawStdoutLength` and must not corrupt the next turn's stdout-slice offset). Walk backwards to the last `done` turn; fall back to the legacy sum over `done` turns only.

**Tests (`antigravity-session-store.test.ts`):**
- `startTurn` writes a `running` line with empty response.
- `finalizeTurn` flips `running` → `done` with response + `rawStdoutLength`, and the file still has exactly one line for that turn (no duplicate).
- `finalizeTurn` → `error` sets `status:'error'` + `error` text + leaves `rawStdoutLength` unset.
- `priorStdoutLength` ignores a trailing `running`/`error` turn and returns the offset of the last `done` turn.
- Loading a legacy line (no `status`) is treated as `done`.

### 4.2 Replay rendering — `server/src/antigravity/antigravity-history-replay.ts`

**Goal:** the user prompt always renders; a `running` turn renders a "still working" placeholder and **no `agent_end`** (so the UI keeps showing it as streaming); an `error` turn renders the error body and a closing `agent_end`.

Changes to `turnsToReplayEvents()`:
- Always emit the `agent_start` + user `message_start/update/end` for every turn (unchanged).
- If turn is **done** (incl. legacy): emit assistant `message_*` with `turn.response` + `agent_end` (current behavior).
- If turn is **error**: emit assistant `message_*` with the body = `turn.response || turn.error || 'The agent run failed.'` + `agent_end {result:null}`.
- If turn is **running** (only possible for the last turn after a crash/restart mid-flight): emit the user message, then **either** an assistant placeholder `message_start` left open **or** nothing after the user message, and **do not** emit `agent_end`. Keep it simple: emit the user message only and let `isStreaming` (set by `replayAntigravityHistory` from `isRunning(sessionId)`) drive the streaming indicator. Document the choice in a code comment.

**Tests (`antigravity-history-replay.test.ts`):**
- A `done` turn produces the existing event sequence (regression guard).
- An `error` turn produces a user message + an assistant message whose delta equals the error body + an `agent_end`.
- A `running` turn produces the user message and **no `agent_end`**.
- A legacy turn (no `status`) renders identically to `done`.

### 4.3 Service lifecycle — `server/src/antigravity/antigravity-service.ts`

This is the core. Modify `sendPrompt` / `runPromptAsync`:

1. **Persist the prompt immediately.** Generate `turnId` up front. As soon as the prompt is accepted (before/around emitting the live user `message_*`), call `store.startTurn(...)` with `status:'running'`. Also update the registry **now** so `firstMessage` (if this is the first turn) and `status:'running'` reflect the in-flight turn. This is what makes a refresh-during-flight show the prompt (RC1).
2. **Normalize the model id (Fix C).** Add a pure helper:
   ```ts
   export function normalizeAgyModel(model: string): string {
     // agy expects a bare label like "Gemini 3.5 Flash (High)".
     // Strip a leading provider prefix (e.g. "antigravity/") that some
     // callers/model pickers attach; passing it makes agy silently
     // downgrade to the default model.
     const slash = model.indexOf('/');
     return slash >= 0 ? model.slice(slash + 1) : model;
   }
   ```
   Use it when building the `--model` arg, and also inside `getModelContextWindow()` so the prefix doesn't break context-window matching. Keep `entry.model` (the stored id) untouched in the registry; normalize only at the agy boundary.
3. **Use the structured `runAgy` outcome (Fix B).** See §4.4. On success, `finalizeTurn` → `done` with `response` + `rawStdoutLength`. On failure/timeout, **emit assistant `message_*` with the error/partial body**, then `agent_end`, then `finalizeTurn` → `error` with `error` = the reason and `response` = partial text (if any) or the reason. Update the registry to `status:'error'` but **keep `messageCount` incremented and `firstMessage` set** (the turn happened).
4. **conversationId continuity.** When detecting the conversation id from history (`history[history.length-1].conversationId`), prefer the last **`done`** turn's id; a `running`/`error` turn may have a null/transient id. Keep the existing per-run agy-log parsing as the source of truth.
5. **Crash recovery (nice-to-have, low risk).** On `ensureSession`/replay, if the last persisted turn is `running` but the session is not actually `isRunning`, treat it as orphaned: either finalize it to `error` ("interrupted") lazily, or just let replay show it as user-prompt-only. Keep this minimal — a code comment plus the replay behavior from §4.2 is acceptable; do not build a heavy reconciliation system.

**Tests (`antigravity-service.test.ts`)** — mock `runAgy`/the agy boundary as the existing tests do:
- After `sendPrompt` starts, the store has a `running` turn with the prompt **before** the subprocess resolves (assert mid-flight durability).
- Successful completion finalizes to `done`, registry `messageCount` increments, `firstMessage` set.
- A subprocess **error/timeout** finalizes to `error`, emits assistant `message_*` events with a non-empty body, emits `agent_end`, and increments `messageCount` / sets `firstMessage`.
- `normalizeAgyModel('antigravity/Gemini 3.5 Flash (High)')` === `'Gemini 3.5 Flash (High)'`; a bare label is unchanged.
- `getModelContextWindow('antigravity/Gemini 3.1 Pro (High)')` returns the Pro window (not the default), proving normalization is applied.
- The `--model` arg passed to the agy boundary is the normalized label.

### 4.4 agy subprocess outcome — `runAgy()` in `antigravity-service.ts`

**Goal:** stop discarding partial output and the failure reason.

Change `runAgy` to resolve with a structured result rather than throwing on non-zero/timeout:
```ts
interface AgyResult {
  stdout: string;
  stderr: string;
  ok: boolean;
  reason?: string;   // e.g. 'timeout' | `exit ${code}`
}
```
- On `close` with `code === 0`: `{ ok:true, stdout, stderr }`.
- On `close` with non-zero but non-empty stdout: `{ ok:true, stdout, stderr }` (we still got a usable reply — current lenient behavior, preserved).
- On `close` with non-zero **and** empty stdout: `{ ok:false, reason: 'exit '+code, stdout, stderr }`.
- On the watchdog timer: kill the process, resolve `{ ok:false, reason:'timeout', stdout, stderr }` (return partial stdout, do **not** throw).
- On `proc.on('error')`: still reject (spawn failure is a genuine throw — binary missing, etc.).

Then `runPromptAsync` branches on `result.ok`. When `!ok`, build a user-facing body like:
`The agent did not return a reply (${reason}).` plus any partial stdout, and route it through the **error finalize** path in §4.3. Keep the agy `--print-timeout` and the watchdog (`promptTimeoutMs + 5000`) as they are.

> **Note on the 10-minute timeout itself:** out of scope to change the value. The fix is to make a timeout *visible and durable*, not to lengthen it. If the executor wants, leave a `// TODO` noting that `antigravityPromptTimeoutMs` is configurable via `ANTIGRAVITY_PROMPT_TIMEOUT_MS`.

### 4.5 Connection/replay glue — `server/src/websocket/connection.ts`

Mostly unchanged, but verify:
- `replayAntigravityHistory()` already sets `isStreaming: this.antigravityService.isRunning(sessionId)` — keep it. With §4.2, a `running` turn replays as user-prompt-only + streaming indicator. Good.
- `handleAntigravityPrompt()` already fans out live events to **current subscribers** (not just the prompting client). No change needed for reconnect — a resubscribed client receives the eventual completion batch. Add a one-line comment pointing at this plan so future readers know durability now also comes from the store.
- Do **not** change the WebSocket protocol shape. No `shared/src/protocol-types.ts` change should be needed; if you think one is, stop and reconsider — replay reuses existing event types.

---

## 5. Edge cases & hazards (read before coding)

1. **stdout offset corruption (highest risk).** `agy --conversation` replays *all* prior assistant replies in stdout. `extractNewReply()` slices at `priorStdoutLength`. If a `running`/`error` turn contributes a bogus `rawStdoutLength`, the **next** turn's reply is sliced wrong (truncated or duplicated). §4.1 step 5 must only count `done` turns. Add a test that simulates: done turn → error turn → done turn, and assert the third turn's slice offset equals the first done turn's `rawStdoutLength`.
2. **Double-count / duplicate lines.** `finalizeTurn` must replace the `running` line in place, not append a second line for the same `turnId`. Assert one line per `turnId`.
3. **Context usage & stats.** `getContextUsage()` and `getSessionStats()` iterate `history`. Decide: count only `done` (+ maybe `error`) turns, not `running`. Keep it consistent and add/adjust a test if those are covered.
4. **Legacy files.** The box already has ~20 legacy `.jsonl` files with no `status`. Loading them must not throw and must render as before. Covered by the "no status === done" rule.
5. **Notification body.** The whole point of RC2 is that the error path now emits assistant text. Verify the notification path would pick it up (it accumulates assistant `text_delta`). You don't need to modify the notification code, but your live validation (§6) should confirm a failed/empty turn no longer yields the `FALLBACK_BODY`.
6. **Atomic finalize.** Use write-temp-then-rename in `finalizeTurn` so a crash mid-write can't corrupt the session file.

---

## 6. Validation — TWO channels, both required

### Channel 1 — Unit tests / static gate
Run from repo root and make all green:
```bash
npm run lint
npm run typecheck
npm test            # or the server workspace test command
npm run build
npm run docs:check-agent-guides
```
All new behavior must be covered by the unit tests added in §4. Do not finish with skipped or failing tests; if you must skip something, document why.

### Channel 2 — Live Internal-API validation (use the skill)
Use the **`pi-web-ui-internal-api-orchestration`** skill (full name, resolve via your harness) to:
1. Spin up a **disposable validation server** (never touch production unless the user explicitly authorizes `--allow-production`).
2. Create an Antigravity session and exercise these scenarios end-to-end through the Internal API (Unix socket), observing the normalized event stream and the replay output:
   - **Happy path:** prompt → response → `agent_end`; confirm the turn persists as `done` and replay reproduces prompt + response.
   - **Durability/refresh simulation (RC1):** after sending a prompt, **before completion**, fetch the session replay (a fresh "view") and assert the **user prompt is already present** (i.e. a `running` turn is persisted). The `view=screen` projection / replay should show the prompt mid-flight, not an empty screen.
   - **Failure visibility (RC2):** force or simulate a non-completing/error turn (e.g. a model/prompt that returns nothing, or inject the error path) and assert the replay shows the user prompt **and** a non-empty assistant/error body, and that the turn is persisted as `error`. Confirm a subscribed notification would carry a real body, not the `FALLBACK_BODY`.
   - **Model fidelity (RC3):** create a session whose model id carries an `antigravity/` prefix and assert the agy `--model` arg is the bare label (and, if observable, that it does not silently downgrade).
3. Capture a PASS/FAIL verdict per scenario in your final report.

> If a genuinely live agy run is impractical in the validation environment (auth/quota), at minimum validate RC1/RC2 against the **persistence + replay** surface (the store and replay are runtime-agnostic and fully exercisable through the Internal API without a real Gemini response), and clearly state which scenarios were live vs. simulated.

---

## 7. Commit & push (executor)

- Work on the **current branch** (the analysis agent intentionally did **not** branch; the user wants this on the existing branch).
- Before committing: `git status --short`, `git diff --stat`, `git diff --cached --stat`. **Verify no secrets, tokens, cookies, session dumps, or local-machine artifacts** are staged (per `CLAUDE.md`). In particular do **not** commit anything under `~/.pi-web-ui/` or any agy log.
- Conventional commit, e.g.:
  `fix(antigravity): durable turn lifecycle + visible failures + model-id normalization`
- Include the repo's required commit trailers (see `CLAUDE.md` / harness conventions).
- Push to the remote.

---

## 8. Hand-back — what the review agent will check

When you report back, the reviewing agent will verify:
1. All three root causes are addressed (A, B, C) with tests that would fail without the fix.
2. Both validation channels are green; the live/Internal-API report includes per-scenario PASS/FAIL.
3. The stdout-offset hazard (§5.1) has an explicit regression test.
4. Legacy `.jsonl` files still load and replay unchanged.
5. No protocol-shape change leaked into `shared/`.
6. Diff is minimal, security rules respected, nothing sensitive committed.
7. The model-id normalization actually changes the `--model` arg (not just stored metadata).

Report: the commit SHA, the files changed, the test names added, and the live-validation verdicts.

---

## Appendix — key source locations

| Concern | File |
|---|---|
| Turn store (schema, append, offset) | `server/src/antigravity/antigravity-session-store.ts` |
| Replay event synthesis | `server/src/antigravity/antigravity-history-replay.ts` |
| Service lifecycle / `runAgy` / model | `server/src/antigravity/antigravity-service.ts` |
| Prompt fan-out + replay wiring | `server/src/websocket/connection.ts` (`handleAntigravityPrompt`, `replayAntigravityHistory`) |
| Notification body / fallback | `server/src/notifications/notification-manager.ts`, `server/src/notifications/notification-formatter.ts` |
| Subscriber tracking | `server/src/antigravity/antigravity-session-subscribers.ts` |
| Tests | `server/tests/unit/antigravity/*.test.ts` |
| Runtime docs | `docs/ANTIGRAVITY-INTEGRATION.md`, `docs/EVENT-PIPELINE.md`, `docs/LIVE-VALIDATION.md` |
