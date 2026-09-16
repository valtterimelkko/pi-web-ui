# Injection marking — execution plan (child, 2026-09-16)

Contract: `BRIEF.md` in this directory. Grounded against the live pi SDK
(`@earendil-works/pi-coding-agent` dist), both work trees, and the operator's
extension set. Status marker per section: ☐ todo / ◐ in progress / ☑ done.

## Grounded design (verified, not assumed)

1. `pi.sendMessage({customType, content, display, details}, {deliverAs:'followUp', triggerTurn:true})`
   exists (extensions.md §pi.sendMessage; `agent-session.js` `sendCustomMessage`).
   `convertToLlm` maps `role:'custom'` → LLM user message, so **content still
   reaches the model and the follow-up turn still triggers** — behaviour
   preserved, plus a structural mark. When idle, `_runAgentPrompt(appMessage)`
   appends + emits `message_start`/`message_end` (role `custom`) and persists a
   `type:'custom'` JSONL entry carrying `customType`.
2. The other agent-os lanes (packet / workset / gated) ride `before_agent_start`
   and are injected INTO the prompt array **between the user message and the
   assistant output** (`agent-session.js` ~line 897; `agent-loop.js` line 52
   emits message_start for each prompt input). They already carry
   `customType:'agent-os'`. They must NOT become turn boundaries.
3. Therefore the capture lane gets its OWN marker: **`customType:'agent-os-capture'`**
   — the only agent-os delivery that triggers its own turn, hence the only one
   that may bound a spoken turn.
4. Existing consumers already drop `role:'custom'`/`type:'custom'` by
   construction — no schema or protocol change anywhere:
   - chat view: `VirtualizedMessageList` keeps `user|assistant|tool` only;
   - Voice Mode side pane: same list component through `messagesToLiveMessages`;
   - session-switch replay: `parsePiSessionHistory` keeps `type==='message'` only;
   - screen view: `shared/src/screen-view.ts` keeps `user|assistant` only;
   - talker state history: `server/src/talker/session-registry.ts`
     `toHistoryEntries` keeps `user|assistant` only (brief finding 5 — correct).
5. The talker's spoken digest decision is CLIENT-side:
   `useAnswerReader.getTurnAssistantParts` scans backwards, stops at `role==='user'`,
   skips everything else. Today the capture prompt is a USER message, so the
   scan's turn = the housekeeping answer — the exact narration bug. After the
   change the capture prompt is `role:'custom'`, which the scan skips without
   stopping — so the rule must become: assistant output more recent than the
   last `agent-os-capture` custom message (with no operator user message after
   it) is excluded; scanning continues below the injection to collect the
   operator's work turn.
6. Wake/goal continuations (`watch-wake`, `goal-engine`, `background-shell`
   completions) all deliver via `sendUserMessage` → real user boundary → their
   work stays spoken. Verified on the host extension set.
7. Kill switch: `AGENT_OS_INJECT_CAPTURE_MARKING=0` (same env-channel style as
   `AGENT_OS_INJECT_COORDINATION`) restores the legacy `sendUserMessage` path;
   missing `pi.sendMessage` also falls back to legacy (fail-open, T3 posture).

## Work

### A. Mark the capture lane at the source — `/root/pi-enhancement-wt-inject` (task/capture-marking)
- ☐ A1 TDD RED: `tests/agent-os-inject-capture-marking.test.mjs` —
  marked delivery (customType/content/display/options), kill switch,
  missing-sendMessage fallback, no-channel outcome, content byte-identical.
- ☐ A2 GREEN: `agent-os-inject/index.ts` — `sendMessage` channel + env kill
  switch + fallback; type surface updated.
- ☐ A3 full extension test suite passes.

### B. Talker spoken-context exclusion — `/root/pi-web-ui-wt-inject` (task/injection-marking)
- ☐ B1 TDD RED (client): turn-scan injection boundary tests
  (`turnAssistantParts.test.ts` + new cases); store `customType` carry tests.
- ☐ B2 GREEN (client): `Message.customType?` + role `'custom'` in the union,
  carry through the three Message-building sites (fold, live message_start,
  multi-session message_start); `getTurnAssistantParts` boundary rule keyed on
  `customType === 'agent-os-capture'` (exported constant + predicate).
- ☐ B3 TDD (server pins): `toHistoryEntries`/snapshot exclude `role:'custom'`;
  `parsePiSessionHistory` drops `type:'custom'`; screen-view drops custom —
  plus a verbatim-quote test: an operator USER prompt containing the exact
  capture wording is never a boundary (structural match only).

### C. Regression proof (brief §C — primary acceptance)
- ☐ C1 Equivalence fixtures: projections (history replay, screen view, talker
  history, client turn scan) produce byte-identical output for sessions with
  NO injections before/after; for sessions WITH injections the only delta is
  the enumerated injection line itself.
- ☐ C2 Full existing suites pass unchanged (client, server, shared) — list
  counts before/after in evidence.

### D. Disposable-server live validation (brief §D)
- ☐ D1 Boot disposable server(s) with a PRIVATE agent dir whose
  `extensions/agent-os-inject` points at the worktree build (no production
  symlink touch); LEGACY boot has `AGENT_OS_INJECT_CAPTURE_MARKING=0`.
- ☐ D2 Real pi sessions with real capture injections; wire-level capture of
  `message_start` (role/customType) for MARKED vs LEGACY.
- ☐ D3 Compare session-switch replay + screen view + tool grouping between
  LEGACY and MARKED: only the enumerated difference.
- ☐ D4 Browser check (disposable client + playwright): chat view and Voice Mode
  pane render identically except the capture bubble; the spoken-turn decision
  never submits housekeeping text to `talker_digest` in MARKED, and does
  expose it in LEGACY (the bug, demonstrated).
- ☐ D5 Evidence + raw commands under `operations/injection-marking-20260916/evidence/`.

### E. Handback
- ☐ E1 `complete.md`: exact commands + exit codes, evidence paths, proven vs
  inferred, commit ids in both repos.
- ☐ E2 `/tmp/injection-marking-coord/03-complete.md` + board update; commits
  pushed on the task branches (no merge, no deploy — parent's call).
