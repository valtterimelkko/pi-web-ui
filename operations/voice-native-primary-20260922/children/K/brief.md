# Child K — correction brief: pass-4 fixes (lab semantics + amendment prompt)

You are **Child K** in the Voice Mode native-primary programme. SOLE WRITER in
**`/root/pi-web-ui-wt-voice-pass4`** (branch `task/voice-native-pass4`, based on current master).
Your session id is in the dispatch prompt.

**Mandatory:** load/follow `agent-os-child`; declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "K: pass-4 fixes (lab + prompt)" --path scripts/voice-lane-lab --path server/tests/voice-live-lab --path server/src/voice/voice-session.ts --path server/tests/unit/voice --exclude client --exclude server/src/talker --exclude server/src/websocket --join-session <SID>`
and leave the board before finishing. The goal objective is your durable aim.

## Live evidence (fix-loop pass 4, real built-app journeys, 4 clean / 8 not)

1. **C20 — presentation completed before the confirm phase began, so the wait stalled.**
   Steps: `speak t2` → candidate `prop-1` observed; `speak t3` → `presentation {identity: prop-1, complete: true}`
   observed (during a speak phase); then the `adaptive-confirm` block's `await-presentation` waited for
   a NEW presentation → "deadline exceeded waiting for presentation". This is the exact presentation-side
   analogue of the J2 `pendingCandidate` fix: **record presentations observed during `speak` phases and
   let a later `await-presentation` be satisfied by an already-complete, identity-matched presentation.**
   A revised candidate (new identity) must still require a fresh presentation.
2. **C16/C21 — verifier flags a legitimate proposalless run as incomplete.** Both are conversation-only
   episodes where the labelled `synthetic-tts-source` seam was declared; the shim spoke nothing because
   there was no proposal to read back. The verifier's seam check then treats "declared + 0 spoken" as
   incomplete (verdict `indeterminate`, exit 2). **Zero shim speech is expected and complete when the
   record contains no proposal and no completed presentation**; it stays fraud/incomplete only when a
   proposal/presentation existed without matching shim speech.
3. **C09/C14/C15 — deterministic word slots on open conversation are over-tight** (the model's correct
   answers omitted a single required word: "retry handler" / "relay" / "send"). The plan (§5.3) says:
   deterministic slots/constraints first, and **one independent evaluator pass for open conversational
   responses**. Implement that design for conversation-only episodes:
   - allow an episode to declare `openResponse: true` with `responseMustContain: []` (schema update);
   - the verifier then skips the required-word check for that episode but keeps the forbidden-claim
     check (negation-aware) and the existing routing/no-release evidence checks;
   - the corpus episodes C09/C14/C15 are updated by the conductor (do not edit corpus yourself).
4. **C18 — the amendment was acknowledged but never re-relayed.** Operator: "Wait, do not deploy anything
   until I approve it in the ticket first." The model said "I have cancelled that relay. I will wait for
   your confirmation…" and no amended candidate appeared (`await-candidate` timed out). Strengthen the
   system instruction in `server/src/voice/voice-session.ts` with this EXACT live example: a correction
   of a pending relay is a NEW relay — call `relay_to_worker` again with the corrected text alone
   (including the new restriction); never say you cancelled, sent or held anything you did not.
   Keep every existing rule byte-intact except the additions/extensions.

## Gates — exact commands + exit statuses in the handback

```
cd /root/pi-web-ui-wt-voice-pass4
NODE_ENV=test npm test --workspace=server -- tests/voice-live-lab
NODE_ENV=test npm test --workspace=server -- tests/unit/voice
npx tsc -p scripts/tsconfig.voice-lab.json --noEmit
npm run typecheck
npm run lint
```
RED-first for each of 1–3 (and a prompt-shape test for 4). **Do not run real Gemini calls.**

## Owned paths · NO-TOUCH

Owned: `scripts/voice-lane-lab/**`, `server/tests/voice-live-lab/**`,
`server/src/voice/voice-session.ts`, `server/tests/unit/voice/**`.
NO-TOUCH: `scripts/voice-lane-lab/corpus/**` (conductor-owned data), `client/**`,
`server/src/talker/**`, `server/src/websocket/**`, `shared/**`, `package.json`,
`server/tests/unit/pi-ai/**`, `/root/pi-web-ui` (read-only).

## Handback

`/root/voice-native-20260922/coordination/K/complete.md` (`FROZEN`) + `complete.json`
`{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions

`/root/voice-native-20260922/coordination/K/NN-questions.md` + end the turn, `PARENT-INPUT-NEEDED`
last. Never wait or poll. Do not push/merge; never touch production.
