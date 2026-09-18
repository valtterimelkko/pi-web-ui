# Phase 8 — production readiness checklist (Voice Mode live engine)

**Class:** operator checklist, conductor-prepared. **Status:** prepared 2026-09-18 — awaiting the
operator's Phase 7 verdict and activation decision.
**Plan basis:** `docs/VOICE-MODE-EXECUTION-PLAN.md` Phase 8 — exit gate requires the full suite and
typecheck to pass **and** a production-readiness checklist approved by the operator. The suite part
is green on the reviewed master (see §D). This file is the part only the operator can approve.

> **Standing gates that this checklist does not lift:** production restart/deploy requires the
> operator's explicit approval in-conversation; Phase 7 (real-ear) is the operator's verdict alone;
> no agent may self-sign either.

## A. What flipping the flag actually does

| Thing | Value |
|---|---|
| Flag | `VOICE_MODE_ENGINE=gemini-live｜cascade` (server env) |
| Default | unset/blank → `cascade` — **no silent activation**; an unknown value fails fast with a clear message (`server/src/config.ts` `resolveVoiceModeEngine`) |
| Effect | voice lanes are served by the native Gemini Live bridge instead of the Gemma cascade |
| Rollback | set/unset the flag to `cascade` and restart — no migration, no data to unwind |
| Blast radius | voice lanes only. The talker gate, the kernel (proposals/releases/receipts), the shipped dictate path and every non-voice feature are unchanged; a mid-session live failure degrades one lane to the cascade with a host-written announcement ("The live voice engine stopped, so I am on the standard talker now. Nothing you had pending was lost.") and never drops drafts or parked items |

## B. Prerequisites — every box must be true BEFORE the flag is flipped

- [ ] **1. Phase 7 verdict is acceptable** (operator's written sign-off from the real-ear session
  run with `scripts/voice-mode-dogfood.sh`; runbook: `PHASE-7-RUNBOOK.md`). Without it, do not
  activate.
- [ ] **2. `GEMINI_API_KEY` is in the production environment.**
  *Current state: it is NOT.* The production service reads
  `EnvironmentFiles=/root/pi-web-ui/.env.production` and `/root/.pi-web-ui/secrets.env`; neither
  contains a `GEMINI` entry (verified 2026-09-18). The key exists only in the operator's interactive
  shell (`/root/.bashrc`), which the service does not read. Without it the bridge refuses to build
  (`GEMINI_API_KEY is required to build a real Gemini Live session factory`) and every lane would
  degrade to the cascade and announce it — working, honest, and not what the flag is for.
  **Action (owner):** add the key to `/root/.pi-web-ui/secrets.env`, then restart as in item 3.
  Never commit it; never print it.
- [ ] **3. Build and restart from the reviewed master, through the audited path.**
  `npm run build` then `scripts/restart-pi-web-ui.sh --reason "<why>"` — the script names the
  requester in the audit trail and writes a `RESTART-REQUESTED` record only on the path that
  actually restarts. Its drain pre-flight **refuses while the Internal API reports
  `.activeTurns > 0`**; `--force` is the named override and should only ever be used with open eyes.
  **Known blind spot, apply the belt-and-braces:** `activeTurns` has been observed reading `0`
  while sessions were demonstrably mid-work (ledger, 2026-09-15 incident notes), so before
  restarting also count busy sessions from the authenticated `GET /api/v1/sessions`
  (`busy === true`) and wait for zero — exactly the conductor's practice for the 1.44.0 deploy.
- [ ] **4. Know the rollback** (operator, out loud): set `VOICE_MODE_ENGINE=cascade` and restart;
  lanes fall back to the shipped push-to-talk cascade; the UI explains itself in place.

## C. Post-flip verification (the first quiet session after the restart)

| Check | How | Expected |
|---|---|---|
| Engine selected | authenticated `GET /api/v1/diagnostics` → `voice.live.engine` | `gemini-live` |
| Lane goes live | open the native voice lane in the UI | status `live · worker idle`; audio flows |
| No silent degradation | the same snapshot's `voice.live.engineFallbacks`, `connectionDrops` | `0` in a quiet session |
| Honest delivery | confirm one instruction | a receipt with `outcome: delivered` and the delivery chime; on anything else, the verdict line says what actually happened (`queued` / `refused` / `unknown`) |
| Usage telemetry | `voice.audio.inputMinutes` / `outputMinutes`, `voice.proposals.{created,released,refused,reconciled}` | rising with use; no cap exists in code — this is the quota watch as well |

The optional fallback drill (owner): kill the provider connection mid-session → the announcement is
spoken once, the lane degrades to push-to-talk, drafts and parked items survive and stay actionable.

## D. What is already proven on the reviewed master

`npm run typecheck && npm test` — exit 0: shared 9 files/246, server 431 files/5355 (+2 skipped),
client 144 files/1611, internal-api-mcp 8/71; `npm run lint` exit 0. The Phase 8 flag, the fallback
path, the metrics surface and both deferred seams (F-1 tool-ack scheduling, F-2 voice frame budget)
were verified by the conductor on the frozen commit (`docs/VOICE-MODE-EXECUTION-LEDGER.md` §12).
The composed browser↔server loop with the live engine was run for real on the disposable slice
(`operations/voice-live-20260917/evidence/phase7-prep/`).

## E. Known limits (recorded, not hidden)

1. **Phase 7 is pending** — no real-ear verdict exists yet. That is the largest open item.
2. **Accepted LOWs** (ledger §12): `ProposalStore.present` can record a present-variant that removed
   nothing (narrowing-only, evidence honesty); the Gate-5 audit proves delivered ⊆ worker-store,
   never the converse (audit scope, plan wording stronger than the proof). Neither is a safety hole;
   both are recorded rather than claimed closed.
3. **No usage cap in code.** Gemini Live draws on the Google key's quota; watch the metrics and the
   provider dashboard. (Owner decision 2026-09-17: real bounded calls approved, no maximum budget.)
4. **Audibility is not machine-verified on this host** (no OS-output oracle), which is exactly why
   Phase 7 is an ear test.

## F. Sign-off (operator only)

- [ ] Phase 7 verdict: acceptable — date/session note:
- [ ] `GEMINI_API_KEY` present in the production env file:
- [ ] Build + restart performed through the audited script:
- [ ] Post-flip checks green (§C):
- [ ] Rollback understood:
- Decision: activate live engine in production / keep `cascade` — signed:
