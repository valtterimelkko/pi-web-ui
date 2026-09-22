# Child H — brief: Phase 3 relay handover and approval fidelity (host/talker)

You are **Child H** in the Voice Mode native-primary programme. You are the SOLE WRITER in the
isolated git worktree **`/root/pi-web-ui-wt-voice-host`** (branch `task/voice-native-host`, based on
`57efe420`). Your session id is provided in the dispatch prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence on the board once your
session id is known:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "H: Phase 3 host relay/approval fidelity" --path server/src/talker --path server/src/websocket/voice-live-mount.ts --exclude server/src/voice --exclude client --exclude scripts --exclude shared --join-session <YOUR-SID>`
and leave the board (`agent-os board leave --id <entry>`) before you finish.
This session runs under a **goal**: the outcome below is your durable aim. Keep working until it is
true, then stop. If blocked, record honestly instead of claiming success.

## Phase 0 RED evidence you inherit (read it first)

`operations/voice-native-primary-20260922/phase0/PHASE0-RED.md` + `phase0/red-probe.ts` (in your
worktree) reproduce four confirmed defects at baseline. Your job is to turn each into a durable RED
test, then fix it:

| # | Defect | Probe case |
|---|---|---|
| 1 | Punctuation-free relay addressing not stripped | `normaliseRelayText('Relay to worker I want to find out about Podpoint')` and `'Ask the worker I want …'` unchanged; `'Relay to worker: …'` control strips |
| 3 | Correction accumulates instead of replacing | two `appendToDraft` calls join both attempts: `'Investigate the alternative Investigate the alternative, but do not change anything'` |
| 4 | Operator original wording not preserved on native promotion | proposal `original` defaults to the model's tidied text; `lastOperatorFinalText` retained but never passed to `kernel.promote` (which supports `original`) |
| 5 | Async source binding guesses the latest utterance | utterance 1 (originating) + utterance 2 before the `relay_to_worker` tool call → `sourceUtteranceId = 2`; should bind the originating turn or refuse as ambiguous |

Class 2 (casual/qualified confirmation) is **already green** — `'not sure'`, `'sure, but wait'`,
`'yes, hold phase three'`, `'I said yes'` → `statement`. Keep them as regression controls; do not
weaken the gate.

## The outcome that must be true when you are done

Make the **source → candidate → presentation → approval → delivery** chain independently auditable
and faithful, on the host side:

1. **Source-turn binding.** A relay tool call binds to its originating operator utterance/turn —
   never to whichever final utterance happens to be last when the asynchronous call arrives.
   Ambiguous provenance **holds or refuses**; it never guesses a source. Race-test at least:
   (a) delayed call after a correction; (b) lane change / attachment generation change; (c) a second
   utterance arriving before the tool result. Design within `server/src/websocket/voice-live-mount.ts`
   + `server/src/talker/**`; read `server/src/voice/contract.ts` (read-only) to see what turn/call
   correlation the bridge already provides — do not invent a protocol change silently.
2. **Correction replaces; identity advances.** A corrected candidate replaces the failed attempt
   instead of concatenating it; a repeat of identical bytes is a **new approval** (new identity),
   not a reused one; a transcript revision/amendment invalidates earlier confirmation; stale
   version/hash echo refuses. The existing version + sha256 + `identityMatches` machinery is the
   base — extend it, do not duplicate it.
3. **Original retention, honestly.** The operator's recognised words and the model's proposed relay
   text are stored independently: pass the retained operator text to `kernel.promote` as `original`
   (when it differs), so the existing original-variant capability reflects bytes actually preserved.
   Never fabricate an original. Card/release bytes stay identical by construction.
4. **Punctuation-free addressing.** Extend the mechanical, removal-only normaliser so the addressing
   frame strips without requiring a colon/`that`/`to` (the two RED cases), while: quoted addressing
   inside message content survives; genuine third-party requests are not retargeted; no aggressive
   rewrite, reorder or re-case. Conservative misses are correct; removing intent is the failure.
5. **Exact read-back + spoken approval.** Keep host-controlled exact candidate read-back; a
   confirmation must answer the current approval prompt (instruction-bearing confirmation and
   unrelated yes are statements/refusals). Reading levels, stop/cancel and one-speech-floor
   semantics unchanged.
6. **Delivery identity.** Approved bytes = release bytes = persisted worker input; no duplicate
   worker task on double confirm; idempotency keys hold. Add the missing join tests if they do not
   exist at the unit level (the full end-to-end join is exercised in Wave 3).

## Gate G3 — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-host
npm test --workspace=server -- tests/unit/talker tests/unit/websocket/voice-live-mount.test.ts
npm run typecheck
npm run lint
```
Also required in the handback: RED evidence per defect (failing run first), the race-test evidence
for source binding (all three races), and a note for every existing test you intentionally changed
and why.

## Owned paths — nothing else may be modified

- `server/src/talker/**`
- `server/tests/unit/talker/**`
- `server/src/websocket/voice-live-mount.ts`
- `server/tests/unit/websocket/voice-live-mount.test.ts`

## NO-TOUCH — do not modify, do not run `git add` on

- `server/src/voice/**` (Child P owns provider profiles in Wave 2)
- `client/**`, `scripts/**`, `shared/**`, `package.json` / workspace manifests
- `server/tests/unit/pi-ai/**` (another lineage)
- `/root/pi-web-ui` (the main checkout) — READ-ONLY to you

If a fix genuinely requires a change inside `server/src/voice/**` or `shared/**`, do NOT make it:
write the exact request (file, symbol, desired shape, why) to
`/root/voice-native-20260922/coordination/H/NN-questions.md`, implement everything you can without it,
and continue. The parent sequences the cross-boundary change.

## How to work

- **TDD, RED first** for every defect and behaviour. Paste failing output; a test that never failed
  proves nothing.
- Keep the diff minimal and path-limited; do not refactor unrelated code, do not reformat.
- The worktree `node_modules` is symlinked from the main checkout on purpose; do not run
  `npm install`. If a cache error mentions `node_modules/.vite`, retry once with `--no-cache`.
- Commit on your branch with clear messages. **DO NOT PUSH. DO NOT MERGE.** Never restart, deploy
  or validate against production.

## Handback — write ONCE at the end

Write `/root/voice-native-20260922/coordination/H/complete.md`, beginning with the word `FROZEN`,
containing: what changed (file paths), the RED evidence (verbatim), the green evidence, exact
commands + exit statuses, the source-binding design (how provenance is established and when it
refuses), what you deliberately did **not** do, and any uncertainty or residual risk. Also write
`/root/voice-native-20260922/coordination/H/complete.json` with
`{status, files, gates:[{command,exit}], red:[{case,evidence}], uncertainties:[]}`.

## Questions — the bar is high

If you need the conductor, write `/root/voice-native-20260922/coordination/H/NN-questions.md` (or
`NN-blocked.md`) and **end your turn immediately**; also print the standalone line
`PARENT-INPUT-NEEDED` as your last line. Never wait, never poll, never hold your turn open. Ask only
about: a contradiction or impossibility in these instructions; an authority or scope boundary you
cannot cross; something irreversible; a premise that turned out to be false. Everything below that
line is yours to decide, record and move on with.
