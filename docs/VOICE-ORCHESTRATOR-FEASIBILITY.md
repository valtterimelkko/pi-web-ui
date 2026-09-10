# Voice Orchestrator Feasibility: Two Lanes

> Status: **findings record, not a plan.** Written 2026-09-10 from a research
> session between the operator and Claude (Fable 5.1). A later agent owns the
> plan, TDD, and implementation. Nothing here has been built or validated.
> Sibling report: [`REVERSE-TRANSFER-FEASIBILITY.md`](./REVERSE-TRANSFER-FEASIBILITY.md).

## 1. The problem being solved

The operator wants to orchestrate agent work **by voice**, in a natural
conversation, without burning Antigravity quota. Concretely:

- Antigravity (Gemini 3.8 Flash High, run from the `agy` CLI) has proven to be a
  surprisingly capable orchestrator of Internal API children (see §6), but its
  usage allowance is small and expensive.
- The existing Pi Web UI **Drive Mode** already lets the operator dictate to any
  runtime (including Antigravity) and hear the answer read aloud — but with a
  reasoning worker the reply arrives "in a minute", which is not a conversation.
  You cannot ask "what do you think about X while you work on this?".
- ChatGPT Voice (GPT-Live) in the desktop app *does* talk while it works and can
  drive Codex threads, but the operator found its orchestration quality poor:
  it dispatched Codex threads on **unfinished thoughts**, prompted other models
  in a long-winded way that was **not faithful** to what was said, and followed
  `AGENTS.md` inconsistently.

So the goal is a surface that (a) talks fluently while tools run, (b) transmits
the owner's intent with very high fidelity, (c) does not act on half-formed
thoughts, and (d) draws on quota the operator already has.

## 2. Route ruled out: the Gemini mobile/web app with a custom MCP server

Investigated first because the Gemini app has separate quota from Antigravity.
**Not feasible for this operator (UK).**

- Custom MCP servers are a *Gemini Spark* "custom apps" feature. Google's own
  requirements: personal Google account, 18 or over **and in the US**, Keep
  Activity on, MCP server URL; set up on the web, then usable in mobile; invoked
  by `@`-mention in typed Spark chats
  ([support.google.com/gemini/answer/17209137](https://support.google.com/gemini/answer/17209137)).
- Spark itself is unavailable in the UK, EEA, Switzerland and Nigeria regardless
  of Pro or Ultra (ppc.land, 30 Jul 2026).
- Gemini Live (voice) only uses first-party connected apps (Calendar, Tasks,
  Keep, Spotify, …), rolling out gradually; no custom apps in Live.
- Gemini Live is powered by a **separate audio model, Gemini 3.1 Flash Live**,
  not Gemini 3.8 Flash. Live API function calling is synchronous only; no code
  execution, no MCP attachment.
- Artificial Analysis Speech Agent Arena (21 Aug 2026): Gemini 3.1 Flash Live
  (minimal thinking) leads *preference* (1,046 Elo) but scores only **74.6 %
  task success**; Grok Voice Think Fast 2.0 High 94.7 %; GPT-Realtime-2.1 High
  91.5 %; ElevenLabs cascaded system 90.5 %. Their comment: "a preferred
  conversation does not always result in successful task completion" — the model
  sounds as if it did the thing without making the tool call.

Consequence: MCP is irrelevant to this design. Drive Mode already has the tool
surface (the runtime's own tools plus the Internal API).

## 3. Lane 1 — talker + worker inside Pi Coding Agent and Drive Mode (recommended)

### 3.1 Shape

Two lanes per session, mirroring the split OpenAI uses (GPT-Live talks, a
reasoning model works), but under the operator's full control:

| Lane | What it is | Model | Changes |
|---|---|---|---|
| **Worker** | The ordinary Pi Coding Agent session in Pi Web UI, running tools, background tasks, children via the Internal API, goals. | Whatever the operator picks (reasoning on). | None. |
| **Talker** | A pi-enhancement extension that answers the operator within ~1–2 s while the worker is busy, using a **side completion** (not the worker's agent loop), and relays finished instructions into the worker. | Cheap, fast, minimal thinking. **Leaning: GLM 5.3 Flash** (Pi runtime, `zai` provider — already-paid quota with lots of headroom). Gemini 3.8 Flash with minimal thinking remains an option, not the default. | New extension. |
| **Drive Mode** | Voice I/O in the browser: OpenAI STT (`/api/dictation`) and OpenAI TTS (`/api/tts`), as today. | n/a | Client changes (§3.4). |

No Gemini API is required for Lane 1 unless Gemini 3.8 Flash is chosen as the
talker; STT/TTS stay on the existing OpenAI path at dictation-scale cost.

### 3.2 Talker behaviour (the part ChatGPT Voice got wrong)

Because the talker is a Pi extension, its instructions are exact and enforced,
not advisory like `AGENTS.md` to GPT-Live. The rules agreed in the session:

1. **Conversation first.** Any utterance while the worker is busy is answered
   conversationally from a compact state view (task list, last N tool events,
   background-task statuses, last assistant text). Questions and thinking-aloud
   are answered; nothing is dispatched.
2. **Never act on an unfinished thought.** The talker waits for the operator to
   finish, then **asks for confirmation** ("shall I send that to the worker?")
   before relaying anything. Confirmation is the gate against the "actually, no,
   let's rethink" problem observed with GPT-Live.
3. **Relay with very high fidelity.** Semi-verbatim: the operator's own words,
   optionally made more concise when the speech rambles, but never summarised
   into the talker's own plan, never expanded into long-winded instructions.
   The worker receives the owner's intent, not a re-planned version of it.
4. **Delivery mechanics.** Relayed text goes to the worker as
   `deliverAs: "steer"` when the worker is mid-run (joins at the next tool
   boundary) or `"followUp"` to queue for the next turn; the talker never starts
   new sessions, children, or goals itself.
5. **Reporting.** Worker completions and background-task wakes (already
   delivered as follow-up messages by `background-shell` / `subagent` /
   `watch-wake`) are summarised aloud by the talker when they land; the worker's
   own final answer is read aloud separately.
6. **Allow-list, not judgement.** What the talker may do is an explicit
   allow-list in the extension (answer, confirm, relay, summarise). Everything
   else is denied in code.

### 3.3 Building blocks verified in the Pi extension API

Checked 2026-09-10 against the installed types
(`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`)
and the shipped example `examples/extensions/input-transform-streaming.ts`:

- `pi.on("input", …)` fires for input arriving **mid-run** with
  `event.streamingBehavior: "steer" | "followUp"` (undefined when idle) — the
  extension can intercept a spoken utterance while the worker is busy.
- `pi.sendUserMessage(text, { deliverAs: "steer" | "followUp" | "nextTurn" })`
  injects into the running worker; `pi.sendMessage({ customType, display: true }, …)`
  emits a rendered message that participates in context.
- `ExtensionContext` exposes `modelRegistry`, `model`, `isIdle()`,
  `hasPendingMessages()`; `@earendil-works/pi-ai` provides `stream`/`complete`
  for a side model call independent of the worker's loop.
- `pi-enhancement` already ships `background-shell` (`bg_run`), `subagent`
  background tasks and `watch-wake`, all of which deliver completion wakes as
  follow-up messages the talker can summarise.
- Source of truth for extensions is `/root/pi-enhancement/` (read its
  `AGENTS.md` first); deployment mirrors live under `~/.pi/agent/extensions/`.

Limit: the Pi SDK runs one agent loop per session, so the talker must be a side
completion, not the worker "multitasking". That is the better design anyway —
the worker's reasoning latency stops mattering to the conversation.

### 3.4 Pi Web UI / Drive Mode: what exists and what changes

Verified in this repo:

- `client/src/hooks/useDriveModeDictation.ts` — calls `sendPrompt` only.
- `client/src/components/DriveMode/DriveModeDictate.tsx` — phase machine: goes
  to `agent-working` while `isStreaming`, to `read-aloud-ready` when streaming
  stops, then speaks `getLastAssistantText(messages)`.
- `client/src/hooks/useWebSocket.ts` — `sendSteer` and `sendFollowUp` already
  exist (`{ type: 'steer' | 'follow_up', message }`); the server steers Pi
  sessions in `server/src/pi/multi-session-manager.ts` (`steer()`).
- `client/src/store/sessionStore.ts` — applies `text_delta`s during streaming,
  so partial text is available to the client.
- `server/src/routes/tts.ts` — one-shot OpenAI mp3, max 4,000 chars, fixed voice
  allow-list. `server/src/routes/dictation.ts` — OpenAI STT with speculative
  transcription.

Changes implied (for the planning agent, not specified here):

- Drive Mode sends `steer`/`follow_up` instead of `prompt` when the session is
  busy, so speech reaches the talker mid-run.
- Talker replies are spoken **as they arrive** (sentence-chunked calls to the
  existing TTS route) instead of waiting for the turn to end; the worker's
  final answer keeps a separate "done" read-aloud.
- The phase machine gains a talking-while-working state instead of blocking in
  `agent-working`.

### 3.5 Open checks (unverified)

- Whether Pi custom messages (`customType`) are forwarded to the browser today —
  a grep found no handling in `server/src/pi/`; if not, the talker should emit
  plain assistant-style text.
- Runtime access to `modelRegistry` from the event context where the talker runs.
- Talker model final choice and latency with GLM 5.3 Flash at minimal thinking.
- Antigravity runtime: `agy` is not extensible and only queues follow-ups, so
  Lane 1 covers the Pi runtime; a server-side talker in Pi Web UI could cover
  all runtimes later but is a larger change.

Rough size discussed: extension ~1–2 days, Drive Mode ~1–2 days, disposable
validation server for both.

## 4. Lane 2 — ChatGPT Voice (phone → desktop Codex) as a pure relay (spike only)

Mechanics verified from OpenAI documentation
([learn.chatgpt.com/docs/features/voice](https://learn.chatgpt.com/docs/features/voice)):
GPT-Live holds the conversation; it can start, check and steer Codex threads;
tasks bill to the Codex budget; mobile use is via Remote on iOS after pairing
with a desktop host; officially macOS and Windows only. On this host a
`/usr/share/applications/chatgpt.desktop` launcher exists and the operator
reports remote voice works — treat platform support as unverified. Codex
threads honour `~/.codex/AGENTS.md` (byte-identical to the global Claude
instructions here) and default to the model/effort in `~/.codex/config.toml`
(currently a premium model at max effort, so each relay is expensive). Twelve
`~/Documents/Codex/2026-08-12-new-realtime-voice-chat-*` directories show
earlier voice attempts created a thread per attempt.

Relay design (half a day): an `AGENTS.md` section — *if this thread was started
from Voice: do not plan, do not spawn; forward the owner's message verbatim to
orchestrator session X over the Pi Web UI Internal API (`steer` if busy, else
`follow_up`); wait for its reply; report it back* — plus a small relay script.

Structural problems (why it is a spike, not the architecture):

- **An ungateable lossy hop.** `AGENTS.md` governs Codex, not GPT-Live. GPT-Live
  paraphrases what the operator said *before* it creates or steers the thread —
  that is the intent-transmission loss, and it sits upstream of anything the
  operator can instruct. It also acted on unfinished thoughts in practice.
- **Latency and cost.** Every utterance = voice → Codex thread start → Internal
  API → orchestrator turn → back: tens of seconds and Codex budget per relay,
  for a message Lane 1 delivers in one hop.

Lane 2 is not declared dead; it is worth running only to learn whether
GPT-Live's paraphrase is tolerable for check-ins while Lane 1 is built.

## 5. Terminology and authority

*Orchestration* here means the lightweight, skill-level parent-and-children
practice (`pi-web-ui-internal-api-orchestration`), which is what the Antigravity
session performed. It is distinct from the Agent OS *conductor*, the heavier
gated process whose development is paused; the conductor is not worth its cost
below a certain task complexity. Both lanes target orchestration, not the
conductor. The operator stays in the intent layer: the talker (Lane 1) or relay
(Lane 2) transports the owner's words; it does not re-plan them. This is the
mechanical form of the observation that one agent cannot transmit intent to
another as faithfully as the owner can.

## 6. Reference: the Antigravity orchestration run that motivated this

Session `3099ab72-b89e-4d5c-8a94-43cff8bd98a8` (agy CLI, Gemini 3.8 Flash High,
2026-09-10, ~13:36–16:19 UTC). Log:
`~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
(sqlite copy under `~/.gemini/antigravity-cli/conversations/`).

- Did well: read both skills first; adopted two pre-existing Pi CLI sessions as
  children; pure-observer watches + a `/watches/wait` long-poll script + native
  `schedule` backstops (real zero-token waiting, backstop self-cancelling);
  board registration; diagnosed the watch-observer wiring and restart
  rehydration defects from source and dispatched a child brief; restarted
  production safely; amended the skill; kept Telegram cadence.
- Cost driver: ~615 `run_command` calls, including ~45 consecutive
  `tmux capture-pane` calls in one turn and repeated `sleep && capture` loops.
  Supervision churn, not model weakness, consumed the quota.
- **Compactions:** five in ~2 h. Antigravity compacts at **~135k tokens**
  regardless of the model's 1M window
  ([ai.google.dev antigravity-agent](https://ai.google.dev/gemini-api/docs/antigravity-agent));
  measured segments between `CHECKPOINT` entries were ~158–185k tokens of raw
  log (chars/4), consistent with 135k plus the ~23–25k system-prompt/tool
  overhead agy sends per request. The small mistakes (wrong token path,
  `localhost:3000`) appeared right after checkpoints. Not tunable from the
  operator side. Design lesson for any voice surface: end the turn after arming
  watchers; polling both spends quota and hastens compaction.

## 7. Sources consulted

- Google support: Connect & manage custom apps for Gemini Spark —
  https://support.google.com/gemini/answer/17209137
- ppc.land, Gemini Spark blocks EU and UK users (2026-07-30)
- Google blog, Gemini 3.1 Flash Live — https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-1-flash-live/
- Gemini Live API tools — https://ai.google.dev/gemini-api/docs/live-api/tools
- Gemini API pricing — https://ai.google.dev/gemini-api/docs/pricing
- Antigravity agent (compaction threshold) — https://ai.google.dev/gemini-api/docs/antigravity-agent
- Artificial Analysis, Speech Agent Arena — https://x.com/ArtificialAnlys/status/2090806900631994528 ; https://artificialanalysis.ai/speech-to-speech
- OpenAI, ChatGPT Voice — https://learn.chatgpt.com/docs/features/voice ; MCP not available in voice: https://community.openai.com/t/chatgpt-support-of-mcp-in-voice-mode-on-web-and-android/1382072
- Simon Willison, ChatGPT voice mode is a weaker model (2026-04-10)
- Local: `docs/DRIVE-MODE.md`, `docs/MCP-SERVER.md` (retained, disabled stdio adapter — not needed for either lane), `/root/.claude/skills/pi-extension/SKILL.md`, `/root/pi-enhancement/`
