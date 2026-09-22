# Child C — brief: Phase 2 native primary surface (client)

You are **Child C** in the Voice Mode native-primary programme. You are the SOLE WRITER in the
isolated git worktree **`/root/pi-web-ui-wt-voice-client`** (branch `task/voice-native-client`,
based on `57efe420`). Your session id is provided in the dispatch prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence on the board once your
session id is known:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "C: Phase 2 native primary surface" --path client/src/components/DriveMode --path client/src/hooks --path client/src/lib/voiceLive --exclude server --exclude scripts --exclude shared --join-session <YOUR-SID>`
and leave the board (`agent-os board leave --id <entry>`) before you finish.
This session runs under a **goal**: the outcome below is your durable aim. Keep working until it is
true, then stop. If blocked, record honestly instead of claiming success.

## The outcome that must be true when you are done

**The familiar main Voice Mode controls operate the native Live engine.** One conversation: the
operator talks to the native model through the primary mic controls they already know; discussion
is the default; a relay candidate appears only through the host's existing proposal path. The old
cascade `useVoiceTurn` surface stops being the default competing engine, and a separate
"free versus bounded" choice must NOT remain as the primary UI decision. Keep the cascade as an
explicit, truthful, labelled degradation.

Concretely:

1. **RED first: main-control routing test.** Write a failing test showing that the main controls
   (the same component tree the operator sees at the top of Drive Mode) are bound to the native
   engine/service when the engine is native. Then make it pass.
2. **Bind, don't fork.** The familiar layout is reused: mic button, push-to-talk, stop/focus,
   reading-level control, lane strip, session pane. Change their engine binding, not the visual
   language. `DriveModeDictate.tsx` currently wires `useVoiceTurn` (cascade, line ~80) and
   separately mounts `NativeVoiceLane` (line ~415); the native surface must become the engine
   behind the main controls (`useVoiceLiveLane`, `lib/voiceLive/surface.ts`,
   `lib/voiceLive/controller.ts` are the existing native building blocks).
3. **No competing default lane selector.** Remove the separate default free/bounded choice from the
   primary surface (the bottom `NativeVoiceLane` as an independent competing surface must not
   remain the way to reach native). Show **which engine is actually operating** (a configured
   label alone is not evidence — surface the engine reported by the live lane state where
   available).
4. **Preservation (do not regress):** VAD/open-mic and push-to-talk, accessibility labels and
   aria states, desktop split layout and narrow/mobile layout, reading levels, stop/cancel/focus,
   one shared speech floor with ducking (`lib/speechArbiter.ts` semantics unchanged), mic capture
   available while another output ducks/queues. Existing tests must stay green or be updated only
   where the intentional binding changed.
5. **Truthful fallback states.** When the native path fails or is unavailable, degrade to the
   cascade explicitly and visibly; never silently change pending text, target or permission state.
   Preserve a draft and require a fresh presentation/confirmation after an uncertain transition;
   never auto-send. A forced failure must be visibly degraded, not blank or silent.
6. **Candidate/approval UI stays the existing host-owned path:** `ProposalCard`/confirmation
   semantics are host-driven; do not add client-side release shortcuts or relaxed approval.
   A native proposal must render through the same card identity/version contract (proposalRef
   version + sha256) that already exists.

## Gate G2 (client half) — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-client
npm test --workspace=client -- <your scoped test paths>       # paste the exact paths/filters you used
npm run build --workspace=client
npm run typecheck
```
Also required in the handback: RED evidence for the routing test (a failing run before the fix),
green evidence after, and a short note on every preserved behaviour you verified by test.

The full **primary-mic browser journey** (built app + disposable compiled server + fake-file mic)
is Child J's deliverable in Wave 2, not yours; your gate is the wiring + tests + build. Do not
build a competing harness.

## Owned paths — nothing else may be modified

- `client/src/components/DriveMode/**`
- `client/src/hooks/useDictation.ts`, `useDriveModeDictation.ts`, `useVoiceLiveLane.ts`, `useVoiceTurn.ts`
- `client/src/lib/voiceLive/**`
- `client/src/store/driveModeStore.ts` (only if engine state genuinely belongs there)
- the tests co-located with those files

## NO-TOUCH — do not modify, do not run `git add` on

- `server/**`, `scripts/**`, `shared/**`, `package.json` / workspace manifests
- `server/tests/unit/pi-ai/**` (another lineage)
- `/root/pi-web-ui` (the main checkout) — READ-ONLY to you

If you need a change in `shared/**` (e.g. a new type re-export), do NOT make it yourself: write the
exact request in `/root/voice-native-20260922/coordination/C/NN-questions.md` and continue with the
rest. The parent applies shared changes and sequences them.

## How to work

- **TDD, RED first** for every behaviour. Paste the failing output in the handback; a test that
  never failed proves nothing.
- Keep the diff minimal and path-limited; do not refactor unrelated code, do not reformat.
- The worktree `node_modules` is symlinked from the main checkout on purpose; do not run
  `npm install`. If a cache error mentions `node_modules/.vite`, retry once with `--no-cache`.
- Commit on your branch with clear messages. **DO NOT PUSH. DO NOT MERGE.** Never restart, deploy
  or validate against production.
- One heavy runner at a time; do not launch parallel browser suites.

## Handback — write ONCE at the end

Write `/root/voice-native-20260922/coordination/C/complete.md`, beginning with the word `FROZEN`,
containing: what changed (file paths), the RED evidence (verbatim), the green evidence, exact
commands + exit statuses, preserved-behaviour checklist, what you deliberately did **not** do, and
any uncertainty or residual risk. Also write `/root/voice-native-20260922/coordination/C/complete.json`
with `{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions — the bar is high

If you need the conductor, write `/root/voice-native-20260922/coordination/C/NN-questions.md` (or
`NN-blocked.md`) and **end your turn immediately**; also print the standalone line
`PARENT-INPUT-NEEDED` as your last line. Never wait, never poll, never hold your turn open. Ask only
about: a contradiction or impossibility in these instructions; an authority or scope boundary you
cannot cross; something irreversible; a premise that turned out to be false. Everything below that
line is yours to decide, record and move on with.
