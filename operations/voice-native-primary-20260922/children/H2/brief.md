# Child H2 — correction brief: eyes-free presentation + routing-prompt hardening

You are **Child H2**, a bounded correction child in the Voice Mode native-primary programme. You are
the SOLE WRITER in the isolated git worktree **`/root/pi-web-ui-wt-voice-readback`** (branch
`task/voice-native-readback`, based on the wave-1/2 merged tree). Your session id is in the dispatch
prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "H2: eyes-free read-back + prompt hardening" --path client/src/lib/voiceLive --path client/src/components/DriveMode --path server/src/voice --path server/src/websocket/voice-live-mount.ts --exclude scripts --exclude server/src/talker --exclude shared --join-session <YOUR-SID>`
and leave the board before you finish. This session runs under a goal: the outcome below is your
durable aim.

## Live evidence you are correcting (fix-loop pass 1, 12 real built-app journeys)

| Observed | Boundary | Interpretation |
|---|---|---|
| C01/C03/C17/C19: candidate created correctly (e.g. `prop-1` payload `"I want to find out about Podpoint."`), then the talker said **"I've prepared that message about Podpoint for you to review."** and presentation never completed → deadline exceeded | presentation | The talker was instructed to read the exact text back verbatim and usually **does not**. Presentation therefore stalls, and nothing can be confirmed. |
| C18: candidate correct; model response "The request to deploy the hotfix to staging is ready for your approval."; operator amends ("Wait, do not deploy anything until I approve it in the ticket first.") → model acknowledges but **never re-relays the amended text** | relay selection | The prompt's "call it at most once" guidance appears to discourage a second call for a correction. A correction of a pending relay IS a new thing to relay. |
| C21 (conversation-only): "Not sure anymore. I said yes earlier, but yes, but wait, check the version number before anything." → model created candidate `"check the version number before anything"` | relay selection | Instruction-shaped clause inside doubt/qualification must NOT be relayed. |

## Outcome 1 — host-controlled exact read-back (the presentation fix)

The plan (§3.3) says: **"Use host-controlled exact candidate read-back for eyes-free approval."**
Today the host's exact read-back exists in the client (`client/src/lib/voiceLive/readBack.ts`,
`surface.readBackProposal`) but is only reachable from a UI button; the voice path depends on the
model voluntarily speaking the exact bytes, which the evidence shows is unreliable.

1. **Client: read the proposal back automatically when it is created.** On a native lane's
   `proposal_created` for the surface that is actually mounted/active, perform the existing local
   read-back of the exact retained bytes (the tidied variant) through `readBackProposal`, so
   presentation completes from the host — not from the model's goodwill. Requirements:
   - single-flight per proposal identity; a newer proposal replaces/cancels an in-flight read-back;
   - never auto-read when this surface is not the active one (multi-lane safety) or when speech
     synthesis is unsupported — in the unsupported case presentation stays incomplete and the
     existing honest "cannot read it back aloud" affordance remains (never fake completion);
   - the manual re-read control keeps working; interrupted read-back reporting is unchanged;
   - floor/ducking semantics unchanged (one speech authority; `speechArbiter` untouched).
2. **Server: stop depending on the model for read-back; stop asking it to duplicate the host.**
   In the relay tool response (`voice-live-mount.ts` ~line 1773) and the system instruction
   (`server/src/voice/voice-session.ts`), replace "Read the exact text back to the operator verbatim"
   with guidance along: *"the host will read the approved text back aloud now; do not read it back
   yourself; tell the operator it is prepared and ask them to confirm after they hear it"*. Keep all
   existing "never claim it was sent/released/delivered" language byte-intact.
3. **Keep the model-read-back path as a completion trigger** (exact contiguous match, as today) —
   it stays correct if it ever happens; do not weaken it.

## Outcome 2 — routing-prompt hardening

1. **Amendment = new relay.** The system instruction must say clearly: when the operator corrects,
   amends or replaces a pending relay, call `relay_to_worker` again with the corrected text — the
   "at most once for the same thing" rule applies to repeats, not corrections. The corrected
   message must be the corrected text alone (no accumulation).
2. **Doubt/qualification is not a relay.** Add the live example: after *"Not sure anymore… but yes,
   but wait, check the version number before anything"* the correct behaviour is conversation (answer
   or acknowledge), NOT a relay; an instruction-shaped clause inside doubt, quotation, or
   thinking-aloud is never a relay. Preserve the existing "never INFER a relay" and trigger-phrase
   rules byte-intact except where you extend them.

## Gates — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-readback
npm test --workspace=client -- src/lib/voiceLive src/components/DriveMode     # + any exact paths you add
npm run build --workspace=client
npm run typecheck
NODE_ENV=test npm test --workspace=server -- tests/unit/voice tests/unit/websocket tests/unit/talker
npm run lint
```
Required in the handback: RED evidence per behaviour (the auto read-back; the prompt changes are
covered by explicit text/shape tests), green evidence, and a note on any existing test you
intentionally updated and why. **Do not run real Gemini calls** — the conductor re-runs the affected
journeys after merge.

## Owned paths — nothing else may be modified

- `client/src/lib/voiceLive/**`, `client/src/components/DriveMode/**`, `client/src/hooks/useVoiceLiveLane.ts`
- `server/src/voice/voice-session.ts`, `server/src/voice/voice-tools.ts`
- `server/src/websocket/voice-live-mount.ts`
- the tests co-located with those files

## NO-TOUCH

- `scripts/**` (the conductor is editing the corpus/verifier concurrently), `server/src/talker/**`,
  `shared/**`, `package.json`/lockfiles, `server/tests/unit/pi-ai/**`, `/root/pi-web-ui` (read-only).

## How to work

TDD, RED first; minimal path-limited diff; do not run `npm install` (node_modules is symlinked);
commit on your branch with clear messages; **DO NOT PUSH, DO NOT MERGE**; never touch production.

## Handback

`/root/voice-native-20260922/coordination/H2/complete.md` beginning with `FROZEN` + `complete.json`
with `{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions

Write `/root/voice-native-20260922/coordination/H2/NN-questions.md` and **end your turn**; print
`PARENT-INPUT-NEEDED` last. Never wait or poll. Ask only about contradictions, authority/scope
boundaries you cannot cross, irreversible actions, or false premises.
