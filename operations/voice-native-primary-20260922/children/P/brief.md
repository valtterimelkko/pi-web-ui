# Child P — brief: Phase 4 §7 provider-profile boundary (standard vs ET-HIGH)

You are **Child P** in the Voice Mode native-primary programme. You are the SOLE WRITER in the
isolated git worktree **`/root/pi-web-ui-wt-voice-provider`** (branch `task/voice-native-provider`,
based on `62739987`). Your session id is provided in the dispatch prompt. Do all work in that worktree.

**Mandatory:** load and follow the `agent-os-child` skill. Declare presence on the board once your
session id is known:
`npm --prefix /root/agent-os run agent-os -- board quick-declare "P: provider profiles standard vs ET-HIGH" --path server/src/voice --path server/tests/unit/voice --exclude server/src/talker --exclude client --exclude scripts --join-session <YOUR-SID>`
and leave the board (`agent-os board leave --id <entry>`) before you finish.
This session runs under a **goal**: the outcome below is your durable aim. Keep working until it is
true, then stop. If blocked, record honestly instead of claiming success.

## Context you must read first

- Plan §7 (arms) and §11 Phase 4 — the boundary to implement.
- `server/src/voice/contract.ts`, `gemini-live-bridge.ts`, `voice-session.ts`, `types.ts` — the
  existing bridge (own these; read them fully).
- `server/src/voice/voice-handshake-probe.ts` + `server/tests/unit/voice/` — existing probe and
  contract tests.
- `docs/VOICE-MODE-NATIVE-PRIMARY-AND-AUTONOMOUS-VALIDATION-PLAN.md` §7.1–§7.5.

The two arms are exactly: **standard Live** and **Extended Thinking HIGH**. Repo research names
`gemini-3.8-live` and `gemini-3.8-live-extended-thinking`; **re-resolve the real, current model
names and limits via a live capability probe — do not trust those strings as facts.**

## The outcome that must be true when you are done

1. **Typed provider-profile boundary.** A profile type/table covering, per arm: connect options,
   tool-reply shape, idle/completion semantics, usage reporting, resumption and compression
   support. No blind model-string substitution; unsupported fields are never cast away. The
   boundary is data + a typed adapter, not `if (model.includes('thinking'))`.
2. **Requested vs actual identity.** Outbound configuration is captured **redacted** (no keys) and
   the provider's acknowledgement/usage records the **actual** model/effort. Never infer identity
   from the model saying its name.
3. **ET semantics honestly handled.** ET-arm idle/interaction-status semantics must not let a
   premature `idle` retire a proposal or stop listening; standard gets no unsupported thinking
   option; ET gets only supported values and no unsupported scheduling.
4. **Late asynchronous tool calls.** Tests for a tool call arriving after `turnComplete`, continued
   background work, duplicate callbacks, cancellation and reconnect — each mapped to the **same
   logical host operations** for both arms. No arm-specific privileges, sidecars or approval
   bypasses; an arm unable to satisfy the mapping is recorded unsupported (never auto-substituted).
5. **Prompts identical in intent and content** across arms; any unavoidable profile-specific
   instruction is recorded (it weakens a pure model-only comparison and must be named).
6. **Real bounded capability probe per arm**, disposable only: connect, send a minimal exchange,
   record setup time, the provider's acknowledgement/usage, and the redacted outbound config.
   These are the programme's first real provider calls — count and record them; they are inside the
   owner-approved §10 budget.
7. **Selection + reporting contract for the campaign runner (J):** expose the active arm through a
   single documented env/config key (e.g. `VOICE_LIVE_PROFILE=standard|et-high`), and report the
   active profile + resolved model in an existing or additively-extended capability/health surface
   so the runner can verify which arm actually ran. Record the exact key/values in your handback —
   this is J's integration contract.

## Gate G4a — must pass, paste exact commands and exit statuses

```
cd /root/pi-web-ui-wt-voice-provider
npm test --workspace=server -- tests/unit/voice
npm run typecheck
npm run lint
npx tsx <your probe script> --profile standard     # real call; paste redacted evidence
npx tsx <your probe script> --profile et-high      # real call; paste redacted evidence
```
Also required in the handback: RED evidence per behaviour, the late/duplicate/cancel/reconnect test
results, the two real probe transcripts (redacted), and the J-selection contract.

## Owned paths — nothing else may be modified

- `server/src/voice/**`
- `server/tests/unit/voice/**`
- a probe script under `scripts/voice-live-lab/**` **only** if the existing server probe cannot carry
  the arm selection; say so in the handback

## NO-TOUCH — do not modify, do not run `git add` on

- `server/src/talker/**`, `server/src/websocket/**`
- `client/**`, `scripts/**` (except the probe exception above), `shared/**`
- `package.json` / workspace manifests
- `server/tests/unit/pi-ai/**` (another lineage)
- `/root/pi-web-ui` (the main checkout) — READ-ONLY to you

If a needed change falls outside owned paths, write the exact request to
`/root/voice-native-20260922/coordination/P/NN-questions.md` and continue with the rest.

## How to work

- **TDD, RED first** for every behaviour; paste failing output.
- Keep the diff minimal and path-limited; do not refactor unrelated code, do not reformat.
- Worktree `node_modules` is symlinked from the main checkout on purpose; do not run `npm install`.
- Commit on your branch with clear messages. **DO NOT PUSH. DO NOT MERGE.**
- Never restart, deploy or validate against production. Disposable servers only, with owned
  `mkdtemp` state and verified teardown.
- Budget: keep real calls minimal (a handful per arm). If a call fails twice with the same
  mechanism, diagnose — do not loop.

## Handback — write ONCE at the end

Write `/root/voice-native-20260922/coordination/P/complete.md`, beginning with `FROZEN`,
containing: what changed (file paths), RED evidence verbatim, green evidence, exact commands +
exit statuses, the real probe evidence (redacted), the J-selection contract, what you deliberately
did **not** do, and uncertainty. Also write `complete.json` with
`{status, files, gates:[{command,exit}], red:[{case,evidence}], selectionContract, uncertainties:[]}`.

## Questions — the bar is high

Write `/root/voice-native-20260922/coordination/P/NN-questions.md` (or `NN-blocked.md`) and **end
your turn immediately**; also print the standalone line `PARENT-INPUT-NEEDED` last. Never wait,
never poll, never hold your turn open. Ask only about: a contradiction or impossibility in these
instructions; an authority or scope boundary you cannot cross; something irreversible; a premise
that turned out to be false. Everything below that line is yours to decide, record and move on with.
