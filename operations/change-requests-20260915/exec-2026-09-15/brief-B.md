You are the SOLE WRITER in the isolated git worktree **/root/pi-web-ui-wt-lanes** (branch `task/multi-lane`, based on master 7c87147). Your session id is {{SID}}. Do all work in that worktree.

## Why this exists
In Voice Mode the operator opened two tabs and the other one started talking while he was speaking on the first, with no way to tell them apart. Today one tab holds exactly one worker session and switching worker requires leaving Voice Mode entirely (`DriveModeDictate` exposes only `onExit`/`onAbort`; the store holds a single `activeSessionId`).

**The owner has decided the shape: ONE TAB HOLDS THE LANES.** No cross-tab coordination, no `BroadcastChannel`, no lane registry on the server. With everything in one page the existing per-tab speech arbiter already schedules playback, so the whole problem is reduced to in-page state. **Do not add cross-tab machinery.**

## READ THESE FIRST (they are the design of record)
- `/root/pi-web-ui/operations/change-requests-20260915/LANE-SHAPE-DECISION.md` — why this shape, grounded in the code.
- `/root/pi-web-ui/operations/change-requests-20260915/child-voice/MULTILANE-DESIGN.md` — lane identity, floor rules (§4.4), the cap, failure modes.
- `/root/pi-web-ui/operations/change-requests-20260915/child-voice/harness/two-tab-repro-v2.mjs` — the existing two-tab browser harness you will adapt to drive lanes in **one** page.

## Do the work in this order
**Step 1 (prerequisite — do this before any lane work).** `client/src/lib/talkerBus.ts` results are global and filtered only by worker session, ignoring the request id and runtime (`talkerBus.ts` ≈ lines 66-92; `useVoiceTurn.ts` ≈ line 261; `useTalkerTurn.ts` ≈ line 210). With one tab that is latent; with several lanes it is exactly how lane A's card appears in lane B. Carry and match on `requestId` plus a lane identity; never let a late result from a previous request overwrite a newer card. Cover out-of-order and foreign-lane arrivals with explicit tests.

**Step 2 — two lanes in one tab.** A lane strip (`Worker 1 · speaking`, `Worker 2 · you have the floor`) that switches which worker the operator's voice is addressed to, live, without leaving the screen; per-lane transcript, card, reading level and focus; a "+" that adds a second worker using the existing session picker.

**Step 3 — the third lane and the asking rule.** Cap **3** lanes. A fourth lane **asks** — offer replace-or-choose — and never appears silently. The lane count is always visible (`2 of 3`).

**Step 4 — one floor across lanes.** No lane may start speech over any lane's capture; speech already playing ducks to 0.15 when capture begins; two lanes wanting the floor queue by tier then **waiting-time fairness**; when the operator takes the floor in one lane, the others announce it. These rules are in `MULTILANE-DESIGN.md` §4.4 — implement them as designed rather than inventing a scheme.

## Invariants that must survive — they are shipped promises
- **Capture is unconditional and never gated by the scheduler.** The operator can always be heard.
- **The operator's floor is never interrupted.**
- **Single-lane use stays behaviourally identical to today** — the strip collapses to the current banner and no cross-lane messages are sent. Pin this with a test *before* you add the second lane, so you can prove you did not change it.
- Every scheduling decision stays observable in the browser diagnostic ring.
- No `BroadcastChannel`, no server-side lane registry, no contract change.

## How to work
- **TDD, RED first**, for the correlation rules, the lane state machine, the cap/asking rule and the floor rules. Paste RED output in the handback — a test that never failed proves nothing.
- Keep changes path-limited and avoid opportunistic refactors of the DriveMode components.
- **Do not run `npm install`** — `node_modules` is symlinked from the main checkout. On a cache error mentioning `node_modules/.vite`, retry once then use `--no-cache`.
- The real UI must work: this is a user-facing change, so a unit test alone is not evidence. Extend the harness so it drives two (then three) lanes in ONE page and asserts the operator is never spoken over.

## Gates — all must pass, paste exact commands and exit statuses
```
cd /root/pi-web-ui-wt-lanes
npm test --workspace=client
npm test --workspace=server
npm run typecheck
npm run lint
npm run build
```
- Commit your work on the branch with clear messages. **DO NOT PUSH. DO NOT MERGE. NEVER restart, touch or validate against production.** Validate the browser harness only against a disposable local server you start yourself.

## Owned paths — nothing else may be modified
- `client/src/components/DriveMode/**`
- `client/src/store/driveModeStore.ts`
- `client/src/lib/talkerBus.ts`, `client/src/hooks/useTalkerTurn.ts`
- `client/tests/**`
- a new harness file under `/root/pi-web-ui/operations/change-requests-20260915/child-voice/harness/` if you extend the existing one
- If you believe a change is genuinely required in `server/`, **stop and ask** — that surface belongs to another child in this programme.

## Read-only / off limits
- `/root/pi-web-ui` (the main checkout) is READ-ONLY to you; the same applies to `/root/pi-web-ui-wt-restart`.
- Production, every other repository, and any live Internal API action beyond read-only GETs.

## Coordination
- **Handback:** write ONCE at the end to `/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15/B-lanes-complete.md`, beginning with `FROZEN`, containing: what changed (file:line), RED then green evidence, the harness command and its observed result, exact commands + exit statuses, what you deliberately did not do, what is not finished, and residual risk.
- **Questions:** write `/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15/B-lanes-questions.md` and **end your turn immediately**. Never wait, never poll, never hold your turn open. Ask only about: a contradiction or impossibility in these instructions, an authority or scope boundary you cannot cross (such as needing to edit `server/`), something irreversible, or a premise that turned out false. Everything below that line is yours to decide and record.
- Optionally declare presence once: `npm --prefix /root/agent-os run agent-os -- board declare --join-session {{SID}} --task "W-C/W-D: lane correlation + multi-lane voice in one tab" --repo /root/pi-web-ui-wt-lanes`.

This session runs under a **goal engine**: the objective is your durable aim. Keep working until it is true, then stop. If part of it turns out to be wrong on the ground, record that honestly rather than claiming success.
