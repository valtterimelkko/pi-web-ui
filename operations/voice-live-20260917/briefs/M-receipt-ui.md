# Track M — receipt verdicts must be visible (N6) + the capacity code in the catalogue

**Role:** small correction child. Review R's finding M2 was fixed on the server (Track K): an
ambiguous delivery is now recorded honestly as `unknown` (with `unknownCause` and `reconcile`)
instead of being mislabelled `refused`. But **the client surface displays no receipt verdict at
all**: after a confirmation the operator only learns of a *delivered* outcome (the chime);
`queued`, `refused` and `unknown` are silent. Intent N6 is "honest delivery, always" — the operator
must be able to tell what actually happened.

**Worktree:** `/root/pi-web-ui-wt-corr-m` · **Branch:** `fix/voice-receipt-ui`
**Base:** `master` (contains the client surface Track C built, L's presentation wiring, and K's
server-side honest receipts).
**Track K is merging into master in parallel and touches only `server/**` — you never touch it.**

**Owned paths:** `client/src/**`, `shared/src/types/voice-messages.ts` (**additive only**),
`operations/voice-live-20260917/evidence/M/**`, and if your browser evidence needs them,
`tests/e2e/**` + a new playwright config at the repo root (new files only; disclose them).
**Do NOT touch:** `server/**`, `docs/**`, `scripts/**`, any existing test of another track.

**Report:** `/root/voice-exec-20260917/coordination/M/complete.md` (never create it before you are
done); genuine blockers: `NN-questions.md` + `PARENT-INPUT-NEEDED`.

## Findings to close

### 1. The receipt verdict must be visible in the voice surface (N6)
`VoiceLiveController` already retains receipts (bounded) and calls `onReceipt`; `DriveModeVoiceLive`
renders nothing for them. Render the verdict honestly for **all four** outcomes:
- `delivered` — the positive state (the chime stays **delivered-only**; test that).
- `queued` — accepted but not yet handed over; show the `disclosure` when present.
- `refused` — show the `reason`.
- `unknown` — show the `unknownCause` and a plainly-worded note that delivery could not be
  confirmed and will be reconciled (`reconcile: true` means exactly that). **Nothing about an
  `unknown` or `refused` outcome may look or read like delivery.**
Minimal diff, consistent with the existing surface; do not restyle unrelated components. The
control must never widen the gate (display only — no new send path, no new authority in the prompt).

### 2. `voice_lane_capacity` joins the shared catalogue (additive)
Track K added a server-local honest capacity refusal code. Add it **additively** to
`VoiceErrorCode` in `shared/src/types/voice-messages.ts` (lane/attachment group), and make the
client render it like any lane-named refusal — preferring the server's own `message`, falling back
to a local line. Keep the union change purely additive (no renames, no removals, no reordering that
breaks consumers); the shared build + both consumers must typecheck.

### 3. Regression guard
Tests proving: the chime fires **only** for `delivered`; each of the four outcomes renders its own
honest state; an `unknown` never renders a delivered-looking state.

## Gates (report exact commands + exit codes + counts)

```bash
cd /root/pi-web-ui-wt-corr-m
npm run typecheck
npm run build --workspace=shared && npm run build --workspace=client
npm run test --workspace=client
npx playwright test <your spec>    # real browser, lab page, all four outcomes + the capacity refusal
```
**Playwright evidence (required):** screenshots + a JSON of the frames under
`operations/voice-live-20260917/evidence/M/`, driving the real component tree (the dev lab page is
fine; a deterministic stand-in for the OS speech service is fine and must be disclosed). Reference
the artefacts in the handback.

Do not run `npm install` anywhere (the worktree is already isolated; use it as-is). Commit on
`fix/voice-receipt-ui`; do not push (the conductor merges).

**Handback:** `coordination/M/complete.md` with per-finding status, the proof test for each, exact
gate commands + exit codes, evidence paths, deliberate deviations and honest gaps.
