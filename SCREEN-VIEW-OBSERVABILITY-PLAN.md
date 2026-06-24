# Plan: Default "Screen View" Observability Layer (Internal API)

> **Status:** Approved for execution (Option B — staged canonical).
> **Owner of execution:** a delegated coding agent (token-heavy work).
> **Final gate:** Claude review/QA (Stage 4) — the executing agent MUST hand off, not self-declare final victory.
> **Created:** 2026-06-24.

---

## 1. Context — why this exists

Today, to let an LLM agent understand "what the user sees in a session," the only options are:

1. Read the **raw session logs** — far more detail than the screen shows (every thought, every full tool output), so the agent gets a distorted, bloated picture.
2. Drive the UI with **Playwright** — clunky, and on production it fights password/bcrypt/CSRF auth, forcing a spin-up-a-second-server dance that is slow.

We want a fast, faithful, **read-only** way for an agent (Claude or a cheaper delegated agent) to see **exactly what the user sees by default on screen** in a session — the *resting* default view: visible messages, collapsed tool cards (output hidden), summarized/collapsed thinking, collapsed tool groups, skill placeholders — **across all four runtime paths** (Pi, Claude, OpenCode, Antigravity).

This is also the foundation for an explicit product goal: tuning how cards render/collapse and how the message list virtualizes. The same projection that answers "what do I see" will attach a **per-item size estimate**, so an agent can reason about which cards bloat the view and feed better virtualization decisions later. (It complements, and may reduce the need for, the larger Option C/D virtualization rework discussed separately.)

### Intended end-state usage
The user reads a **Session ID** from the Session Info box (`client/src/components/StatusBar/SessionInfoModal.tsx`, the `Session ID: …` line — present for **all four** runtimes), hands it to an agent, and says *"read what I see in session `<id>`."* The agent calls the new Internal API endpoint **against the live production instance, read-only**, and receives a markdown "text screenshot" plus structured items.

> **Important distinction for the executing agent:** *Live validation during this build* uses a **spun-up disposable validation server**, NOT production. *End-state usage* of the finished endpoint is against production's Internal API socket, read-only. Do not run build-time validation against production.

---

## 2. Key architectural facts (already true — do not rebuild these)

- **Normalization already happens per-runtime, server-side, before the UI.** Every runtime emits a **common replay-event stream** (`message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_end`, etc.). The projection therefore sits **above** normalization and is **runtime-agnostic by construction**. Producers:
  - Pi → `server/src/pi/event-forwarder.ts` (+ Pi source parsing in `server/src/session-transfer/pi-source-adapter.ts`)
  - Claude → `server/src/claude/claude-history-replay.ts` (`historyToReplayEvents`)
  - OpenCode → `server/src/opencode/opencode-history-replay.ts` (`opencodeMessagesToReplayEvents`)
  - Antigravity → `server/src/antigravity/antigravity-history-replay.ts` (`turnsToReplayEvents`)
- **An event-level projection already exists**: `server/src/session-transfer/visible-transcript.ts` → `replayEventsToVisibleItems(events)`. It already implements skill-placeholder transform, a visible-tool filter, and tool primary-arg extraction. **The new projection is a richer sibling of this** (adds: thinking handling, default-collapse metadata, tool grouping, special card kinds, per-item size estimate, markdown rendering, and a UNIFIED tool allowlist).
- **A unified session ID already exists**: `RegistryEntry.id` (`server/src/session-registry.ts`). The registry stores runtime-specific ids alongside it (`claudeSessionId`, `opencodeSessionId`, `antigravityConversationId`, `path`) and there is already a universal resolver pattern (see `scripts/debug-where.mjs`, which accepts `id` | `path` | `claudeSessionId` | `opencodeSessionId` | `antigravityConversationId`). **We do not need a new ID system** — we reuse this resolver.
- **The Internal API authenticates with a bearer token over a Unix socket** (`~/.pi-web-ui/internal-api.sock` + `~/.pi-web-ui/internal-api-token`) — no password/CSRF/browser. This is why it beats Playwright for this use case.
- **A `/transcript` endpoint already exists**: `handleSessionTranscript` in `server/src/internal-api/routes/sessions.ts` (~line 1269), wired in the handler table (~line 1773). It already contains a **per-runtime event-loading switch** (Pi/Claude/OpenCode). We extend this pattern.

### Drift to kill (the reason canonical is the right approach)
There are currently **two divergent "visible tool" allowlists**:
- `server/src/session-transfer/types.ts` → `VISIBLE_TOOL_NAMES` (9 lowercase names)
- `client/src/components/Chat/VirtualizedMessageList.tsx` → `VISIBLE_TOOL_NAMES` (large, includes PascalCase Claude/OpenCode variants, subagent, todo, web_search…)

The shared module becomes the single source of truth for this set and for all default-view rules.

---

## 3. Design — the shared projection (single source of truth)

Create a new shared module: **`shared/src/screen-view.ts`** (re-exported from `shared/src/index.ts`). It must be **pure** (no Node/server/client imports, no I/O) so both the server and the client can consume it and it builds under `npm run build --workspace=shared`.

### 3.1 Types (illustrative — finalize names during TDD)
```ts
export type ScreenItemKind = 'user' | 'assistant' | 'tool' | 'tool_group' | 'thinking';

export interface ScreenItem {
  kind: ScreenItemKind;
  /** Text shown by default (collapsed). For tools: the header line (name + primary arg). */
  text: string;
  /** True if this item hides content behind a collapsed card by default. */
  collapsedByDefault: boolean;
  /** Present only when the agent opts in via expand=… ; the hidden content. */
  expandedText?: string;
  toolName?: string;
  toolPrimaryArg?: string;
  /** For tool_group: how many tools are collapsed under the toggle. */
  groupSize?: number;
  /** Cheap rendered-size estimate (line count) — for card/virtualization tuning. */
  estimatedLines: number;
  timestamp?: number;
}

export interface ScreenView {
  items: ScreenItem[];
  itemCount: number;
  /** Total estimated default-rendered lines (sum of visible items). */
  estimatedTotalLines: number;
  /** Echo of which expansions were applied. */
  expanded: { tools: boolean; thinking: boolean };
}

export interface ProjectOptions {
  expand?: { tools?: boolean; thinking?: boolean };
}
```

### 3.2 Exports
- **Rule primitives** (single source of truth, importable by the client in Stage 3):
  - `VISIBLE_TOOL_NAMES` (the unified set — superset covering Pi lowercase, Claude/OpenCode PascalCase, subagent/Agent/Task, todo/TodoWrite/TodoRead, web_search/WebSearch, skill, etc. — port from the client list, which is the richer one)
  - `isVisibleTool(name: string): boolean`
  - `detectSkillContent(text): { isSkill: boolean; skillName?: string }` and `skillPlaceholder(name?)` (port logic from client `getSkillContentInfo` in `VirtualizedMessageList.tsx` AND `transformSkillContent` in `visible-transcript.ts` — unify)
  - `toolPrimaryArg(name, args): string | undefined`
  - `estimateItemLines(item): number`
  - the tool-grouping rule (consecutive runs of **3+** visible tool messages collapse into one `tool_group` item — port from client `toolGroupMeta` useMemo)
  - the default-collapse predicate (tool output hidden; thinking hidden/summarized; mirror `MessageBubble` + `CollapsibleToolCard` + `ThinkingBlock` defaults)
- **Event projection (server entry point):** `projectDefaultViewFromEvents(events: Array<Record<string, unknown>>, opts?: ProjectOptions): ScreenView`
- **Markdown renderer:** `renderScreenViewMarkdown(view: ScreenView): string` — the "text screenshot."

### 3.3 Default-view rules to encode (the contract of "what I see by default")
Port these faithfully from the client. Source of truth for current behavior:
- Visible items = `user` + `assistant` + visible-`tool` only (`isVisibleTool`). Everything else (arbitrary MCP tools, etc.) is omitted — see `VirtualizedMessageList.tsx` `visibleMessages`.
- **Skill content** (`<skill name="…">…</skill>`, or the markdown skill headers) → collapse to `📚 Skill loaded: <name>` placeholder.
- **Thinking** content is **hidden by default**; represent as a `thinking` item whose `text` is a short summary (≈ first sentence / 60 chars, matching `ActivityIndicator`/`ThinkingBlock`), `collapsedByDefault: true`, full text in `expandedText` only when `expand.thinking`.
- **Tool cards** are **collapsed by default**: `text` = header (`<toolName>: <primaryArg>`), output hidden; full (truncated) output in `expandedText` only when `expand.tools`. Reuse `MAX_TOOL_OUTPUT_LENGTH` semantics from `session-transfer/types.ts` for the expanded form.
- **Tool groups**: 3+ consecutive visible tool items collapse into one `tool_group` item (`groupSize = N`, `text` = `"(N tools)"`), unless `expand.tools` (then emit the individual tool items).
- **Special cards** (`subagent`/`Agent`/`Task`, `todo`/`TodoWrite`/`TodoRead`): serialize sensibly in text (subagent → one-line summary of mode + task count; todo → a short checklist). Default collapsed.
- **Snapshot = resting state** of a *completed* session. Streaming-only collapses (e.g. auto-collapse of long intermediate assistant messages, which depends on `isStreaming && !isLast`) **do NOT apply** — a point-in-time snapshot reflects what you see when you open a finished session.

---

## 4. Staged execution

> Each stage is independently shippable and has **hard success criteria** the executing agent MUST satisfy before moving on. **Use TDD** (write failing tests first) per `CLAUDE.md`. Keep diffs minimal. Do **not** refactor unrelated code.
>
> Skills to use (signposted by name — discover them via the Skill tool): **`test-driven-development`**, **`pi-web-ui-internal-api-orchestration`** (browserless live validation over the Internal API), **`webapp-testing`** (localhost UI smoke).

### Stage 1 — Shared projection module (pure, fully tested)

**Build:** `shared/src/screen-view.ts` + re-export from `shared/src/index.ts`. Implement everything in §3.

**TDD / tests:** add `shared/` unit tests (mirror existing shared test style, e.g. `shared/src/protocol-types.test.ts`) covering, at minimum:
- visible filter (user/assistant kept; unknown MCP tool dropped; visible tool kept)
- skill placeholder transform (XML form + markdown-header forms; and the "mentions SKILL.md in a path but isn't skill content" negative case)
- thinking item is collapsed-by-default with a summary; full text only under `expand.thinking`
- tool item collapsed-by-default (header only); full output only under `expand.tools`
- tool grouping: exactly 3 consecutive tools form a group; 2 do not; `expand.tools` un-groups
- subagent and todo special-card serialization
- `estimateItemLines` is monotonic with content length; `estimatedTotalLines` sums visible items
- `renderScreenViewMarkdown` output is stable for a fixed input (snapshot)

**Success criteria (all required):**
- [ ] `npm run build --workspace=shared` passes; module is exported from `shared/src/index.ts` and importable as `@pi-web-ui/shared`.
- [ ] The module imports **nothing** from `server/` or `client/` and uses no Node/DOM APIs (purity verified by build + review).
- [ ] New unit tests cover **every** bullet above; `npm run test --workspace=shared` (or the repo's shared test runner) is green with **0** failures.
- [ ] `npm run lint` and `npm run typecheck` are green (**0 errors**).
- [ ] No change to runtime behavior anywhere else (no other files modified except the new module + index re-export + tests).

### Stage 2 — Internal API `view=screen` endpoint (read-only)

**Build:** extend the transcript surface in `server/src/internal-api/routes/sessions.ts`.
- Add a `view` query/body param to the transcript endpoint: `view=screen` (default remains the existing transcript behavior — **do not break existing callers**). Add optional `expand=tools,thinking`.
- Resolve the session by **any id form** using the registry resolver (mirror `scripts/debug-where.mjs`: `id` | `path` | `claudeSessionId` | `opencodeSessionId` | `antigravityConversationId`).
- Load the **common replay events** per runtime, mirroring the existing per-runtime switch in `handleSessionTranscript`:
  - Pi → reuse the Pi session→events parsing used by `server/src/session-transfer/pi-source-adapter.ts` (`extractPiTranscript`'s internals) — extract/expose an events array if needed.
  - Claude → `store.loadHistory(id)` + `historyToReplayEvents` (`server/src/claude/claude-history-replay.ts`), as done in `server/src/websocket/connection.ts:replayClaudeHistory`.
  - OpenCode → `opencodeMessagesToReplayEvents` (`server/src/opencode/opencode-history-replay.ts`).
  - **Antigravity → `turnsToReplayEvents`** (`server/src/antigravity/antigravity-history-replay.ts`) + the Antigravity session store loader. **This branch is NEW** (the transfer path lacks Antigravity) — add it so all four runtimes are covered.
- Run `projectDefaultViewFromEvents(events, opts)` and return: structured `ScreenView` **plus** the rendered markdown (`renderScreenViewMarkdown`). The endpoint is **read-only** (no prompts, no mutation, no session start).
- Add/extend response types in `server/src/internal-api/types.ts` (e.g. a `ScreenViewResponse`, reusing shared `ScreenView`).

**Contract + docs:** bump the Internal API contract **minor** version (additive change). Find the current version (referenced in `docs/INTERNAL-API.md` and `docs/INTERNAL-API-CONTRACT.md` and published by the capabilities route `server/src/internal-api/routes/capabilities.ts`) and increment the minor. Document the new endpoint/params in `docs/INTERNAL-API.md` (and contract doc), including that it is **read-only** and **prod-usable**.

**TDD / tests:**
- Unit tests for the per-runtime event-loading + projection wiring (mock the loaders; assert the endpoint returns a `ScreenView` for each `sdkType`, including Antigravity).
- An integration test under `server/tests/integration/` exercising the route end-to-end against fixture sessions.

**Live validation (NOT production):** using the **`pi-web-ui-internal-api-orchestration`** skill — start a disposable validation server (`npm run validate:server`) and confirm the endpoint returns a faithful screen view for a **real session of each available runtime**. Capture the markdown output for at least one Pi/Claude/OpenCode session and eyeball that it matches the default screen (visible items, collapsed cards). Reference: `docs/LIVE-VALIDATION.md`, `docs/INTERNAL-API.md`, `docs/INTERNAL-API-ORCHESTRATION.md`.

**Success criteria (all required):**
- [ ] `view=screen` returns structured `ScreenView` + markdown for **all four** `sdkType`s (Pi, Claude, OpenCode, Antigravity). Antigravity returns a valid (if thin) view — **no error**.
- [ ] Session resolves by **id, path, and runtime-specific id** (test at least `id` + one runtime-specific id).
- [ ] Endpoint is strictly **read-only**: it never starts a session, sends a prompt, or writes session/registry state (verify by inspecting it does not call prompt/dispatch/upsert paths).
- [ ] Existing `/transcript` behavior is **unchanged** when `view` is absent (regression test).
- [ ] Internal API contract minor version bumped in **all** places that publish it; `docs/INTERNAL-API.md` documents the new param.
- [ ] `npm run lint`, `npm run typecheck`, `npm run build` green (**0 errors**); server unit + integration tests green.
- [ ] Live validation performed on a **disposable** server (evidence: the markdown output for ≥1 real session per available runtime). **Not** run against production.
- [ ] `npm run docs:check-agent-guides` passes (if any agent-guide files were touched).

### Stage 3 — Client migration to the shared rules (the canonical guarantee)

**Build:** make the client consume the shared rule primitives so the screen and the agent's view are defined by **one** body of code.
- Replace the client-local `VISIBLE_TOOL_NAMES`, `getSkillContentInfo`, the tool-grouping `toolGroupMeta` logic in `client/src/components/Chat/VirtualizedMessageList.tsx`, and the default-collapse decisions in `client/src/components/Chat/MessageBubble.tsx` / `client/src/components/Tools/CollapsibleToolCard.tsx` / `ThinkingBlock` with imports of the shared primitives from `@pi-web-ui/shared`.
- Delete the now-duplicated client constants/logic. Keep the client's data flow (it still renders from `LiveMessage[]`); only the **rules/decisions** move to shared.

**Conformance test (the anti-drift guarantee):** add a client unit test that, for a set of fixture sessions, asserts the **set and order of visible items** the client produces equals the items `projectDefaultViewFromEvents` produces from the same session's replay events. This is what enforces "the agent sees exactly what the user sees."

**Success criteria (all required):**
- [ ] Client no longer defines its own visible-tool allowlist, skill detection, tool-grouping, or default-collapse rules — it imports them from `@pi-web-ui/shared`. (Grep proves the duplicates are gone.)
- [ ] Conformance test green: client visible-item selection === server projection on shared fixtures.
- [ ] Full client suite green: `cd client && npx vitest run` (**all** tests pass, incl. existing `VirtualizedMessageList.test.tsx` / `MessageBubble.test.tsx`).
- [ ] `npm run lint`, `npm run typecheck`, `npm run build` green (**0 errors**).
- [ ] **No UI regression**: run a localhost UI smoke with **`webapp-testing`** (or the isolated-server recipe in the Appendix) confirming a real long session still renders correctly and the recent scroll behavior (followOutput, scroll-up holds) is intact. **Not** against production.

### Stage 4 — Final QA / Claude review gate (DO NOT SKIP)

The executing agent **stops here and hands off to Claude** (the user will route it back). The executing agent must **not** declare the overall task complete. Provide for Claude:
- A summary of what changed per stage, with the green output of: `npm run lint`, `npm run typecheck`, `npm run build`, `npm test` (server + client), shared tests, and the live-validation evidence (markdown outputs).
- The git diff for review.

Claude (Stage 4 reviewer) will: review for correctness/drift/contract accuracy and minimal-diff discipline, confirm the conformance guarantee, and perform a final **production read-only** smoke of the endpoint (the actual "read what I see" flow) before anything is declared done. Only after Claude's sign-off is the task complete.

---

## 5. Anti-give-up clauses (the agent MUST honor these)

- "Tests pass" means **0 failures**, not "the ones I wrote." Do not delete, skip, or weaken existing tests to go green. If an existing test legitimately must change, justify it in the handoff.
- "Lint/typecheck/build green" means **0 errors** (pre-existing warnings are acceptable; do not introduce new errors).
- Antigravity coverage is **required** in Stage 2 — do not drop it as "thin/low-value." A valid thin view is the success condition.
- Do **not** run build-time live validation against production. Use a disposable validation server / localhost.
- Do **not** make this a pixel-perfect renderer (no fonts/wrapping/layout). "Logical default view" only.
- If blocked, leave the stage `in_progress`, write down the blocker, and hand off — do not fake completion.

---

## 6. Out of scope (record, do not build now)

- `extractAntigravityTranscript` for **session-transfer** parity across all four runtimes (the user wants this eventually; it is NOT part of this plan — this plan feeds the projection from **replay events**, which already covers Antigravity).
- The larger virtualization rework (Option C/D). This plan only *enables* tuning by exposing per-item size estimates.
- One-click "copy Session ID" affordance in `SessionInfoModal` — nice-to-have; optional micro-task, not required for success.

---

## 7. Resources / references (repo-relative paths)

- Existing event-level projection to model on: `server/src/session-transfer/visible-transcript.ts`
- Existing transfer allowlist + primary-arg keys: `server/src/session-transfer/types.ts`
- Client default-view truth to port/replace: `client/src/components/Chat/VirtualizedMessageList.tsx`, `client/src/components/Chat/MessageBubble.tsx`, `client/src/components/Tools/CollapsibleToolCard.tsx`, `client/src/components/Chat/ThinkingBlock.tsx`
- Per-runtime replay→events: `server/src/claude/claude-history-replay.ts`, `server/src/opencode/opencode-history-replay.ts`, `server/src/antigravity/antigravity-history-replay.ts`, `server/src/session-transfer/pi-source-adapter.ts`, `server/src/pi/event-forwarder.ts`
- WS replay reference (how events are loaded today): `server/src/websocket/connection.ts` (`replayClaudeHistory` etc.)
- Internal API route to extend: `server/src/internal-api/routes/sessions.ts` (`handleSessionTranscript`)
- Internal API types: `server/src/internal-api/types.ts`; capabilities/version: `server/src/internal-api/routes/capabilities.ts`
- Unified id + resolver: `server/src/session-registry.ts`, `scripts/debug-where.mjs`
- Shared package: `shared/src/index.ts`, `shared/src/types.ts`, test style in `shared/src/protocol-types.test.ts`
- UI id surface: `client/src/components/StatusBar/SessionInfoModal.tsx`
- Docs to update: `docs/INTERNAL-API.md`, `docs/INTERNAL-API-CONTRACT.md`; read first: `docs/LIVE-VALIDATION.md`, `docs/INTERNAL-API-ORCHESTRATION.md`, `docs/ARCHITECTURE.md`, `docs/EVENT-PIPELINE.md`, `CLAUDE.md`
- Skills (signposted by name; discover via the Skill tool): `test-driven-development`, `pi-web-ui-internal-api-orchestration`, `webapp-testing`

---

## Appendix A — Isolated (non-prod) server recipe for UI / live smoke

Run a fully isolated instance against a **copy** of the registry (zero production interference), then point `webapp-testing`/Playwright or the orchestration skill at it.

```bash
# 1. Build everything
npm run build

# 2. Isolated data dir + registry copy (optionally trim to one session)
ISO=/tmp/screen-view-iso; mkdir -p "$ISO"/{pi-agent,antigravity,watches,pins}
cp ~/.pi-web-ui/session-registry.json "$ISO/registry.json"
cp ~/.pi-web-ui/claude-profiles.json  "$ISO/claude-profiles.json" 2>/dev/null || true

# 3. bcrypt the test password (production mode requires a hash)
HASH=$(node -e "console.log(require('bcryptjs').hashSync('testpw',10))")

# 4. Launch on a FREE port (NOT 3456 prod, NOT 3457 if taken). CLAUDE_SESSION_DIR
#    points at the real read-only replay store (replay never writes).
cd server
PORT=3479 NODE_ENV=production AUTH_PASSWORD="$HASH" JWT_SECRET=test-only \
ALLOWED_ORIGINS=http://localhost:3479 \
SESSION_REGISTRY_PATH="$ISO/registry.json" \
CLAUDE_SESSION_DIR="$HOME/.pi-web-ui/claude-sessions" \
CLAUDE_PROFILES_PATH="$ISO/claude-profiles.json" \
PI_AGENT_DIR="$ISO/pi-agent" ANTIGRAVITY_SESSION_DIR="$ISO/antigravity" \
INTERNAL_API_SOCKET_PATH="$ISO/internal-api.sock" INTERNAL_API_TOKEN_PATH="$ISO/internal-api-token" \
INTERNAL_API_WATCH_DIR="$ISO/watches" INTERNAL_API_PIN_DIR="$ISO/pins" \
node dist/index.js &
# Login: POST /api/auth/login {"password":"testpw"} with Origin: http://localhost:3479
```

For the orchestration-skill live validation, prefer the skill's own `npm run validate:server` flow (a purpose-built validation server) per `docs/LIVE-VALIDATION.md`; the recipe above is for **UI** smoke when a served bundle is needed.
