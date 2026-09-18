# The talker's window on the work — full session, a measured ceiling, and retrieval

> **Class:** implementation plan (voice lane). **Status:** implemented, unit-tested and live-validated
> through the shipped composition path (2026-09-18); the deploy step follows under the owner's
> authorisation for this change. Evidence: [`operations/voice-live-20260917/evidence/full-session-brief-20260918/`](../../operations/voice-live-20260917/evidence/full-session-brief-20260918/README.md).
> **Owner:** conductor.
> **Decision record:** this file records the measurements and the reasoning behind the
> change; the operator asked for it after the 2026-09-18 "I don't have access" report.

## 1. What changed, and why now

The native talker was given a *bounded* worker-session brief (the relay lane's P20/P23
view, 12k characters) while it sits next to a session that may be far larger. The operator
asked the obvious question: **why not let it see the entire session?**

Measured on the real provider (real instruction, real context, a needle fact placed at the
very START of the brief — the worst case for "send everything"):

| brief sent | ≈tokens | injection turn | answer latency | needle recalled |
|---|---|---|---|---|
| 12k chars (current cap) | 3k | 1.4 s | 1.1 s | ✅ |
| 26k chars (median session) | 6.5k | 1.2 s | 1.0 s | ✅ |
| 160k chars | 40k | 1.6 s | 1.0 s | ✅ |
| 330k chars | 82k | 1.6 s | 1.5 s | ✅ |
| 500k chars | 125k | **stalled — 150 s, never completed** | none | ❌ |
| 660k chars (largest real session) | 165k | **stalled** | none | ❌ |

Two conclusions, both of which shape the design:

1. **The 12k cap was not buying latency.** Up to ~82k tokens a full brief is effectively
   free *and* the model still finds a fact buried 80k tokens back. The operator's instinct
   was right.
2. **The failure above the cliff is not degradation, it is a dead lane** — the injection
   turn never completes and the talker says nothing at all. So "always send everything"
   would brick exactly the long sessions where the question matters most.

Sizes on this host (166 real sessions): median ≈6.6k tokens; only the top handful exceed
40k tokens. A ceiling around 50k tokens therefore covers essentially every session while
staying well below the observed 82k success / ~100k stall.

## 2. The design

1. **Full session by default**, up to a measured ceiling of **50k tokens** (200k chars) —
   `VOICE_BRIEF_LIMITS.fullMaxChars`. This is the brief at lane start.
2. **Deltas afterwards.** A live session accumulates context: re-injecting a 40k-token
   brief on every change would walk it into the cliff mid-conversation. After the first
   injection the lane sends only the messages the model has not been told about.
   Losslessness requires one small service change: pending context is **appended** rather
   than replaced, so a coalesced/hold-and-flush cannot silently drop a delta.
3. **Above the ceiling: the bounded recent window plus retrieval.** The brief says so
   explicitly (the model is told how many messages are not included), and the talker can
   call **`read_worker_history({ query })`** to read further back on demand. The intent
   already names this as the right mechanism (§19.2/§19.3: *"read-only retrieval: more
   worker history than the standing window, a specific earlier turn… retrieval fixes it
   properly; enlarging the prompt does not"*).
4. **Disclosure to the operator.** When the lane is on the reduced view the talker is told
   to say so and to offer reading further back, rather than answering as if it had seen
   everything.
5. **Retrieved text is data, never authority.** It rides the existing context seam; it can
   authorise nothing. The retrieval tool takes a *query string only* and has no path to the
   gate; the two gate tools stay parameterless.

## 3. Where the pieces live

| Piece | File |
|---|---|
| Budget parameters on the ONE bounded renderer | `server/src/worker-history-view.ts` |
| The voice lane's brief policy (pure): full / window / delta / none, and search | `server/src/voice/worker-brief.ts` (new) |
| Pending context appended, not replaced | `server/src/voice/voice-session.ts` |
| Retrieval tool declaration + argument validation | `server/src/voice/gemini-live-bridge.ts` |
| Brief policy application, retrieval handling, evidence | `server/src/websocket/voice-live-mount.ts` |
| A larger history tail for the retrieval source | `server/src/talker/session-registry.ts` |
| Wiring | `server/src/websocket/connection.ts` |

## 4. Quality gates

- **TDD throughout**, RED first, focused suites per unit.
- **Unit/integration**: policy (full at ≤ceiling, window above it, delta after the first
  injection, nothing when there is no new work), search bounds, retrieval round-trip at the
  mount (tool call → retrieved block injected → recorded), bridge argument rules (declared
  tool with a bounded string accepted; the gate tools still refuse any argument), the
  instruction's new rules.
- **Live validation** (real provider, real instruction, real brief):
  1. the needle test at ~6.6k / 40k / 82k / 165k tokens **through the shipped composition
     path**, so the numbers belong to the implementation rather than to a prototype;
  2. a retrieval round-trip: the model must actually call `read_worker_history` for a fact
     that sits outside the window and then answer with it.
- **Deploy**: production restart under the operator's authorisation, then verify the served
  bundle, the engine/model line and the lane's own evidence fields.
- **Honesty**: what was live-validated and what is only unit-tested is stated in the
  evidence file, never blurred.
