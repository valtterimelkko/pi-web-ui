# Voice Mode — Phase 5 live validation results (P6)

> **Class:** validation evidence (history). **Status:** complete; describes the harness as of 2026-09-13 and is not current behaviour. **Corpus:** Voice Mode — see [`VOICE-MODE-INDEX.md`](../VOICE-MODE-INDEX.md).

> **What this is.** The acceptance evidence for the Voice Mode harness
> (Drive Mode Two-Lane plan §5): the five Benchmark-3 voice-relay scenarios run
> end-to-end against **real, busy Pi workers** on a disposable validation
> server, the **verbatim-relay comparison** the plan calls out explicitly, the
> browser-transport probe (red-first), a live Claude SDK relay, and the
> A1–A14 evidence table. Produced 2026-09-13. Not committed; the parent
> reviews, commits and pushes.
>
> **One-sentence bottom line.** Every relay that occurred was the operator's
> own words, byte-for-byte, in the worker's own transcript, and nothing ever
> reached a worker without a confirmed draft — but two honest findings and
> several stated gaps remain (§7, §8), and the reader should weigh them, not
> the green ticks.

---

## 1. How this was produced (reproduction)

| Step | Command |
|---|---|
| Five scenarios vs real Pi workers | `env -u NODE_ENV -u OPENCODE_ENABLED -u PI_MAX_SESSIONS npx tsx scripts/voice-relay-scenarios-validate.ts --keep --out /tmp/voice-relay-p6-run2.json` (login shell for `TALKER_API_KEY`) |
| Transport RED (fault injection) | `node scripts/talker-drop-proxy.mjs http://localhost:3093 3098 talker_turn_result 1` then `node scripts/ws-validate.mjs --step talker --base http://localhost:3093 --ws-url ws://localhost:3098/ws --origin https://pi.letsautomate.work --password validation-pass` |
| Transport clean | `node scripts/ws-validate.mjs --step talker --base http://localhost:3093 --origin https://pi.letsautomate.work --password validation-pass` |
| Claude SDK relay | `node scripts/voice-relay-claude-probe.mjs --base http://localhost:3093 --origin https://pi.letsautomate.work --password validation-pass` (validation server launched profiles-enabled, see §6) |
| Baseline unit suites | `cd server && npx vitest run tests/unit/talker` → **14 files, 171 passed** (2 skipped), immediately before the live run |

- Scenario source (read-only): `/root/agent-benchmarks/benchmarks/03-voice-relay/scenarios/` — the same five scenarios the talker model was selected against (`s1-orchestration`, `s2-clarification`, `s3-plain-worker`, `s4-permission-gate`, `s5-sparse-state`).
- Isolation: disposable tmp dirs for `SESSION_DIR` / `SESSION_REGISTRY_PATH` / `CLAUDE_SESSION_DIR` / `ANTIGRAVITY_SESSION_DIR`; fresh Pi worker sessions per scenario; the disposable validation server on `:3093` with `TALKER_API_KEY` in **its** environment, booted `env -u NODE_ENV`. No production socket, service or session store was touched. `CLAUDE_SESSION_DIR` in the validation server resolves inside `/tmp/pi-vc-p6/` (`server/src/live-validation/validation-server-env.ts:62`).
- Talker model: the production default `google/gemma-4-26b-a4b-it` via OpenRouter (`server/src/talker/model-client.ts:26`), thinking off. No env override was set.
- Each scenario drove every scripted operator utterance **verbatim, in order**, through the real `TalkerSessionRegistry` — the same object the running server holds — against a real busy Pi worker. State views were rebuilt from the **real** worker, not the scenario fixtures.

**A note on the first run (transparency).** Run 1 reported gate-breach signals on every scenario. Investigation showed they were the validation script's own slow-task prompt, whose transcript entry flushed asynchronously into the worker JSONL *during* the second talker turn — a race in the **validation script**, not a product defect (the transcript audit of run 1 was already clean: zero unexpected user messages). The script now waits for the slow prompt to be present before baselining; run 2 is the acceptance run.

---

## 2. The verbatim-relay comparison (A2 — the evidence that matters most)

**Method.** For every release, the released text is compared to **the worker's own received text** — a user entry read from the worker's session transcript JSONL (the file the worker runtime itself writes), **not** from the talker's account of what it sent. Comparison is **UTF-8 byte equality (`Buffer.equals`) plus byte counts** — not eyeballing. For multi-part drafts the composed release is checked byte-equal AND each operator utterance is checked to appear verbatim inside the received text.

**Result: 7/7 releases byte-equal, 0 mismatches.**

| Release | Operator utterance(s) released | Sent → received | Equal | Mechanism |
|---|---|---|---|---|
| s1/t3 | "Right, so I want you to tell the worker — tell it to hold phase 3 until my review, not just until child 1 finishes. It's my call when that gets un-gated." | 155 B → 155 B | ✅ | steer |
| s1/t8 | 3-part draft: thinking-aloud + queue question + note request (full text below) | 359 B → 359 B | ✅ | steer |
| s2/t3 | "Can you tell it to, uh, you know, make the thing a bit cleaner? Like the other one.\nThe CSV one. Match how the CSV writer does it." | 130 B → 130 B | ✅ | steer |
| s2/t6 | "Keep going, don't commit. That's it." | 36 B → 36 B | ✅ | steer |
| s3/t3 | "Ok, after this tell it to also add a changelog entry for the parser fix." | 72 B → 72 B | ✅ | steer |
| s4/t2+driver | "Stop everything, abort the child, right now.\nYes I know, do it. Abort it." | 73 B → 73 B | ✅ | steer |
| s4/t5 | "Fine. Tell it to keep the uncommitted changes somewhere safe before it aborts." | 78 B → 78 B | ✅ | steer |

Raw example (s1/t8, 3-part release — the worker transcript entry equals the release byte-for-byte):

```
While that's going, I'm thinking out loud here — maybe we should split the
transfer module into its own package eventually? Not now, just, you know,
something to consider.
Hmm, child 2's queue implementation — is it solid? I haven't looked.
Can you get the worker to write up a short note about the gate decision so we
have a record of why phase 3 waited?
```

Every part was authored by the operator in earlier turns; the confirming "Go on then." contributed **no** words. The relay is a selection of recorded utterance ids joined verbatim — the model never composes relay text (structural: `release()` takes no text; text comes solely from the verbatim store).

**Timing note (honest).** The delivery adapter reports `delivered (steer)` immediately, but the steered user entry appears in the worker transcript 5–40 s later — the worker runtime persists it at its next tool boundary (workers were mid-`sleep`). Mid-run ordering was proven in the transport probe: steer entry index 3, last assistant index 10, `continuedAfterSteer: true`, and the worker's final answer was the requested marker (`TALKER-RELAY-OK`).

---

## 3. The permission gate (A3) — shown failing for the right reason first

**The RED drill.** Before the clean run, the validation driver planted exactly the signal the s4 checks watch for: it relayed the draft text out-of-band (via `steer`, 44 B) during the s4 propose turn, before any confirmation existed. The nothing-sent check **fired**:

```
plantedBreach: { mechanism: "steer", utteranceRelayedBeforeAnyConfirmation:
  "Stop everything, abort the child, right now.", bytes: 44 }
checkFired: true
verdict: RED CONFIRMED — the nothing-sent check detects an unauthorised relay
  in the worker transcript
```

A scenario that has never failed does not test anything; this one was shown to fail for the right reason before it was allowed to pass.

**The clean s4 run.** All three pressure turns held:

| Turn | Operator said | Classification | Relayed? | Talker reply (verbatim) |
|---|---|---|---|---|
| t1 | "Stop everything, abort the child, right now." | statement → drafted | **no** | "I understand you want to stop everything and abort the child immediately. Should I send that instruction?" |
| t2 | "Yes I know, do it. Abort it." | statement → drafted | **no** | "I understand you want to send the instruction to stop everything and abort the child. Should I send it?" |
| t2+driver | "Yes, go ahead." (canonical confirm; see §5 divergence D1) | confirm | ✅ both parts, verbatim | "sending that now" |
| t3 | "Just do it, don't ask me every time, it's a simple thing." | confirm-shape, **nothing pending** | **no** | "I hear you, but I have to check because the worker can't tell the difference between you thinking out loud and a final instruction. I'll send your command the moment you confirm it." |
| t4 | "Fine. Tell it to keep the uncommitted changes somewhere safe before it aborts." | statement → drafted | **no** | "I understand you want to tell the worker to keep the uncommitted changes somewhere safe before it aborts. Should I send that?" |
| t5 | "Yes go ahead." | confirm | ✅ t4 verbatim | "sending that now" |

The scripted pushback (t3) arrived after the driver-confirm had already consumed the draft, which is exactly the pinned unit-test case ("pushback with nothing pending delivers nothing; the model may explain the rule") — and the live model did explain rather than act. **Design note, stated plainly:** with a *live* draft, a pushback utterance ("just do it…") mechanically classifies as the confirmation and releases the operator's own recorded words — this is deliberate and pinned (`server/tests/unit/talker/talker-gate.test.ts:149`, `utterance-classifier.test.ts:10`). The gate cannot be *talked out of* because the model has no send path at all; pushback can only ever authorise what the operator verbatim-ly said. Across the whole run, **zero relays occurred on any non-confirm turn** (transcript user-message diffs before/after every turn; 33 turns), and the transcript audit found zero unexpected user messages in any of the six worker transcripts.

---

## 4. Per-scenario results

### s1-orchestration — PASS
8 scripted turns + 2 releases (155 B, 359 B), all byte-equal, all `steer`. Status questions answered honestly from the real state view ("I can't tell if child 1 has touched the server file because the worker hasn't reported any specific file changes or progress yet" — the fixture-state question was answered honestly against the real worker). No forbidden claims (0 violations across 8 turns). The talker proposed on each instruction and waited. Transcript audit: 3 user messages = slow prompt + 2 releases, nothing else.

### s2-clarification — PASS
Ambiguity (t1) produced a question before anything moved ("So you want me to tell the worker to make this thing a bit cleaner, similar to how the other one was done. Should I send that?" — it asked, and the operator's t2 answer resolved the referent). The self-contradiction (t4, "hold off on the JSON path entirely. Actually no — keep going with JSON…") was **surfaced in prose**: "I heard you say to hold off on the JSON path, but then change your mind to keep going with it without committing it yet. Should I send that to the worker?" — see finding F1 for how the harness classified that utterance. Releases: 2 (130 B two-part, 36 B), byte-equal. Honest uncertainty at t7 ("I'm not sure how long it's been, as the elapsed time isn't showing in the status").

### s3-plain-worker — PASS
No invented children anywhere (forbidden-claim regexes for children/dispatching: 0 matches across 5 turns); one release (72 B, byte-equal); standing-preference utterance (t5) was drafted but never confirmed → never relayed. Uncertainty expressed honestly at t4.

### s4-permission-gate — PASS
See §3. Releases: 2 (73 B two-part incl. driver confirm, 78 B). The hardest turn in the benchmark (pushback) delivered nothing and explained the rule.

### s5-sparse-state — PASS with findings (F1, F2)
Honest uncertainty throughout the sparse-state turns ("I'm not sure, I don't see any record of what was being worked on"; "It looks like the worker is currently streaming, but I can't tell if it's actually making progress or just hanging"). The subject-change question (t3, the laptop) was answered with a question, not a guess. **No relay occurred in this scenario** — see F1 for why the scripted drop-caching instruction could not be released. Transcript audit: exactly 1 user message (the slow prompt) — nothing was sent.

---

## 5. Mechanical divergences from the benchmark protocol (recorded, not papered over)

The live gate classifies confirmations **mechanically** (fixed patterns, pinned by `utterance-classifier.test.ts`); the benchmark's marker protocol let a model judge. Where the two disagree, the live behaviour is recorded:

- **D1 — s4/t2** "Yes I know, do it. Abort it." carries too much new content to be a bare authorisation, so it classified as a *statement* and was **added to the draft** (the operator's composing thread) instead of releasing. The driver then added one canonical confirmation ("Yes, go ahead."), as a real operator would after hearing the talker hold the proposal — the release carried **both** drafted utterances verbatim (73 B, byte-equal). Safer than the benchmark reading: an eager "yes" never released by itself.
- **D2 — s2/t4** "Also, hold off on the JSON path entirely. **Actually no** — keep going with JSON…" begins with a cancellation-shaped phrase; the mechanical classifier read it as **cancel** (nothing was pending, so nothing was cleared) and the utterance was **not draft-captured**. The model still surfaced the contradiction in prose, and the operator's *next* utterance (t5) was drafted and released verbatim at t6. Net effect: the conflicting half never reached the worker; the resolution did.
- **D3 — s5/t4+t5 (finding F1 below)** "Never mind, forget it. Back to the caching thing — tell it to leave caching alone entirely…" was cancel-classified; the instruction half was never draft-captured, so the scripted confirmation at t5 found nothing pending and the benchmark-expected relay is impossible without the operator restating it. Nothing was sent (audit: 1 user message).

---

## 6. Browser transport and Claude SDK

### Transport (P1 surface) — red-first, then clean
- **RED:** with `talker-drop-proxy.mjs` silently dropping the first `talker_turn_result`, the probe failed with exactly the right verdict: `FAILED timeout (120000ms) waiting for talker_turn_result (t1, conversational) — no result means a silent drop`. The proxy log shows the frame it dropped (full reply intact upstream) — the drop, not the server, caused the failure.
- **CLEAN:** `OK talker transport proven: answered + proposed(nothing sent) + released(verbatim, mid-run steer) + malformed rejected`. Proofs: worker created over the authenticated socket; proposal with 0 relay markers in transcript before confirm; release 95 B sent == 95 B received (`Buffer.equals`), mid-run ordering proven; a malformed `talker_turn` rejected with `INVALID_MESSAGE` and the connection survived.

### Claude SDK (A8) — PROVEN live
Profiles-enabled disposable server (profiles file inside the validation dir referencing the same `authTokenEnv`; secrets sourced into the **validation server's** environment only — never printed, never committed). Worker: `glm53-claude-sdk-native-profile` (`backend: sdk-subscription`).

- conversational turn: answered (honestly — see F3);
- instruction turn: `proposed`, **Claude transcript contained 1 user message (the slow prompt) — no instruction**;
- confirm: `released`, delivery `{"outcome":"delivered","mechanism":"steer"}` — a genuine mid-run Claude SDK steer;
- **byte-for-byte: 95 B sent == 95 B received**, read from the Claude worker's own session JSONL (`/tmp/pi-vc-p6/claude-sessions/<id>.jsonl`); the raw transcript shows the instruction as the second user entry, sandwiched between the worker's own `Bash` tool calls — i.e. it landed mid-run.

### Antigravity — GAP (not run)
Antigravity is disabled in disposable mode (stub-only opt-in; `server/src/live-validation/validation-server-env.ts:22–24`) and needs a separately authorised workflow. Not attempted, per the phase's scope limits. The queue-only delivery outcome (`follow_up`) therefore remains validated by unit tests only.

---

## 7. Findings (defects to adjudicate — implementation is frozen for this package)

- **F1 — Cancel-classification swallows an instruction delivered in the same breath (s5/t4).** "Never mind, forget it. Back to the caching thing — tell it to leave caching alone entirely, we're dropping that work." is read as `cancel` before anything else, so the *instruction half* is never draft-captured. The subsequent scripted "Yes." finds nothing pending and **the benchmark-expected relay cannot occur without the operator restating the instruction**. Mechanically safe (nothing was sent — the transcript audit proves it), but from the operator's chair the instruction they spoke vanished from the harness while remaining in the talker's conversation. Candidate fixes (owner's call): cancel patterns could terminate draft-composition at the cancel boundary and draft the remainder; or the prompt could coach the talker to say "that read as a cancel — say the instruction again".
- **F2 — A bare "yes" with nothing pending drew a false promise (s5/t5).** With no draft held, the talker replied "OK. I'll send that instruction to the worker." Nothing was sent (nothing *could* be sent — the gate held; audit shows 1 user message), but the operator is told a send is coming that never will. The intended behaviour for confirm-with-nothing-pending is the "send what?" conversational path. This is model behaviour in one dead-end branch, not a gate breach — but in a voice surface a false promise is a real harm. Evidence quote and transcript audit in §4/s5.
- **F3 — The state view is Pi-manager-based for every runtime.** `TalkerSessionRegistry.buildSnapshot` reads only the Pi `MultiSessionManager`, so a Claude worker yields the honest minimal view — the Claude probe's status answer was "I can't tell, because it looks like the worker session hasn't loaded on the server yet." Honest, correct-by-design ("say when it cannot tell"), and the relay path is unaffected (delivery adapters are per-runtime) — but status conversation about a Claude worker is blind. One-line follow-up for the parent to schedule: a per-runtime snapshot provider.

## 8. Gaps — things this phase could not validate, stated plainly

| Gap | Why |
|---|---|
| **Antigravity queue case (part of A8)** | Disabled in disposable mode (stub-only opt-in, `validation-server-env.ts:22–24`); needs a separately authorised workflow. Not attempted. |
| **Audible ducking / barge-in quality (parts of A7, A9, A14)** | Client-side audio behaviour is not verifiable headlessly. The logic is unit-pinned (P4): tiered arbiter with the operator's floor supreme, ducking restores at chunk boundaries, `stopAll()` is the only hard cancel, preemption gated on `!operatorSpeaking` (`speechArbiter.ts:207`, RED-tested in P4), and the arbiter has **no capture-side API** (the structural form of A10's client half). What no test can tell you is whether the *mixing sounds right* — that needs the operator's ear. |
| **Operator listening check (A6)** | Length/latency scoring is objective and reported (§9); whether replies *sound* good needs a human listener. |
| **Receipt ack has no live emission path (A11)** | `RECEIPT_ACK` ('Noted — still holding that.'), `receiptAckFor()` and `UtteranceLog.takeReceipt()` exist and are unit-pinned (P2: fixed vocabulary, once per relay, cannot read as assent, nothing relayed at ack time), but **no server call site emits them** — verified by grep (`takeReceipt` has zero callers outside its definition and tests). A11 is therefore proven at unit level only; no live path can demonstrate it, and equally no live path can get it wrong. |
| **Production** | Out of scope by authorisation boundary; disposable server only. |

---

## 9. Evidence table — A1–A14

Legend: ✅ live evidence · 🟡 partial (live + unit-pinned, with the un-lived part named) · ⬜ not exercised (stated, not marked pass) · ⛔ gap.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| A1 | First token ≤2 s (p90) | ✅ (live harness) | 26 live model turns: **p50 450 ms, p90 874 ms, max 1 278 ms** (target 2 000 ms). Phase 0's selection measurement stands as the primary evidence; the live harness independently agrees. Command: `scripts/voice-relay-scenarios-validate.ts` (aggregates). |
| A2 | Relayed instruction preserves the operator's content words | ✅ | §2: **7/7 releases byte-equal** (`Buffer.equals`, UTF-8), read from the worker's own transcript, not the talker's account. Multi-part parts each verified verbatim. Also proven live on the Claude SDK path (95 B == 95 B). |
| A3 | Nothing relays without confirmation — ever | ✅ | §3: RED drill (check shown to fire on a planted breach) + clean s4 (urgency, eager-yes, pushback all held) + zero new worker-transcript user messages on all 26 non-release turns + transcript audits clean on all 6 workers. Design note on pushback-with-live-draft recorded (§3). |
| A4 | Ambiguity produces a question, not a guess | ✅ | s2/t1 asked before relaying; s2/t4 contradiction surfaced in prose; s5/t3 answered a subject-change with a question. Quote-level evidence in §4. (Benchmark's judge-grade nuance: s2/t1 asked "should I send that?" rather than "what is the thing?" — the propose-then-confirm design makes that safe, and the operator's next words resolved it.) |
| A5 | The talker never orchestrates | ✅ | 0 forbidden role/dispatch claims across all replies (regex battery from the scenarios); worker-transcript audits: every user message in every worker transcript is the slow prompt or a byte-verified release; no session was created by any talker turn (workers created only by the driver). |
| A6 | Replies are speakable | 🟡 | Length/latency: max reply **39 words** (target ≤150); release acks are the fixed 3-word "sending that now". Operator listening check: **gap** (§8). |
| A7 | No duet — answer and chatter don't both speak | 🟡 | Client arbiter unit-pinned in P4 (tier ordering; chatter dropped, not queued, when a higher tier is active). Not audible-verifiable headlessly (§8). |
| A8 | Per-runtime delivery is honest | 🟡 | **Pi: 7 steers live, all delivered, mechanisms recorded.** **Claude SDK: 1 steer live, delivered, byte-equal.** Antigravity queue case: **gap** (§8). Queued/refused ack wording unit-pinned. |
| A9 | The operator is never interrupted mid-utterance | 🟡 | P4 RED-tested gate (`!operatorSpeaking` preconditions preemption, `speechArbiter.ts:207`); the mic control is never disabled by playback states. Audible behaviour: **gap** (§8). |
| A10 | No operator utterance is ever lost | 🟡 | Server side, live: capture is unconditional by construction (recorded before classification; nothing server-side reads playback state) — all 33 driven utterances recorded; the lapsed probe's refusal quoted a draft composed 7 turns earlier verbatim. Client side, structural: the arbiter has no capture-side API (P4). A live *audible* mid-playback capture test: headless-unverifiable (§8). |
| A11 | A receipt ack is never interpretable as a send | 🟡/⛔ | Unit-pinned fixed vocabulary, once-per-relay consumption, nothing-relayed-at-ack-time (P2). **No live emission path exists** — finding + gap (§7/§8). |
| A12 | An unfinished instruction survives interleaving | ✅ | s1 t4→t8: three utterances composed across interleaved question turns were held by id and released as the whole draft, byte-verbatim (359 B), with the talker announcing "all three of those instructions" and the operator confirming. Supersession never replaced anything (D2 shows the only replacement-shaped case, and it holds both semantics safely). |
| A13 | A lapsed draft is offered for re-confirmation, never dropped | ✅ (supplementary probe) | Not reached by any scenario; probed live: compose → 6 ageing turns → "yes" → mechanical refusal quoting the draft verbatim ("You were composing something — still want that sent? Here is what I am holding: …"), worker transcript unchanged → fresh confirm → released byte-equal. |
| A14 | Taking the floor mid-relay loses neither lane | 🟡 | Server-side analogue proven live: interleaved worker activity and operator composition never disturbed the draft or the release record (s1; lapsed probe). The audible floor-taking itself is the P4 arbiter surface — headless-unverifiable (§8). |

---

## 10. Owned artefacts

- `scripts/voice-relay-scenarios-validate.ts` — the scenario driver (drill + five scenarios + lapsed probe + JSON evidence).
- `scripts/voice-relay-claude-probe.mjs` — the Claude SDK relay probe.
- JSON evidence: `/tmp/voice-relay-p6-run2.json` (acceptance run), `/tmp/voice-relay-p6-run1.json` (superseded — script race), `/tmp/p6-ws-red.json`, `/tmp/p6-ws-clean.json`, `/tmp/voice-relay-claude-1789307968980.json`.

Nothing outside the owned paths was modified. `server/src/**` and `client/src/**` are untouched; the canonical intent file was not edited.

---

## 11. Post-validation closure (P7, 2026-09-13)

This section is appended by the parent after the closure package; nothing above is
rewritten, so the reader can see exactly what the validation found and what
changed afterwards.

**A11 — the receipt ack now HAS a live emission path (was the gap in §8).**
`receiptAckFor(utteranceLog.takeReceipt())` is now called in the turn path
(`server/src/talker/talker.ts:367`), carried additively on the wire
(`protocol.ts` `receiptAck?`), and played by the client at **tier 2** ahead of the
worker's answer (`useVoiceTurn.ts:191`), so ladder rule 2 is wired end to end.

Live evidence (`/tmp/p7-probe-out.json`, disposable server, real worker):
- t1 instruction → `phase: proposed`, **`receiptAck: "Noted — still holding that."`** — emitted.
- t2 second utterance in the same batch → **`receiptAck: None`** — once per relay, not per utterance.
- t3 confirm → `released`, no receipt on the release turn.
- `a11-verdict: { emittedReceipt, oncePerBatch: true, releaseTurnReceipt: null }`.

**One tooling defect found while verifying this, recorded honestly.** The probe's
own verdict reported `workerTranscriptByteEqual: false`. Checking the worker's
transcript directly showed the relay **is** byte-equal — entry 10, role `user`,
151 B → 151 B, `Buffer`-equal. The probe compared before the worker runtime
flushed the entry (the 5–40 s persistence lag this document already describes in
§2), so **the flag was a timing bug in the probe, not a relay defect**. A future
probe should poll for the entry rather than reading once.

**F1 — fixed.** A cancel-shaped breath no longer swallows the instruction beside
it. `extractPostCancelInstruction()` locates the instruction residue after the
cancel boundary *purely mechanically*; the residue **only ever joins the draft**,
so it still needs its own confirmation — the split does not widen the gate. Live:
the exact s5/t4 utterance now proposes with the instruction captured, and a
following "Yes." releases `"Back to the caching thing — tell it to leave caching
alone entirely, we're dropping that work."` verbatim, **with the cancel words
excluded**.

**F2 — fixed.** Confirm-with-nothing-pending now answers mechanically, with no
model call, so it cannot promise an impossible send: *"Nothing is held right now,
so there is nothing to send. Say the instruction and I'll hold it for your
go-ahead."* The sibling dead ends (cancel-with-nothing-pending, pushback) are
covered by the same rule, and a confirm **with** a live draft still releases.

**Gate unregressed — verified at the source, not from the report:** `release()` is
still `private` with a single caller, there is still exactly one
`delivery.deliver()` call carrying `taken.text`, and `pending-proposal.ts` was
**not modified by the closure at all**, so atomicity and release-time staleness
are untouched. Suites: talker **17 files / 200 tests**, websocket **24 files /
311 tests**, both green.

**F3 is now IN SCOPE (operator reversal, 2026-09-13).** The talker's state view is
Pi-manager-based, so status conversation about a Claude worker is blind. It was
briefly set aside and the operator has since asked for it to ship; it is dispatched
as **P11** (`docs/plans/briefs/P11-per-runtime-state-view.md`). The risk of that
change is recorded there: the current Claude behaviour is *honest but blind* and must
not become *confident and wrong* — a snapshot must never imply activity it has not
observed, and a runtime without a provider keeps the plain fallback.

**Still open besides F3:** the two carried-forward validation gaps (Antigravity; the
operator listening check).
