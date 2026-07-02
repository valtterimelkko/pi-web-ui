# Claude SDK `AskUserQuestion` — Premature-Timeout / Zombie-Dialog Fix Plan

Status: **Implemented** in commit `25eb290` (first-class AskUserQuestion support). This document is preserved as the implementation record and root-cause write-up. For the current runtime reference, see [`../CLAUDE-BACKENDS.md`](../CLAUDE-BACKENDS.md), [`../PROTOCOL.md`](../PROTOCOL.md), and [`../EVENT-PIPELINE.md`](../EVENT-PIPELINE.md).

Audience: an execution agent implementing the fix with strict TDD and live validation.
Primary runtime target: **Claude SDK backend only** (same scope as the original feature).

Prerequisite reading: [`CLAUDE-SDK-ASK-USER-QUESTION-PLAN.md`](./CLAUDE-SDK-ASK-USER-QUESTION-PLAN.md) — the original feature plan. This document is the **follow-up bug fix** for that feature.

> ⚠️ **Execution-agent warning.** This plan exists because a real production session silently failed in a way that *looked* fine in logs. Do **not** claim success from unit tests alone. The bug is a timing/lifecycle bug that only shows up end-to-end. Section 11 (live validation) and Section 13 (failure modes) are the acceptance bar, not Section 9.

---

## 1. What actually happened (root-cause evidence)

Real production session: **`0adfbeaf-3abd-4230-8933-08d5e1d37a9b`**
Replay file: `/root/.pi-web-ui/claude-sessions/0adfbeaf-3abd-4230-8933-08d5e1d37a9b.jsonl`

Claude emitted a valid `AskUserQuestion` with **4 rich questions** (multi-line previews, long option descriptions). The transcript timing is exact:

| Event | jsonl line | timestamp (ms) | Δ from ask |
|---|---|---|---|
| `AskUserQuestion` tool call (4 questions) | 39 | 1782990296144 | 0 |
| `tool_result`: **"The user did not answer the questions."** | 40 | 1782990596206 | **300062 ms = 5:00.06** |
| assistant continues: *"No problem — answer however you like…"* | 41 | 1782990615943 | 5:19 |
| user's real answer, typed as a **prose chat message** | 43 | 1782991146014 | **14:10** |

The 300062 ms gap is **exactly `DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000`** (`server/src/claude/claude-sdk-service.ts:95`).

### 1.1 Chain of failure

1. `handleAskUserQuestion` arms a 5-minute `setTimeout` (`claude-sdk-service.ts:719-722`).
2. The user needed longer than 5 minutes to read/answer 4 dense questions.
3. The timeout fired → `resolvePendingAskUserQuestion(requestId, { cancelled: true })`.
4. The cancel branch returned `{ behavior: 'allow', updatedInput: input }` **with no `answers`** (`claude-sdk-service.ts:763-764`), so the SDK gave Claude its built-in *"The user did not answer the questions."* tool result.
5. Claude, seeing a legitimate "user skipped", **continued the turn** while the dialog was still open in the browser.
6. The browser dialog was **never told** the request had expired — no server→client signal exists. It stayed open ("zombie dialog").
7. When the user finally submitted, `respondToAskUserQuestion(id)` returned `false` because the pending entry was already deleted; the WS handler just logged *"response ignored because request is no longer pending"* (`connection.ts:2451-2452`) and **silently dropped the answer**. The user had to re-type everything as prose.

### 1.2 Three defects to fix

- **D1 — Timeout far too aggressive.** 5 minutes is shorter than a realistic answer time for multi-question dialogs.
- **D2 — Zombie dialog.** No server→client notification when a request is resolved for any reason *other than the user's own submission* (timeout / abort / turn-end / disconnect). The dialog stays open and misleading.
- **D3 — Silent drop of late/stale answers.** A submission that arrives after the request is gone is logged and discarded with no user-visible feedback, wasting the user's effort.

---

## 2. Chosen approach (approved)

**Option B + Option C** from the analysis:

- **B — Wait generously; make abandonment event-driven, not clock-driven.**
  The primary "give up" signals become: (1) explicit turn stop → SDK `AbortSignal` (already wired), (2) **tab closed / no subscribers for a grace period** (new), (3) turn end cleanup (already wired). The wall-clock timeout is demoted to a **long safety net** (default raised), still env-configurable.
- **C — Robustness so a resolved request is never silently confusing.**
  - Emit a server→client **cancel/expire** notification whenever a pending `AskUserQuestion` is resolved for a non-answer reason, so the dialog closes with a clear explanation (fixes D2).
  - Never silently drop a late answer: surface a clear client notification and preserve the user's typed answers so nothing is lost (fixes D3).
  - Make the deadline visible in the dialog (soft countdown / warning near expiry).

### 2.1 Non-goals

- Do **not** touch the direct CLI (`claude -p`) or channel backends. SDK only.
- Do **not** auto-inject the late answer as a brand-new Claude turn **by default** (risk: the session may already be mid-turn). Auto-forward is an *optional* enhancement in §7.5, gated to idle sessions only, and must be explicitly called out if implemented.
- Do **not** add an `ANTHROPIC_API_KEY` path. Preserve subscription-auth constraints.
- Do **not** change the persisted transcript/tool-result shape beyond what these fixes strictly require.

---

## 3. Mandatory resource signposts

Read before editing:

### Project docs
- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/CODEBASE-MAP.md`
- `docs/EVENT-PIPELINE.md`
- `docs/PROTOCOL.md`
- `docs/CLAUDE-BACKENDS.md`
- `docs/INTERNAL-API.md`
- `docs/INTERNAL-API-ORCHESTRATION.md`
- `docs/LIVE-VALIDATION.md`
- `docs/OBSERVABILITY.md`
- `docs/TROUBLESHOOTING.md`
- `docs/plans/CLAUDE-SDK-ASK-USER-QUESTION-PLAN.md` (the original feature)

### Skills to use by name
- `test-driven-development`
- `systematic-debugging` (on any failing test/typecheck/lint/build/validation)
- `pi-web-ui-internal-api-orchestration` (before any Internal API / live-validation work)
- `webapp-testing` (mandatory for the disconnect + zombie-dialog browser proof)

### Backend files in scope
- `server/src/claude/claude-sdk-service.ts` — timeout, pending map, resolve/cleanup, canUseTool bridge
- `server/src/claude/claude-service.ts` — delegation surface (`isPendingAskUserQuestion`, `respondToAskUserQuestion`)
- `server/src/websocket/connection.ts` — `ask_user_question_request` emit, `handleExtensionUiResponse`, `handleDisconnect`, subscriber tracking
- `server/src/claude/claude-session-subscribers.ts` — per-session subscriber sets
- `server/src/internal-api/routes/sessions.ts` — approvals `/respond` route (AskUserQuestion branch ~line 1141)
- `server/src/internal-api/event-types.ts` — event catalogue
- `server/src/internal-api/types.ts` — approval response shape
- `server/src/live-validation/scenarios.ts` — validation scenarios
- `server/src/live-validation/internal-api-client.ts`, `server/src/live-validation/types.ts`
- `shared/src/protocol-types.ts` — server→client message union (for the new cancel message)

### Frontend files in scope
- `client/src/store/sessionStore.ts` — `ExtensionUIRequest`, `extension_ui_request` handling (~1511), toast/error surface
- `client/src/App.tsx` — dialog render + `onResponse`
- `client/src/components/Extensions/ExtensionDialog.tsx` — delegation to `AskUserQuestionDialog` (currently drops `timeout`)
- `client/src/components/Extensions/AskUserQuestionDialog.tsx` — no countdown / no expiry handling today

### SDK typings / runtime evidence
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
- Relevant: `Options.canUseTool`, `PermissionResult`, `AskUserQuestionInput`

---

## 4. Current code anchors (verify before editing — line numbers drift)

- `DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS = 5 * 60 * 1000` → `claude-sdk-service.ts:95`
- `getAskUserTimeoutMs()` reads `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS` → `claude-sdk-service.ts:624`
- `PendingAskUserQuestion` interface → `claude-sdk-service.ts:84` (fields: `sessionId, toolCallId, originalInput, resolve, timeout, abortListener, signal`)
- `handleAskUserQuestion` (timeout + abort listener + emit) → `claude-sdk-service.ts:683-775`
- `resolvePendingAskUserQuestion` (idempotent resolve+cleanup) → `claude-sdk-service.ts:810`
- `cleanupPendingAskUserQuestionsForSession` (turn-end) → `claude-sdk-service.ts:825`
- `ClaudeService.isPendingAskUserQuestion` / `respondToAskUserQuestion` → `claude-service.ts:122,133`
- `ask_user_question_request` → `extension_ui_request` emit (with `timeout` field) → `connection.ts:963-993`
- `handleExtensionUiResponse` AskUserQuestion branch + "no longer pending" log → `connection.ts:2427-2453`
- `handleDisconnect` (unsubscribes, does **not** cancel pending questions) → `connection.ts:2731`
- Subscriber lookups: `this.claudeSubs.getSubscribers(sessionId)`
- Internal API respond route AskUserQuestion branch → `routes/sessions.ts:1141`
- `ask_user_question_request` catalogue entry → `event-types.ts:46`
- Client store `extension_ui_request` handler → `sessionStore.ts:1511`; `ExtensionUIRequest` type → `sessionStore.ts:197`

---

## 5. Target design

### 5.1 Timeout policy (D1)

- Raise `DEFAULT_ASK_USER_QUESTION_TIMEOUT_MS` to a **long safety net** (recommended **30 minutes** = `30 * 60 * 1000`). Rationale: with disconnect-based cancellation as the real abandonment signal, the wall clock only guards against a truly orphaned query that somehow kept a subscriber. 30 min is comfortably longer than any realistic human answer time, yet bounded.
- Keep `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS` env override intact and documented.
- **Do not** set it to `Infinity`/disabled; a finite safety net must remain so a leaked query cannot pin an SDK subprocess forever.

### 5.2 Disconnect-based cancellation with a grace period (D1/B)

Abandonment is best detected when the **last** subscriber for a session goes away and does **not** come back:

- Add a per-session **disconnect grace timer** (recommended default **120 s**, new env `CLAUDE_ASK_USER_QUESTION_DISCONNECT_GRACE_MS`).
- When `handleDisconnect` removes the last Claude subscriber for a session that has ≥1 pending `AskUserQuestion`, **start** the grace timer (do not cancel immediately — mobile/network blips reconnect constantly).
- If any client re-subscribes to that session before the timer fires, **clear** it.
- If the timer fires with still zero subscribers, resolve the pending question(s) as cancelled (reason `disconnected`).

This grace window is the key correctness/UX tradeoff: too short reintroduces the drop-on-blip bug; too long delays cleanup of a genuinely closed tab. 120 s is a safe middle. Make it configurable and document the tradeoff.

> Ownership note: subscriber tracking lives in `connection.ts` (`claudeSubs`), but the pending map lives in `claude-sdk-service.ts`. Keep the SDK service as the source of truth for pending state. The connection layer should call a new `ClaudeService`/`ClaudeSdkService` method (e.g. `cancelPendingAskUserQuestionsForSession(sessionId, reason)`) rather than reaching into internals.

### 5.3 Cancel/expire notification to the browser (D2)

Introduce a resolution **reason** and notify subscribers when resolution is *not* the user's own answer.

- Extend the pending entry to store the `onEvent` emit callback (so any resolve path can emit).
- `resolvePendingAskUserQuestion(requestId, result, opts?: { notifyClient?: boolean; reason?: AskUserQuestionCloseReason })`.
  - Called from **user-answer** path (`respondToAskUserQuestion`) → `notifyClient: false` (browser already knows; it initiated).
  - Called from **timeout / abort / turn-end / disconnect** → `notifyClient: true` with the reason.
- On `notifyClient`, emit a new normalized event:

```ts
{
  type: 'ask_user_question_closed',
  sessionId,
  timestamp,
  data: { requestId, reason: 'timeout' | 'aborted' | 'turn_end' | 'disconnected' }
}
```

- `connection.ts` maps `ask_user_question_closed` to a new **server→client** message and broadcasts to the session's subscribers:

```ts
{ type: 'extension_ui_cancel', request: { id: requestId, reason } }
```

- Add `extension_ui_cancel` to `shared/src/protocol-types.ts` server→client union.
- The event also flows through the Internal API `/events` broker (register `ask_user_question_closed` in `event-types.ts`, category `control`, verbosity `FULL`) so browserless validation can observe expiry.

### 5.4 Client dialog: expiry + deadline (D2/D3 UX)

- `ExtensionDialog` must forward `timeout` into `AskUserQuestionDialog` (today it is dropped at `ExtensionDialog.tsx:44-48`).
- `AskUserQuestionDialog`:
  - Optional soft **deadline indicator**; show a visible **warning** only when < 60 s remain (avoid a distracting 30-minute countdown).
  - On `extension_ui_cancel` for the open request: switch the dialog to an **expired** state (do not just vanish) with a clear message, e.g. *"This question expired and the assistant moved on. Your draft is kept below — copy it or send it as a normal message."* Keep the user's current selections/text visible so nothing is lost.
- Store: handle `extension_ui_cancel` — if it matches the current `extensionUIRequest.id`, mark it expired (add an `expired?: boolean` / `expiredReason?` to the store request state) rather than clearing it outright.

### 5.5 Never silently drop a late answer (D3)

In `handleExtensionUiResponse`, when the request is a Claude AskUserQuestion but `respondToAskUserQuestion` returns `false` (already resolved):

- **Do not** just log-and-return.
- Send the requesting client a user-visible notification (reuse the existing toast/error channel) such as *"That question already closed; your answer wasn't delivered to the assistant. Send it as a normal message."*
- Optional (§7.5, off by default): if the session is idle (no active turn), auto-forward the answers as a normal user prompt so the user's effort is preserved. Must be explicitly flagged if implemented; do **not** forward into a busy session.

### 5.6 Invariants that must not regress

- Non-`AskUserQuestion` tools still obey the allowlist/denylist (`createCanUseTool`).
- The user-answer happy path still returns `updatedInput.answers` to the SDK and does **not** emit a client cancel.
- `resolvePendingAskUserQuestion` stays idempotent; the new `notifyClient` must fire **at most once** per request.
- Timers/listeners are always cleared on every resolution path (no leaks).
- Existing confirm/select/input/editor extension dialogs and Claude-channel/OpenCode permission prompts are untouched.

---

## 6. Protocol / type changes summary

| Layer | Change |
|---|---|
| `claude-sdk-service.ts` | New `AskUserQuestionCloseReason` type; `PendingAskUserQuestion` gains `onEvent`; `resolvePendingAskUserQuestion` gains `opts`; new normalized event `ask_user_question_closed`; new `cancelPendingAskUserQuestionsForSession`; raised default timeout; new disconnect-grace helpers. |
| `claude-service.ts` | Delegate `cancelPendingAskUserQuestionsForSession`. |
| `shared/src/protocol-types.ts` | New server→client message `extension_ui_cancel`. |
| `connection.ts` | Map `ask_user_question_closed` → `extension_ui_cancel` broadcast; disconnect-grace wiring in `handleDisconnect` + re-subscribe path; late-answer client notification in `handleExtensionUiResponse`. |
| `event-types.ts` | Register `ask_user_question_closed` (control / FULL). |
| `internal-api/routes/sessions.ts` | No behavioural change required for answers; ensure late/stale respond returns a clear non-200 (e.g. 409) instead of a silent success, mirroring the WS surface. |
| Client store/components | Forward `timeout`; handle `extension_ui_cancel`; expired dialog state; late-answer toast. |

---

## 7. Backend implementation plan (strict TDD)

> **RED first, every time.** Write the failing test, run it, capture the failure reason, *then* write the minimal code. The final report must show at least a few captured RED failures (see §12).

### 7.1 Raised default + env override (D1)
- Test: default constant is 30 min; `getAskUserTimeoutMs()` still honours `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS`; invalid/zero env falls back to default.
- Implement: bump constant; keep parsing.

### 7.2 Resolution reason + single-fire client notify (D2)
- Tests:
  - Timeout resolution emits exactly one `ask_user_question_closed` with `reason: 'timeout'`.
  - Abort-signal resolution emits `reason: 'aborted'`.
  - **User-answer** resolution emits **no** `ask_user_question_closed`.
  - A second resolve for the same requestId is a no-op and emits nothing (idempotency).
  - All paths clear the timeout and remove the abort listener (no leak).
- Implement: store `onEvent` on the pending entry; add `opts` to `resolvePendingAskUserQuestion`; emit from timeout/abort/turn-end/disconnect only.

### 7.3 Session-level cancel API (B)
- Tests: `cancelPendingAskUserQuestionsForSession(sessionId, 'disconnected')` resolves all pending for that session with `reason: 'disconnected'`, emits one closed event each, leaves other sessions untouched; `ClaudeService` delegates.
- Implement: method on SDK service + delegation on `ClaudeService`.

### 7.4 Disconnect grace timer (B)
- Tests (in `connection.test.ts` or focused `claude-ask-user-question-disconnect.test.ts`):
  - Last subscriber leaving a session with a pending question **starts** a grace timer; the question is **not** cancelled immediately.
  - Re-subscribing before expiry **clears** the timer; no cancellation.
  - Grace expiry with zero subscribers calls `cancelPendingAskUserQuestionsForSession(..., 'disconnected')`.
  - A non-last subscriber leaving (others remain) does nothing.
  - Grace window respects `CLAUDE_ASK_USER_QUESTION_DISCONNECT_GRACE_MS`.
  - Use fake timers; assert no dangling timers after teardown.
- Implement: grace-timer map keyed by sessionId in `connection.ts`; hook `handleDisconnect` and the subscribe path.

### 7.5 Late-answer handling (D3)
- Tests:
  - `handleExtensionUiResponse` for a no-longer-pending Claude AskUserQuestion sends a client notification (assert the outbound message) and does **not** throw.
  - Existing valid (pending) answer path still calls `respondToAskUserQuestion` and sends no such notice.
  - (If auto-forward implemented) it only fires when the session is idle; never into an active turn. Otherwise omit auto-forward and document it as deferred.
- Implement: notification on the `false` return; optional gated auto-forward.

### 7.6 Client-facing map (D2)
- Tests (WS routing): `ask_user_question_closed` normalized event becomes a top-level `extension_ui_cancel` broadcast to the session's subscribers, carrying `{ id, reason }`; not forwarded as a `session_event`.
- Implement: branch in the normalized-event handler (near `connection.ts:963`).

### 7.7 Internal API parity
- Tests: registering/observing `ask_user_question_closed` on `/events` (FULL); a `/respond` for an already-resolved request returns a clear non-success (e.g. 409 with an error code) rather than silent 200.
- Implement: `event-types.ts` entry; respond-route branch.

---

## 8. Frontend implementation plan (strict TDD)

### 8.1 Forward the timeout
- Test: `ExtensionDialog` passes `timeout` to `AskUserQuestionDialog`.
- Implement: thread the prop.

### 8.2 Deadline warning
- Tests: no warning when far from deadline; warning element appears when < 60 s remain (drive with fake timers / injected clock). Submit still works normally.
- Implement: soft indicator; must not auto-submit or auto-close on its own (server drives expiry).

### 8.3 Expiry handling
- Tests:
  - Store: `extension_ui_cancel` matching the open request sets an expired state (does not null it out); non-matching id is ignored.
  - Dialog: in expired state it shows the explanatory message, keeps the user's current selections/draft visible, and offers an explicit dismiss.
  - Submitting after expiry does not call the normal submit path (the request is dead) — instead surfaces the "send as a message" guidance.
- Implement: store field + dialog branch.

### 8.4 Late-answer toast
- Test: receiving the late-answer notification renders a visible, non-blocking message via the existing toast channel.
- Implement: wire to existing surface.

### 8.5 Regression guard
- The existing `AskUserQuestionDialog` tests (single/three/multi-select/cancel/preview-safety) and `ExtensionDialog` tests must still pass unchanged. Do not weaken them.

---

## 9. Server & client test inventory (write these RED first)

Server (extend or add focused files):
- `server/tests/unit/claude/claude-sdk-ask-user-question.test.ts` — §7.1, §7.2, §7.3
- `server/tests/unit/claude/claude-service-ask-user-question.test.ts` — delegation of the new cancel method
- `server/tests/unit/websocket/claude-ask-user-question.test.ts` — §7.4, §7.5, §7.6
- `server/tests/unit/internal-api/session-routes-ask-user-question.test.ts` — §7.7
- `server/tests/unit/internal-api/event-types.test.ts` — `ask_user_question_closed` present
- `server/tests/unit/live-validation/scenarios-ask-user-question.test.ts` — new scenarios registered

Client:
- `client/tests/unit/components/Extensions/AskUserQuestionDialog.test.tsx` — §8.2, §8.3
- `client/tests/unit/components/Extensions/ExtensionDialog.test.tsx` — §8.1, expiry delegation
- store test for `extension_ui_cancel` + late-answer toast

---

## 10. Reproduction harness (prove the OLD bug, then the fix)

Because the real bug takes 5 real minutes, make it deterministic via the env override.

**Reproduce old behaviour (should now be improved, not silent):**
1. Start a disposable validation server with `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS=3000`.
2. Trigger an `AskUserQuestion`; do **not** answer within 3 s.
3. Assert on `/events`: an `ask_user_question_closed` with `reason: 'timeout'` is emitted (D2 — previously nothing was emitted).
4. POST a late answer to `/respond`; assert it returns a clear non-success (409/error), not a silent 200 (D3).
5. Assert the tool_result is still the graceful no-answer string (unchanged, intended).

**Prove the fix (no premature expiry within a realistic window):**
6. With `CLAUDE_ASK_USER_QUESTION_TIMEOUT_MS=60000`, trigger `AskUserQuestion`, wait ~10 s (longer than a fast reply but well inside the window), then answer.
7. Assert the answer is accepted, `updatedInput.answers` reaches the SDK, **no** `ask_user_question_closed` fired, and Claude's final output reflects the answers.

---

## 11. Live validation (the real acceptance bar)

Use the `pi-web-ui-internal-api-orchestration` skill. **Disposable validation server only** — never `~/.pi-web-ui/internal-api.sock` or `pi-web-ui.service` without explicit user permission and `--allow-production`.

```bash
VALIDATION_DIR=$(mktemp -d)
npm run validate:server -- --dir "$VALIDATION_DIR" --port 0
# use $VALIDATION_DIR/internal-api.sock and $VALIDATION_DIR/internal-api-token
```

### 11.1 New/extended scenarios in `server/src/live-validation/scenarios.ts`
- `claude-ask-user-question-timeout` — the §10 reproduction: short timeout, no answer, assert `ask_user_question_closed`(timeout) on `/events` **and** late-answer POST rejected clearly.
- `claude-ask-user-question-delayed-answer` — the §10 fix proof: longer timeout, delayed answer accepted, no premature close, final transcript reflects answers.
- Keep the original `claude-ask-user-question` scenario green.

### 11.2 Browser validation (MANDATORY — the zombie dialog is a UI bug)
Backend events cannot prove the dialog closes. Use `webapp-testing` against a disposable server:
1. Open an SDK Claude session; trigger `AskUserQuestion`.
2. **Zombie-dialog / D2:** with a short server timeout, let it expire while the dialog is open; assert the dialog enters the **expired** state with the explanatory message (not stuck-open, not silently gone) and the user's partial selections remain visible.
3. **Disconnect / B:** open the dialog, close the tab/navigate away, wait past the grace window, reopen; assert the pending question was cancelled server-side (and, if reopened in time, that it was **not** cancelled).
4. **Happy path:** answer within the window; assert the dialog closes, answers reach Claude, and Claude continues using them.

If any browser step cannot be automated, the final report must say so explicitly and show exactly what was run instead — **do not** claim end-to-end success on unit tests alone.

### 11.3 Commands
```bash
npm run validate:live -- --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime claude --scenario claude-ask-user-question-timeout --json
npm run validate:live -- --socket "$VALIDATION_DIR/internal-api.sock" \
  --token-path "$VALIDATION_DIR/internal-api-token" \
  --runtime claude --scenario claude-ask-user-question-delayed-answer --json
```
Tear the server down afterward.

---

## 12. Quality gates (all must pass; run before claiming done)

Targeted tests during TDD, then the full suite:
```bash
npm run docs:check-agent-guides
npm run lint
npm run typecheck
npm run build
npm test
```
Plus the §11 live + browser validation.

The final report **must** include:
- Files changed and tests added.
- A sample of captured **RED** failures (proof tests were written first).
- Exact validation commands and their PASS/FAIL output.
- Disposable socket/token paths used, or an explicit statement that production was untouched.
- Any skipped validation and why.
- Confirmation via `git status --short` / `git diff --stat` that no secrets, tokens, cookies, or session/transcript dumps are staged.

---

## 13. Failure modes — DO NOT claim victory if any occur

1. **Unit tests pass but the browser dialog still hangs open on expiry.** The core reported bug (D2) is unfixed. Section 11.2 is mandatory.
2. **The dialog closes on a brief network blip / mobile tab-background.** The grace window is too short or the re-subscribe clear path is broken. Re-test §7.4.
3. **`ask_user_question_closed` fires on the normal user-answer path.** You broke the happy path; the browser will flash a spurious "expired".
4. **The closed notification fires twice** for one request. Idempotency of `resolvePendingAskUserQuestion` is broken.
5. **A late answer is still silently dropped** (only a server log, no user-visible feedback). D3 unfixed.
6. **The safety-net timeout was set to Infinity/removed.** A leaked query can now pin an SDK subprocess forever. Keep it finite.
7. **Non-allowlisted tools become allowed** because `createCanUseTool` was refactored carelessly.
8. **Validation ran against production** without explicit permission. Hard process failure.
9. **Timers/listeners leak** (tests show dangling handles). Every resolution path must clean up.
10. **You reported success from `npm test` alone.** Live + browser validation is the acceptance bar, not the unit suite.

---

## 14. Suggested execution order

1. Read §3 resources; re-verify §4 anchors (line numbers drift).
2. RED → GREEN: §7.1 timeout default.
3. RED → GREEN: §7.2 reason + single-fire notify (+ idempotency/leak tests).
4. RED → GREEN: §7.3 session cancel API + delegation.
5. RED → GREEN: §7.6 WS `extension_ui_cancel` mapping + `shared` protocol type.
6. RED → GREEN: §7.4 disconnect grace timer.
7. RED → GREEN: §7.5 late-answer notification.
8. RED → GREEN: §7.7 Internal API event + respond parity.
9. RED → GREEN: §8 frontend (forward timeout, warning, expiry state, toast).
10. Add §11.1 live scenarios; run §10 reproduction on a disposable server.
11. Run §11.2 browser validation.
12. Run §12 full quality gates.
13. Inspect `git status`/diffs; write the honest final report per §12.

---

## 15. Definition of done

Backend:
- [ ] Default timeout raised to a long, finite, env-overridable safety net.
- [ ] Disconnect grace timer cancels only genuinely-abandoned dialogs; re-subscribe cancels the grace.
- [ ] `ask_user_question_closed` emitted exactly once for timeout/abort/turn-end/disconnect, never for user answers.
- [ ] Non-AskUserQuestion allowlist/denylist behaviour unchanged.
- [ ] All resolution paths clear timers/listeners.

Client:
- [ ] `timeout` forwarded; near-expiry warning shown.
- [ ] Expired dialog shows a clear message and preserves the user's draft.
- [ ] Late answers surface a visible notice; nothing is silently dropped.
- [ ] Existing extension dialogs and their tests unchanged.

Validation:
- [ ] RED failures captured before implementation.
- [ ] `lint`, `typecheck`, `build`, `test`, `docs:check-agent-guides` all pass.
- [ ] Disposable live scenarios (`-timeout`, `-delayed-answer`) pass; original scenario still green.
- [ ] Browser validation of zombie-dialog + disconnect + happy path run and reported (or explicitly explained if not automatable).
- [ ] No production access without explicit permission; no secrets/session artifacts staged.
