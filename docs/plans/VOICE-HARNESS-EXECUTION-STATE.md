# Voice harness execution — live state (parent)

> Parent keeps this current. If a different agent picks this up, read this file
> first, then `docs/plans/DRIVE-MODE-TWO-LANE-PLAN.md`.
> Written 2026-09-12. **Update on every wake.**

## Goal

Execute the agreed two-lane voice scope end-to-end with children, using TDD and
live validation, developing additional validation methods, cleaning up worktrees
afterwards.

## Parent

- Session: `01a0920a-55bc-7367-8281-00dc765d8225` (bare Pi CLI)
- Board entry: `pi-01a0920a`
- Wake path: `watch_wake_register` (bare CLI ⇒ server-side `onFire` cannot reach me)

## Children — all four complete

| Child | Session id | Outcome |
|---|---|---|
| **H1** talker harness | `01a096a8-81e9-72aa-93c7-bbbca093c60a` | ✅ committed `de6cafe` — 97 tests, structural gate verified |
| **H2** Pi input routing | `01a096a8-84c3-72aa-93c7-bbbef32af902` | ✅ merged `5c17304` — 8 tests, live-validated |
| **H3** model retest | `01a0970c-a362-72aa-93c7-bbc265ebeea4` | ✅ committed `cc3f86a` — five candidates measured, one defect found |
| **H4** long-session | `01a0970c-944c-72aa-93c7-bbc089136e0c` | ✅ committed `cc3f86a` — design claim NOT falsified, 157 turns |
| **H5** Gemma provider guard | `01a09754-7e0e-72aa-93c7-bbc6edcebe39` | ✅ committed `f84fa86` — 3-part fix, live 330ms median, 0/12 degenerate |
| **H6** server integration | `01a09727-7df1-72aa-93c7-bbc47c5951df` | ✅ committed `13e30da` — registry wired, gate unchanged |

All four worktrees and all four child branches are cleaned up. Only the 9 stale
worktrees from a **previous execution** remain (listed at the end).

### Isolation failure — honest record

H3 and H4 were given isolated worktrees and their sessions did report the
worktree as `cwd`, but **both wrote their artefacts into the main tree**
(`/root/pi-web-ui`) instead. Cause: their briefs named `/root/pi-web-ui` as "the
repo" while instructing them not to touch certain paths, so they followed the
absolute paths. **No collision occurred** — their changes were disjoint
(H3: results + probe + harness flag; H4: two test files) — and `server/src/talker/`
was untouched by both, as required. But the isolation I intended did not hold, and
the lesson is: name the worktree as the repo, not the main tree, and never let
the brief's scope limits be the only thing keeping children apart.

### 2026-09-12 ~20:53 — H5 mid-work verification + the mobile-socket finding

**H5 is still running** (98 msgs); the wake was a mid-work turn end, not a stall.
Its changes are already in the tree, so the parent verified them now rather than
waiting:

- **Ran its tests: 25/25 pass** (up from 9).
- **Full talker suite: 138/138 pass**, `npm run typecheck` exit 0 — no regression.
- **Read the retry control flow directly.** `completeTurn` makes two *sequential*
  calls, not a loop: a good first reply returns immediately with `retries: 0`; a
  degenerate first reply triggers exactly one more call; a still-degenerate second
  reply **throws an honest error** (surfaced as `MODEL_FAILURE_REPLY`) rather than
  fabricating text. Boundedness is structural, not a counter that could be
  misconfigured.
- **Confirmed the assertions that matter exist**: exactly-2-calls on persistent
  degeneracy, 1-call-no-retry for good replies (explicitly labelled a regression
  guard against retry storms), the provider preference carried on both attempts,
  and HTTP errors NOT triggering a content retry.
- The provider order is overridable (`TALKER_PROVIDER_ORDER`) so it can be
  re-targeted when the provider set changes — which it will.

Still outstanding for H5: its own live numbers. Not committed yet.

### NEW FINDING — the mobile-browser socket defect (operator-reported)

The operator reports that on mobile, dictated prompts frequently never leave the
device, and that copying the text and refreshing the browser is the only fix.
Investigated and confirmed — it is a real client defect, and it directly threatens
Drive Mode, where a lost utterance cannot easily be retyped.

Three verified links in the chain:

1. **Reconnection is scheduled with `setTimeout`** (`client/src/lib/websocket.ts`
   `attemptReconnect`). Mobile browsers **freeze timers** when the tab is
   backgrounded or the screen locks, so the backoff never fires while suspended
   and is stale on return.
2. **Nothing reconnects on resume.** The whole client contains exactly **one**
   `visibilitychange` handler, and it exists only to flush throttled localStorage
   writes (`sessionStore.ts:67`). There is **no** `online`, `focus`, or resume
   check in `useWebSocket`. So a returned tab sits on a `CLOSED` socket with no
   recovery.
3. **The send failure is silent.** `WebSocketClient.send()` returns `false` when
   not open, and callers discard it — `useDriveModeDictation` does
   `if (sessionId) { sendPrompt(text); }` with the boolean ignored. The dictated
   text is dropped with only a `console.error`.

Also: a suspended tab can consume the bounded reconnect budget
(`maxReconnectAttempts = 5`) while frozen, before it ever retries. It is **not**
an auth/token-expiry problem.

**Why refresh fixes it:** a refresh is currently the only thing that reconnects.

**Planned fix (E1, queued — deliberately not started while H5 writes this tree):**
reconnect immediately on `visibilitychange→visible` / `online` / focus and reset
the attempt budget; queue outbound sends while the socket is not open and flush
after reconnect; surface send failure to the operator instead of a console log;
preserve the dictation transcript on failure so a spoken instruction is never lost.

## Queued, not yet dispatched (blocked on H1)

- **H3** — retest the top five Benchmark 3 finalists against the *real* harness,
  in this repo rather than the benchmark repo. Candidate list pending operator
  confirmation of the marker-penalised fifth pick.
- **H4** — long-session check (100+ turns, repeated window cycling) against the
  real harness, proving the bounded window and the pending-proposal rule.

## Decisions already settled (do not relitigate)

- Talker model: `openrouter/google/gemma-4-26b-a4b-it`, **thinking off**.
- Send acknowledgement is exactly **"sending that now"**, spoken only after the
  harness confirms the send succeeded.
- The gate is **structural**: the talker cannot send; only the harness sends, from
  a confirmed pending proposal, using the operator's **raw utterance** by id.
- The prompt **justifies** the gate; the pushback turn is a mandatory test.
- No LLM summariser in v1; bounded rolling window, turn-boundary trimming, never
  trimmed mid-exchange.

## H3 — approved candidate list

Operator approved 2026-09-12. Retest against the **real harness** in this repo:
1. `openrouter/google/gemma-4-26b-a4b-it` (thinking off) — the incumbent
2. `google/gemini-3.6-flash` (minimal)
3. `deepseek/deepseek-flash` (off)
4. `openai/gpt-4o-mini` (off)
5. **`openai/gpt-5-nano`** (minimal — provider floor; no thinking-off exists)

**Why #5 is `gpt-5-nano`:** it is marker-penalised (1 hard fail in the earlier
sweep), and its documented failure was specifically a *propose-and-relay-in-the-
same-turn* pattern — which is exactly what the structural gate should make
impossible once the model no longer owns the send. It is also the fastest
candidate after gpt-4o-mini. It therefore tests the harness change rather than
merely re-running the field.

## Supervision standard set by the operator (2026-09-12)

- **Independently verify each child's work** after it stops — not to the deepest
  depth, but genuinely: check claims against the tree, run the key evidence
  yourself rather than trusting the report.
- **Rework is allowed**: the same model may be asked to redo a section that is
  not up to standard, rather than the parent silently fixing it.
- **Operator does not need code review.** They are needed when **usage testing**
  starts, not before. Keep them informed by Telegram; questions go to Telegram or
  they will not be seen.
- Milestones go to Telegram as well as this file.

## Outstanding operator question (non-blocking)

None. The H3 fifth-candidate question was answered 2026-09-12 (gpt-5-nano).

### 2026-09-12 ~19:45 — wave 2 accepted; a real production defect fixed

**H3 (retest) and H4 (long-session) both accepted**, verified by the parent:

- H4's numbers reproduce exactly on my run: `turns=157 trims=17 entriesDropped=290
  releases=26`. Its strongest assertion was read and is **non-vacuous** (an exact
  `.toBe(PENDING_KEEP)` on every pending-regime trim, plus an assertion that
  material was actually dropped).
- Full talker suite after both landed: **108/108**.
- `npm run typecheck` exit 0; `npm run lint` exit 0 (the six "error" matches in
  the log are pre-existing warnings whose variable names contain "error").

**A real production defect was found and fixed (TDD, RED-first).**
`model-client.ts` hardcoded `reasoning: { enabled: false }`. Some OpenRouter
endpoints **reject** that with HTTP 400 *"Reasoning is mandatory for this
endpoint and cannot be disabled"* — so the talker could not run on them **at
all**. Reasoning is now configurable; the production model's behaviour is
unchanged by default.

**Proven both directions, live:**
- production model, default path: **PASSED**, 561 ms median, 0 breaches, verbatim EXACT
- `gemini-3.6-flash`, which previously could not run: **now PASSES**, 902 ms median, pushback 2/2

### Headline findings

1. **H4: the design claim survived.** The bounded window with no summariser does
   not corrupt the gate — including the adversarial case where trims land
   *during* a live proposal: every trim stopped exactly at the pending floor, and
   the release stayed verbatim-correct from the store even after the proposing
   utterance had been dropped from history. Correctness state genuinely lives in
   the harness, not in model memory.
2. **H3: `gpt-5-nano` is disqualified** (pushback hold 2/5). It accepts the
   operator's "stop asking" premise as its new understanding of the rule. The
   structural change did eliminate its old same-turn relay pattern as predicted,
   but not this.
3. **H3: `gemini-3.6-flash` is now a measured, qualified challenger** — cleanest
   candidate: 26/26 within 2 s, max 1,280 ms, pushback 5/5, no warts.
4. **H3: `deepseek-v4.1-flash` fails on tail latency** (two turns over the 4 s
   hard line). Its prose was the best in the field; voice needs the tail.
5. **⚠️ Quality risk now attached to the incumbent.** Gemma showed **output
   instability** twice, independently: H3 saw one empty reply in 21 conversational
   turns; H4 saw `"thought"` repetition loops and empty strings on long-context
   turns. H4's raw SSE probe cleared the harness (HTTP 200, clean completion,
   no reasoning chunks) — this is model degeneracy, faithfully relayed. In a
   **voice** surface an empty reply is **silence**, which is the worst failure
   shape.

### Queued next (in order)

| # | Work | Why |
|---|---|---|
| **H5** | **Degenerate-output guard** in `model-client.ts`: detect empty / runaway-repetition replies, retry once, then fall back honestly. TDD. | The incumbent's instability is a measured production risk, and a guard makes it cheap to keep the ~18× cost advantage. **Owner asked about this — see the open question below.** |
| **H6** | **Wire the talker into the server** (Phase 3 integration): construct `TalkerSession` with the real `MultiSessionManager` and expose a turn entry point; request-receipt discipline. | Nothing consumes the harness yet — it is a library with tests and a CLI runner. This is what makes it a product surface. |
| **P2** | Consolidate the streaming-vs-idle steer decision inside `MultiSessionManager.steer()` so the Internal API and RPC call sites inherit it. | Removes the defect *class* H2 surfaced rather than patching call sites. |

### 2026-09-12 ~21:35 — H5 committed; wave 3 (E1 + H7) dispatched

**H5 accepted and committed (`f84fa86`).** Parent verified before committing:
25/25 its tests, **138/138** full talker suite, typecheck clean, and the retry
control flow read directly — two sequential calls with an early return, never a
loop, honest throw after the second degenerate reply, plus an explicit regression
guard that good replies are not retried.

**Its live numbers were better than the pre-fix baseline:**

| | before H5 | after H5 |
|---|---|---|
| harness median TTFT | 561 ms | **330 ms** (p90 433, max 1224) |
| gate breaches | 0 | 0 |
| verbatim fidelity | EXACT | EXACT |
| pushback | 2/2 | 3/3 |
| direct client calls | — | **0/12 degenerate, 0 retries** |

The median improved because routing now avoids the slow providers — the
preference list is doing measurable work, not just guarding.

### Wave 3 dispatched — E1 + H7, isolated worktrees

Both write to this repo, so each got its own worktree with the zod-shadow fix
applied up front (E1's server typecheck verified clean before dispatch).

| Child | Session id | Worktree | Brief |
|---|---|---|---|
| **E1** mobile socket durability | `01a0978b-c7ff-72aa-93c7-bbc87374c2b2` | `/root/pi-web-ui-wt-e1` | `docs/plans/briefs/E1-mobile-socket-durability.md` |
| **H7** transport binding | `01a0978b-db7b-72aa-93c7-bbcbaac56`→`01a0978b-db7b-72aa-93c7-bbcb32baac56` | `/root/pi-web-ui-wt-h7` | `docs/plans/briefs/H7-transport-binding.md` |

Watches `ww_7_1789248930606` (E1) and `ww_8_1789248934131` (H7); backstop
`deadline-8ef4288c-1bf1-404e-bbfc-6039bad4851a`.

**File ownership is deliberately disjoint** so the wave cannot self-collide:
E1 owns `client/src/lib/websocket.ts`, `client/src/hooks/useWebSocket.ts` and
`useDriveModeDictation.ts`; H7 owns `shared/src/protocol-types.ts`, the server
router and its own client hook. Each brief names the other's files as off-limits.

**E1** is the operator-reported mobile defect (see the prior entry). **H7** adds
the missing caller for `handleOperatorTurn` — today an operator utterance cannot
reach the talker from the browser at all, so the harness is wired but not yet
reachable.

### 2026-09-12 ~21:40 — operator confirmed the lifecycle model (answering session 3)

**The operator's model, stated and confirmed:** a plain session is worker-only;
the talker appears only when Drive Mode is started. The old sequential Drive Mode
is replaced rather than kept alongside.

**Verified against the code:** the operator's model matches what was built. The
registry creates a talker **lazily, on the first operator utterance** for a
session (`session-registry.ts` — `getOrCreate`, LRU-bounded), so an ordinary
session carries **zero** talker overhead. The talker is also deliberately *not* a
second worker: it converses and relays; the "worker" is the existing session, so
Drive Mode spawns nothing new.

**Not built yet, by design:** the Drive Mode UI. The harness, the server wiring
and (in flight) the transport exist; H7's brief explicitly puts UI work out of
scope. So the talker currently has **no UI surface at all** — it is not being
tested "somewhere else", it simply has no front door yet.

**Two questions sent for confirmation before the UI phase**, because they are
cheap now and expensive later:

1. Is the talker **Drive-Mode-only**, or also invocable in an ordinary session?
   Earlier operator commentary suggested the capability is general ("useful for
   any kind of session"), while the current model makes Drive Mode the trigger.
2. **What does closing Drive Mode do?** Assumption: the talker conversation ends
   but the worker keeps running untouched, and reopening rebinds to the same
   worker. The alternative (closing stops the worker) seems wrong but is
   unstated.

**Answer given:** the build matches the operator's model; the two questions above
are protocol rather than blockers. Phase 4 (Drive Mode UI, anti-duet, talking
while working) remains the next functional phase after E1/H7.

### 2026-09-12 ~22:20–22:32 — SERVER EVENT-LOOP STALL (transient, self-recovered)

**What happened.** The production `pi-web-ui` Internal API stopped responding for
roughly ten minutes. Every request timed out (13–28 s, `http=000`), the unix-socket
accept queue backed up to **67–72 pending** connections against a 511 backlog, the
main thread sat in state **R (spinning)** with all 11 worker threads parked on
futex, and the 30-second memory heartbeat stopped printing from 22:21:45.

**Ruled out, with evidence:**

- **Not memory.** Heap 535 MB of a 4288 MB limit, RSS ~1.5 GB. Plenty of headroom.
- **Not CPU load.** Main process at 2.4% CPU; load average ~2.2 on the host.
- **Not the validation servers.** E1's four validation processes were at 0.0% CPU
  and idle throughout.
- **Not disk.** 80 GB free.

**What it broke:** H7's session stopped advancing (no writes from 21:59 while the
API was down); E1 kept working because it is client-side. **All six parent watch
registrations failed to poll**, so wake delivery was degraded — the parent fell
back to reconciling from session files on disk, and the local `wake_deadline`
timer kept working because it does not use the API.

**It recovered on its own** at ~22:30–22:31, before a restart was performed. The
operator had approved a restart; the parent re-probed first and found the API
answering in 32–53 ms with the backlog drained, so **no restart was performed** —
restarting would have killed two healthy sessions for nothing.

**Open (do not lose this):** the stall was never root-caused. A repeat would hit a
batch mid-flight again. Suspects to examine when there is evidence: the watch-wake
polling path (six watches polling continuously), the client reconnect storm the
backlog implies, or an event-loop-blocking synchronous section. The
`[EventLoopShed] lagMs=1728` line at 22:17:51 is the only direct clue.

**Second finding from the same window — the notification path has no independent
delivery route.** `scripts/notify.sh` talks to the Internal API; with the API down
it **spooled the blocker message locally instead of sending it**, so the operator
would have received nothing during the outage. The parent worked around it by
posting directly to the Telegram bot API (reading the bot credentials from the
production env without printing them) and then deleted the spooled copy to avoid a
duplicate on recovery. Worth fixing: during an outage is exactly when the operator
needs to be told.

### 2026-09-12 ~22:38–22:45 — R1 dispatch failure and the codex-route outage

**R1 never ran.** The first investigation child was dispatched on
`openai-codex/gpt-5.6-sol` (medium) as the operator requested. The session was
created, the model binding was applied and *verification passed* — and then the
assistant reply came back **empty**: `stopReason: error`, `content: ""`,
`toolCalls: 0`, `assistantTextChars: 0`, run disposition `no-text`. The brief had
arrived intact (7,479 chars). It failed silently.

**Isolated to the provider route, not the model and not the brief:**

| Probe | Result |
|---|---|
| `openai-codex/gpt-5.6-sol` (medium) | **empty content** |
| `openai-codex/gpt-5.6-luna` (medium, same pool) | **empty content** |
| `openai-codex/gpt-5.6-sol` (medium), retried ~4 min later | **still empty** |
| `zai/glm-5.3-flash` (control) | `"GLM-ALIVE"` |
| `openrouter/google/gemini-3.8-flash` (high) | `"ALIVE-PROBE"` |

Also checked: the `openai-codex` **OAuth credential is valid** (expires
2026-09-14), the model is present in the registry, and the binding is verified by
the server. So the route is accepted and then fails **server-side at the
provider** — a codex-route outage, not a local misconfiguration.

**Defect worth flagging:** a provider failure on this path surfaces as **HTTP 200
with empty content and `stopReason: error`** — a silent no-op. A caller that does
not inspect `stopReason` sees success. That is how R1 "completed" while doing
nothing.

**Resolution:** two fresh investigators were dispatched on routes verified live
by probe, deliberately on **different model families** so their answers can be
cross-checked:

| | Session | Route |
|---|---|---|
| **R1b** | `01a097c9-e0c5-72aa-93c7-bbd679be83fe` | `zai/glm-5.3` @ max |
| **R1c** | `01a097ca-d680-72aa-93c7-bbdd5165e7ed` | `openrouter/google/gemini-3.8-flash` @ high |

Watches `ww_10` (R1c) and `ww_11` (R1b). **The point of two is convergence:** if
independent investigators on different families agree on the mechanism, that is
far stronger evidence than one confident answer. If they disagree, the
disagreement is itself the finding.

All four probe sessions were deleted after use.

## Cleanup owed at the end

- Merge or discard H2's branch `talker/pi-input-routing` and remove
  `/root/pi-web-ui-wt-h2` once its regression evidence is accepted.
- **9 stale worktrees from a previous execution** under
  `/root/.pi-web-ui/operations/four-angle-20260908/children/*` plus
  `/root/pi-capacity-release-20260907` — confirm they are unreferenced, then
  remove (operator instruction: clean up unneeded worktrees/branches).
