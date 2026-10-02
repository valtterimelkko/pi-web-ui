# Hb2 — the browser rendered the first streamed chunk twice (pre-existing, H-wave finding)

Lane Hb2 of the R4 follow-up wave H-b (orchestration-scaling plan; ledger row "Browser renders the first streamed chunk twice"). Lane branch `orch/hb2`, worktree `/root/.worktrees/orch-scaling/hb2-pi-web-ui`, base = master `6a70238d`, fix commit `60fe690f`. Design gate `01-design.md`, parent answer `01-answer.md` (coordination directory `/root/orch-ops/orchestration-scaling/hb2/`).

**Status:** complete — reproduction (both flag states, both prompt paths), wire-level attribution, server fix + parent-added client fill-on-end, contract 1.58.4, all gates green, disposable live proofs with exact-text and receipt assertions.

## 1. Attribution (the defect, with file:line)

Captured on a disposable server built from master `6a70238d` (flag off, arm `c3off-api-desktop`): the exact frames the tab received for one Internal-API-prompted turn were

```
session_event message_start  {"role":"assistant","content":[{"type":"text","text":"HB"}],"provider":"zai",…}
session_event message_update {"type":"text_start","contentIndex":0}
session_event message_update {"type":"text_delta","contentIndex":0,"delta":"HB"}     ← same "HB" again
session_event message_update {"type":"text_delta","contentIndex":0,"delta":"2"} … "LIVE-6612"
session_event message_end    {"role":"assistant","content":[{"type":"text","text":"HB2LIVE-6612"}],…}
```

Each frame delivered exactly once (single manager broadcast funnel) — the duplication is **inside the `message_start` frame's content**. Causal chain:

1. `@earendil-works/pi-ai` `dist/api/openai-completions.js` (the zai provider's API) creates one mutable `output` object, aliases `output.content`, pushes `{type:"start", partial: output}`, then **mutates the array in place** as HTTP chunks land.
2. `@earendil-works/pi-agent-core` `dist/agent-loop.js:284` emits `message_start` with `message: { ...partialMessage }` — a shallow copy that keeps the live content-array reference.
3. The event crosses several async hops (AssistantMessageEventStream → agent-loop `for await` → `session.subscribe` funnel → `MultiSessionManager.handleAgentEvent`); GLM's first chunk lands inside them, so by projection time the array already holds the first chunk.
4. `server/src/pi/stream-transport.ts` `detachMessageContent` copies at **projection time** — post-race — so the serialised frame carries `HB`. The docstring invariant ("content at start is tiny (empty blocks…)") is exactly what the race violated.
5. The client (`client/src/store/sessionStore.ts`, session-event `message_start` seeds content + `message_update` appends deltas) applies both faithfully → `HBHB2LIVE-6612`. The client reducer was correct for the frames it received.

The class is broader than the H-wave flow: **a prompt typed in the browser doubles identically** (captured: `c3off-typed2-desktop`, same signature). Flag-independent (manager funnel identical), viewport-independent.

## 2. What changed (commit `60fe690f`)

1. **Server — `server/src/pi/stream-transport.ts`:** `projectStreamingEventForTransport` neutralises assistant-role `message_start` content to **typed-empty blocks** (block types and order preserved, streamed payloads dropped). User-role frames (prompt echoes) pass through verbatim. The synthetic skill placeholder is preserved via a marker. Wire contract restored: clients rebuild streamed text from deltas exactly once. The projection is shared by browser WS fan-out, the Internal API broker/normalisation and direct SSE, so all transports are fixed consistently.
2. **Server — `server/src/pi/multi-session-manager.ts`:** `transformSkillContentEvent` marks its placeholder message `customType: 'skill-content'` (`SKILL_CONTENT_MARKER` exported from stream-transport) so the neutralisation preserves it — the client renders the placeholder from the start frame, and it exists at emit time by construction.
3. **Client — `client/src/store/sessionStore.ts` (parent answer 01 addition):** the `message_end` handlers (session-event path — new case; main path — extended) fill text/thinking blocks whose streamed payload is empty from the terminal message (positionally matched; missing terminal blocks appended) and **never replace non-empty streamed text**, so an assistant message that arrives as start+end with no deltas still renders its text.

**Contract 1.58.4** (patch, C6 window; 1.58.3 is Hb5's): no route, field, error code, event or default change; snapshot fingerprint identical to the 1.58.0 baseline apart from the version; version pins moved with it (`capabilities.test.ts`, `command-code-contract.test.ts`). **Agent OS mirror change the parent must make:** the contract-version constant only (1.58.2 → 1.58.4) in `/root/agent-os`'s three mirror files per `docs/INTERNAL-API-CONTRACT.md` → "Downstream mirrors".

## 3. TDD (strict, RED receipts before the fix)

| Behaviour | Test | RED | GREEN |
|---|---|---|---|
| Assistant `message_start` streamed text neutralised (the race shape) | `stream-transport.test.ts` "neutralises streamed text in an assistant message_start…" + "…every streamed block type…" | `npx vitest run tests/unit/pi/stream-transport.test.ts tests/unit/pi/multi-session-manager-message-start.test.ts` → **4 failed \| 10 passed (14)** | same files → exit 0, **14 passed (14)** |
| User frames + skill-marked frames verbatim; empty stays empty | same file | covered by the 4 RED (marker test) | included in the 14 |
| Manager broadcasts typed-empty assistant starts; marks the skill placeholder | `multi-session-manager-message-start.test.ts` (new) | in the 4 RED | included in the 14 |
| `message_end` fill-on-end (error/abort shapes), never clobbers streamed text, appends missing blocks, main path too | `client/src/store/sessionStore.message-end-fill.test.ts` (new) | `npx vitest run src/store/sessionStore.message-end-fill.test.ts` → **4 failed \| 3 passed (7)**, exit 1 | exit 0, **7 passed (7)** |

Vitest environment: `env -u PI_MAX_SESSIONS -u OPENCODE_ENABLED -u CLAUDE_CODE_SESSION_ID -u CLAUDE_WATCH_WAKE_ARMED NODE_ENV=test`.

## 4. Gates (from the worktree, at `60fe690f`)

| Command | Exit | Evidence |
|---|---|---|
| `npm run lint` | 0 | `305 problems (0 errors, 305 warnings)` (pre-existing warnings) |
| `npm run lint:ratchet` | 0 | `checkedChangedFiles: 11, violations: []` |
| `npm run typecheck` | 0 | clean (after fixing two `content \|\| []` coercions the first run exposed) |
| `npm run build` | 0 | client + server build clean; the disposable proof servers ran this build |
| pi + websocket suites | 0 | `Tests 1109 passed \| 1 skipped (1110)` |
| full monorepo suite (`npm test`, scoped unit) | 0 (2nd run; 1st run exit 1 = the two version pins, fixed) | shared **249 passed (249)**; server **587 files, 7213 passed \| 3 skipped (7216)**; client **148 files, 1664 passed (1664)**; internal-api-mcp **71 passed (71)** |
| contract guards (snapshot drift + stability window + version drift) | 0 | `Tests 28 passed (28)` |
| `npm run docs:check-links` | 0 | `OK: 1338 internal link(s) resolve across 349 Markdown files` |
| `npm run docs:check-agent-guides` | 0 | `AGENTS.md and CLAUDE.md are byte-identical` |

(One full-suite invocation was killed by the scope (exit 137) with 21 GB host memory free; the immediate re-run under the identical cap passed — treated as transient, both receipts retained in the run log `/root/hb2-runs/full-test-2.log`.)

## 5. Live validation (disposable servers only, from this worktree's build at `60fe690f`)

Boots: `phaseB-01` (flag off, port 33227, agent dir = real 16-extension set + 201-skill corpus + zai credential + a loopback mock provider), `phaseB-02` (flag on, port 40703), vite dev client (`VITE_API_TARGET` → the disposable server), transient systemd units `MemoryMax=12G`/`MemorySwapMax=1G`, isolated agent dir, fake HOME, Agent OS stub, notifications off. Each arm: real Chromium via the vite dev client, one session, one active turn at a time (peak concurrent active turns = 1 in every arm; each number is that single run's receipt/DOM comparison — n=1 per arm, not a sample).

| Arm | Flag | Prompt via | Transcript | Rendered (DOM) | Receipt `finalText` | Result |
|---|---|---|---|---|---|---|
| fixoff-api-desktop | off | Internal API | `HB2FIXAPI-4410` | exact | `HB2FIXAPI-4410` MATCH | **EXACT, no doubled prefix** |
| fixoff-api-mobile2 | off | Internal API | `HB2FIXAPI-9051` | exact | MATCH | **EXACT**; screenshot: sessions drawer CLOSED, transcript fully visible (image checked) |
| fixoff-typed-desktop | off | typed in composer | `HB2FIXTYPED-3318` | exact | n/a (WS prompt) | **EXACT** |
| fixon-api-desktop | on | Internal API | `HB2FIXON-API-5540` | exact | MATCH | **EXACT** |
| fixon-api-mobile | on | Internal API | `HB2FIXON-API-8827` | exact | MATCH | **EXACT**; drawer-closed image checked |
| fixon-typed-desktop | on | typed in composer | `HB2FIXON-TYPED-2214` | exact | n/a | **EXACT** |

Corrected wire captured (`fixoff-api-desktop` frames): `message_start content [{"type":"text","text":""}]` → deltas `HB`,`2`,`FIX`,`API`,`-`,`44`,`10` → `message_end` full text — the exact pre-fix frame sequence (`start content "HB"` + `delta "HB"`) is in §1 for contrast.

**Answer item 3 — no-delta path (error + abort arms, flag off):**
- Provider-500 arm (`hb2-error-mock.mjs`, loopback mock whose chat completions always 500): the browser surfaced the error (`api_error` frame "500: mock provider outage", API Error cards + toasts rendered, composer back to idle); the error turn's assistant frames carry `message_start content []` + `message_end content []`, `stopReason: 'error'` — no text exists on that path, nothing was hidden by the neutralisation, no hang, no doubled text. Receipt: `status=completed finalText=None` (errored turn).
- Abort arm (typed prompt, Stop clicked): `message_start content []` + `message_end content []`, `stopReason: 'aborted'`; no doubled text, no hang. A second attempt where the turn completed before the click incidentally proved a multiline reply renders fully (`1 2 3 … 30` present in the DOM; the harness's exact-match missed only because `inner_text` collapses newlines).
- Honest finding: under the current pi-ai adapters **no live path was found that emits `message_start` with final text and then `message_end` with no deltas** (chunked completions always delta; the error/abort fallbacks carry empty content). The fill's protection for that shape is unit-proven (4 RED→GREEN cases); the live arms prove the error and abort flows render correctly with the fix in place.

**Answer item 4 — Internal API receipts:** pre-fix receipts (Phase A, master build): `4fa3c1d9` `finalText='HB2LIVE-6612'`, `45006258` `finalText='HB2ON-5562'` — both **correct** (receipts parse `message_end`, which always passed the projection untouched; the doubling never reached them). Post-fix receipts: all four API arms **MATCH** the transcript (table above).

**Not a regression of interactive use:** the only browser-visible change is the corrected first frame (and the defensive end-fill); typed prompts, thinking blocks, skill placeholders (unit-pinned), streaming UI and error surfaces behave as before — proven by the typed arms, the thinking block visible in the flag-on mobile screenshot, the skill-marker unit test, and the error/abort arms.

## 6. Blind spots

1. Only the approved route (`zai/glm-5.3-flash`, openai-completions API) is live-proven. Other pi-ai adapters were read (all emit text through `*_delta` per the parent's check) but not live-exercised; the neutralisation is shape-based and provider-independent.
2. Non-browser consumers of the projection (Internal API broker replay byte counts, direct SSE) get the same neutralised frames — unit-covered via the shared projection tests; no separate live SSE proof. Cached byte-count drift moves in the favourable direction (frames shrink).
3. The agent-loop also emits `message_start` for initial/queued messages (`pi-agent-core` `agent-loop.js:52–55, 117–118`); no evidence those reach the browser funnel (frame captures show no history flood at turn start). If one ever did, blanking would change its content shape — reasoned safe, not separately proven.
4. The fill targets the tracked current message (the terminal `message_end` frame carries **no id** — the raw pi message has none); concurrent multi-view scenarios rely on the same per-session tracking the delta path uses.
5. The 1.58.2→1.58.4 jump leaves 1.58.3 to Hb5; the parent resolves the version-constant conflict at merge (changelog entry written as 1.58.4 per the answer).

## 7. Correction 02 — interactive regression arms (parent follow-up after the Luna review ACCEPT WITH FIXES)

The reviewer could not verify the interactive flows; production runs `PI_WEB_UI_VIEW_ONLY_SUBSCRIBE=on`. All arms re-run on disposable servers from this worktree (build at HEAD `e074202a`; `npm run build` exit 0 — the code delta vs `60fe690f` is docs-only), real Chromium via the vite dev client, real `zai/glm-5.3-flash` turns, typed prompts, DOM asserted against the session transcript on disk with the doubled-prefix sweep. Boot `phaseC-01` flag ON (arms 1–6), boot `phaseC-02` flag OFF (arm 7). Each arm is one run (n=1), one active turn at a time. No code change was needed; every arm passed.

| # | Arm | Flag | Viewport | Assertions (all OK) | Receipt |
|---|---|---|---|---|---|
| 1 | typed prompt → text → **bash tool call** → text | on | desktop | tool card renders (`echo 6114`); all 2 assistant text segments render; no doubled prefix; final text exact | `c03-tool-desktop` |
| 2 | same arm | on | **mobile, drawer closed** (image checked: transcript fully visible, tool card + replies on screen) | tool card renders (`echo 6339`); all 4 assistant segments render; no doubled prefix | `c03-tool-mobile` |
| 3 | **thinking block** (session `thinkingLevel: high`) | on | desktop | thinking text in transcript AND rendered (accordion-expanded fragment `The user wants exactly one line: HB2THIN…`); final answer text exact; no doubled prefix | `c03-think-desktop` |
| 4 | **/compact** (typed → confirmation modal → Compact) then one more prompt | on | desktop | compaction entry in transcript; post-compaction reply exact (`HB2COMPACT-F1`); no doubled prefix | `c03-compact-desktop` |
| 5 | **skill-content invocation** (model asked to emit `<skill name="hb2-demo">…</skill>` — the real detection path through `getSkillContentInfo`) | on | desktop | placeholder renders (`📚 Skill loaded: hb2-demo`); the marked start frame preserved on the wire (`customType: 'skill-content'`, content intact — the marker mechanism this lane added, proven live); raw skill text absent from DOM (replaced by placeholder, transcript keeps raw text) | `c03-skill3-desktop` (plus `c03-skill-desktop`/`skill2` runs that pinned down the assertions) |
| 6 | **goal-armed session** (`/goal <trivial objective>` typed; engine continuation turn streams) | on | desktop | continuation marker renders exactly (`HB2GOAL-3377`/`4482`); no doubled prefix (goal2 receipt); engine completion line renders (`Status: GOAL_ACHIEVED`, markdown-bold rendered); goal widget shows `Last goal achieved · 1 run`; engine cleared (`/goal clear`) | `c03-goal2-desktop`, `c03-goal3-desktop` |
| 7 | tool arm, flag OFF | off | desktop | tool card renders (`echo 8845`); both text segments exact; no doubled prefix | `c03-tool-flagoff-desktop` |

Findings recorded along the way (no defects): (a) skill-shaped content transforms on BOTH user and assistant `message_start` when the markers are present at projection time (short one-chunk replies make detection deterministic) — the placeholder replacing the whole message is the designed mechanism (H1's documented behaviour), and the wire carries the raw text only in the transcript; (b) the goal engine appends its completion marker (`**Status: GOAL_ACHIEVED**`) to the final continuation turn — markdown bold renders with the asterisks consumed, so verbatim transcript-to-DOM matching is not the right assertion there (marker + completion-line + widget checks used instead); (c) the goal-continuation reply itself streams and renders exactly like any other live turn — no doubled first chunk anywhere.

Housekeeping: servers `hb2c-srv-on` (42945), `hb2c-srv-off` (42889), vite (3457) stopped, ports verified dead; zai credential copies deleted from both run dirs; production checkout re-verified read-only (`master`, empty status); worktree tree clean.

## 8. Housekeeping

All disposable servers, the vite dev client and the error mock were stopped before hand-back (ports 33227 / 40703 / 3457 / 46081 all dead). zai credential copies (`auth.json`, `models.json`) deleted from all four run dirs; no heap snapshots were created. The production checkout was untouched throughout (re-verified read-only at hand-back: `git -C /root/pi-web-ui status --porcelain` → empty, branch `master`). Worktree tree clean at `60fe690f`; nothing pushed (lane branch, parent merges).
