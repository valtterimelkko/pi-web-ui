FROZEN — W-B: card identity + variant gate + contract 1.44.0

Session: 01a0a543-2fac-7451-bac8-3ca063b63bd8 · Worktree /root/pi-web-ui-wt-card (branch `task/card-identity`, base = task/multi-lane HEAD 56d7d33)
Commits (server and client deliberately separate — the server fix can go to master alone):
- `8c5e196` talker-card: proposal identity + staleness/original-variant release gates (contract 1.44.0) — server + contract + server tests
- `a0ac7dd` talker-card: the card echoes the identity of the bytes it displays (client half) — client + client tests
No merge, no push, no production restart, no writes to /root/agent-os. /root/pi-web-ui touched only in operations/change-requests-20260915/exec-2026-09-15/ (harness, evidence, logs, this handback) — untracked by design.

## 1. What changed (file:line, worktree paths relative to /root/pi-web-ui-wt-card)

Server half:
- `server/src/talker/pending-proposal.ts`
  - :107–141 `ProposalDescriptor.hash` (new field) + `ProposalIdentity {version, hash}` + `proposalHash()` — deterministic SHA-256 over the exact release bytes (tidied text + NUL + original-when-present). Pure, one source of truth.
  - :195–199 `describeProposal()` now always stamps `hash` (covers the original bytes too, so a tidied draft never shares an identity with its clean twin).
  - :299, :374–389 store-level version counter `nextProposalVersion`, bumped and stamped on every draft mutation (`appendToDraft`, both branches) and on partial (selection) consume (:498).
  - :400–417 `describeCurrentProposal()` (descriptor + version; null when nothing held) and `identityMatches(echo)` (BOTH halves must match: hash alone would pass a cancel-then-retype of identical words; version alone would pass a partial release that left different bytes on the card).
- `server/src/talker/talker.ts`
  - :151–168 mechanical refusal replies `staleProposalReply` / `originalNotOfferedReply` (fixed strings quoting the CURRENT draft text — model never composes them).
  - :355–377 confirm branch, AFTER the existing lapsed-window gate and BEFORE the ambiguous-selection gate: (1) echoed `proposalRef` that no longer matches `identityMatches()` → refuse: nothing released, draft untouched, reply "That card is out of date …", history 'mechanical', modelCalled false — the same refusal class as lapsed/ambiguous/empty; (2) `releaseVariant:'original'` refused unless the CURRENT descriptor advertises `original` (visible removal). A bare spoken "yes" carries no echo and keeps today's semantics; the lapsed window still runs first.
- `server/src/talker/session-registry.ts` :108, :352 — `TalkerOperatorTurnInput.proposalRef` passthrough (no capability added).
- `server/src/websocket/protocol.ts` :462–476 `TalkerTurnMessage.proposalRef` (+ doc), :505–519 `proposal` result gains `version`/`hash`, :540–556 `isProposalRef` structural guard (malformed ref fails the schema, never coerced).
- `server/src/websocket/connection.ts` :4196–4201 forwards `proposalRef`; :4211–4239 card payload now built via `describeCurrentProposal()` (identity included; the old snapshotDraft+describeProposal two-step replaced — `describeProposal` import removed).
- `server/src/internal-api/types.ts` :75 `INTERNAL_API_CONTRACT_VERSION = '1.44.0'`.

Client half:
- `client/src/lib/talkerBus.ts` :47–65 `proposal` mirror gains `version`/`hash` (lane correlation logic untouched — acceptance/ordering/rejection code is byte-for-byte the lane work's).
- `client/src/hooks/useTalkerTurn.ts` :49, :107 `SendTalkerTurnInput.proposalRef` passed through to the wire verbatim.
- `client/src/components/DriveMode/useVoiceTurn.ts` :99–117 `PendingProposal.version/hash`; :127–148 `proposalFromResult` parses them defensively (junk ignored, old server → absent); :256–281 `attemptSend` opts carry variant+ref; :385–409 `identityEcho()` — Confirm and "Send my exact words" echo the displayed identity; no identity (old server) → no echo, byte-identical behaviour. The stale refusal arrives as this lane's own `proposed` result with the CURRENT text + fresh identity, so the existing effect re-shows the card.
- `client/src/components/DriveMode/ConfirmationCard.tsx` :47–54, :78–89 optional `version`/`hash` props rendered as `data-proposal-version` / `data-proposal-hash` (observable; the echo stays the hook's job).
- `client/src/components/DriveMode/DriveModeDictate.tsx` :426–437 passes version/hash to the card.
- `docs/INTERNAL-API-CONTRACT.md` :24 example `"contractVersion": "1.44.0"`, :36–44 the 1.44.0 changelog entry (what changed, consumer guidance, rollback).

## 2. RED then GREEN per case

New server file `server/tests/unit/talker/proposal-identity.test.ts` (16 tests). RED state before implementation: 15 failed / 1 passed (the passing one was the bare-voice sanity anchor — existing behaviour). GREEN after implementation: 16/16.
- append-after-render → refused, nothing released, draft intact, reply quotes current text; fresh echo then releases both parts. (RED: `describeCurrentProposal is not a function`.)
- proposal replaced (cancel + identical retype): same hash, different version → still refused. (RED: same.)
- proposal cancelled → confirm on the dead card = NOTHING_PENDING_ACK dead end, no release.
- second confirm after a successful release → NOTHING_PENDING_ACK, delivery saw the text exactly once.
- cross-lane/foreign mutation with both-half mismatches: wrong hash (right version) refuses; wrong version (right hash) refuses; draft survives both probes.
- matching echo releases exactly the displayed bytes (the whole point).
- `original` gate: clean draft + variant original (fresh identity) → refused, draft intact, ordinary confirm still releases; tidied draft + variant original → releases the exact raw bytes; STALE identity + variant original on a now-clean draft → refused (gate reads the CURRENT proposal, not the echoed one); variant original with NO echo on a clean draft → refused.
- voice path untouched: bare confirm releases as before; lapsed-window refusal still runs FIRST and is unchanged; after re-arm the fresh identity releases.

Wire tests appended to `server/tests/unit/websocket/talker-transport.test.ts` (the P27 wire-row area — the wire genuinely changed, so amendment is justified; the existing D1 rows were NOT edited, only the new D-card block added). RED before the protocol/registry/connection changes: 3 failed / 1 passed — "carries version+hash" (wire had none), "stale echo refuses" (no proposalRef support), "malformed proposalRef" (no guard). The fourth (original gate) already passed pre-wire because the talker gate was in and an undefined echo tripped the identity check — it pins the true post-wire behaviour now (real identity + variant original on a clean draft → variant gate refuses). GREEN: 25/25 in the file.

Store-descriptor amendments `server/tests/unit/talker/pending-proposal.test.ts`: the three R1–R5 `toEqual` rows amended for the new `hash` field (`expect.any(String)`) plus one new assertion (tidied draft's hash ≠ its clean twin's). These were the only existing-test breaks; the rest of the 4,450-test server suite needed nothing.

Client tests (RED first):
- `client/tests/unit/components/DriveMode/useVoiceTurn.test.tsx` new D-card block (5 tests): RED 3/5 (confirm echo, original echo, stale-refusal re-show all failed because `useTalkerTurn` did not forward `proposalRef` — the RED run caught the real gap; the fix was the :107 passthrough). The other two (old server sends NO proposalRef; junk identity fields ignored) passed immediately as behaviour anchors. GREEN 5/5.
- `client/tests/unit/components/DriveMode/ConfirmationCard.test.tsx` D-card block (2 tests): RED 1/2 (identity attributes missing); GREEN 2/2.

## 3. The exact contract change (1.43.0 → 1.44.0, minor, additive)

- `talker_turn` (browser→server) gains optional `proposalRef: { version: number; hash: string }` — the identity of the proposal the confirming card displayed. Bare spoken confirms omit it and behave exactly as before; a malformed ref fails the message schema (`INVALID_MESSAGE`), never coerced.
- `talker_turn_result.proposal` (only on `phase === 'proposed'`) gains `version` (monotonic per-draft counter, bumped on every draft mutation incl. partial/selection consume) and `hash` (SHA-256 over the exact release bytes: tidied text + NUL + original-when-present).
- Behaviour: a confirm whose echoed identity no longer matches the current proposal refuses mechanically — nothing released, draft untouched, spoken refusal quotes the current text, and the result carries a fresh `proposal` payload so the card re-shows what is really held. `releaseVariant:'original'` is refused unless the CURRENT proposal advertises an `original`. Both refusals are fixed-vocabulary, model-free.
- Drift guard `server/tests/unit/internal-api/contract-version-drift.test.ts` green; the deliberate version pins in `server/tests/unit/command-code/command-code-contract.test.ts:21` and `server/tests/unit/internal-api/capabilities.test.ts:68` were amended to 1.44.0 (that is the bump being felt where those tests say it should be).
- Rollback: revert the server — identity fields disappear, every client keeps working, pre-1.44.0 staleness exposure restored. Documented in the changelog entry.

## 4. Browser harness — command + observed result

File: `operations/change-requests-20260915/exec-2026-09-15/harness-card-identity.mjs`
Command: `bash /tmp/card-boot.sh server` then `bash /tmp/card-boot.sh client` (systemd-run `--scope --collect` units `cardid-server` / `cardid-client`, outside the production cgroup; server on port 3591 + socket /tmp/card-srv, vite dev client on 3599 proxying to it, both from the wt-card worktree; Chromium fake media devices), then:
`cd /root/pi-web-ui && node operations/change-requests-20260915/exec-2026-09-15/harness-card-identity.mjs`
Observed: **ALL VERDICTS PASS, exit 0 — twice consecutively.** Eight verdicts over the four paths, evidence in `exec-2026-09-15/card-evidence/` (card-identity-run1.json, card-identity-run2.json, 8 screenshots):
- A propose→inspect→confirm: identity on card === wire payload (v3); released `"hold phase 3 for review"` === displayed bytes.
- B propose→cancel: card cancelled after displaying `"deploy the fix to staging now"`; release count unchanged.
- C propose→STALE confirm: a second authenticated WebSocket (runtime 'claude' — the foreign writer must name the runtime, else the server defaults to 'pi' and keys a different draft) appends to the SAME draft; the card stayed at v5 (the foreign result goes only to the foreign socket — the card cannot learn of it); Confirm refused: `released: null`, spoken "That card is out of date — the wording has changed since it was shown, so I sent nothing. Here is what I am holding now: …", and the card re-showed the CURRENT joined text under fresh identity v6; the fresh Confirm then released exactly the re-shown bytes.
- D propose→"Send my exact words": tidied card showed `"rerun the suite"` with original disclosed; released `"Um, tell the worker to rerun the suite"` === the displayed original bytes, identity v7 echoed with variant 'original'.
All released bytes were read from the wire tap (the server's own `talker_turn_result` payloads), never from component state. Harness quirks documented in the file header: pi delivery awaits the worker's ENTIRE agent turn (minutes with a real model) so the worker session is claude-runtime — every card-relevant step stays real while the delivery itself refuses fast (no SDK backend on the validation server); the bootstrap propose uses a scripted dictation /finish response (capture+STT not under test); everything from transcript to release is the real product path.

## 5. Gates — exact commands and exit statuses

- `npm test --workspace=client` → exit 0 — 126 files, **1349/1349 passed**.
- `npm test --workspace=server` → exit 1 as-is: 4 failures in 2 files (`pi-max-sessions` 1, `opencode-service-expanded` 3) — verified pre-existing on the base commit via `git stash` (identical failures, machine env sets `PI_MAX_SESSIONS=20` and `OPENCODE_ENABLED=false`). With those inherited env vars unset: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED npm test --workspace=server` → **exit 0, 385 files, 4450 passed / 2 skipped**.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0 (0 errors, 304 pre-existing warnings).
- `npm run build` → exit 0.
- Harness → exit 0 (both runs). No `npm install` was run.

## 6. Deliberately not done

- No merge / push / production restart / production validation — disposable server only (validation-server cgroup guard respected; boot via systemd-run scope units, now stopped and reset-failed).
- No writes to `/root/agent-os` (conductor owns the mirror resync of contract 1.44.0); `/root/pi-web-ui`, `/root/pi-web-ui-wt-restart`, `/root/pi-web-ui-wt-lanes` untouched except the exec-dir handback/evidence/log files.
- The lane surface (`LaneStrip.tsx`, `voiceLanes.ts`, `driveModeStore.ts`) untouched — no test required it. `talkerBus.ts`/`useTalkerTurn.ts` carry only additive fields; the lane acceptance/ordering/rejection logic is byte-for-byte as the lane work left it.
- No upstream issues/PRs filed.

## 7. Lane regression net

- Unit-level: the full lane suite passes in this tree — `voiceLanes`, `voiceFloor`, `LaneStrip`, `DriveModeDictate.lanes/.single-lane/.speech-dedup/.stop-talker/.whole-turn`, `DriveModeOverlay.lanes`, `readingLevel.lanes`, `voiceLayout*` — inside the 1349/1349 client run.
- Browser-level: the 14/14 real-browser lane verdicts belong to the lanes child's own harness/environment (ports since stopped, worktree read-only to me); I did not re-run it. Fresh real-browser evidence from THIS branch: my harness drove the real Voice Mode surface end-to-end (login, session binding, Voice Mode entry with collapsed single-lane strip, real capture via fake media, real dictation, card flows, speech tiers) — no lane-surface regression observed.

## 8. Residual risk

- Bare spoken "yes" (no echo — voice confirmations without the card) keeps its pre-existing exposure: it releases the current draft, guarded by the lapsed window but not by byte identity. That is unchanged semantics by design; the card gestures are the precise path.
- The identity hash is content-only (SHA-256 of release bytes) paired with the version counter; a hash collision would additionally require a version match to release, so the residual risk is negligible.
- Harness evidence uses claude-runtime workers because the pi relay legitimately blocks on the worker's full agent turn (minutes); if the conductor wants a pi-relay browser run too, it needs a fast worker turn or the null delivery wired into the validation server.
- The dictation `/finish` interception and the typed fallback bootstrap mean the STT path is not exercised by this harness (out of scope for the card item; covered by the child-voice work).
- 4 pre-existing server test failures under the host's inherited env (`PI_MAX_SESSIONS`, `OPENCODE_ENABLED`) remain somebody's cleanup; not owned by this item.
