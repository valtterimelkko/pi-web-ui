# Plan: Wire Claude Code's **native `/goal`** feature into the Pi Web UI (Claude runtime path)

> **Status:** Proposed / not started. Investigation complete; ready for an executing agent.
> **Author of plan:** Claude (Opus 4.8) investigation session, 2026-06-19.
> **Audience:** the agent that will implement this. Read this whole file first; it
> already contains the root-cause analysis, exact file/line anchors, the
> integration nuances, and a validated test harness recipe so you don't have to
> re-derive any of it.
>
> **Related prior work (already shipped on `master`):**
> - `94cd66c` — fix(opencode): route goal-engine UI events so the live goal tag shows
> - `efd39cf` — feat(opencode): user-driven goal pause/resume/clear from the web UI
>
> Those two commits built the **OpenCode** goal experience (live chip + pause/resume/clear).
> This plan does the analogous thing for **Claude**, but with a crucial difference:
> **Claude Code has its own native goal feature — do NOT port the custom goal-engine
> plugin to Claude. Drive the native `/goal` command instead.**

---

## 1. Objective

Make the Claude Code runtime path in the Pi Web UI able to **start, observe, and stop
Claude's native autonomous "goal" mode** from the browser — so that typing
`/goal <condition>` (or using a UI control) in a Claude session actually activates
Claude Code's built-in goal loop, shows a live status chip, and can be cleared/stopped,
mirroring the OpenCode goal UX we already shipped.

---

## 2. Background — Claude Code's native goal feature (verified, not assumed)

Claude Code (verified on the installed build **2.1.183**, binary at
`/root/.local/share/claude/versions/2.1.183`) ships a **native goal feature**. This is
NOT the custom goal-engine plugin the user wrote for OpenCode/Pi — it is built into the
Claude Code CLI itself. Evidence (strings extracted from the binary):

- Slash command **`/goal <condition>`** — described as *"Set a goal Claude checks before stopping."*
- **`/goal`** / **`/goal active`** → shows `Goal active: …`
- **`/goal clear`** → *"/goal clear to stop early"*
- Lifecycle / status strings: `Goal set: `, `Goal cleared: `, `Goal achieved`,
  `Goal could not be achieved`, `No goal set`, `goal_status`, `goal-command-nudge`.
- Telemetry events: `tengu_goal_achieved`, `tengu_goal_failed`, `tengu_goal_restored_on_resume`.
- Resume support: `restoreGoalFromTranscript`, `goal_restored_on_resume`,
  `hasTerminalGoalSnapshot`.
- Non-interactive variant exists: `goalNonInteractive` (for `-p`/print mode; **not** used
  by the web UI, which drives interactive PTY).

**How it works mechanically:** the goal is enforced through Claude Code's **Stop hook**.
When Claude would stop, the goal machinery checks whether the goal condition is met; if
not, it injects a continuation nudge (`goal-command-nudge`) and Claude keeps working.
It loops until the goal is `achieved` or `could not be achieved`, or until `/goal clear`.

**Two hard preconditions** (both enforced by the CLI with explicit error strings):
1. **Trusted workspace** — *"/goal is only available in trusted workspaces. Restart, accept
   the trust dialog, and try again."*
2. **Hooks not restricted** — *"/goal can't run while hooks are restricted (disableAllHooks
   or allowManagedHooksOnly is set in settings or by policy)."*

> Implication: for Claude, the user does **not** need the custom goal-engine plugin. The
> native feature already provides the autonomous loop, achieved/failed detection, and
> resume survival. This plan only needs to *plumb the web UI into it*.

---

## 3. Root cause — why `/goal` currently does nothing in the web UI

Reproduced from a real session (web UI session `85e1f1ae-1b1d-4c05-8fc5-76b94d04a755`,
claudeSessionId `6fb19ed2-4d9e-403e-96e3-c157703707d2`, model sonnet, cwd `/root`). The
user typed `/goal do a mock, test task…`; Claude just performed the task in a single turn.
No `Goal set:` ever appeared in the channel output; no goal loop ran. Two reasons, both
confirmed in code + logs:

### 3a. (Primary) The web UI injects prompts via the MCP channel, NOT the PTY input line
Claude Code only parses slash commands typed into its **interactive TUI input**. The web
UI channel sends the user's prompt programmatically as an MCP channel message:

- `server/src/claude/claude-channel-service.ts` → `sendPrompt()` (~line 398): the prompt is
  delivered with `this.wsClient.send({ type: 'prompt', sessionId, content: prompt, cwd })`
  (~line 518–524). That arrives at Claude as a **user message**, so `/goal …` is treated as
  literal message text — Claude just "does the task."

By contrast, the **control** slash commands DO work, because the channel special-cases them
and writes them straight to the PTY with a carriage return:
- `server/src/claude/claude-channel-process-manager.ts`:
  - `switchModel()` (~line 308): `proc.write('/model ${model}\r')`
  - `setThinkingLevel()` (~line 317): `proc.write('/effort ${effort}\r')`
  - `clearContext()` (~line 346): `proc.write('/clear\r')`

`/goal` is simply not in that special-cased set. **That is the core gap.**

### 3b. (Secondary) The session's workspace was not trusted
`~/.claude.json` → `projects` shows `/root` → `hasTrustDialogAccepted=false` (whereas
`/root/pi-web-ui` → `true`). The reproduced session ran in cwd `/root`, so even if `/goal`
had reached the parser it would have hit the "trusted workspaces" gate.

Hooks are **not** restricted (the channel spawns without `--bare`; `~/.claude/settings.json`
sets neither `disableAllHooks` nor `allowManagedHooksOnly`), so precondition #2 is already
satisfied.

---

## 4. Goals / Non-goals

**Goals**
- Start Claude's native `/goal <condition>` from the web UI (control + intercepted typed `/goal`).
- Stop it (`/goal clear`) and show its state (`Goal active` / `achieved` / `cleared`).
- Reuse the existing goal chip UI where reasonable.
- Ensure the session workspace is trusted (precondition #1).
- Keep the autonomous continuation turns streaming to the browser (the hard part — §6.3).

**Non-goals**
- Do **not** port the custom goal-engine plugin to Claude. Use the native feature.
- Do not change the OpenCode/Pi goal paths (already shipped).
- Do not implement the `-p`/`goalNonInteractive` path (web UI uses interactive PTY).

---

## 5. Architecture anchors (read these before coding)

| Concern | File / symbol |
|---|---|
| Claude prompt entry (web UI) | `server/src/websocket/connection.ts` → `handleClaudePrompt` (~line 891) |
| OpenCode `/goal` interception precedent | `connection.ts` → `handleOpencodePrompt` (~line 1008–1013, `parseGoalCommand`) |
| OpenCode goal-control handler precedent | `connection.ts` → `handleGoalControl`, `emitOpencodeGoalState`, `emitOpencodeGoalCleared`; route `case 'goal_control'` (~line 652) |
| Goal command parser | `server/src/opencode/goal-command.ts` → `parseGoalCommand` |
| Channel: how prompts are sent (MCP) | `server/src/claude/claude-channel-service.ts` → `sendPrompt` (~398), `abort` (~527), `waitForPtySettle` (~838) |
| Channel: PTY slash writes (the pattern to copy) | `server/src/claude/claude-channel-process-manager.ts` → `switchModel`/`setThinkingLevel`/`clearContext`/`sendInterrupt`; spawn args (~97–115), `DEFAULT_PERMISSION_MODE='dontAsk'` (~29) |
| Channel: managed hooks (Stop → agent_end) | `server/src/claude/claude-channel-hooks-config.ts` → `MANAGED_HOOK_NAMES` (~18), Stop hook (~40) |
| Turn completion / agent_end detection | channel hook server (`pi-claude-channel/server.ts`, port 3111) + `claude-channel-service.ts` pendingPrompts/onComplete |
| WS protocol (client→server) | `server/src/websocket/protocol.ts` → `ClientMessage` (the `goal_control` variant already exists) |
| Client goal chip + controls | `client/src/components/Chat/ChatView.tsx` (chip JSX, `goalControlsEnabled` gate = `currentSessionSdkType === 'opencode'`) |
| Client goal tag derivation | `client/src/lib/piExtensionControls.ts` → `deriveGoalTag` |
| Client WS action | `client/src/hooks/useWebSocket.ts` → `goalControl` |
| Client store event routing | `client/src/store/sessionStore.ts` → `handleServerMessage` (`extension_status` / `widget_*`, incl. the `session_event`-unwrap added in `94cd66c`) |
| Trust state | `~/.claude.json` → `projects["<cwd>"].hasTrustDialogAccepted` |

---

## 6. Implementation plan (phased)

> Follow repo rules: **TDD**, minimal diffs, run `npm run lint`/`typecheck`/`build`/tests,
> `npm run docs:check-agent-guides`. Live-validate per §7. Don't commit secrets.

### Phase 0 — Workspace trust (precondition #1)
The native `/goal` refuses in untrusted workspaces. Decide and implement ONE of:
- **(Recommended)** When the channel starts a Claude session whose `cwd` is not yet trusted,
  ensure trust before any `/goal` write — e.g. mark `projects[cwd].hasTrustDialogAccepted=true`
  in `~/.claude.json` (the same state the trust dialog sets), guarded so we only do it for
  cwds the operator already runs Claude in. **Open question for executor:** confirm there is
  no cleaner first-class flag (re-check `claude --help` / `claude project` subcommand on the
  installed build) before writing config directly.
- Alternatively, surface a clear UI error when the session cwd is untrusted and require the
  operator to trust it once.
- Verify hooks are unrestricted (no `--bare`, no `disableAllHooks`/`allowManagedHooksOnly`);
  add a guard that returns a friendly error if they ever are.

### Phase 1 — Route `/goal` to the PTY (server, core fix for §3a)
1. Add PTY-write methods to `claude-channel-process-manager.ts`, mirroring `clearContext()`:
   - `setGoal(condition: string)` → `proc.write('/goal ' + condition + '\r')`
   - `clearGoal()` → `proc.write('/goal clear\r')`
   - (optional) `showGoal()` → `proc.write('/goal\r')` to refresh status.
   - Sanitize `condition`: single line, strip CRs, cap length (the binary has a
     `Goal condition is limited to …` cap — discover the limit and enforce/trim to it).
2. Add a method on `claude-channel-service.ts` (e.g. `setGoal`/`clearGoal`) that:
   - resolves the session, calls `await this.waitForPtySettle()` (so the write isn't
     swallowed mid-render — same gating `/model` etc. use), then calls the process-manager
     write. Restore the correct model/thinking first only if needed (see `sendPrompt`).
3. Wire a handler in `connection.ts`:
   - Extend the existing **`case 'goal_control'`** path so it dispatches to Claude when the
     session is a Claude session (currently `handleGoalControl` is OpenCode-only). Cleanest:
     branch by runtime — keep `handleGoalControl` for OpenCode; add `handleClaudeGoalControl`
     for Claude.
   - **Intercept typed `/goal`** in `handleClaudePrompt` (mirror the OpenCode interception at
     `handleOpencodePrompt` ~line 1008). Reuse/extend `parseGoalCommand` BUT note semantic
     differences: for Claude, `/goal <condition>` must pass the **condition text** through
     (OpenCode's parser only returns a verb). So either generalize `parseGoalCommand` to also
     return the remainder/argument, or add a Claude-specific parse that yields
     `{ action: 'set'|'clear'|'status', condition?: string }`.
   - For `set`: call the service `setGoal(condition)`. For `clear`: `clearGoal()`.
   - Do NOT also forward the `/goal …` text as a normal MCP prompt (avoid double-execution).

### Phase 2 — Surface goal status to the browser (reuse the chip)
Claude has **no `goal.json`** (that's an OpenCode-only artifact). Source the status from the
**channel PTY output** instead:
1. In the channel output/event pipeline (`claude-channel-event-adapter.ts` /
   `claude-channel-service.ts` output handling), detect the native goal markers in PTY text:
   `Goal set:`, `Goal active:`, `Goal achieved`, `Goal could not be achieved`,
   `Goal cleared:`, `No goal set`.
2. Emit an `extension_status` NormalizedEvent with **key `goal-engine`** and a text shaped to
   what the chip expects, so the existing chip + `94cd66c` `session_event` unwrap just work.
   On clear/achieved/failed, emit the status-clear (text `undefined`) like
   `emitOpencodeGoalCleared`.
3. **`deriveGoalTag` vocabulary** (`client/src/lib/piExtensionControls.ts`): today it parses
   OpenCode words (`Running`/`Paused`/`Idle`/`Run N`). Claude's words differ (`active`,
   `achieved`, `cleared`). Either (a) have the server map Claude states into the existing
   vocabulary (e.g. active → render as running), or (b) generalize `deriveGoalTag` to also
   recognize Claude's words. Keep the helper unit-tested either way.

### Phase 3 — Keep autonomous continuation turns streaming (the hard nuance)
The native goal continues via the **Stop hook**. The web UI ALSO keys turn completion off
the Stop hook (managed Stop hook → `:3111/hook/stop` → `claude-channel-service` marks
agent_end and completes the pending prompt). Collision: when a goal is active and Claude hits
a stop-but-continue, the web UI may mark the turn complete on the first Stop while Claude
actually keeps working → the goal's self-continued turns become "orphaned" (no pending
prompt) and either don't stream or show the session idle while Claude is busy. (This is the
same class of gap as OpenCode auto-continuation not streaming live.)

Tasks:
1. Determine, from the Stop hook payload Claude Code sends to `:3111/hook/stop`, whether the
   stop was **blocked/continued by the goal** (inspect the real payload — log it during a
   live run). Claude Code's Stop hook input typically includes `stop_hook_active` and the
   decision context; capture what's actually present on 2.1.183.
2. If the stop was a goal-driven continuation, **do not** finalize the pending prompt; keep
   the turn "open" (re-arm/extend the pending listener and keep `status: running`) so
   subsequent assistant output keeps streaming under the same logical turn.
3. Finalize (agent_end, prompt complete, status idle) only on a **terminal** stop:
   `Goal achieved` / `Goal could not be achieved` / `/goal clear` / user abort.
4. Make sure `abort()` (`claude-channel-service.ts` ~527, sends Escape + channel abort) also
   issues `/goal clear` (Phase 1 method) so a user Stop truly ends the goal rather than the
   goal re-nudging Claude back to work.

### Phase 4 — Client controls (reuse, gated for Claude)
1. In `ChatView.tsx`, broaden the chip-controls gate `goalControlsEnabled` beyond
   `currentSessionSdkType === 'opencode'` to also enable for `'claude'`. Confirm `goalControl`
   (`useWebSocket`) and the `goal_control` WS message carry through for Claude (the protocol
   message already exists; only the server branch + status-source are new).
2. For Claude, the relevant actions are **clear** (and optionally a "set goal" affordance —
   a small input to type a condition, since Claude's goal needs a condition string). Pause/
   resume are OpenCode-specific (Claude's native feature has no pause); hide those for Claude.
3. Keep the typed `/goal …` interception (Phase 1) as the primary entry; the chip is the
   discoverable stop control.

---

## 7. Testing & live-validation recipe (battle-tested in prior commits — reuse verbatim)

Unit tests (TDD):
- New parser/branch logic (`parseGoalCommand` generalization or Claude variant) — pure unit tests.
- `deriveGoalTag` vocabulary changes — extend `client/tests/unit/lib/piExtensionControls.test.ts`.
- Channel `setGoal/clearGoal` PTY-write methods — unit test the write payloads (mock the pty proc),
  mirroring existing channel tests under `server/tests/unit/claude/`.
- Server status-emit on goal markers — unit test the marker → `extension_status` mapping.

Live validation (do NOT touch production on `:3456`; use a disposable server):
1. Boot disposable server with a KNOWN password (production uses a hashed/complex one — avoid it):
   ```bash
   NODE_ENV=development AUTH_PASSWORD=goaltagtest PI_WEB_UI_VALIDATION_DIR=/tmp/claudegoal-val \
     nohup npm run validate:server -- --port 3091 > /tmp/cg-val.log 2>&1 &
   ```
   (The validation server is API/WS only; it does NOT serve the client.)
2. Serve the dev client pointed at it, on an **allowed origin** (the validation server only
   allows origins 3457/3456/3000/5173 — use **3457** or CSRF/origin checks reject the WS).
   Create a temp `client/vite.validation.config.ts` (DELETE before commit) with `server.port=3457`
   and proxy `/api` + `/ws` (with `ws:true`, cookie forwarding) → `http://localhost:3091`, then
   `npx vite --config vite.validation.config.ts`.
3. Drive with Playwright (`/root/pi-web-ui/node_modules/playwright`, CommonJS:
   `import pw from '.../playwright/index.js'; const { chromium } = pw;`). Gotchas learned:
   - The persistent WS prevents `networkidle`; use `page.goto(BASE,{waitUntil:'commit',timeout:60000})`
     then `await page.waitForSelector('#password', {timeout:60000})`. Warm vite first
     (`curl http://localhost:3457/src/main.tsx`).
   - Log in with the known password; the runtime badge in the sidebar selects the session
     (OpenCode shows `OC`; check the Claude badge text and click that row).
   - Assert `[data-testid="goal-tag"]`, `goal-pause`/`goal-resume`/`goal-clear`/`goal-clear-confirm`
     (existing testids); add Claude-appropriate ones as needed.
4. **Claude-specific validation that the NATIVE goal actually fired** (the whole point):
   - After issuing `/goal <condition>`, assert the channel logs show `Goal set:`/`Goal active:`
     (`journalctl`-style: tail `/tmp/cg-val.log`), NOT just task execution.
   - Assert the goal **loops**: more than one assistant turn occurs without a new user prompt
     (Stop-hook continuation), and the session keeps streaming in the UI.
   - Assert `/goal clear` (typed AND chip button) stops it: chip disappears and Claude stops
     continuing.
   - Use a SHORT, clearly-checkable goal condition so the loop terminates quickly (and abort to
     avoid burning quota). Ensure the validation cwd is trusted (Phase 0).
5. Tear down: kill the validation server + vite, remove temp vite config and `/tmp/claudegoal-val`,
   confirm `:3456` production untouched.

Deploy to production (only when the user asks): `npm run build` then `systemctl restart pi-web-ui`;
verify served bundle hash updated and channel subprocesses (claude / pi-claude-channel / opencode
serve) came back.

---

## 8. Acceptance criteria
- Typing `/goal <condition>` in a **Claude** web-UI session activates the **native** goal
  (channel shows `Goal set:` / `Goal active:`), proven in live validation — not just task execution.
- The goal **loops autonomously** (multiple turns, no extra user prompt) and the turns **stream
  live** in the browser (Phase 3) — the session does not look frozen/idle while Claude works.
- A live **goal chip** shows the active state for Claude sessions, sourced from channel output.
- **Stop / `/goal clear`** (typed and via chip) reliably ends the goal (Claude stops continuing).
- Untrusted-cwd and restricted-hooks cases produce a clear UI error instead of silent no-op.
- OpenCode and Pi goal paths are unchanged. `lint`/`typecheck`/`build`/tests/docs-check all pass.

---

## 9. Risks & edge cases
- **Stop-hook collision (Phase 3) is the main risk.** Get the real Stop-hook payload from a
  live 2.1.183 run before designing the "is this a goal continuation?" check; don't guess.
- **Single shared Claude PTY:** the channel multiplexes all Claude sessions over one process
  (`contextOwnerSessionId`, `/clear` on switch). A goal is bound to the live PTY/session; if the
  user switches sessions mid-goal, define behavior (the native goal is per-conversation and
  `restoreGoalFromTranscript` exists — verify resume behavior across the channel's `/clear`).
- **Condition length cap** (`Goal condition is limited to …`) — enforce/trim.
- **Trust writes** to `~/.claude.json` must be conservative and reversible; prefer a first-class
  mechanism if one exists.
- **Quota:** autonomous loops consume subscription quota; keep validation goals tiny and abort.
- Don't let the typed `/goal` get double-handled (intercept = do not also send as MCP prompt).

---

## 10. Open questions for the executor (decide early)
1. Is there a first-class way to trust a workspace for the channel (a flag / `claude project`
   subcommand on 2.1.183) instead of writing `hasTrustDialogAccepted`? Re-check the installed build.
2. Exact shape of Claude Code's Stop-hook payload on 2.1.183 (fields that reveal goal
   continuation vs terminal stop) — capture from a live run.
3. Best place to detect goal markers — PTY raw output vs a structured channel event — and the
   precise marker strings on this build (`Goal set:`/`Goal active:`/`Goal achieved`/`Goal could
   not be achieved`/`Goal cleared:`/`No goal set`).
4. UX for entering a goal **condition** from the browser (inline input on the chip vs typed
   `/goal <condition>` only).
