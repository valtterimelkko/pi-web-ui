# P8 — Get CI green: clear the lint-ratchet ceiling, then verify coverage

## Context

The GitHub workflow **"Application correctness"** (`.github/workflows/application.yml`)
is currently **red on every push**. The parent has diagnosed why; you are doing the
fix.

The failing step is the **changed-source warning ratchet**
(`scripts/check-lint-ratchet.mjs`). It enforces two things:

1. **No new ESLint warnings in changed implementation files** — a multiset
   comparison against the base revision, robust to line moves and renames.
2. **A whole-repository warning ceiling** — `maxWarnings: 1738`, hardcoded in the
   script's `parseArgs` default.

**Current state, measured by the parent:** `warnings: 1776, ceiling: 1738` → **38
over**, so the ratchet fails regardless of what a given commit contains. The two
ESLint *errors* that were also failing have already been fixed (commit `2dc5ff6`).

## The aim

**`node scripts/check-lint-ratchet.mjs --base HEAD` passes with no ceiling
violation, ideally by genuinely reducing warnings rather than by moving the
line.**

## What to do

1. **Measure first and report the distribution.** Run the ratchet and an ESLint
   JSON pass, and say where the warnings actually are (which directories, which
   rules, which files carry most).
2. **Fix warnings for real.** Prefer genuine fixes:
   - `@typescript-eslint/no-unused-vars` → remove the unused binding (or prefix
     with `_` if the signature requires it).
   - `@typescript-eslint/no-explicit-any` → a real type, or `unknown` plus
     narrowing.
   - `@typescript-eslint/no-non-null-assertion` → narrow properly, or a small
     guard/assertion helper. In **tests**, an explicit
     `expect(x).toBeDefined()` followed by a narrowed access is fine.
3. **Prioritise this session's own files.** The recent warning growth is mostly
   from work done today: `server/src/talker/**`, `client/src/lib/speechArbiter.ts`,
   `client/src/components/DriveMode/**`, `client/src/dev/**`,
   `scripts/talker-*.mjs`, `scripts/voice-relay-*.{ts,mjs}`, and the talker/voice
   test files. Clearing your own contribution is the honest part of this job.
4. **Then, if more are needed**, take the cheapest genuine wins elsewhere — but
   do not mass-edit unrelated test files for cosmetic lint preferences. If the
   residual is dominated by long-standing debt in files this work never touched,
   **say so with numbers instead of grinding through them**.

## Hard rules

- **Do NOT add `// eslint-disable` comments, `eslint-disable-next-line`, or any
  other suppression** to reach the target. The ratchet exists precisely to stop
  debt being hidden; suppressing would defeat the purpose and the script's own
  documentation says no suppression configuration is generated. If a warning
  genuinely cannot be fixed without harming the code, **report it** — do not
  silence it.
- **Do NOT change the `maxWarnings: 1738` default yourself.** Raising the ceiling
  is a deliberate baseline-reset decision for the parent and the owner, not a
  convenience. If you conclude it is the right call, present the case with numbers
  and leave it alone.
- **Do NOT weaken or delete a test to remove a warning.** If a warning is in test
  code, fix the test's typing, do not remove the assertion.
- **Changes must not alter behaviour.** These are lint fixes; if a "fix" would
  change runtime behaviour, stop and report it instead.

## Then verify coverage (the step after the ratchet)

Because the ratchet fails first, the later CI steps have not run in the failing
builds, so the coverage gate is unverified. Run:

```
npm run test:coverage
```

Thresholds — `client/vitest.config.ts`: lines 56, functions 53, branches 74,
statements 56; `server/vitest.config.ts`: lines 74, functions 79, branches 76,
statements 74. Report the actual numbers against those thresholds **per
workspace**, and say plainly whether each passes. If one fails, report the
shortfall — **do not** lower a threshold; that is an owner decision.

## Owned paths (yours)

Any source or test file you need to fix lint warnings in — but keep the changes
minimal and behavioural-neutral. `scripts/check-lint-ratchet.mjs` and the vitest
thresholds are **read-only** for you.

## Evidence you must return

- The **before and after** ratchet JSON (`warnings`, `ceiling`, `violations`).
- The command you ran to verify, with its exit code.
- A breakdown of what you fixed: rule → count → files.
- Explicitly, **what you could not fix and why**, with numbers.
- The **coverage numbers per workspace** versus the thresholds, pass/fail each.
- Anything that did **not** work, stated plainly.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.

---

# P8 execution report (child → parent)

## Ratchet: before / after

Before (verbatim, base `0ea0cbf`):

```json
{ "base": "0ea0cbfc972d874227a2421b2213ef64170188da", "warnings": 1776, "ceiling": 1738, "checkedChangedFiles": 1, "violations": ["Warning ceiling exceeded: 1776 > 1738"] }
```

After (verbatim, same command, final state of the tree):

```json
{ "base": "0ea0cbfc972d874227a2421b2213ef64170188da", "warnings": 1736, "ceiling": 1738, "checkedChangedFiles": 18, "violations": [] }
```

Verification command and exit code: `node scripts/check-lint-ratchet.mjs --base HEAD` → **exit 0**, empty violations. The changed-file multiset check also passes (no new warning signatures in any changed implementation file vs HEAD). `npm run lint` → exit 0, 0 errors, 1720 warnings reported by the CLI (the CLI undercounts the ratchet's own glob by ~16; the ratchet's figure is authoritative).

## Distribution (measured with the ratchet's own invocation)

Whole repo before fixes: `no-explicit-any` 994, `no-non-null-assertion` 505, `no-unused-vars` 217, `no-console` 46, `prefer-const` 14 = 1776. The bulk lives in long-standing test debt (`server/tests/unit/internal-api` 406, `server/tests/unit/pi` 200, `server/tests/unit/websocket` 159, …); the largest files (e.g. `multi-session-manager.test.ts` 149, `claude-ask-user-question.test.ts` 58) predate this workstream.

## What was fixed — rule → count → files (40 total; 38 were required, 2 are buffer)

Owned talker/voice files (32):

| Rule | Count | File |
|---|---|---|
| no-non-null-assertion | 8 | `scripts/voice-relay-scenarios-validate.ts` — `hasRelease`/`hasAskedClarification` type predicates on `TurnRecord` replace every `r.released!` / `r.clarification!` |
| no-explicit-any | 2 | `scripts/voice-relay-scenarios-validate.ts` — `unknown` + `isRecord`/`textFromContent` narrowing helpers for JSONL parsing |
| no-explicit-any | 3 | `scripts/talker-live-validate.ts` — same helper pattern |
| no-unused-vars | 1 | `server/tests/unit/talker/operator-draft.test.ts` — unused `vi` import removed |
| no-non-null-assertion | 2 | `operator-draft.test.ts` — explicit null guard before `taken.utteranceId`/`taken.text` |
| no-non-null-assertion | 3 | `server/tests/unit/talker/talker-long-session.test.ts` — narrowed `released` local + guard |
| no-non-null-assertion | 1 | `talker-long-session.integration.test.ts` — same |
| no-explicit-any | 2 | `session-registry.test.ts` + `websocket/talker-transport.test.ts` — `noopRecursive: any` → typed callable `(...args: never[]) => unknown` |
| no-non-null-assertion | 3 | `client/…/DriveMode/useVoiceTurn.test.tsx` (2) + `DriveModeDictate.test.tsx` (1) — `resolvers.shift()!()` → `resolvers.shift()?.()` (identical: shift on non-empty array never returns undefined) |
| no-non-null-assertion | 7 | `DriveModeDictate.test.tsx` — new `dictate()` helper with explicit unwired-capture guard replaces `capture.transcript!(…)` |

Cheapest genuine wins elsewhere (8, all `prefer-const`, never-reassigned `let` → `const`, behaviour-identical):

`client/src/components/Tools/TodoToolCard.tsx` (todos), `server/src/claude/claude-service.ts` (totalTokens), `server/src/pi/multi-session-manager.ts` (`resolvedWebUIContext` — dead `let` declaration merged into the single `const` assignment; uses only occur after it), `server/src/session-cleanup.ts` (entry), `client/tests/unit/store/sessionStore-step7b.test.ts` (messages), `server/tests/unit/opencode/opencode-session-lifecycle.test.ts` (callIdx), `server/tests/unit/websocket/claude-session-info-pin.test.ts` (totalTokens), `tests/workloads/run.mjs` (messages).

## Could not fix — reported, not silenced (5 warnings)

- `server/src/pi/multi-session-manager.ts:634` (`prefer-const`, `sessionPath`) — assigned only after `createSession()` resolves and read by a handler registered earlier; the in-file comment documents the ordering as intentional. Not const-convertible.
- `server/src/live-validation/worker-cgroup-conformance.ts:131,373,683` (3 × `prefer-const`, `adapter`) — genuine cyclic initialisation: the adapter needs `receipts`, whose `isRuntimeQuiescent` closure reads `adapter`. Restructuring would risk behaviour change; out of scope for lint-only work.

Residual ceiling headroom needed only 6 beyond the owned set; the 14 available `prefer-const` sites were more than enough, so no unrelated cosmetic grinding was done. A baseline reset is NOT needed — the case for raising `maxWarnings` was never opened.

## Coverage gate (final rerun, after the discovery fix below) — `npm run test:coverage` → exit 0

"All files" per workspace (columns Stmts/Branch/Funcs/Lines) vs each workspace's own configured thresholds:

| Workspace | Stmts | Branch | Funcs | Lines | Verdict |
|---|---|---|---|---|---|
| shared (≥92.17/81.71/93.11/92.17) | 93.31 | 82.73 | 94.44 | 93.31 | **pass** |
| server (≥74/76/79/74) | 80.32 | 78.14 | 84.09 | 80.32 | **pass** |
| client (≥56/74/53/56) | 70.69 | 78.05 | 60.25 | 70.69 | **pass** |
| packages/internal-api-mcp (≥85/80/85/85) | 94.63 | 80.44 | 88.54 | 94.63 | **pass** |

Discovery verified for all four workspaces (shared 8, server 347, client 97, internal-api-mcp 8 required files). Thresholds untouched.

## What did not work, stated plainly

1. **First coverage run failed — not on thresholds but on the discovery gate**: `server/tests/unit/talker/talker-long-session.integration.test.ts: no executed assertions`. That live test skips both real-model tests without `OPENROUTER_API_KEY` (which the sandboxed runner deliberately strips), and the inventory gate fails closed on all-skipped files — by design. `npm test` would have failed the same way. Fixed inside the file with an always-executed gate suite pinning config honesty (`resolveTalkerModelConfig({})` throws; a wired key resolves). No gate or threshold was edited.
2. **First version of that gate test itself failed** when it branched on ambient env: a shell with `TALKER_API_KEY` but no `OPENROUTER_API_KEY` (which `resolveTalkerModelConfig` honours) broke the else-branch assumption. Rewritten as two unconditional assertions with no ambient dependence.
3. A scoped-tsc check through a temp tsconfig initially reported DOM/matcher errors — config artifacts (missing client lib and jest-dom types), confirmed clean via the workspace configs; none on edited lines. Pre-existing, CI-invisible type debt noted but not in scope: 4-arg `it(name, {timeout}, fn, 240_000)` calls in the integration test (CI never typechecks test files).

## Behaviour-neutrality evidence

- `npm run typecheck` exit 0; scoped tsc over every edited test/script file clean (with the server Express augmentation file included).
- Affected suites re-run: server 301 passed (talker, talker-transport, opencode-session-lifecycle, claude-session-info-pin, session-cleanup), client 89 passed (DriveMode × 9 + sessionStore-step7b).
- Full coverage rerun green across all four workspaces after the gate fix.
- `expect(` counts per changed test file are unchanged vs HEAD (integration test +2 from the new gate suite); no assertion removed or weakened; zero `eslint-disable` additions (`git diff | grep '^+.*eslint-disable'` → empty); `scripts/check-lint-ratchet.mjs` and all vitest configs untouched.

Nothing committed: 17 modified files + the untracked brief remain in the tree for parent review.
