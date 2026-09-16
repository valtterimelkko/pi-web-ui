# Parent verification and deployment record — injection marking

**Author:** parent orchestrator session `01a0a978` (bare Pi CLI). **Date:** 2026-09-16.
**Child:** session `01a0aa8f` (`zai/glm-5.3-flash`, goal-armed). Its own handback is
`complete.md` in this directory; **this file is the parent's independent verification and the
ship decision** — the child's report was not taken at face value.

## Verdict

**ACCEPTED and shipped.** The marking is correct, structurally matched, and the exclusion is
confined to the talker's spoken context. Every material claim below was re-derived by the parent
from the raw artefacts or by re-running the tests; three defects the child's own report did not
surface were found and fixed.

## Independent verification (parent-performed)

| # | Claim | How the parent checked it | Result |
|---|---|---|---|
| 1 | Capture prompt flips `user` → `custom` with identical wording | Parsed `evidence/{legacy,marked}/*-message-starts.json` directly | LEGACY idx 5 `role:"user"`; MARKED idx 6 `role:"custom", customType:"agent-os-capture"`; same wording. Packet lane `custom agent-os` inside the turn in both |
| 2 | The operator's bug reproduced, then fixed | Counted and read the `talker_digest` frames in `evidence/browser-{legacy,marked}/*-ws-sent.json` | LEGACY **2** requests (2nd = "Agent OS capture comp…"), MARKED **1** (the work) |
| 3 | The routine capture still happens | Read `evidence/journal-{legacy,marked}.jsonl` | `agent_end … outcome:"delivered"` in both legs, then `skip:already-fired` — once-per-session guard intact |
| 4 | Session view loses only the capture wording | Counted occurrences in `evidence/{legacy,marked}/*-screen.json` | LEGACY 2 → MARKED 0 |
| 5 | New tests pass | Re-ran them | client 24/24, server pins 5/5, extension 7/7 |
| 6 | Tests actually pin the behaviour | **Mutation check:** neutered `isAgentOsCaptureInjection` → re-ran | 6 of the new tests failed; file restored, tree clean |
| 7 | Operator prompts can never be injections | Read the pinned tests in both suites | Client + server both pin the verbatim-quote case; predicate is `role === 'custom' && customType === 'agent-os-capture'` |
| 8 | The one extension failure is pre-existing | Ran `tests/pi-extension-api-compat.test.mjs` on the **pristine base** `f4ed617` | Fails identically there: `deployed missing: /root/.pi/agent/extensions/clinepass/index.ts` — host state, unrelated |
| 9 | Type widening is type-only | Read the `TreeView`/`useSessionStream`/`messageAdapter` hunks | Union widened + additive `customType` passthrough; no rendering change |
| 10 | Host left clean | symlink target, `injmark-*` units, ports, production state | Symlink restored; **two leaked `injmark-client-3541/3542` scopes were still running and were stopped by the parent**; no 35xx listeners remain |

## Defects found and fixed by the parent

1. **Unrelated local-install churn in the feature commit** — `package.json` `allowScripts` (host-pinned
   versions) + lockfile `hasInstallScript`. Dropped in `ac7a7f2`.
2. **An ESLint error in the new test file** (`no-unused-expressions` — a label written as a comma
   operand) which **would have failed CI**. Fixed in `daf3735`; lint 0 errors, ratchet no violations.
3. **Leaked disposable lab units** (`injmark-client-3541/3542` scopes) that the child's teardown
   reported as stopped but which were still active. Stopped by the parent.

## Ship state

- `pi-web-ui` master `daf3735` (merge `1ebd705`) — pushed. `pi-enhancement` master `ebd7ee4` — pushed.
- Post-merge gates on the merged tree: docs check pass, typecheck clean, lint 0 errors, **6,186 tests
  green** (server 4,503 · client 1,394 · shared 218 · mcp 71).
- **No production restart was performed, deliberately.** The merge contains **no server runtime
  change** (`git diff 4f6f825..HEAD -- server/src shared/src packages` is empty), so a restart could
  only have killed the operator's two live voice lanes for zero benefit. Production already serves the
  new client bundle from disk: `/assets/index-G9gjuXgi.js` returned HTTP 200 with a sha256 identical
  to the freshly built file and contains the `agent-os-capture` marker. `prod-smoke` pass (200, React
  mounted, login screen, no page errors). Production uptime and `NRestarts=0` are unchanged.
- **Emitter activation proven on the host**, not just in a worktree: a fresh `pi` run driven by the
  parent wrote a session entry `custom_message { customType: "agent-os-capture", display: false }`
  carrying the identical capture wording, with **no** user-shaped capture message anywhere.
- Child session never touched production, merged, or restarted anything; its kill-switch legs were
  disposable servers with isolated journals and a disposable Agent OS vault.

## Residual, intentional and honestly stated

- **The one visible change:** the capture prompt no longer renders as a user bubble in the web UI
  session view (every projection drops `role:'custom'` by construction). It still reaches the model,
  still lives in the session file, and the assistant's answer about the capture still appears. Raised
  with the operator as a yes/no (hide it vs. render a subtle housekeeping line); default if silent:
  hide it. A request for a visible housekeeping line is a small follow-up, not a defect.
- An already-open browser tab keeps its older bundle until reload; new page loads get the fix.
- The DOM-level Voice Mode pane check in the child's evidence is weak evidence (virtualized list), and
  is labelled as such in its own README; the authoritative session-view proof is the projection
  comparison plus the unit pins, both of which the parent re-verified.
- Cleanup: both worktrees removed, both `task/*` branches deleted (ancestors verified), the disposable
  lab and coordination directories purged.
