# Child H3 — correction brief: source-binding transcription race

You are **Child H3** in the Voice Mode native-primary programme. SOLE WRITER in
**`/root/pi-web-ui-wt-voice-bind`** (branch `task/voice-native-bind`, based on current master).
Your session id is in the dispatch prompt.

**Mandatory:** load/follow `agent-os-child`; declare presence:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "H3: source-binding race fix" --path server/src/talker --path server/src/websocket/voice-live-mount.ts --path server/tests/unit --exclude scripts --exclude client --join-session <SID>`
and leave the board before finishing. The goal objective is your durable aim.

## Live evidence (fix-loop pass 3, real built-app journeys)

`relay_to_worker` is refused with `reason:"unbound_source", candidateCount:0` even though the operator
had just spoken the relay aloud. Four episodes (C03, C19, C20, and one repeat call in C01) show the
model — with the addressing frame already correctly stripped, e.g. text `"restart the payment
service"` — being refused, after which it tells the operator *"I couldn't process that / please
repeat"*, and the journey stalls with no candidate. Root cause: the tool call is issued from the
model's audio understanding **before the host's final operator transcript lands**, so the
content-binding window (recent FINAL operator utterances) is still empty at call time. In passes 1–2
this never surfaced because the stale served server predated the content-binding code.

## The outcome that must be true when you are done

1. **Bounded transcription grace.** In `handleToolRequest` for `relay_to_worker`, when the operator
   binding window has **no candidates**, do not refuse immediately: wait a bounded window
   (default ~2 s, poll every ~50–100 ms, injectable clock) for a final operator transcript to arrive;
   then bind normally. If none arrives, refuse `unbound_source` exactly as today. Candidates that
   arrive during the wait must be recorded and eligible (they may have finalised late).
2. **No weakening of ambiguity refusal.** With ≥1 candidate the current semantics stay (exactly-one
   match → bound; ≥2 matches → `ambiguous_source`; one candidate, no match → bound; several, no match
   → `ambiguous_source`). Never bind to the latest by position.
3. **Idempotent duplicate handling unchanged** (the 5 s same-text window) and `lastRelay` is still set
   only on success.
4. **Evidence** records whether a wait occurred and its outcome (`relay_binding_waited` with
   `waitedMs`/`arrived`), so the journal shows the race being absorbed.

## Gates — exact commands + exit statuses in the handback

```
cd /root/pi-web-ui-wt-voice-bind
NODE_ENV=test npm test --workspace=server -- tests/unit/websocket tests/unit/talker
npm run typecheck
npx eslint server/src/talker server/src/websocket server/tests/unit/websocket server/tests/unit/talker
```
RED-first: a test where the tool call arrives with an empty window and the utterance arrives during
the grace period must show the pre-fix refusal (`unbound_source`) and the post-fix binding. A second
test: nothing arrives → still refused, no candidate created. No real provider calls.

## Owned paths · NO-TOUCH

Owned: `server/src/talker/**`, `server/src/websocket/voice-live-mount.ts`,
`server/tests/unit/talker/**`, `server/tests/unit/websocket/voice-live-mount.test.ts`.
NO-TOUCH: `scripts/**`, `client/**`, `shared/**`, `package.json`, `server/tests/unit/pi-ai/**`,
`/root/pi-web-ui` (read-only). A concurrent child (J3) edits `scripts/**` — never touch it.

## Handback

`/root/voice-native-20260922/coordination/H3/complete.md` (`FROZEN`) + `complete.json`
`{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions

`/root/voice-native-20260922/coordination/H3/NN-questions.md` + end the turn, `PARENT-INPUT-NEEDED`
last. Never wait or poll. Do not push/merge; never touch production.
