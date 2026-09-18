# Track M evidence — the receipt verdict is visible (N6) + the capacity code

**Branch:** `fix/voice-receipt-ui` · **Worktree:** `/root/pi-web-ui-wt-corr-m`
**Findings closed:** the review-R M2 consequence in the client surface (N6: honest delivery,
always) and the additive `voice_lane_capacity` catalogue entry Track K's server-local code needed.

This directory holds the committed proof. Everything here was produced by the commands in
`/root/voice-exec-20260917/coordination/M/complete.md`; only the `.txt` gate logs are command
output captured verbatim, and nothing is hand-written.

## What is REAL in the browser evidence

* the **REAL product component tree**: `DriveModeVoiceLive` bound to the real `VoiceLiveSurface`
  + `VoiceLiveController`, mounted by `client/src/dev/voiceLiveLab.tsx`;
* the **real receipt path**: `receipt_event` arrives at `VoiceLiveSurface.onWireMessage`, is
  accepted by `interpretInbound` (the same envelope check the server's bytes meet), and the
  controller's retained snapshots drive the rendered verdict;
* the **real delivered chime**: the production Web Audio chime, armed by a real user gesture, and
  the badge it drives — asserted delivered-only;
* the **real capacity frame shape**: a lane-named `voice_error` carrying `code:
  voice_lane_capacity`, exactly as `server/src/websocket/connection.ts` sends it (`VOICE_REFUSAL_TEXT`
  is the text used), once with Track K's correlated `requestId` echo and once without;
* a real Chromium browser over HTTP, with the real AudioWorklet capture path available (unused
  here: the receipt path does not touch capture).

## What is SUBSTITUTED (disclosed)

| Substituted | Why | Where |
|---|---|---|
| The operating system's microphone | headless Chromium has no device | the lab's virtual microphone (the same substitution Tracks C and L use). Not exercised by these verdicts. |
| The server itself (the frames are delivered through the surface's seam) | the evidence is a page-level rendering claim, not a socket claim | `tests/e2e/voice-live-receipts.spec.ts`; the bytes are the contract's own frames and the server's own `VOICE_REFUSAL_TEXT` line |
| The OS speech service | no read-back is needed to prove a verdict | deliberately NOT installed here (Track L's presentation spec is where that stub belongs) |

Nothing about the product's wiring is stubbed: the spec asserts what the component rendered from
the controller's own retained receipts, and what the chime actually played.

## Files

| File | What it proves |
|---|---|
| `01-typecheck.txt` | `npm run typecheck` (all workspaces): exit 0 |
| `02-build.txt` | `build --workspace=shared` exit 0; `build --workspace=client` exit 0 |
| `03-client-suite.txt` | full client suite: 144 files / 1611 tests passed, exit 0 |
| `04-playwright-receipts.txt` | `npx playwright test --config playwright.voice-live-receipts.config.ts`: 9 passed, exit 0 |
| `05-lint.txt` | `npm run lint`: 0 errors, exit 0 (339 pre-existing warnings, incl. the file's own `_AssertTrue` convention) |
| `07-shared-suite.txt` | `npm run test --workspace=shared`: 9 files / 246 tests passed, exit 0 |
| `receipt-verdicts.json` | per-outcome DOM evidence: the rendered text, `data-outcome` / `data-verdict-tone` / `data-reconcile`, whether the chime badge was present, **which chime variant actually played**, the receipt payload, and whether the lane's whole text mentions "delivered" |
| `capacity-refusal.json` | the capacity code, the server's own message and `fatal:false` as the component received them |
| `browser-console.log` | the browser console/page errors from the evidence run (no page errors) |
| `M1-delivered[-full].png` | delivered: "Delivered to the worker · via steer", with the delivered chime badge |
| `M2-queued[-full].png` | queued: "Accepted — not yet handed to the worker · Antigravity queues this in the worker loop.", no badge, no delivered wording |
| `M3-refused[-full].png` | refused: the server's own `reason`, no badge, no delivered wording |
| `M4-unknown[-full].png` | unknown: unconfirmed + cause + reconciliation, no badge, no delivered wording |
| `M5-verdict-replaced.png` | a delivered verdict replaced by a later unknown one — no delivered claim left standing |
| `M6-capacity-refusal[-full].png` | the capacity refusal rendered as a lane refusal with the server's text |
| `M7-capacity-fallback-full.png` | the same frame with no server message: the client's local capacity line |
| `M8-capacity-correlated-full.png` | the capacity refusal answering a **real issued** `requestId` is applied (not refused as a foreign request) |
| `M9-superseded-verdict-full.png` | a delivered verdict does not stand once a newer proposal is live and unconfirmed |

## The chime, stated precisely

`receipt-verdicts.json` shows which chime variant actually played per outcome. The **delivered
figure** is used only for `delivered`; queued/refused/unknown play their own distinct tones, and
the **visual chime badge** is rendered for `delivered` only (the non-delivered verdict is carried by
the verdict line). The two together are the N6 claim: nothing looks or reads like delivery unless it
was delivered.

## Honest gaps in this evidence

* **No live server socket was used.** These are the contract's frames delivered through the
  surface's own inbound seam. The end-to-end browser↔server capacity refusal (a real
  `voice_session_start` at the lane cap) belongs to the merged-branch integration run, and it cannot
  be produced from this worktree because Track K's mount is still merging in parallel.
* **Track K was read, not merged.** The capacity frame shape, code and text come from
  `fix/voice-corr-server` (`voice-live-mount.ts:303`, `connection.ts:91`). If K's merged wire differs
  from what was read, the bytes this evidence replays would need re-checking — the rendering logic
  itself is independent of that (it renders whatever `voice_error` arrives, and the shared catalogue
  now names the code).
* **Audibility is not measured** (this host has no OS-output oracle): the evidence proves the
  component's chime gate and the variant the product asked the chime to play, not that a human
  heard it.
