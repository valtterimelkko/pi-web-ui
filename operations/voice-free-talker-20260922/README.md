# Voice Mode — the free talker (2026-09-22)

Evidence and handback record for the owner directive: *the native live talker
decides for itself what is conversation and what is a relay; the harness keeps
only the approval gate and one worker per lane.*

## What changed

| Area | Change |
|---|---|
| Server relay | One typed tool, `relay_to_worker(text)`, creates a **proposal** (idle worker) or **parks** it (busy worker). It can never release. |
| Server gate strip | `isDirectedWorkerInstruction`, the commission-frame regex, and `normaliseRelayText` as the relay trigger are **removed**; `mark_addressed_to_talker` / `offer_ask_worker` are **removed**. The harness no longer classifies transcripts into relay vs conversation. |
| Prompt | Rewritten around the **"relay to worker"** trigger: relay what follows, as close to the operator's own words as possible, without the phrase; never claim a send. |
| Client | The live surface is the **main lane** (`NativeVoiceLane` mounts expanded, no free-lane toggle), teaches the trigger phrase, and keeps the cascade as the honest fallback. Open-mic VAD and push-to-talk unchanged. |
| Docs | Intent §18.1/§18.2/§19.3/§19.5 rewritten, §23.5 added; architecture §5.3 annotated superseded; wire contract N7 annotated; `OBSERVABILITY.md` gains the relay evidence queries; new plan. |

## Authority

Owner directive, 2026-09-22, in-conversation. It supersedes architecture §5.3
("why not a model-composed relay for instructions") and the intent's earlier
"the harness decides the route" reading. The release predicate (N1/N3/N8) is
**unchanged**: a relay is only a proposal; the operator's own confirmation is
the only release.

## Follow-up — UI restore and lane-fix (2026-09-22, same day)

Owner report: *"when I click start listening … it says it can't access the work
session … I get a bunch of errors"*, and *"bring back the old UI"*. Reproduced in
a real browser against a disposable live-engine server (`repro/repro.mjs`, report
`repro/repro-report.json`):

- the **production build** already started the lane in ~0.5 s (no error); the
  **dev/StrictMode build** left the lane `connecting` while the wire was `live`,
  and the 12 s probe falsely reported *"no answer from the voice engine"* — the
  effect cleanup disposed the memoized surface and unsubscribed the controller
  (`useVoiceLiveLane`); fixed with `armController()` + `teardownForUnmount()`;
- the talker's *"can't access the work session"* came from the worker brief: for
  an existing-but-empty session the registry reported *"worker session is not
  loaded on this server"*, and the brief source read **every** lane as `pi`;
- the UI now lays out the bounded main surface on top and the free lane below
  (verified in the browser: `drive-mic` before `native-voice-lane`).

Durable regression proof: `playwright.voice-live-e2e.config.ts` +
`tests/e2e/voice-live-e2e.spec.ts` (real disposable live server + built client),
and `evidence/run6` for the relay flow after the server change.

## Evidence

The live vertical slice was run repeatedly against real Gemini Live on a
disposable server. Each run is preserved; the failures are the point.

| Run | S1 conversation | S2 relay | S3 parking | What it established |
|---|---|---|---|---|
| `evidence/run1` | **FAIL** (2 over-relays) | PASS | PASS | The model-driven relay works end to end; the talker over-relayed thinking-aloud and falsely claimed "I've relayed…". |
| `evidence/run2` | **FAIL** (1 over-relay) | PASS | FAIL (busy window elapsed) | Honesty fix held ("prepared … for your approval"); one instruction-shaped statement still inferred as a relay; S3 exposed the 45 s busy window being too short. |
| `evidence/run3` | **PASS** | FAIL (store poll) | PASS | The "never INFER a relay" rule stopped the over-relay; the widened 90 s busy window parked correctly; S2's 45 s store poll was too short for the 90 s turn. |
| `evidence/run4` | **PASS** | PASS | FAIL (duplicate parked item) | The model emitted the same relay twice 483 ms apart, creating two identical parked items — a real duplicate-send risk. |
| `evidence/run5` | **PASS** | **PASS** | **PASS** | **Acceptance: 3/3** after the duplicate guard — conversation produces no proposal, the relay is approved and delivered byte-exact, busy items park and promote correctly. |

**Defects found by live validation (all prompt/harness level, all fixed):**

1. **Over-relay of thinking-aloud.** Fixed by making relay deliberate, naming
   the thinking-aloud classes, and forbidding the inference of a relay from an
   instruction-shaped statement.
2. **False action claim.** *"I've relayed…"* before approval; fixed by banning
   every past-tense action verb and requiring *"ready for your approval"*.
3. **Duplicate relay call.** The model emitted one relay twice within a second;
   the harness now ignores an identical repeat inside a 5 s window
   (`relay_duplicate_ignored`), so the operator can never approve the same
   message twice. The relay *decision* is still the model's.

**Scenario timing (not product defects).** The disposable worker's slow turn is
90 s so both a mid-run steer (S2) and mid-run parking (S3) are real; the S2 store
poll is 150 s to cover the turn boundary.

| Artefact | What it proves |
|---|---|
| `slice-run.json` | The full vertical-slice record: per-scenario checks, wire frames, kernel evidence, byte-fidelity and worker-store audits. |
| `negative-control.json` | A tampered confirmation is refused; an instruction-bearing confirm frame is refused. |
| `gate-leak-audit.json` | No release outside an authorised confirmation. |
| `byte-fidelity-audit.json` | The worker store holds exactly the approved proposal bytes. |
| `slice-run*.log` | The run logs (disposable server, real Gemini Live, real Pi worker). |

The slice streams **real synthesised speech** into the **real Gemini Live**
model against a **disposable server**, and reads the results off the **real
wire** — no fake model, no fixture standing in for the relay decision.

## Reproduction

```bash
cd /root/pi-web-ui
npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice \
  --repo-root /root/pi-web-ui \
  --evidence-dir /root/pi-web-ui/operations/voice-free-talker-20260922/evidence
```

Requires `GEMINI_API_KEY` in the environment. The disposable server is booted and
stopped by the runner; **production is never touched**.

## Static gates (pre-live)

- server unit suite 5460/5460, shared 249/249, client DriveMode + voiceLive 224/224
- `typecheck`, `build` clean; `lint` 0 errors (314 warnings, under the ratchet ceiling)
- `docs:check-links`, `docs:check-status`, `docs:check-agent-guides` green

## Known limitations

- The live model's decision to relay is stochastic; the slice asserts the
  observable outcome (a proposal from the trigger phrase) and fails closed if it
  does not fire.
- Cross-lane native playback remains **one mounted lane per page** by design
  (one playback chain per page); the cascade multi-lane read-back stays queued
  through the one shared speech arbiter.
- Production restart/deploy is **owner-gated** and was not performed.
