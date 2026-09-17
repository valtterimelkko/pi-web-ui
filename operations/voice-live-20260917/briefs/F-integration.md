# Brief F — disposable vertical slice integration (plan Phase 5 = Track F)

**Session:** assigned at dispatch. **Worktree:** `/root/pi-web-ui-wt-integration` (branch `feat/voice-integration`, based on master after **Wave 1** merged: contract E, kernel A, bridge B, client C). **Runtime:** pi. **Model:** assigned at dispatch (deepseek-v4.1-flash pool rotation); thinking `high`, `max` if advertised.

## Bounded outcome

Connect Tracks A + B + C into **one end-to-end working system** in an isolated, disposable
environment, and prove the full conversational and delivery loop against a **real worker session**
with real receipts. You deliver the slice runner, the three scenarios and the mount wiring.

## Read first

- `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md` — the frozen contract (§2 transport, §4 catalogue,
  §6 service boundary and §6.4 the router handler you register).
- `docs/VOICE-MODE-EXECUTION-PLAN.md` §Phase 5 (your tasks and Gate 5, verbatim).
- `docs/VOICE-MODE-INTENT.md` §9 (speech policy), §16 (four objects), §17–§19 (provenance, context,
  allowed operations).
- **Track B's delivered code**: `server/src/voice/voice-router.ts` (`VoiceSessionRouter`,
  `VoiceKernelDelegate`, `mapBridgeEventToServerMessage`), `server/src/voice/voice-session.ts`
  (`VoiceBridgeService` implementation), `server/src/voice/gemini-live-bridge.ts`
  (`GeminiLiveBridge`, `createGenaiLiveSessionFactory`, `buildVoiceConnectConfig`).
- **Track A's kernel**: `server/src/talker/*` — especially `delivery.ts` (`createPiDelivery`,
  `createDefaultDeliveries`), `release-store.ts`, `proposal-store.ts`, `kernel-operations.ts`.
  Read-only: do not edit `server/src/talker/**`.
- **Track C's client**: `client/src/lib/voiceLive/*` and `tests/e2e/voice-live-ducking.spec.ts` —
  the client half of the wire; the slice drives the server side.
- **The lab**: `scripts/voice-live-lab/` — `cli.ts` (you add a `test-vertical-slice` command),
  `boot-disposable-server.sh` (you may extend it), `lib/providers/gemini-live.ts` and
  `lib/harness/*` (reuse; do not fork the provider adapter).
- `server/src/websocket/connection.ts` — the authenticated transport your handler plugs into.

## Deliverables (owned paths)

1. **Mount wiring** — `server/src/index.ts` and/or `server/src/websocket/*` (mount wiring only):
   construct the voice service (bridge + session service + `VoiceSessionRouter` with a kernel
   delegate), attach it to the authenticated WebSocket path per contract §6.4, and make it
   **inert unless enabled** (no behaviour change for sockets that never send voice frames; no
   client bundle change; N1–N9 and the relay gate untouched).
2. **Slice runner + `test-vertical-slice` CLI command** — `scripts/voice-live-lab/**`:
   boot a disposable server (`boot-disposable-server.sh`), attach Voice Mode to a **real disposable
   Pi worker session** created through that server's Internal API, and run the three scenarios by
   speaking scripted operator utterances through a real Gemini Live session (reuse
   `lib/providers/gemini-live.ts` + the L-series harness idioms).
3. **The three scenarios** (plan §Phase 5, exactly):
   - **S1 Thinking together** — converse about a code problem across 4 turns; no offer/steer is
     generated and the worker is never interrupted.
   - **S2 Directed steer** — say *"Tell the worker to check the tests"*; a proposal appears;
     confirm with *"Yes, send that"*; the worker receives the **exact bytes**; the out-of-band
     delivery chime trigger condition (`receipt_event { outcome: "delivered" }`) is observed on the
     wire.
   - **S3 Parking & surface** — flag two items while the worker is busy; both park; promote one
     after the worker turn completes; the second remains parked.
4. **Assertions on real evidence** — server logs, the proposal/release stores' records, worker
   session receipts (`GET /sessions/:id` style facts through the disposable server's Internal API).
   A **gate-leak check**: nothing may reach the worker without a logged proposal id and matching
   SHA. Byte fidelity between the confirmed proposal and the delivered worker prompt must be proven
   by inspection, not assumed.
5. **Evidence + handback** — write machine-readable records under
   `operations/voice-live-20260917/evidence/F/` (in the repo) and the handback at
   `/root/voice-exec-20260917/coordination/F/complete.md`.

## Anti-cheat requirements (plan §Phase 5, binding)

- **Mock client stubs are strictly forbidden.** The operator side must be the real provider loop;
  the worker side must be a real runtime session; the server must be the real disposable server.
- **Zero gate leaks.** Any instruction reaching the worker without a logged proposal id and
  matching SHA fails the mission.
- The scenario runner must **fail** when a scenario's evidence is missing — a suite that cannot
  fail proves nothing. Include at least one negative control (e.g. a deliberately tampered
  confirmation must be refused, not delivered) and record it.
- No production state: the disposable server must not touch production's registry, socket or
  service; boot outside the production cgroup exactly as `boot-disposable-server.sh` does.
- `GEMINI_API_KEY` comes from the server environment (already set there); never print it, never
  commit it, never place it in a client bundle.

## Gate 5 (run and record, verbatim from the plan)

```bash
npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice
```

Exit 0; all 3 scenarios complete; log inspection proves 100 % byte fidelity for confirmed
proposals. Also run `npm run typecheck` and `npm run build` (exit 0) and the full server suite
(`env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npm --prefix server test`) — record the tail.

## Constraints

- Owned paths only. **NO-TOUCH:** `server/src/talker/**`, `server/src/voice/**` (B's frozen code),
  `shared/**`, `client/**` (except nothing at all — the client is not wired in this phase), docs.
  A needed change in a frozen track is a `PARENT-INPUT-NEEDED` question, never an edit.
- Keep the mount **additive and inert**: no new behaviour when voice is not in use.
- Do not weaken or skip tests to pass; a suite with 0 executed checks or skips fails.

## Stop protocol

Blocked or a contract conflict → `/root/voice-exec-20260917/coordination/F/01-questions.md`, print
`PARENT-INPUT-NEEDED`, end turn.

## Handback

Commit on `feat/voice-integration`. `/root/voice-exec-20260917/coordination/F/complete.md`: outcome;
changed-path inventory (every file); gate commands + observed results (scenario records, byte-fidelity
proof, negative control); the mount-wiring diff summary; `FROZEN` marker. Declare on the agent-os
board; leave the entry on completion.
