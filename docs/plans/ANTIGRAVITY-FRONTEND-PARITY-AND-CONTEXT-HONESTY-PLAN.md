# Antigravity Frontend Parity & Honest Context — Improvement Sequence

Status: **EXECUTED 2026-09-09 (this session; contract 1.39.0)** — Phases 0–6 complete with TDD + disposable-server live validation; Phase 7 (production restart) owner-gated. Execution actuals: all 12 findings addressed except F10 (`subagent_info` surfacing — wire shape still unverified; passthrough fixture ready) and the F12 fix (verified as upstream agy workspace behaviour — the model-facing root is /root regardless of spawn cwd, `--add-dir` does not change it; documented in ANTIGRAVITY-INTEGRATION.md, not fixable at our layer). Live proof: disposable server + `scripts/agy-stub.mjs` (ANTIGRAVITY_ENABLED stub opt-in in validation-server-env) — screen view shows agy tool cards (4 items incl. tool_group collapsed / 4 individual expanded vs 0 before), session-info modal renders Antigravity + native conversation id + real usage, context bar 14% → 17% across turns matching the real request sizes. Screenshots: /tmp/agy-shots (01–08).
Date drafted: 2026-09-09 (live evidence same day, against production contract 1.38.0, stream-json backend mode).
Owner trigger: operator request — "make tool calls / background processes visible at antigravity in the frontend like pi; fix the session-info box saying Pi SDK; validate the context-window numbers actually hold true; confirm whether the displayed session id is real; make the Internal API see-what-I-see endpoint fully work for antigravity, then use it to compare Pi vs Antigravity sessions."

## 1. What was already validated (evidence base)

A same-task A/B pair was run live on production (read-only; both sessions deleted afterwards):

- Antigravity `gemini-3.6-flash-medium`, cwd `/tmp/agpi-compare`, task = write 2 files, run a unittest suite, run an ~8s command.
- Pi `zai/glm-5.3-flash`, identical task and cwd.
- Event streams captured via `GET /sessions/:id/events` SSE; screen views via `GET /sessions/:id/transcript?view=screen`; stored turns read from `~/.pi-web-ui/antigravity-sessions/<id>.jsonl`; agy tool inventory captured from a live `init` event (57 tools).

Key measurements:

| Surface | Pi | Antigravity |
|---|---|---|
| Live `tool_execution_start` args | full args (path/content, command/timeout) | **toolName only** (agy ACTIVE step has no parameters) |
| Streaming tool output while running | `tool_execution_update` partial results (5 events incl. mid-run test output) | **none** (agy wire has no partial output; no ticks during an 8s run_command) |
| `tool_execution_end` | structured result + isError | plain string result; **empty string for write_to_file** |
| Final assistant message | one message | **delivered twice** (streamed id never closed + full re-emit under a new id) |
| Screen view `expand=tools` | 8 items incl. 4 tool cards | **4 items, zero tool cards** (4 stored tool calls dropped) |
| Turn-1 usage | n/a (websocket context_update; SDK estimate) | input 42,445 · cacheRead 106,044 · output 2,259 · thinking 1,531 · total 44,704 (= input+output) |
| Turn-2 usage | — | input 66,273 · cacheRead 114,196 · output 2,718 · total 68,991 |
| Session id shown | native pi session id (jsonl uuid) | pi-web-ui's own random UUID (agy conversation id stored but not shown) |

Usage semantics decoded: agy `total = input + output` and **excludes cacheRead**; the real request size is `input + cacheRead` (turn 1: ≈148,489 = 14.2% of 1,048,576; turn 2: ≈180,469 = 17.2%). Today's display uses `total` → shows 4.3% / 6.6% — **understates ~2.6×; looks realistic, does not hold true.**

## 2. Findings (root causes)

- **F1 Screen view drops all antigravity tool cards.** `shared/src/screen-view.ts` `VISIBLE_TOOL_NAMES` covers pi/claude/opencode names only; agy names (`run_command`, `write_to_file`, `view_file`, …) are not members → `emitTool` early-returns. Affects `transcript?view=screen` and the `/sessions/:id/evidence` screen expansion — the "agents see what the operator sees" surface.
- **F2 Live assistant text duplicated.** `agy-event-normalizer.ts` `onResult` (suppressTerminalEvents branch) clears `state.assistantMessageOpen` before `antigravity-service.ts` `finalizeStreamSuccess` consults it → service takes the "nothing streamed" else-branch and re-emits the whole response under a fresh id; the streamed message never gets `message_end`. Reload/replay shows a single copy (live/replay mismatch).
- **F3 Live tool cards lack args and friendly results.** Args exist only in the DONE step (`tool_info.parameters`) and are stored + replayed but never re-surfaced live. `write_to_file` ends with empty output → card body empty.
- **F4 Session Info modal mislabels antigravity as "Pi SDK"** — `client/src/components/StatusBar/SessionInfoModal.tsx` has no antigravity branch. Same handler hardcodes `tokens`/`cost` to zeros (real per-turn usage IS stored), leaves `sessionFile` undefined, and never surfaces the native agy conversation id (registry `antigravityConversationId`, present after first turn; Command Code already uses this `nativeSessionId` pattern).
- **F5 Context % wrong formula** — `antigravity-service.ts` `getContextUsage` uses `usage.total` (=input+output) ÷ static window table; should be `input + cacheRead` (real measured request size). Also `session_switched` for antigravity omits `contextWindow/contextUsed/contextPercent` (opencode sends them) → the composer bar is blank after reopening a session until the next turn finishes.
- **F6 Static window table** — `ANTIGRAVITY_MODEL_CONTEXT_WINDOWS` best-effort prefix match; acceptable, keep maintained; flash=1,048,576, pro=2,097,152 verified present for current catalogue.
- **F7 Displayed session id** — pi-web-ui's own UUID, not agy-native. Correct as the durable identity (transfer/watch use it), but the info box should also show the native conversation id (see F4).
- **F8 Frontend name/arg mappings pi-centric** — `normalizeToolName`, `TOOL_ICONS`, `TOOL_DISPLAY_NAMES`, `getPrimaryParam` (priority keys `path/command/...`) miss agy PascalCase keys: `CommandLine` (run_command), `TargetFile` (write_to_file), `AbsolutePath` (view_file). Shared `buildToolHeaderText` needs the same keys.
- **F9 agy background processes render as unrelated cards** — agy's background-command lifecycle is `run_command` (returns immediately) + `command_status` polls + `send_command_input`; a background test suite currently shows as disconnected cards, nothing like a coherent live process view.
- **F10 `subagent_info` passthrough unused** — agy steps carry `subagent_info`; potential child surfacing (cf. contract 1.34.0) — wire shape unknown, investigate.
- **F12 cwd fidelity observation** — session cwd was `/tmp/agpi-compare` but the model wrote to `/root/calc.py`; unknown whether agy respects spawn cwd (init.cwd echo) or the model chose /root. Verify during execution; fix or document.

## 3. Improvement sequence (phases)

Each phase: strict TDD (red first), `npm run lint && typecheck && build`, targeted suites; live gates as noted. Frontend phases produce paired desktop/mobile before/after screenshots as evidence artefacts for the owner review point at the end (production restart is owner-gated anyway).

- **Phase 0 — Fixtures & groundwork.** Embed the two captured live event sequences (ag + pi) as test fixtures. AGY_BINARY stub (env override already supported in `antigravity-service.ts`/`agy-stream-process.ts`) scripted to emit init/steps/result incl. tools, delayed run_command, usage blocks — enables disposable-server frontend validation without production. Freeze the 57-tool inventory as a shared constant.
- **Phase 1 — Screen-view tool visibility (F1).** Add agy families to `VISIBLE_TOOL_NAMES` (run_command, write_to_file, view_file, replace_file_content, multi_replace_file_content, sed_file, list_dir, grep_search, find_by_name, search_web, read_url_content, read_resource, invoke_subagent, generate_image, notebook_*, browser_* core set — exact set decided against the inventory, avoid over-matching). agy primary-arg keys in `buildToolHeaderText`. Tests: stored-turn replay → tool cards projected; grouping unaffected. Gate: stub-agy disposable server screen view + read-only prod re-check after deploy.
- **Phase 2 — Live stream honesty (F2, F3).** Normalizer suppress-mode: do not clear the open-assistant bookkeeping; service emits `message_end` for the streamed id and never re-emits streamed text. On DONE-with-parameters-after-argsless-start: carry `args` on `tool_execution_end` (additive) and have the client patch the card's args. Synthesize friendly result text for write-family tools when output is empty ("Wrote <TargetFile>"). Document honestly: no streaming partial output is possible from the agy wire (verified); the running card shows name/args/spinner only.
- **Phase 3 — Session Info truth & context honesty (F4, F5, F7).** Antigravity branch in SessionInfoModal ("Antigravity — agy CLI"); real token panel from stored usage (input/output/thinking/cacheRead/total summed per finalized turns; last-turn cumulative for context); `sessionFile` = store path; `nativeSessionId` = registry `antigravityConversationId`. `getContextUsage`: `tokens = input + cacheRead` of the last finalized turn; percent accordingly (real, not estimated). Add context fields to antigravity `session_switched`. Turn-over-turn growth assertion via stub + a real two-turn live check.
- **Phase 4 — Frontend display parity (F8, F9).** Name→display/icon mappings and primary-arg keys for agy tools (run_command→"Shell"/Terminal/CommandLine; write_to_file→Write/TargetFile; view_file→Read/AbsolutePath; replace-family→Edit; list_dir→Find Files; grep_search/find_by_name→Search; search_web→Web Search; read_url_content/read_resource→Fetch URL; invoke_subagent→Subagent card). `command_status` cards rendered as a coherent "Background process" card with accumulated output; stretch: visually chain run_command→command_status. Client store tests + webapp-testing visual pass (stub agy).
- **Phase 5 — Investigations (F10, F12).** Inspect `subagent_info` wire shape (one live probe) — implement child surfacing only if the payload is bounded and stable; else record finding. Verify agy cwd semantics via init.cwd echo; fix spawn or document.
- **Phase 6 — Docs, contract, skills.** Update `docs/ANTIGRAVITY-INTEGRATION.md` (tool surfacing, context formula, session-id semantics), EVENT-PIPELINE/CODEBASE-MAP pointers if needed. Contract: no Internal API wire-shape change expected (screen-view schema already has tool items; `tool_execution_end.args` is websocket-client additive) — bump to 1.39.0 ONLY if a governed field actually changes; otherwise no bump. Skills: pi-web-ui-internal-api-orchestration canonical note that screen view now shows agy tools.
- **Phase 7 — Deploy & verify (owner-gated).** Production restart request (preflight: activeTurns 0, nonterminal receipts 0). Post-deploy read-only A/B re-run on production; screenshots presented; Agent OS capture; cleanup of validation sessions.

## 4. Execution notes

- Validation stack: unit/fixtures + stub-agy disposable server for frontend; production used read-only for pre/post evidence (no restart without permission).
- Comparison models: antigravity `gemini-3.6-flash-medium`, pi `zai/glm-5.3-flash` (operator-specified cheap pair).
- Do not touch the three "are you here?" antigravity sessions (other agents' board probes).
- Keep diffs minimal; no new branch (master); commit+push per repo rules.
