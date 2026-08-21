# Mid-run steering research — Claude Agent SDK & Command Code

> Research reference for the streaming composer's steer/follow-up behaviour on
> the Claude (SDK backend) and Command Code runtime paths. Everything here was
> verified **empirically** (wire probes against the real CLIs) plus official
> docs; probe transcripts are summarised below. Implementation shipped in
> commit `6495262` (2026-08-21); this file is the durable evidence record.
>
> Companion docs: [`PROTOCOL.md`](./PROTOCOL.md) (wire contract),
> [`plans/CLAUDE-COMMAND-CODE-STEERING-PLAN.md`](./plans/CLAUDE-COMMAND-CODE-STEERING-PLAN.md)
> (decision record), [`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) §Steering
> (validation runbook), [`CLAUDE-BACKENDS.md`](./CLAUDE-BACKENDS.md),
> [`COMMAND-CODE-INTEGRATION.md`](./COMMAND-CODE-INTEGRATION.md).

**Versions verified against:** Claude Agent SDK `@anthropic-ai/claude-agent-sdk`
0.3.185 driving the system `claude` CLI **2.1.235** (the version
`ClaudeSdkService` resolves via `pathToClaudeCodeExecutable`). Command Code
`cmdc` **1.28.4** (`/root/.npm-global/bin/cmdc`). SDK types live in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`SDKUserMessage` ~L4127,
`Query.interrupt()` ~L2192, `streamInput()` ~L2407).

---

## 1. Claude Agent SDK — streaming-input steering

### How it works

- `query({ prompt, options })` accepts either a **string** prompt (single-turn:
  stdin closes immediately, no mid-run input possible) or an
  **`AsyncIterable<SDKUserMessage>`** (streaming-input mode: stdin stays open,
  each yielded message is written to the CLI's stdin as a user message).
- Keep the iterable open for the whole run → mid-turn pushes become steering.
- Control methods (`interrupt()`, `setModel()`, `setPermissionMode()`,
  `streamInput()`, …) are **only supported in streaming-input mode**.

### `SDKUserMessage.priority` — the steering knob

```ts
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;          // { role:'user', content:[{type:'text',text}] }
  parent_tool_use_id: string | null;
  priority?: 'now' | 'next' | 'later';   // ← THE field
  shouldQuery?: boolean;          // false = append to transcript without a turn
  origin?: SDKMessageOrigin;      // set { kind:'human' } for user-typed text
  ...
};
```

**Verified semantics matrix** (probe: 5-step sequential `sleep 5` Bash task,
steer injected after tool call #1, CLI 2.1.235, 2026-08-20):

| Variant | Behaviour observed | Verdict |
|---|---|---|
| `priority: 'next'` | Steer injected at the **next tool boundary**, joined the *current* turn: step 1 completed, model replied `PIVOTED` immediately, single result `num_turns=2` | ✅ true steer (Pi-like) |
| `priority: 'now'` | In-flight tool call **aborted** (`tool_result` = "Command was aborted"), turn ended (`result=""`, `num_turns=2`), steer ran as its **own turn** (`PIVOTED`, `num_turns=1`) | interrupt+send |
| `priority: 'later'` | Current turn ran to completion — all 5 steps, `ALL DONE` (`num_turns=6`) — then steer ran as its own turn (`PIVOTED`) | ✅ follow-up |
| **omitted** | **Silently dropped.** All 5 steps ran, `ALL DONE`, steer never appeared in any turn | ⚠️ every mid-turn push MUST set an explicit priority |
| `q.interrupt()` + default push | Turn aborted → `error_during_execution` result (is_error), then steer ran as its own turn. Receipt resolves `""` on this SDK/CLI combo (capabilities advertised: `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`) | works but error-shaped; `'now'` is cleaner |

### Edge cases (all verified)

- **Steer at turn tail** (`priority:'next'` pushed after the LAST tool result):
  degrades gracefully — current turn finishes (`ALL DONE`), steer runs as its
  own turn (`PIVOTED`). Never dropped. So `'next'` is safe to send any time
  mid-run.
- **Push while CLI idle** (stream still open, right after a result): starts a
  new turn normally (`PIVOTED`, `num_turns=1`).
- **stdin EOF with queued turns**: closing the input stream immediately after
  result #1 does **not** cancel an already-delivered `'later'` message — the
  queued turn still runs (RESULT #2 `SECOND` arrived after EOF). This is what
  makes the post-result end-grace safe: once a message is on the wire, closing
  stdin cannot strand it.
- **Injected messages are NOT echoed on the stream.** The CLI does not emit a
  user `SDKUserMessage` for what you pushed — the server must emit **synthetic
  persisted user `message_start`/`message_end` events** itself so the browser
  transcript and the composer's queued-chip clearing work. (Pi Web UI does this
  in `ClaudeSdkService.emitUserMessage`.)
- `origin: { kind: 'human' }` should be set on user-typed text (per docs,
  requirements that need a human-typed prompt reject unattributed messages;
  pre-2.1.210 CLIs treated absent origin as human).
- Streaming-input sessions emit **one result per turn**, and usage on results is
  cumulative across turns in the same query — read the latest result for totals.

### Sources — Claude

- Streaming input mode (official): https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- TypeScript SDK reference — `SDKUserMessage`, `Query` methods, `interrupt()`
  receipt, capabilities: https://code.claude.com/docs/en/agent-sdk/typescript
- Approvals / clarifying questions ("Redirect entirely — use streaming input"): https://code.claude.com/docs/en/agent-sdk/user-input
- Claude Code changelog: https://code.claude.com/docs/en/changelog
- GitHub issue confirming the TUI steering model ("picked up between tool
  calls"), useful corroboration of `next` semantics:
  https://github.com/anthropics/claude-code/issues/71726
- Community write-up on queueing while busy (background reading):
  https://gist.github.com/YoraiLevi/f7c454a0e3a1e206124004241940f972
- Local ground truth: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  (types) and `sdk.mjs` (`streamInput` writes each message + `\n` to the
  transport; string prompts are written once at query start).

---

## 2. Command Code (`cmdc`) — no mid-run input channel

### What the CLI actually does (verified)

- Print mode (`cmdc -p`) reads **stdin once, to EOF, with a 30-second timeout**.
  Keeping stdin open and writing a second line mid-run produces:
  `stderr: Error reading from stdin: Timeout reading from stdin` and a
  `{"type":"result","subtype":"error","durationMs":30021}` frame, exit 1.
  Source: `readStdin()` in `command-code/dist/cli.mjs` (30_000ms timer,
  `resolvePrintStdinQuery` consumes the whole buffer as THE prompt).
- The **agent loop has native steering/follow-up queues** — `getSteeringMessages`,
  `drainSteering`, `drainFollowUp`, `steeringMode`/`followUpMode` config, and
  the TUI help literally documents "Type + Enter — Queue a steering message" —
  but in print mode these are wired to nothing external; there is no stdin
  bridge, control socket, or RPC to reach them.
- Therefore the only honest "steer" over a `cmdc -p` run is
  **abort + immediately send the steering text as the next prompt on the same
  native session** (`--resume <nativeSessionId>`), which is what Pi Web UI
  implements.

### Sources — Command Code

- `cmdc --help` (v1.28.4) — no steering/stdin flags in print mode.
- `command-code/dist/cli.mjs` (installed package, local inspection):
  - `readStdin()` — 30s EOF timeout, single prompt read.
  - `runPrintMode({ … readStdin … })` — prompt resolved once before the harness
    runs; no later stdin consumption.
  - `agentLoop(e)` — `getSteeringMessages` / `drainSteering` / `drainFollowUp`
    hooks exist but are only fed by the interactive TUI.
- Wire probe (kept-open stdin, steer line written mid-run): timeout error above.

---

## 3. How Pi Web UI maps this (implementation map)

| Concern | Location |
|---|---|
| Pushable prompt iterable + end-grace | `server/src/claude/claude-steer-stream.ts` (`SteerablePromptStream`: `push`/`end`/`scheduleEnd`; a push cancels a scheduled end) |
| Streaming-input `sendPrompt`, steer/followUp, synthetic user events, transient-retry stream swap | `server/src/claude/claude-sdk-service.ts` (steer → priority `'next'`, followUp → `'later'`; post-result grace `CLAUDE_STEER_END_GRACE_MS`, default 1500) |
| Facade (channel/cli-direct → not steerable) | `server/src/claude/claude-service.ts` (`steer`/`followUp` delegate to SDK service) |
| WS routing: claude steer/followUp; CMD steer hand-off (`abort` → `waitForTurnEnd` → next prompt) + follow-up FIFO queue + Stop clears queue + steer-abort toast suppression (`commandCodeSteerHandoffs`) | `server/src/websocket/connection.ts` (`handleSteer`, `handleFollowUp`, `handleCommandCodeSteer/FollowUp`, `drainCommandCodeFollowUps`) |
| CMD turn-settlement promise for the hand-off | `server/src/command-code/command-code-service.ts` (`waitForTurnEnd`, backed by `inFlightTurns`) |
| Composer gating + per-runtime labels | `client/src/lib/piExtensionControls.ts` (`canSteerWhileStreaming`: pi/claude/commandcode) and `client/src/components/Chat/MessageInput.tsx` (Steer/After strip; Claude "Joins at next step", CMD "Steer now — interrupts & redirects") |
| Busy prompt fast-fail | `handleClaudePrompt` now returns `SESSION_BUSY` immediately (the old 30s busy-wait poll was removed) |
| Intentionally NOT changed | Internal API `steer` mode stays **pi-only** (`server/src/internal-api/routes/sessions.ts` rejects others); `priority:'now'` exists on the wire but is not exposed in the UI |

### Wire contract summary (browser WebSocket)

`{ type:'steer', message }` / `{ type:'follow_up', message }` — unchanged
shapes; both new paths emit a persisted synthetic user `message_start` carrying
the text, which is also what clears the composer's queued chips. Errors:
`STEER_NOT_RUNNING` when a steer/follow-up arrives with no live steerable run.

---

## 4. Validation evidence & recipe (disposable servers)

Live-validated 2026-08-21 over the real cookie-authenticated WebSocket path
(`scripts/live-validate-steer.mjs`):

- **Command Code (fixture)**: slow run via the `COMMAND-CODE-SLOW-RUN` fixture
  marker → steer interrupted it (slow-run completion never appeared) and the
  agent replied `COMMAND-CODE-LIVE-OK`; follow-up queued mid-run executed
  strictly after the slow run completed. Fixture:
  `server/src/live-validation/command-code-fixture.ts`.
- **Claude (real SDK backend, GLM 5.3 profile)**: 3× sequential sleep task →
  steer pivoted the model mid-run (`CLAUDE-STEERED-OK`, joined the live run);
  follow-up ran as its own turn after the second slow task.

Recipe gotchas (all bit during validation — see
[`LIVE-VALIDATION.md`](./LIVE-VALIDATION.md) §Steering for the full runbook):

- The validation server **isolates `CLAUDE_CONFIG_DIR`**, so native Anthropic
  OAuth fails (`authentication_failed` / "Not logged in"). Use a provider
  profile with `--env-file .env.production --env-key GLM_CODING_PLAN_TOKEN` and
  a profiles file in the validation dir.
- Bare model aliases (`sonnet`/`opus`/`haiku`) **deliberately skip GLM default
  profiles** (`ClaudeService.createSession` bare-alias rule) — select the SDK
  profile explicitly with `--model profile:<id>`.
- Node's global `WebSocket` **cannot send a Cookie header** — the `ws` package
  is required for path-3 validation, and the upgrade needs
  `Origin: https://tmux.letsautomate.work` (the server's allowed origin).
- Validation-server directories are process-locked; stale servers must be
  killed by PID (never `pkill -f`) before reusing a dir.

---

## 5. Open items / future options

- Expose `priority:'now'` ("send immediately / interrupt & send") as a UI mode —
  the wire semantics are already verified.
- Extend Internal API `steer`/`follow_up` modes beyond pi if orchestration
  clients need mid-run steering.
- Re-verify the priority matrix if the pinned SDK (`0.3.185`) or system CLI
  moves materially; capabilities in the init message (`interrupt_receipt_v1`,
  `msg_lifecycle_v1`) are the feature-detection hook.

*Probe scripts used for this research were temporary (`tmp-*-probe*.mjs`) and
deleted after evidence capture; the summarised transcripts above are the
durable record.*
