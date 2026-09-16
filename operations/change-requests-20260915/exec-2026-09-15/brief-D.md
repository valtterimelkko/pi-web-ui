You are the SOLE WRITER in the isolated git worktree **/root/pi-web-ui-wt-card** (branch `task/card-identity`). Your session id is {{SID}}. Do all work in that worktree.

**Branch base — read this carefully.** You are stacked on `task/multi-lane` (HEAD `56d7d33`), which contains verified multi-lane Voice Mode work: lane correlation through `talkerBus`/`useTalkerTurn`, a lane floor coordinator, and a lane strip. That work is SETTLED and independently verified (14/14 real-browser verdicts). **You must not regress it** — its tests are your regression net.

## Why this exists (the defect)
The card's promise is "this is the exact text that will be sent to the worker". Today the confirm gesture sends a generic `yes`, and the server releases **whatever the draft holds at that moment** — there is no proposal identity linking the confirmation to the text that was displayed. If the draft changes between render and confirm (the operator speaks again, another lane or tab mutates it), the released bytes differ from what was approved. An independent reviewer called this **critical**. The `original` release variant has a second, related hole: it is only enum-validated, so a stale or buggy client can release raw text the card never offered.

## The outcome that must be true when you are done
1. **Proposal identity.** The `proposed` payload carries an identity for the exact bytes displayed (a version counter and/or a content hash — your choice, but it must be stable and comparable). The card displays from that identity and echoes it on confirm.
2. **Staleness refusal.** On confirm, if the echoed identity no longer matches the current proposal, **refuse**: surface it honestly ("that card is out of date — here is the current text"), release nothing, and do **not** consume the draft. Route it through the same mechanical refusal path as the existing lapsed/ambiguous/empty refusals — never a silent substitution.
3. **`original` variant gate.** `releaseVariant: 'original'` is refused unless the current proposal's descriptor actually advertised an `original` (i.e. a visible removal happened). Same mechanical refusal path.
4. **Contract 1.44.0.** This changes the wire shape on both sides. Bump `INTERNAL_API_CONTRACT_VERSION` in `server/src/internal-api/types.ts` from `1.43.0` to **`1.44.0`**, add the changelog entry to `docs/INTERNAL-API-CONTRACT.md` describing the change, how a consumer adapts and rollback, and keep the drift guard green (`server/tests/unit/internal-api/contract-version-drift.test.ts` enforces constant ⇄ changelog ⇄ published example). **Do NOT touch `/root/agent-os`** — the conductor owns that mirror resync.
5. **Browser harness.** Build it (see below) and make it pass.

## Where (verify every pointer yourself before editing)
- Server: `server/src/talker/pending-proposal.ts` (`describeProposal`, `takeForRelease`), `server/src/websocket/protocol.ts` (the `proposed` message and the confirm message schemas), `server/src/websocket/connection.ts` (the operator-turn handler, ≈ lines 4231–4236 build the card payload from `describeProposal`).
- Client: `client/src/components/DriveMode/ConfirmationCard.tsx` (render + the confirm/variant gestures), `client/src/components/DriveMode/useVoiceTurn.ts`, `client/src/hooks/useTalkerTurn.ts`, `client/src/lib/talkerBus.ts`. **Those last three were changed by the lane work — read the current code before editing; the correlation rules there are load-bearing.**
- Tests: `server/tests/unit/talker/**`, `server/tests/unit/internal-api/**`, `client/tests/unit/components/DriveMode/**`.

## Required test cases (TDD, RED first — a test that never failed proves nothing)
Write these as unit-level server cases; they are the point of the item: append-after-render, proposal replaced, proposal cancelled, second confirm after a successful release, and a foreign/cross-lane mutation. Plus: an `original` confirm when no original was advertised (must refuse), and one when it was (must serve the original). Amend the P27 wire-row test only if the wire genuinely changed — it pins the card contract, not its absence.

## The browser harness (this is the W-F(ii) deliverable)
Build a small Playwright-driven harness that drives the **real card** against a **disposable validation server** you start yourself (`npm run validate:server -- --dir <tmp> --port <port>`, run under `systemd-run --scope --collect` so it lives outside the production cgroup), with Chromium's fake media devices. Reuse the patterns already in `/root/pi-web-ui/operations/change-requests-20260915/child-voice/harness/` (read `two-tab-repro-v2.mjs` and `one-tab-lanes.mjs` — they wrap `getUserMedia`/`MediaRecorder`/dictation fetch observationally). Paths to cover: propose → inspect → confirm; propose → cancel; propose → **stale** confirm (must refuse and re-show the current text); propose → "Send my exact words" (must send the raw bytes).
**The assertion that matters: the bytes released equal the bytes the card displayed, for every path** — read the released bytes from the transcript or the talker/relay record, not from component state. Put the harness in `operations/change-requests-20260915/exec-2026-09-15/harness-card-identity.mjs` (that directory is untracked by design).

## Commit structure — required
Keep **server-side changes in their own commits, separate from client-side changes**. The owner may want to take the server-side fix alone onto master, and a stacked branch must not make the critical fix hostage to the client work.

## Gates — all must pass, paste exact commands and exit statuses
```
cd /root/pi-web-ui-wt-card
npm test --workspace=server
npm test --workspace=client
npm run typecheck
npm run lint
npm run build
```
and the harness command + its observed result. Do NOT run `npm install` (node_modules is symlinked). On a `node_modules/.vite` cache error, retry once then use `--no-cache`.

## Invariants and off limits
- **No merge, no push, no production restart, never validate against production.** Your disposable server only.
- `/root/pi-web-ui`, `/root/pi-web-ui-wt-restart`, `/root/pi-web-ui-wt-lanes` and `/root/agent-os` are all READ-ONLY to you. Do not write to `/root/agent-os` at all.
- Owned paths: `server/src/talker/**`, `server/src/websocket/protocol.ts`, `server/src/websocket/connection.ts`, `server/src/internal-api/types.ts`, `docs/INTERNAL-API-CONTRACT.md`, `client/src/components/DriveMode/ConfirmationCard.tsx`, `client/src/components/DriveMode/useVoiceTurn.ts`, `client/src/hooks/useTalkerTurn.ts`, `client/src/lib/talkerBus.ts`, `server/tests/**`, `client/tests/**`, `package.json` (only if a script is genuinely needed), and the harness file above.
- Do not touch the lane surface itself (`LaneStrip.tsx`, `voiceLanes.ts`, `driveModeStore.ts` lane state) unless a test proves it necessary — if it does, say so loudly in the handback.

## Coordination
- **Handback:** write ONCE at the end to `/root/pi-web-ui/operations/change-requests-20260915/exec-2026-09-15/D-card-complete.md`, beginning `FROZEN`, with: what changed (file:line), RED then green evidence per case, the exact contract change, the harness command + observed result, commands + exit statuses, what you deliberately did not do, and residual risk.
- **Questions:** write `.../D-card-questions.md` and **end your turn immediately**. Never wait or poll. Ask only for a contradiction, an authority/scope boundary, something irreversible, or a false premise.
- Optionally: `npm --prefix /root/agent-os run agent-os -- board declare --join-session {{SID}} --task "W-B: card identity + variant gate + contract 1.44.0" --repo /root/pi-web-ui-wt-card`.

This session runs under a **goal engine**: the objective is your durable aim. Keep working until it is true, then stop.
