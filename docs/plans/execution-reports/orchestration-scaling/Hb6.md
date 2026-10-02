# Hb6 — one typed user prompt rendered as two bubbles

Lane Hb6 of the R4 follow-up wave H-b (orchestration-scaling plan; finding from Hb2's correction-02 arms). Lane branch `orch/hb6`, worktree `/root/.worktrees/orch-scaling/hb6-pi-web-ui`, base = master `0dda1190` (includes the Hb2 fix), fix commit `70b2c2a4`. Design gate `01-design.md`, parent answer `01-answer.md` (coordination directory `/root/orch-ops/orchestration-scaling/hb6/`).

**Status:** complete — reproduction (both flags, desktop + mobile, in-row and after tool calls), wire-level attribution, client-side reconciliation fix, all gates green, disposable live proofs with settled bubble==transcript assertions.

## 1. Attribution (file:line)

The server sends each typed prompt once and the transcript is correct; the double bubble is assembled client-side:

1. `client/src/components/Chat/MessageInput.tsx:120–131` — on every successful typed send an **optimistic user bubble** is added locally: `id: optimistic_<ts>_<rand>` (introduced `449549e2`, 2026-03-30, "Show user's prompt immediately").
2. The server broadcasts the real user `message_start` echo once per prompt (WS capture `hb6on-desktop2-wire.json`: one `prompt` send per typed prompt, one echo received, 90 frames). The echo's message carries **no id on the pi wire** (message keys: `role, content, timestamp, …`).
3. `client/src/store/sessionStore.ts` session-event `message_start` handler appended the echo via `addMessageToSession`; `allocateStoredMessageId` deduplicates **by wire id only**, and the fallback wire id (`msg_<ts>`) can never equal `optimistic_…`. **No code anywhere removed the optimistic copy when the echo landed** (repo-wide grep: only the insertion site; the queued-streaming-chip cleanup clears chips, not bubbles).
4. Result: two identical user bubbles for one real message. Intermittency explained: pre-echo captures show 1×; a reload/`session_switched` rebuilds from the file (1×); API-prompted turns add no optimistic copy (1×).

## 2. What changed (commit `70b2c2a4`)

`client/src/store/sessionStore.ts` (+ helpers `OPTIMISTIC_USER_ID_PREFIX`, `messageTextOf`, `findOptimisticUserMatch`): in BOTH `message_start` handlers (session-event and legacy main path), an incoming `role: 'user'` message is reconciled with the **oldest unreconciled optimistic user copy of the same session whose text is exactly equal** — the copy is replaced in place (adopts the stored id; keeps its richer local fields, per the parent's attachments guardrail) instead of appending. No match → append exactly as today; non-optimistic messages are never removed. `client/src/components/Chat/MessageInput.tsx` now uses the shared prefix constant. `client/src/store/index.ts` re-exports it.

**No wire change**: no Internal API contract bump, no Agent OS mirror change (confirmed in `01-answer.md`).

## 3. TDD (strict)

RED first: `client/src/store/sessionStore.message-start-reconcile.test.ts` (new, 8 cases) — `npx vitest run src/store/sessionStore.message-start-reconcile.test.ts` (env `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test`) → **"Tests 6 failed | 2 passed (8)", exit 1**. GREEN after the fix → exit 0, **"Tests 8 passed (8)"**. Cases: reconcile + position preservation; no false match on different text; two identical prompts (first echo consumes the optimistic copy, second appends); no-optimistic append (API/steer parity — steer chip flow untouched per the parent's guardrail); optimistic-without-echo persistence (no silent deletion); `session_switched` single-bubble rebuild; main-path reconcile.

## 4. Gates (at `70b2c2a4`)

| Command | Exit | Evidence |
|---|---|---|
| full monorepo suite (`npm test`, scoped unit) | 0 | shared 249 passed (249); server "Test Files 589 passed (589)", "Tests 7254 passed \| 3 skipped (7257)"; client 149 files, 1672 passed (1672); internal-api-mcp 71 passed (71) |
| `npm run lint` | 0 | 0 errors (pre-existing warnings) |
| `npm run lint:ratchet` | 0 | `violations: []` |
| `npm run typecheck` | 0 | clean |
| `npm run build` | 0 | the proof servers ran this build |
| `npm run docs:check-links` | 0 | OK: 1339 links / 353 files |
| `npm run docs:check-agent-guides` | 0 | byte-identical |

## 5. Live validation (disposable servers only, this worktree's build at `70b2c2a4`)

Boots: `phaseB-01` (flag ON, port 40439), `phaseB-02` (flag OFF, port 38403); vite dev client; real Chromium; real `zai/glm-5.3-flash` turns; fresh session per arm; four typed prompts per arm (two one-liners, one bash-tool prompt, one typed while streaming → delivered as steer). Settled metric: DOM occurrences of each prompt text inside the chat interface **excluding the `streaming-queue` chip** (a by-design pending-delivery UI, fenced out by `01-answer.md`) vs transcript user entries. Peak concurrent active turns: 1 per arm (n=1 per arm).

| Arm | Flag | Viewport | Settled counts (dom/file per prompt) | Screenshot |
|---|---|---|---|---|
| hb6fix-on-desktop | on | desktop | 1/1 ×4 | `hb6fix-on-desktop-p{1,2,3tool,4}.png` |
| hb6fix-on2-desktop | on | desktop (fresh session) | 1/1 ×4 | `hb6fix-on2-desktop-p*.png` |
| hb6fix-on2-mobile | on | **mobile, drawer closed (image checked)** | 1/1 ×4 | `hb6fix-on2-mobile-p*.png` |
| hb6fix-off-desktop | off | desktop | 1/1 ×4 | `hb6fix-off-desktop-p*.png` |
| hb6fix-off-mobile | off | **mobile, drawer closed (image checked)** | 1/1 ×4 | `hb6fix-off-mobile-p*.png` |

Reproduction arms BEFORE the fix (Phase A, master `0dda1190` build): `hb6on-desktop`, `hb6on-desktop2`, `hb6on-mobile`, `hb6off-desktop`, `hb6off-mobile` — settled DOM showed **2 occurrences per typed prompt against 1 transcript entry** on both flags, desktop and mobile; after a tool call likewise (`c03-tool-mobile.png` from Hb2, whose session file holds the 6339 prompt once). Wire evidence: one send, one echo per prompt (§1).

Non-regression notes: the steer-while-streaming flow is behaviourally unchanged (chip flow untouched; its echo appends when no optimistic copy exists — pinned by test); API-prompted turns append as before; reload rebuilds single bubbles (test-pinned).

## 6. Blind spots

1. Live-proven on the pi runtime only (approved route); the reconcile is runtime-agnostic (shared composer/handlers) but other runtimes were not browser-proven.
2. Content-equality matching assumes the echo text equals the composer-built text (true on pi; `buildPromptWithFiles` builds both sides). A runtime that mutates user text server-side would fall back to append (duplicate returns; no data loss).
3. The steer chip can remain visible after delivery when the echoed content is an array (the chip-clearing effect matches string content) — a PRE-EXISTING cosmetic nit in the fenced-out chip flow, observed during the arms (chat bubble counts unaffected); flagged for the parent, not fixed here.
4. The virtualised message list renders only on-screen rows, so DOM counting is per rendered view; fresh-session-per-arm keeps rendered set == transcript for the asserted prompts.

## 7. Housekeeping

Servers `hb6-srv-on` (32821), `hb6-srv-off` (46189), `hb6b-srv-on` (40439), `hb6b-srv-off` (38403), vite (3457) stopped — ports verified dead (000). zai credential copies deleted from all four run dirs (`/root/hb6-runs/phaseA-01`, `phaseA-02`, `phaseB-01`, `phaseB-02`); no heap snapshots. Production checkout untouched (read-only re-check: `master`, empty status). Worktree tree clean at `70b2c2a4`; nothing pushed (lane branch, parent merges).
