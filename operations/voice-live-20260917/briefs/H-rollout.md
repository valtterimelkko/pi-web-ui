# Brief H — reversible rollout + engine-seam corrections (plan Phase 8, Gate 8)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-wt-rollout` (branch `feat/voice-rollout`, based on master after **Wave 2** merged: contract, kernel, bridge, client surface, regression suite, vertical slice + mount). **Runtime:** pi. **Model:** assigned at dispatch (deepseek-v4.1-flash pool rotation); thinking `high`, `max` if advertised.

## Bounded outcome

Make the live engine **safe to turn on and off**: a reversible environment flag, a seamless fallback
to the existing Gemma cascade, real operational metrics — plus the two durable corrections that
Phase 5 deferred to this phase. One coherent deliverable: *the live engine is production-ready behind
a flag, with the deferred seams closed*.

## Read first

- `docs/VOICE-MODE-EXECUTION-PLAN.md` §Phase 8 (your tasks and Gate 8, verbatim) and the gate table.
- `docs/VOICE-MODE-INTENT.md` §17–§19 (allowed operations, provenance), §21/§22 (rollout posture).
- `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` §6 (service boundary) and §6.4 (the router handler).
- **The merged code you are changing**:
  - `server/src/websocket/voice-live-mount.ts` (the Phase-5 mount; see `withIdleToolAcknowledgements`
    and the voice frame budget usage),
  - `server/src/websocket/connection.ts` (the transport half; see the voice frame budget around
    "the dedicated voice-frame budget (Phase 5)"),
  - `server/src/voice/gemini-live-bridge.ts` (`VOICE_FUNCTION_RESPONSE_SCHEDULING`, the connect config)
    and `server/src/voice/voice-session.ts` (the service Track B implements),
  - `server/src/talker/model-client.ts` (**what "cascade" means here**: the existing
    `google/gemma-4-26b-a4b-it` talker model path) and `server/src/talker/session-registry.ts`,
  - `server/src/security/rate-limit.ts` (`wsMessageLimiter` — the shared limiter),
  - `server/src/observability/operational-metrics.ts` (`getOperationalMetrics()`, surfaced by
    `GET /api/v1/diagnostics` through `server/src/internal-api/routes/diagnostics.ts`).
- Evidence of the findings you are closing: `operations/voice-live-20260917/evidence/F/FINDINGS.md`
  (F-1, F-2) and the ledger §12 entries for Wave 2.

## Deliverables (owned paths — nothing else)

1. **F-1 correction — where tool-acknowledgement scheduling belongs.**
   The Phase-5 mount wraps the provider session to re-schedule tool acknowledgements `WHEN_IDLE`
   (`withIdleToolAcknowledgements`), because with the contract's declared functions and a
   `SILENT`-scheduled acknowledgement `gemini-3.8-live` answers conversational speech by calling a
   tool and **ending the turn silently** (F-1: the operator hears nothing). Move that decision into
   the engine where it belongs — a bridge/session option surface in `server/src/voice/**` (e.g. a
   scheduling option on the connect config with a documented default that keeps the operator
   hearing a reply) — and **delete the mount's wrapper** once the engine owns it. Keep Track B's
   public contract (`VoiceBridgeService`, `VoiceSessionRouter`) intact; this is an additive option
   plus a default change, with tests.
2. **F-2 correction — the voice frame budget lives with the other rate limits.**
   `connection.ts` currently carries the voice-frame budget inline (1200 frames / 2 s per client,
   voice frames exempt from the generic 60/min `wsMessageLimiter`). Fold that policy into
   `server/src/security/rate-limit.ts` next to `wsMessageLimiter` so both policies live in one place,
   keep the behaviour identical (bounded, surfaced as `voice_error` when exceeded, generic limiter
   unchanged for every non-voice message), and keep the existing tests green.
3. **Phase 8 — the reversible flag.**
   `VOICE_MODE_ENGINE=gemini-live|cascade` in `server/src/config.ts`, **default `cascade`** until the
   operator enables it. The flag is validated (unknown value fails fast with a clear message) and
   surfaced where the engine is selected; nothing about the live path may activate when the flag is
   `cascade`.
4. **Phase 8 — seamless fallback.**
   When the Live engine fails to connect, drops unrecoverably, or exhausts quota, the session
   registry falls back to the existing Gemma cascade **without dropping active drafts** and without
   losing the operator's parked items. Surface the degradation honestly on the wire (the contract's
   `voice_state`/`voice_error` frames are the client's announcement surface — the client already
   renders them), and make the fallback observable in logs/metrics.
5. **Phase 8 — operational metrics.**
   Expose, through the existing `getOperationalMetrics()` / diagnostics surface: audio minutes
   streamed (input/output), live connection drops and resumption success rate, and proposals
   created / released / refused / reconciled. Counters must be cheap, monotonic, and testable.
6. **Tests, including the plan's fallback proof.**
   The plan's anti-early-claim guard: *"Test the fallback path: kill the Live bridge connection
   mid-session and verify that the UI seamlessly degrades to push-to-talk cascade with an audible
   announcement."* Prove the server half with a real test: kill the live connection mid-session and
   assert (a) the fallback engages, (b) active drafts survive, (c) the announcement frame reaches the
   wire, (d) the cascade path is the one now serving the lane. A hermetic test can drive the bridge
   seam; do **not** require a live provider call for the gate.

## Gate 8 (run and record, verbatim from the plan)

```bash
npm run typecheck && npm run test
```

Exit 0 across all workspaces with the dual-engine fallback verified. Note: run the server suite with
the repository's own env-normalised recipe (`env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npm --prefix
server test`) and record the tail; the raw command inherits two variables this host sets globally.

## Constraints

- Owned paths only: `server/src/config.ts`, `server/src/talker/session-registry.ts`,
  `server/src/voice/**`, `server/src/websocket/connection.ts`, `server/src/websocket/voice-live-mount.ts`,
  `server/src/security/rate-limit.ts`, `server/src/observability/operational-metrics.ts`,
  `server/src/internal-api/routes/diagnostics.ts`, and their tests under `server/tests/**`.
  **NO-TOUCH:** `server/src/talker/**` other than `session-registry.ts`, `client/**`, `shared/**`,
  `scripts/**`, docs, and everything else.
- The safety core is frozen: N1–N9, the relay gate, the confirm/release predicate, the wire contract.
  A needed change there is a `PARENT-INPUT-NEEDED` question, never an edit.
- Defaults must keep today's behaviour when the flag is unset (`cascade`) — no silent activation.
- Do not weaken or skip tests to pass; a suite with 0 executed checks or skips fails.
- Never print, log, commit or emit credentials; evidence must pass through the repo's redaction
  conventions (Wave 2's F-6).

## Stop protocol

Blocked or a contract conflict → `/root/voice-exec-20260917/coordination/H/01-questions.md`, print
`PARENT-INPUT-NEEDED`, end turn.

## Handback

Commit on `feat/voice-rollout`. `/root/voice-exec-20260917/coordination/H/complete.md`: outcome;
changed-path inventory; gate commands + observed results (including the fallback proof and the metric
read); the flag's default and validation behaviour; `FROZEN` marker. Declare on the agent-os board;
leave the entry on completion.
