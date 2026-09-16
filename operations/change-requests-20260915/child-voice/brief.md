# Child V — Drive Mode: the two-tab voice defect, and a desktop layout mode

**You are a dispatched child worker.** You own one bounded outcome (two related
operator items on one surface). You do not commit, push, build for production,
or touch any service; the parent does that.

- Your session id: `01a0a42e-eb8f-7422-bc57-05640c176744`
- Your tree (worktree, yours alone): `/root/pi-web-ui-wt-voice`
- Handback: `/root/pi-web-ui/operations/change-requests-20260915/child-voice/complete.md`
  (create the directory; evidence in `logs/` and `shots/` beside it)

## Item A (behaviour defect) — two voice lanes, two tabs

Operator, verbatim:

> "when holding two voice modes on separate browser tabs, I might struggle to
> switch - especially if I'm trying to voice myself on one while the other,
> unexpected started to talk. the microphone button does not seem to activate,
> even if the browser tab activates the red 'recording' button. How would a
> multi-voice mode thing look like, with max 3 voice modes on?"

Map (not a verdict): `client/src/hooks/useDictation.ts` (mic + recorder),
`client/src/lib/speechArbiter.ts` (playback ladder, `setOperatorSpeaking`),
`client/src/components/DriveMode/voiceFloor.ts`, `FloorBanner.tsx`,
`DriveModeDictate.tsx`, `useVoiceTurn.ts`, `client/src/store/driveModeStore.ts`.

**Reproduce before you theorise.** Use the repo's own real-browser audio lane so
no physical microphone is needed: `docs/plans/REAL-BROWSER-AUDIO-REGRESSION-LAB-PLAN.md`
and `scripts/audio-lab` (`npm run audio-lab -- …`), which drives Chromium with
fake media devices and a deterministic audio oracle. Two tabs, two different
worker sessions, both in Drive Mode. Establish which layer actually fails —
browser capture policy, the recorder state machine, the surface's enable/disable
logic, cross-tab contention, or the STT round trip — and prove it.

Then fix the concrete defect with TDD (RED first). If the honest fix requires an
architecture change (lane identity, arbitration across lanes), implement only the
minimal safe part now and say exactly what the rest would need.

**Deliverable for the operator's question:** a short design note — what up to
three concurrent voice lanes should look like and do (per-lane identity, how you
switch, which lane is speaking, what happens when a second lane starts talking
while you are speaking, the cap, and the failure modes). Concrete recommendation,
not options-forever. Write it to
`/root/pi-web-ui/operations/change-requests-20260915/child-voice/MULTILANE-DESIGN.md`.
**Do not implement the multi-lane redesign** — the operator reviews the note first.

## Item B (layout) — a desktop mode, current layout kept as mobile

Operator, verbatim:

> "Two modes for voice mode? For a computer screen, one that also shows the
> session itself on one half of the screen - the current version could stay as
> 'mobile mode' as mobile screen can't really handle more information."

Implement: a **desktop layout** for Drive Mode in which the voice surface and the
live session (transcript / stream) share the screen, with the existing layout
kept as the **mobile** mode. Requirements:

- the mode is explicit and persists (a preference the operator sets once);
- mobile mode is unchanged for narrow screens — do not regress it;
- the session pane is the real session view (same store, no fork), and reading
  aloud / confirmation card / floor banner keep working in the desktop split;
- sensible behaviour when the window is narrow even in desktop mode.

TDD the pure logic (layout selection, breakpoints, persistence). Then validate
in the browser: screenshots at a desktop width and a mobile width, both modes,
plus the voice flow still working in the desktop split.

## Constraints

- Only your worktree is yours to edit. No git mutations, no `npm run build`,
  no production, no service changes, no disposable *production* validation.
- Clean up servers/sessions/tabs you create.
- Do not restyle the existing mobile surface beyond what the layout requires —
  the operator approves taste, not the child.

## Handback (`complete.md`)

For item A: the reproduction (both tabs, exact steps), the failing layer with
evidence, RED/GREEN per change, and the honest boundary of what you fixed.
For item B: the persistence and layout tests, screenshots, and any operator
decision you need. Plus changed-path inventory and anything you could not do.
