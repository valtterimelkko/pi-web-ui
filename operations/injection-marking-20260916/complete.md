# Injection marking — COMPLETE (2026-09-16)

Child session `01a0aa8f-6aeb-77eb-8ae8-7fdda68ad7dc`, goal-armed. Contract:
`BRIEF.md` (this directory). Plan: `PLAN.md`. Evidence: `evidence/` (see its
README for the file-by-file proof index).

## Outcome

Routine Agent OS injections are **structurally marked at the emitter**, and
**only** those marked injections are excluded from the talker's spoken context.
Every other consumer is unchanged, proven by tests and disposable-server live
validation. Self-reported (no independent verification command configured); the
parent can re-verify every claim with the commands below.

## What changed

### Repo 1 — `/root/pi-enhancement-wt-inject` (branch `task/capture-marking`), commit **`5c67c9d`**

- The session-end capture prompt is delivered via `pi.sendMessage` with
  `customType: 'agent-os-capture'`, `display: false`, options
  `{ deliverAs: 'followUp', triggerTurn: true }` — content byte-identical to
  the legacy framed prompt; the model sees exactly what it saw before.
- It is deliberately NOT the packet lane's `'agent-os'` type: packet/workset
  injections ride `before_agent_start` INSIDE the operator's turn (verified in
  pi's `agent-session.js` + live wire evidence, evidence index 1 in both
  legs); the capture prompt triggers its own turn — only it may bound a
  spoken turn downstream.
- Fail-open ladder: marked channel → legacy `sendUserMessage` lane (also on a
  throwing marked channel or the kill switch) → honest `false` so the emitter
  logs `no-channel` (previously it could claim a delivery that never happened;
  no existing test relied on that).
- Kill switch `AGENT_OS_INJECT_CAPTURE_MARKING=0|false|no`
  (`coordinationConfigFromEnv` semantics), read per delivery from the injected
  env, so an owner can retire the mark without reloading the session.
- Tests: `tests/agent-os-inject-capture-marking.test.mjs` (7 cases, TDD RED
  first). Full extension suite: **429/430** — the single failure
  (`tests/pi-extension-api-compat.test.mjs`) is a pre-existing host-state
  check (`/root/.pi/agent/extensions/clinepass/index.ts` missing) that fails
  identically on the clean base commit `f4ed617` (verified via `git stash`).

### Repo 2 — `/root/pi-web-ui-wt-inject` (branch `task/injection-marking`), commit **`f596f07`**

- `useAnswerReader.getTurnAssistantParts`: assistant output more recent than
  the last marked capture injection (with no operator message after it) is
  housekeeping and is never the spoken turn; the operator's work between their
  words and the injection still is. The match is STRUCTURAL (`role === 'custom'`
  + `customType === 'agent-os-capture'`, exported as
  `isAgentOsCaptureInjection`/`AGENT_OS_CAPTURE_CUSTOM_TYPE`) — never textual.
- `sessionStore` carries `role: 'custom'` + `customType` through every
  Message-building path (live `message_start`, multi-session `session_event`,
  folded history replay). `LiveMessage`/`messageAdapter`/`TreeEntry` unions
  widened — type-honesty only (custom messages have arrived at runtime for
  weeks via the packet lane); rendered projections already filtered custom by
  role and are untouched.
- Server-side projections (talker `toHistoryEntries`, session-switch
  `parsePiSessionHistory`, shared screen view) drop custom entries BY
  CONSTRUCTION — pinned, not changed, by
  `server/tests/unit/talker/injection-marking-projections.test.ts`.
- Full suite after: **all workspaces green** — 4,503 client + 1,394 server +
  218 shared + 71 MCP tests, 0 failures, 2 pre-existing skips.

## Regression proof (brief §C)

1. **No-injection sessions**: no projection code changed; the server pin test
   asserts the talker prompt, session-switch replay and screen projection are
   unchanged for injection-free message lists, and the full suites pass
   unchanged (only additive tests added).
2. **Injection sessions — the only enumerated differences**:
   a. The injection's own rendering: previously a user bubble (live + replay +
      screen view); now a custom entry that every existing projection drops.
      Live: `legacy-screen.json` has the capture wording as a user item
      (`=1`), `marked-screen.json` does not (`=0`); full/history likewise.
   b. The talker's spoken turn: browser Drive Mode digests — LEGACY sent TWO
      `talker_digest` requests (work answer + capture housekeeping, i.e. the
      operator's bug reproduced live); MARKED sent ONE (work answer only).
   Nothing else differs in kind or order on the wire or in any projection.
3. **Verbatim-quote guarantee (structural, never textual)** — unit-tested on
   both sides: an operator USER prompt quoting the capture wording verbatim is
   never an injection (client `turnAssistantParts.test.ts` +
   server `injection-marking-projections.test.ts`); it is still shown, still
   part of the talker prompt, still counted.

## Live validation (brief §D) — disposable only

Two same-build disposable legs differing ONLY in the kill-switch env; the
extension symlink flip to the worktree build was scoped to MARKED session
creation and restored immediately (original target recorded, restored, and
verified: `/root/pi-enhancement/agent-os-inject`). The REAL `agent-os` verb ran
with `AGENT_OS_VAULT_ROOT` pointed at a disposable vault (real decision logic,
real canonical prompt, zero operator-vault writes). Journals confirm
`capture-prompt outcome=delivered` in BOTH legs — the routine capture keeps
happening exactly as today — followed by `skip:already-fired`.

Key live evidence (commands embedded in `evidence/*.sh|*.mjs`):

- Wire: `evidence/legacy/legacy-message-starts.json` (capture = `role:"user"`,
  index 5) vs `evidence/marked/marked-message-starts.json`
  (`role:"custom", customType:"agent-os-capture"`, index 6).
- Spoken context: `evidence/browser-legacy/legacy-ws-sent.json` (2 digest
  requests; the second is the housekeeping) vs
  `evidence/browser-marked/marked-ws-sent.json` (1 digest request; work only).
- Projections: `*-screen.json` / `*-full.json` / `*-history.json` pairs.
- Journals: `evidence/journal-{legacy,marked}.jsonl`.

Re-run path: `evidence/boot-ab.sh legacy|marked` →
`evidence/flip-symlink.sh worktree` → `evidence/drive-session.mjs` /
`evidence/browser-drive.mjs` → `evidence/flip-symlink.sh restore`. Exact
commands with exit codes are recorded in `/tmp/injection-marking-coord/03-complete.md`.

## Proven vs inferred

- **Proven** (wire/projection/browser/journal evidence + tests): the marking
  shape on the wire and in the session file; capture delivery and once-per-
  session guard unchanged; capture wording rendered as a user item only under
  LEGACY; spoken digest receives the housekeeping only under LEGACY;
  projections identical for all non-injection content; structural (non-textual)
  matching; kill switch restores legacy behaviour byte-for-byte; real model
  turns (zai/glm-5.3-flash on the wire legs; openai-codex/gpt-5.6-luna in the
  browser legs — the picker's kimi-for-coding quota was exhausted, verified).
- **Inferred** (argued, not separately exercised): the Voice Mode side pane is
  the same `VirtualizedMessageList` component as the chat view (code-identical
  path; its DOM dumps show worker answers in both legs, but the virtualized
  list makes DOM absence non-evidentiary, so the authoritative session-view
  proof is the screen projection). Session search and transfer were not
  separately exercised: search operates on the client messages array (whose
  custom handling is unchanged) and transfer on the same session-file
  projections; no code path touching them changed.

## Not done (parent's call by contract)

- No merge to master, no deploy, no restart of `pi-web-ui.service`, no changes
  to the live extension symlink beyond the recorded reversible flip (restored;
  verified). Worktrees `task/capture-marking` (pi-enhancement) and
  `task/injection-marking` (pi-web-ui) hold the commits, pushed for review.
- One environment note: `package.json` in the web-ui worktree gained the
  `allowScripts` block that this worktree's `npm install` needed (esbuild,
  bcrypt, better-sqlite3, node-pty, protobufjs, @google/genai); committed with
  f596f07 so the parent's re-verification install works.
