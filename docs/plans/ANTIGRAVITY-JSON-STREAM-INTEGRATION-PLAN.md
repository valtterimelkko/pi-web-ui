# Plan: Antigravity JSON Stream Integration (agy 1.1.27 stream-json)

> **Status:** PROPOSED — awaiting owner go. No execution before approval.
> **Evidence base:** live-validated 2026-09-08 against `agy` 1.1.27 on this
> host; full capture with raw command outputs:
> `/root/pi-enhancement/docs/research/2026-09-08-agy-json-headless-live-validation.md`
> (referenced below as **[LV-doc]**). Official docs:
> <https://antigravity.google/docs/cli/headless/>
> **Contract:** no Internal API wire-schema change expected (stays `1.27.0`);
> see D6 for the escalation rule.
> **Coordination:** another agent was finalising changes in this repo while
> this plan was written; the plan commit touches only this new file. Phase
> commits must follow the same own-files-only discipline.

---

## 0. Owner constraints (already decided — do not re-ask)

| # | Constraint / decision (owner, 2026-09-08) |
|---|---|
| D1 | **Consumer subscription only.** Auth must remain the CLI's existing local OAuth login (`~/.gemini/antigravity-cli/`). **No Google/Gemini API keys anywhere.** The Antigravity SDK is excluded (Python + `GEMINI_API_KEY`/Vertex — cannot use the consumer subscription). |
| D2 | **No credentials in this repo.** Same posture as today: the server spawns `agy` as the same OS user; no secrets read, copied, or committed. |
| D3 | **Exploit the new surface, don't port the old architecture.** The current text-print-mode design existed because nothing else existed. stream-json modes, per-turn result events, real usage, tool visibility, stdin multi-turn, effort semantics, `--json-schema` should all be taken advantage of where they remove complexity. |
| D4 | Model selection and thinking-level selection must be **reliable and live-validated against what is advertised** (loud-fail semantics, slug/label handling, effort conflicts — all validated in [LV-doc] §2). |
| D5 | Steering: support what the transport honestly supports, in both the **frontend** and the **Internal API**; the queue/send-immediately question is settled by the live probe ([LV-doc] §3: mid-turn stdin writes queue natively; no mid-run join exists). |
| D6 | Contract version: **no bump expected** (all changes are additive server behaviour; capabilities values change but not the wire schema). If execution review finds a genuine wire-schema change, take `1.28.0` (next free; steer-wake was de-reserved) and pause for the agent-os mirror-resync gate like every bump. |
| D7 | Live validation must be cheap: `gemini-3.6-flash-low` is the validation model (model-validation failures are free — they fail before any model call). |

---

## 1. Rationale and intent

The current Antigravity runtime (`server/src/antigravity/`) is a
subprocess-per-turn wrapper around `agy -p` **text** print mode. Because text
mode is a batch blob that replays ALL prior replies on stdout, the
integration carries an entire layer of lossy workarounds, every one of them
rooted in "text mode is the only option" — which is no longer true:

| Workaround in current code | Root cause | stream-json replacement [LV-doc] |
|---|---|---|
| `sliceAfterPriorReply` / `extractNewReply` / `priorReplyAnchor` byte-offset + anchor search | resumed text runs replay all prior replies | `result.response` is **per-turn**; no replay in the event stream (§4) |
| `pickNewConversationId` filesystem diffing + `extractSentConversationIdFromAgyLog` log regex | no structured conversation id | `conversation_id` in `init` and every `result` (§1, §4) |
| `extractAgyModelDowngrade` log scraping (RC3) | silent model fallback in old print mode | unknown/ambiguous model now **loud-fails** with an ERROR envelope listing valid models (§2) |
| `ANTIGRAVITY_CHARS_PER_TOKEN = 4` estimates | no usage data | real `usage` per turn + per step (§1) |
| synthetic `stream_activity` heartbeat + log-mtime stall watchdog | no streaming, no events | real ~200 ms-cadence events; liveness = event flow (§1) |
| zero tool visibility (`toolCalls: 0` hardcoded) | text mode hides tools | `tool` steps with `tool_info` (call + result) (§1) |
| `supportsSteer: false`, no follow-up queue | batch subprocess, nothing to queue | persistent stdin process queues mid-turn writes as the next turn (§3) |
| no streaming in the UI | batch blob | NDJSON `text_delta` streaming (§1) |

**Intent:** replace the text-mode wrapper with a **persistent
`--input-format stream-json --output-format stream-json` process per
session**, normalise its event stream into the unified `NormalizedEvent`
pipeline, and delete the workaround layer. The runtime gains: true streaming
in the browser, tool-call visibility, real token usage and context
percentages, native follow-up queueing (frontend + Internal API), reliable
model/thinking-level selection with loud failures, and crash recovery via
`--conversation` resume.

## 2. Architecture decision

### Chosen: persistent stdin process per session (Claude-SDK-service-style)

```
AntigravityService
  └── AgyStreamProcess (1 per active session)
        spawn: agy --input-format stream-json --output-format stream-json
                   [--model <slug>] [--conversation <id>] [--add-dir …]
        stdin  : {"event":"user","message":{"content":…}}   ← one line per turn
        stdout : NDJSON init / step_update / result          → AgyEventNormaliser
        stderr : diagnostics (logged, rate-bounded)
```

* **Turn lifecycle:** a turn = one stdin user event → events → one `result`.
  The `result` event is the turn boundary; `num_turns`/`usage` cumulative,
  `response` per-turn.
* **Queueing:** a user event written while a turn runs is buffered by agy
  itself and executes as the next turn ([LV-doc] §3). This is the
  `follow_up` primitive — server-side queue becomes a thin stdin write.
* **Liveness:** step events flow continuously during a live turn; a
  no-events-for-`stallTimeoutMs` window replaces the log-mtime watchdog.
* **Idle:** keep the process for `antigravityIdleTimeoutMs` (already exists),
  then close stdin (clean exit 0). Next prompt respawns with
  `--conversation <id>` (validated resume-into-stdin, [LV-doc] §4).
* **Crash/kill recovery:** process death mid-turn finalises the turn as
  error; the conversation id is already durable in the store/registry, and
  the next prompt resumes it (validated, §4).
* **Model switch:** `--model` is process-scoped and slash commands are
  rejected in stream input mode, so a model change while idle restarts the
  process with `--model <new> --conversation <id>` (resume validated, §4).
  While running: rejected with 409 (see D-decisions).
* **Warm-start cost:** ~2.4–2.6 s per process spawn, paid once; warmed
  follow-up turns skip it (§3).

### Rejected alternatives (documented so they stay rejected)

1. **Subprocess-per-turn with `--output-format stream-json`** — fixes
   slicing/ids/usage/tool-visibility but keeps per-turn spawn cost, cannot
   queue follow-ups natively, and cannot offer the frontend anything while a
   turn runs. Strictly dominated by the persistent process given validated
   crash recovery.
2. **Antigravity SDK** — Python + API-key auth; violates D1/D2.
3. **Interrupt-style steer** (SIGINT + immediate re-prompt): SIGINT/SIGTERM
  produce a closing `result` (good for abort) but **kill the whole session
  process** and its warm state ([LV-doc] §3); re-prompt requires a respawn.
  Reject as a steer primitive; revisit only if agy ships a real control
  channel (`control_request`/`control_response` inputs are currently
  *rejected* — reserved names suggest future surface).

### Open decisions for the owner (defaults marked ⭢)

| # | Question | Default |
|---|---|---|
| O1 | Steer semantics to advertise: honest queue-only (`followUpSemantics: 'queue_while_busy'`, `supportsSteer: false`) vs Command-Code-style interrupt steer | ⭢ queue-only first; interrupt steer is a separable follow-up |
| O2 | Permission posture: keep `--dangerously-skip-permissions` (current behaviour) vs scoped `permissions.allow` policy in `~/.gemini/antigravity-cli/settings.json` (safer, changes runtime behaviour) | ⭢ keep current flag (behaviour-preserving refactor); posture change is its own task |
| O3 | Model/thinking-level switch while a turn runs: 409 vs queue-until-idle | ⭢ 409 `SESSION_BUSY` (matches Pi surface; simplest honest semantics) |
| O4 | Expose `--json-schema` structured output through the Internal API now | ⭢ no — out of scope; normaliser just preserves the fields |

## 3. Validated ground truth (summary — full detail in [LV-doc])

Every item below is live-verified against `agy` 1.1.27 and is the basis of
the test fixtures:

1. **Event grammar:** `init` once → `step_update`* → `result` per turn.
   Step types seen: `user_input`, `agent_response`, `tool`, `system_message`,
   `unknown`; documented but unseen: `checkpoint`; `subagent_info` possible.
2. **Streaming invariant:** Σ all `text_delta` === `result.response`
   byte-exact (5609 = 5609 measured). ~200 ms cadence. Most intermediate
   `agent_response` DONE events carry **no** text (reasoning-only calls).
3. **`tool_info`:** `{name, parameters, output, error?}` on DONE.
4. **Models:** slug and label both accepted; `init.model` echoes the slug.
   Unknown model / tab-string / effort-conflict / effort-unsupported all
   **loud-fail** with a precise ERROR envelope, exit 1, zero usage, before
   any model call. Thinking level = slug sibling (`gemini-3.x-flash-{low,
   medium,high}`); Claude/GPT-OSS have no effort axis. `agy models` prints
   `<slug>\t<Label>` (14 entries). `agy -p /model` is a free model probe.
5. **Queue:** mid-turn stdin user event → runs as the next turn. Invalid
   JSON line → ERROR result + exit 1. Unknown event name → stderr warning +
   skip + continue. Slash command → ERROR + exit 2. stdin close → clean
   exit 0.
6. **Signals:** SIGINT/SIGTERM mid-turn → closing `result`
   `{status:ERROR, error:"timeout waiting for response"}` + exit 1 —
   **same string as real print-timeout expiry**; the parent disambiguates
   from what it sent.
7. **Resume:** `--conversation` (one-shot or into a stdin process) carries
   full context, same id, cumulative `num_turns`; event stream does NOT
   replay prior turns; `result.response` is only the new turn's reply.
   **Invalid id silently creates a new conversation** (detect via id
   mismatch); **empty-string id resumes an unrelated recent conversation**
   (never pass unvalidated ids).
8. **Usage:** real per-turn/per-step token counts; ~20–30k input tokens even
   for tiny prompts (agent context includes workspace/rules).
9. **Parallel processes on separate conversations are safe.**

## 4. Target file layout

```
server/src/antigravity/
  agy-event-normalizer.ts     NEW — pure: NDJSON line stream → NormalizedEvent[]
                              (+ per-turn accumulator: text, toolCalls, usage)
  agy-models.ts               NEW — pure: `agy models` parsing → catalogue with
                              selectors (slug), labels, thinkingLevels (sibling
                              slugs), effort support map; + model-request builder
  agy-stream-process.ts       NEW — child-process lifecycle: spawn/stdin writes/
                              line reader/queue/watchdogs/signals/idle shutdown
  antigravity-service.ts      REWRITE — orchestrates the above; same public
                              surface (sendPrompt/abort/setModel/…) + new
                              followUp()/setModel internal restart
  antigravity-session-store.ts ADDITIVE — turn gains usage/numTurns/turnStatus/
                              toolCalls; old fields stay readable (back-compat)
  antigravity-history-replay.ts EXTEND — render tool calls + usage from stored
                              turns (old lines replay unchanged)
  antigravity-session-subscribers.ts unchanged
```

Deleted with their tests (each deletion lands in the same phase as its
replacement, guarded by the new tests): `sliceAfterPriorReply`,
`extractNewReply`, `ANCHOR_*`, `pickNewConversationId`,
`extractSentConversationIdFromAgyLog`, `applySentConversationId`,
`extractAgyModelDowngrade`, `normalizeAgyModel` (replaced by `agy-models.ts`
canonicalisation), `buildAgyErrorBody` partial-slicing path,
`ANTIGRAVITY_CHARS_PER_TOKEN` estimate path, log-mtime stall watchdog,
synthetic heartbeat interval.

---

## 5. Phases (strict TDD: RED test first, then implementation)

### Phase 0 — Groundwork (no behaviour change)

* **T0.1** Capability probe: `agyStreamCapable()` — `agy --help` contains
  `--output-format` **and** `--input-format` (version gate for 1.1.x
  stream modes). RED: unit test over injected help text (with/without
  flags) → boolean.
* **T0.2** Zod schemas for the wire surface in
  `server/src/antigravity/agy-event-types.ts`: `AgyEnvelope` (json/result
  shape incl. `usage`, `structured_output?`), `AgyStreamEvent` (init /
  step_update / result), `AgyStepUpdate` (state/step_type/tool_name/
  text_delta/usage/tool_info), **lenient**: unknown `step_type` values and
  extra fields must parse (observed: `unknown`, `system_message`).
  RED: fixture lines from [LV-doc] §1 parse; malformed line rejected.
* **T0.3** Config knobs (additive in `server/src/config.ts`):
  `antigravityStreamMode` (default `true`; `false` → keep legacy text path
  as escape hatch until Phase 10 removes it), reuse existing
  `antigravityIdleTimeoutMs`, `antigravityStallTimeoutMs` (repurposed:
  event-flow gap, not log mtime), `antigravityPromptTimeoutMs` (per-turn
  ceiling), `antigravityMaxAttempts`. RED: env parsing tests.
* Commit boundary: types + probe + config, all suites green.

### Phase 1 — `agy-event-normalizer.ts` (pure, fully unit-tested)

Feed = parsed `AgyStreamEvent`s; output = `NormalizedEvent`s + a per-turn
accumulator the service consumes. RED tests first, fixtures embedded from
the [LV-doc] captures (keep them small; full captures live in the research
doc):

* **T1.1** `init` → `agent_start` (data: permissionMode, toolCount, model).
* **T1.2** `agent_response` ACTIVE/DONE with `text_delta` →
  `message_start`(assistant, once per turn on first delta) +
  `message_update` `text_delta` per fragment; DONE without `text_delta` →
  no text emission (reasoning-only step; regression from the 5609-capture).
* **T1.3** `tool` ACTIVE → `tool_call_start` (name + parameters from
  `tool_info`); DONE → `tool_call_end` (output / error). Map to the same
  shapes other runtimes emit (check `opencode`/`commandcode` adapters for
  the exact `NormalizedEvent` tool fields).
* **T1.4** `user_input`, `system_message`, `unknown`, `checkpoint` steps →
  no user-facing events; optionally a `stream_activity` with step metadata
  (keeps the heartbeat UI alive between text bursts).
* **T1.5** `result` SUCCESS → final `message_end` + `agent_end`
  `{result:null, usage:{input,output,thinking,cacheRead,total}}`; ERROR →
  assistant error body + `agent_end` with `error`; `CANCELED`/`INTERRUPTED`/
  `INVALID`/`WAITING`/`RUNNING` → mapped statuses (WAITING defensively:
  `agent_end` with `waiting:true` data flag).
* **T1.6** Turn-boundary discipline: events after a `result` belong to the
  next turn; step_index is monotonic but never reset — normaliser must not
  key anything on "index 0".
* **T1.7** Conversation-id ledger: normaliser records
  `result.conversation_id`; mismatch with the requested id ⇒ surface a
  structured warning event + service callback (silent-new-conversation
  detection, [LV-doc] §4).
* **T1.8** Streaming invariant property test: for the 141-event fixture,
  Σ emitted `text_delta` === `result.response`.

### Phase 2 — `agy-models.ts` (pure)

* **T2.1** Parse real `agy models` output (`<slug>\t<Label>` 14 lines,
  fixture embedded) → entries `{id: slug, name: label, provider:
  'antigravity'}`.
* **T2.2** Derive `thinkingLevels` from sibling slugs: slug matches
  `^(gemini-[0-9.]+-flash|gemini-[0-9.]+-pro)-([a-z]+)$` → siblings sharing
  the prefix become `[low, medium, high] ∩ siblings`; Claude/GPT-OSS → `[]`
  (no effort axis; live-validated §2). Expose `selector: slug` (contract §2
  of the models route: selector = exactly what create/bind accepts).
* **T2.3** Effort-conflict pre-validation (fail fast without spawning):
  `buildModelArgs({model, effort})` reproduces the CLI rules: baked-level
  slug + mismatched effort → structured error (message mirrors agy's);
  non-Gemini model + any effort → structured error. RED from [LV-doc] §2
  table rows 4–6.
* **T2.4** `parseInvalidModelError(envelope)`: extract the available-models
  list from an ERROR envelope (it embeds the catalogue) → refresh cache.
* Wire into `getAvailableModels()` (service) and both model routes
  (`/api/models` websocket + Internal API `/api/v1/models`) with
  `thinkingLevels` per entry. RED: route fixtures asserting
  `selector: 'gemini-3.6-flash-low'`, `thinkingLevels: ['low','medium','high']`.

### Phase 3 — `agy-stream-process.ts` (child lifecycle)

Dependency-injected `spawn` for unit tests; real spawn only in integration
+ live validation.

* **T3.1** Spawn args builder: `--input-format stream-json
  --output-format stream-json [--model slug] [--conversation uuid]
  [--add-dir …]`; **never** an empty/whitespace conversation id (guards the
  §4 empty-id hazard); model always canonicalised to slug via Phase 2.
* **T3.2** Line reader: NDJSON framing over chunked stdout; malformed line
  → logged, skipped (observed warnings stay non-fatal), never crashes the
  reader.
* **T3.3** Turn state machine: `writeTurn(prompt)` resolves on the next
  `result` (with the normaliser's accumulator); while a turn is open,
  further writes are accepted into the **queue** (write-through — agy
  buffers them; validated §3) with a bounded queue depth; stdin errors
  (EPIPE after process death) reject pending turn promises with reason
  `process-exited`.
* **T3.4** Watchdogs: (a) per-turn hard ceiling =
  `antigravityPromptTimeoutMs` → SIGTERM; (b) stall = no events for
  `antigravityStallTimeoutMs` while a turn is open → SIGTERM. On signal:
  await the closing `result` (agy emits one, validated §6) with a short
  grace period, then SIGKILL; surface reason `timeout`/`stall`/`aborted`
  **from what we sent** (same agy error string for all — parent
  disambiguates).
* **T3.5** Idle shutdown: after `antigravityIdleTimeoutMs` with no open
  turn and no queued writes → close stdin → expect exit 0.
* **T3.6** Abort API: `abort()` = SIGTERM → closing result → turn promise
  resolves `{status:'aborted'}`; the service renders it as a visible error
  turn (keeps RC2 behaviour: no blank screen).
* **T3.7** Restart-with-resume: `restart({model?})` closes stdin, waits for
  exit, respawns with `--conversation <lastId>`; used by model switch and
  crash recovery. RED: fake-spawn test that a mid-write restart never loses
  the conversation id (it comes from durable store, not process memory).

### Phase 4 — Service rewrite (keep public surface)

* **T4.1** `sendPrompt`: open/resume process (lazy spawn on first prompt or
  after idle death), `startTurn` persisted as today (RC1 durability), then
  `writeTurn`. Stream normalised events through the existing
  emit/api-observer plumbing (both websocket and Internal API `/events` get
  identical streams).
* **T4.2** Turn finalisation from the `result` accumulator: `response` =
  `result.response`; persist additive fields `usage`, `numTurns`,
  `turnStatus`, `toolCalls` count, `turnDurationMs` (from
  `duration_seconds`); `conversationId` from the result ledger.
* **T4.3** `getContextUsage` / `getSessionStats`: last `result.usage`
  cumulative totals vs. context window (windows from the model catalogue
  tier, keep the existing table keyed by slug prefix); toolCalls real.
  Remove char/4 path.
* **T4.4** Failure taxonomy → turn error reason: `aborted` (we signalled),
  `timeout`, `stall`, `process-exited` (crash; queue restart), agy
  `ERROR` (surface agy's error string verbatim in the body). All paths
  finalise the turn, emit `agent_end`, keep the notification layer fed
  (RC2).
* **T4.5** Retry policy: `stall`/`timeout` retry ≤ `antigravityMaxAttempts`
  **inside the same process** (conversation continuity is native now — no
  per-attempt id resolution); `process-exited` → respawn with
  `--conversation` then retry once.
* **T4.6** Capabilities: `backendMode: 'stream-json'`,
  `supportsFollowUp: true`, `followUpSemantics: 'queue_while_busy'`,
  `supportsSteer: false` (+ comment: revisit if agy ships a control
  channel), `supportsThinkingLevel: true`, `supportsStreaming: true` (flag
  exists? if not, add additively), `supportsTools: true`,
  `supportsHeartbeat: false` (real events replace it — check what reads
  this flag before flipping), keep pinning/replay flags.
* **T4.7** Registry/store back-compat tests: legacy turn lines (no usage
  fields, `rawStdoutLength` present) still load and replay; legacy
  conversations (`antigravityConversationId` in registry) resume through
  the new process on next prompt.

### Phase 5 — Follow-up queue: websocket + Internal API + frontend

* **T5.1** Service `followUp(sessionId, text)`: open turn ⇒ stdin queue
  write (returns true); no open turn ⇒ false (caller sends as prompt).
  Bound the queue (depth from config; overflow → honest error, do not
  write).
* **T5.2** `connection.ts handleFollowUp`: add the antigravity branch
  (mirrors the Claude branch; STEER_NOT_RUNNING error when idle). Prompt-
  injection gate already applies — keep it.
* **T5.3** `handleSteer`: antigravity branch returns the honest error
  (`STEER_NOT_RUNNING`-style message naming queue semantics) so clients
  that probe steer get a clean answer.
* **T5.4** Internal API `POST /sessions/:id/prompt`: extend the dispatch
  table — busy antigravity + `mode:'follow_up'` ⇒ queue (write-through),
  receipt `deliveryKind: 'deferred-follow-up'`; busy + `mode:'prompt'`
  stays 409 `SESSION_BUSY`. Reuse the Pi queued-run observability pattern
  where it applies (antigravity needs no server-side run queue — agy
  buffers — but the receipt/correlation shape should match).
* **T5.5** Frontend: add `'antigravity'` to the streaming-compose path in
  `client/src/lib/piExtensionControls.ts` with **follow-up-only** delivery:
  the strip shows "Queue — runs after the current turn" (followUp mode);
  the steer option is hidden/disabled with an explanatory title (O1).
  Update `steerLabels` in `MessageInput.tsx`. Unit tests for the label
  matrix; a component test that Enter while streaming enqueues and renders
  the queued bubble (the queued-message UI already exists for other
  runtimes).
* **T5.6** E2E (authorised live validation, Phase 9): follow_up mid-turn →
  exactly one extra `result`, `num_turns` +1, both replies distinct.

### Phase 6 — Model + thinking-level selection (frontend + Internal API)

* **T6.1** `setModel(sessionId, modelId)`: canonicalise to slug (Phase 2);
  idle ⇒ store + (if process alive) `restart({model})`; running ⇒ 409
  `SESSION_BUSY` (O3). `agy -p /model`-style probe is *not* needed for
  switching but keep a diagnostic helper that shells
  `--print /model`-equivalent? **No** — slash in stdin mode is rejected;
  the probe exists only as a standalone one-shot; skip unless diagnostics
  need it.
* **T6.2** Thinking level: `setModel` accepts `{model, thinkingLevel}` ⇒
  sibling slug swap; validation against the catalogue's `thinkingLevels`.
  Surface in the session-controls model picker exactly like Pi/Claude
  (reuse `ThinkingLevelSelector`): antigravity entries now advertise
  levels.
* **T6.3** Create-session model binding (`POST /sessions`
  `runtime:'antigravity'`, `model` field): accept slug or label; store
  slug; **live-verify** the binding by asserting `init.model` echo on the
  first turn's event stream (Phase 9 scenario) — the loud-fail envelope
  path (T2.4) covers mismatches.
* **T6.4** `--effort`: **not exposed as a separate control** — the slug
  encodes the level (validated conflict semantics, §2). Document this in
  capabilities (`supportsThinkingLevel: true` with
  `thinkingLevelSemantics: 'model-slug'` additive field if the flag shape
  allows; else document in ANTIGRAVITY-INTEGRATION.md).

### Phase 7 — Replay & store rendering

* **T7.1** `turnsToReplayEvents`: emit tool_call_start/end per stored
  toolCall (new additive per-tool records in the turn line: keep a compact
  array `tools: [{name, parameters?, output?, error?}]` bounded by size
  caps — truncate long outputs with a marker, consistent with other
  runtimes' tool-result truncation); emit usage in `agent_end`.
* **T7.2** Legacy lines (no `tools`/`usage`) replay exactly as today —
  byte-for-byte event-shape test against the current implementation's
  output for the same input.
* **T7.3** Orphaned `running` turn after crash: unchanged semantics (user
  prompt visible, no synthetic assistant reply); plus: a respawned process
  must not double-run a turn whose prompt was written but whose result was
  lost — on process death the in-flight turn is finalised `error` before
  any new write is accepted.

### Phase 8 — Docs + skills

* Rewrite `docs/ANTIGRAVITY-INTEGRATION.md`: new architecture diagram
  (persistent process), event mapping table, model/thinking-level
  semantics, queue semantics, watchdog/abort taxonomy, back-compat notes,
  updated capabilities JSON, troubleshooting refresh (`/model` probe,
  invalid-conversation-id behaviour, empty-id hazard).
* `docs/EVENT-PIPELINE.md`: add the antigravity stream adapter row.
* `docs/CODEBASE-MAP.md`, `AGENTS.md` "If you need to change X" table: only
  if file names change meaningfully (they do: three new modules).
* `docs/LIVE-VALIDATION.md`: new antigravity scenarios (below) + keep the
  "non-disposable, authorised target only" warning (agy shares the real
  `~/.gemini` state — unchanged by this refactor).
* Skills (canonical source only, **not** runtime copies):
  `/root/.skills-global/skills-global/agy-p/SKILL.md` — add stream-json
  section (stdin multi-turn, queue semantics, loud model failures,
  conversation-id rules) once the integration ships. This repo's docs link
  to it rather than duplicating.
* `docs/RECENT-CHANGES.md` entry.

### Phase 9 — Live validation (authorised target; cheap model per D7)

Disposable server caveat: antigravity stays outside `--runtime all`
disposable mode (no conversation-dir override exists in agy). Run against
an explicitly authorised server (the established pattern: separate socket +
token, or `--allow-production` with owner permission). Every scenario
asserts **wire-level evidence**, not UI screenshots alone.

| # | Scenario | Assertions |
|---|---|---|
| L1 | smoke-stream | create → prompt → NDJSON-driven `text_delta` events arrive **incrementally** (≥3 deltas before final) → `agent_end` with real usage; turn stored with usage/numTurns |
| L2 | multi-turn-queue | turn 1 streaming → follow_up write → turn 1 result completes untouched → exactly one more result; `num_turns` 1→2; replies distinct; UI shows queued bubble delivered |
| L3 | model-tier-live-check | bind `gemini-3.6-flash-low` ⇒ first turn's `init.model` echoes slug verbatim; bind sibling `gemini-3.6-flash-high` via thinking-level swap ⇒ echo again; `/models` selector round-trips through POST create |
| L4 | model-loud-fail | bind `bogus-model` ⇒ turn fails with agy's ERROR envelope text surfaced in the error body; **no** silent downgrade; zero usage recorded |
| L5 | abort | SIGTERM path: mid-turn abort ⇒ closing result consumed ⇒ visible error turn, session reusable (next prompt works, same conversation id) |
| L6 | timeout | `--print-timeout`-scale watchdog trip (short config) ⇒ error turn `timeout`; process healthy afterwards |
| L7 | crash-recovery | kill -9 the child mid-turn ⇒ error turn `process-exited`; next prompt resumes same conversation id; model recall check ("what did I ask before?") |
| L8 | idle-restart | idle timeout closes process (exit 0); next prompt respawns with `--conversation`; context retained |
| L9 | parallel | two antigravity sessions running turns concurrently; independent conversation ids and results |
| L10 | internal-api-follow-up | Internal API prompt `mode:'follow_up'` on busy session queues (receipt `deferred-follow-up`); `mode:'prompt'` on busy ⇒ 409; `/events` SSE carries both turns' normalised streams |
| L11 | legacy-resume | pre-refactor session (text-mode turn history + `antigravityConversationId` in registry) continues through the new path; old turns replay unchanged |

Evidence recording: per scenario, save the NDJSON capture + normalised
event log + store diff under the run's validation artefacts, referenced
from the completion report.

### Phase 10 — Cleanup + cutover (after L1–L11 pass)

* Delete the legacy text-mode path and its now-dead helpers/tests
  (`antigravityStreamMode=false` escape hatch removed) — only after one
  full validation pass on the stream path.
* Remove `agy-logs/` per-run log machinery *if* nothing else consumes it
  (check `runtime.agyLogs` consumers in the Internal API session-detail
  route — keep the field pointing at `~/.gemini/antigravity-cli/log/`
  which agy still writes natively).
* Final `npm run lint && npm run typecheck && npm run build && npm test` +
  targeted suites (`server/tests/unit/antigravity/**`, internal-api route
  fixtures, client label-matrix tests).

---

## 6. Edge-case catalogue (each has a named test)

| Edge | Handling | Test |
|---|---|---|
| Unknown `step_type` / new event fields | lenient Zod; ignored steps → optional `stream_activity` | T0.2, T1.4 |
| `agent_response` DONE without text | no text emission | T1.2 |
| Same error string for timeout/signal | parent-issued reason wins | T3.4, T4.4 |
| Invalid conversation id → silent new conversation | id-mismatch warning event + registry rebind refusal (surface, never silently rebind — keep current `applySentConversationId` spirit in the new ledger) | T1.7, T4.2 |
| Empty/whitespace conversation id | never pass it (respawn fresh) | T3.1 |
| Invalid JSON line into stdin | cannot happen from our writer (we always serialise); documented for external drivers | T3.2 (reader tolerance) |
| Unknown stdin event | we never send one; reader tolerates stderr warnings | T3.2 |
| Slash commands | never forwarded on the stream path; prompt text starting with `/` is sent as literal user content (agy treats it as text in stream mode) | T3.3 fixture |
| WAITING status | defensive mapping (`agent_end` + `waiting` flag) | T1.5 |
| Queue overflow | bounded depth, honest error | T5.1 |
| EPIPE / process death mid-write | pending turn → `process-exited`, auto-respawn on next prompt | T3.3, T4.5 |
| Startup spike (~2.5 s) | first-turn `stream_activity` "starting agent process" so the UI never looks dead | T4.1 |
| Huge tool outputs | truncation with marker at store time (caps consistent with other runtimes) | T7.1 |
| Model cache stale (catalogue changed server-side) | loud-fail envelope parser refreshes cache (T2.4); `/models` TTL stays 60 s | T2.4 |
| `--json-schema` fields present | preserved on the accumulator, not exposed (O4) | T1.5 |

## 7. Migration & back-compat

* **Store:** additive fields only; loader unchanged; legacy lines replay
  byte-identically (T7.2).
* **Registry:** `antigravityConversationId` semantics unchanged; ids now
  come from result events instead of log scraping.
* **Capabilities:** value changes (`backendMode: 'stream-json'`,
  `supportsThinkingLevel: true`, `followUpSemantics: 'queue_while_busy'`)
  — additive field `thinkingLevelSemantics` only if the schema owner
  confirms; otherwise document. No wire-schema change ⇒ contract stays
  `1.27.0` (D6).
* **Sessions in flight at deploy time:** a running text-mode turn finishes
  under the old code only if the deploy waits; standard practice applies
  (deploy with `activeTurns:0` gate as usual). Old sessions resume via
  stored conversation ids (L11).
* **Rollback:** Phase 0's `ANTIGRAVITY_STREAM_MODE=false` env restores the
  legacy path until Phase 10 deletes it.

## 8. Risks

| Risk | Mitigation |
|---|---|
| agy protocol drift (new step types/statuses) | lenient schemas + ignore-unknown normaliser (T0.2/T1.4) + version probe (T0.1) |
| Persistent processes leak (idle timeout missed) | idle watchdog (T3.5) + existing cleanup interval + dispose path unmodified |
| Queue semantics change upstream (mid-turn write behaviour) | L2 pins the behaviour at cutover; normaliser keys on result events, not write timing |
| Conversation-id reuse acrossPi sessions | ids are agy-side UUIDs; ledger refuses silent rebind (T1.7) |
| Behaviour change in permission posture | none by default (O2 keeps the current flag) |
| Frontend follows a steer affordance that lies | honest queue-only labels (T5.5); steer branch returns a clean error (T5.3) |

## 9. Commit & coordination protocol (this plan's execution)

* Each phase = one commit on `master` (no new branch), own files only;
  `git status --short` inspected before every commit; never stage another
  agent's work (repo was mid-finalisation by another agent at plan time).
* Push after each green phase; full gates before the cleanup phase.
* Production restart + any contract bump remain **owner-gated** (nothing in
  this plan requires them unless D6's escalation triggers).
* Telegram milestone at: plan approved (owner), Phase 4 done (server
  streaming live-validated), Phase 9 complete, final cutover.

## 10. Suggested execution order & sizing

Phases 0→2 (pure, ~1 day) → 3→4 (server core, ~1–1.5 days) → 5→6
(surfaces, ~0.5–1 day) → 7→8 (~0.5 day) → 9 (validation session, ~0.5 day)
→ 10 (cleanup, ~0.5 day). A single execution agent can run it
end-to-end; no cross-repo work except the skills-global doc update (§8)
which is a separate commit in `/root/.skills-global`.
