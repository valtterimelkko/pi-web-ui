# Voice Mode — restore the bounded main UI and fix the live-lane report

> **Class:** implementation plan (owner report, 2026-09-22). **Status:** authorised
> in-conversation (`"restart production now"` was the prior gate; this is the
> follow-up bug/UI report). **Companions:** [`VOICE-MODE-INTENT.md`](../VOICE-MODE-INTENT.md),
> [`plans/VOICE-MODE-FREE-TALKER-PLAN.md`](./VOICE-MODE-FREE-TALKER-PLAN.md).

## 1. The report, in the operator's words

> *"when I click on start listening, … it actually does initiate the talker, but
> it says it can't access the work session on the server. I get immediately when I
> press it, I get a bunch of errors. … I'd like to bring back the old UI … the
> main option, which was the whole, much more bounded, much more gated voice
> mode, that had a good UI … on the top of the page, while the free lane was on
> the bottom … take exactly what it was, but just tweak it to the new
> functionalities … enough so that it works end to end."*

## 2. What the evidence shows

Reproduced against a disposable live-engine server with a real browser
(`operations/voice-free-talker-20260922/repro/`), and read from the production
`VoiceLive` evidence at 09:08.

1. **The talker is told a non-answer about the worker.** For a session the server
   is not holding in memory, the registry reports
   `activity: "worker session is not loaded on this server"`; the mount injects
   that verbatim as `ACTIVITY: …`, and the model turns it into *"I don't have
   access to any information or history"*. Observed in production
   (`worker_brief_empty`, `talker_reply`). The session in the report was a
   genuinely new, empty session — but "not loaded" is the wrong statement for it,
   and the model treats it as a refusal rather than as "this session is new".
2. **The brief source hard-codes the `pi` runtime.** `createWorkerBriefSource`
   reads every lane's worker as `pi`; a Claude or Antigravity lane therefore
   reads the wrong (or no) history and gets the same non-answer.
3. **The dev/StrictMode lane goes falsely unavailable.** In a development build,
   React StrictMode mounts/cleans up/re-mounts the effect in `useVoiceLiveLane`,
   whose cleanup calls `surface.dispose()` — which permanently unsubscribes the
   controller. The lane reaches `live` on the wire but never syncs, so the 12 s
   probe marks it **"unavailable — no answer from the voice engine"** while the
   talker is working. The production build does **not** show this (verified:
   `live` at ~0.5 s), but every dev client, the dogfood script and the browser
   harnesses do.
4. **"A bunch of errors" is the surface's own error region** (unavailable panel,
   capture/refusal lines) rather than a server error: production logged no
   `voice_error` at all.

## 3. What changes

### 3.1 Server — the worker brief tells the truth
- Thread the lane's **runtime** into the brief source
  (`createWorkerBriefSource → (workerSessionId, runtime)`), and pass
  `lane.runtime` from the mount.
- Distinguish **empty-but-existing** from **not found** in the registry snapshot:
  an existing session with no messages reports *"worker session is new; it has no
  messages yet"*, and only a genuinely unresolvable session keeps
  *"not loaded on this server"*.
- Confirm the talker's prompt handles a new session by conversing normally,
  rather than treating an empty brief as a refusal (no "I have no access").

### 3.1a Server — the "relay to the worker" trigger is stripped in BOTH lanes
After the layout restore the operator naturally spoke *"Relay to the worker that
it needs to summarize what it knows about Podpoint."* to the **bounded main
(cascade) lane** (observability: a `VoiceMode` turn at 10:55Z, `phase:
proposed`). The cascade's `normaliseRelayText` stripped "ask/tell/let/pass the
worker" frames but not the new **"relay to the worker"** trigger, so the worker
would have received the phrase and read "the worker" as another agent.

`consumeRelayFrame` now strips *"relay to the worker that/to X"*, *"relay to
worker: X"*, *"relay this/that to the worker – X"*, and lead-ins; a bare trigger
with no content is left untouched. The native lane's prompt already strips it, so
the worker can never see the trigger from either lane.

### 3.2 Client — the bounded main UI returns, the free lane returns to the bottom
- Restore the **pre-`ff75d0c4` layout** in `DriveModeDictate`: the bounded/gated
  voice controls at the top, the collapsible **free lane** at the bottom. Keep
  the model-driven relay server-side; the free lane keeps its new relay
  behaviour and gains the short **"relay to worker"** hint.
- Fix `useVoiceLiveLane`: the effect cleanup must **not** dispose the memoized
  surface (which unsubscribes the controller). Dispose only on real unmount, or
  make the subscription part of the effect.

### 3.3 Playwright end-to-end
- A dedicated config/spec that boots a disposable live-engine server (real
  `GEMINI_API_KEY`) and drives the **built** client end to end: login → Drive
  Mode → the bounded main UI present at the top → the free lane at the bottom →
  Start listening → the lane reaches `live` with no false unavailable panel.
- Reuse the existing disposable-server harness; the server-side relay flow is
  already proven by `test-vertical-slice` (3/3).

## 4. Gates
- Unit: server (brief/registry), client (surface, NativeVoiceLane, DriveMode).
- `npm run typecheck`, `build`, `lint`, docs checks.
- Playwright end to end against a disposable server.
- Production restart is **owner-gated**.

## 5. Interpretation recorded
"Bring back the old UI" is taken literally: the bounded/gated main surface on
top, the free (live-model) lane at the bottom. The model-driven relay stays on
the server and is reached through the free lane. If the owner instead wants the
main bounded UI *backed by* the live model, that is a separate, larger change and
is called out in the handback rather than assumed.
