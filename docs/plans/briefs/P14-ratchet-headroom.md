# P14 — Restore lint-ratchet headroom (small, bounded)

## Why

`scripts/check-lint-ratchet.mjs` enforces a whole-repository ESLint warning ceiling.
It currently reads **1738 warnings against a ceiling of 1738 — zero headroom**. CI
passes, but **the next commit that adds a single warning anywhere fails the build**.
The ceiling was 1736 before the P13 voice work added two.

This is a small CI-protection task, not a feature.

## The aim

**At least a few warnings of headroom, without suppression and without touching the
ceiling.**

## Rules

- **Do NOT raise the `maxWarnings` ceiling.** A baseline reset is a parent/owner
  decision; restoring headroom by moving the line defeats the ratchet.
- **No `eslint-disable`, `@ts-ignore`, `@ts-nocheck`, or any other suppression.**
- **Do NOT weaken or delete a test** to remove a warning.
- **Behaviour-neutral only.** This is lint hygiene; if a fix would change runtime
  behaviour, leave it and report it.
- The two warnings added by P13 are the natural first targets, but any genuine,
  safe reduction counts.
- No new warnings introduced anywhere.

## Verify and report

1. `node scripts/check-lint-ratchet.mjs --base HEAD` — quote the before/after JSON
   (`warnings`, `ceiling`, `violations`).
2. `npm run lint` exit code, and the affected workspaces' tests still green.
3. `npm run typecheck` clean.
4. State exactly which rules/files you fixed, and anything you deliberately left.

## Owned paths

Any file needed for genuine lint fixes. `scripts/check-lint-ratchet.mjs` and the
vitest configs are **read-only**.

## Do not commit

Leave the work in the tree and report. The parent reviews, commits and pushes.

---

# Outcome record (P14 complete — 2026-09-13, uncommitted)

## Result

Headroom restored by genuine fixes only: **1738 → 1700 warnings against the unchanged
ceiling of 1738 — 38 warnings of headroom**, `violations: []` (no new warnings anywhere).

```json
// before
{ "base": "f67e304b3cf5e493375789d49af4e98a631bcf47", "warnings": 1738, "ceiling": 1738, "violations": [] }
// after
{ "base": "f67e304b3cf5e493375789d49af4e98a631bcf47", "warnings": 1700, "ceiling": 1738, "checkedChangedFiles": 31, "violations": [] }
```

Validation: `npm run lint` exit 0 (0 errors, 1684 warnings); `npm run typecheck` exit 0;
`npm test` exit 0 — shared 218 passed, server 4048 passed / 2 skipped (353 files),
client 1087 passed (101 files), internal-api-mcp 71 passed. Gate script and vitest
configs untouched. 30 files modified, +21/−43 lines.

## The two P13-added warnings

Not in voice implementation code — the ratchet's multiset changed-file check absorbed
them, so only a whole-repo count diff against `4e88f78` (keyed like the ratchet:
ruleId + message + trimmed source line) revealed them. Both in
`server/tests/unit/routes/client-diagnostics.test.ts`:

1. unused `type LogRecord` import — removed;
2. unused `(_, i)` callback param in the 13-event flood array — reduced to `()`
   (test logic untouched; the flood still has 13 entries).

## Other genuine reductions (rules: `@typescript-eslint/no-unused-vars`, `prefer-const`)

- Unused type imports: `AgentMessage`/`Model` (shared/protocol-types), `Verbosity`
  (event-filter), `NativeSessionItem` (internal-api routes/sessions), `NextFunction`
  (middleware/compression), `WorktreeInfo` (merge-coordinator), `ServerConfig`
  (routes/config), `Preferences` (session-cleanup), `SdkType` (pi-source-adapter),
  `ValidationResult` (transfer-service), `SessionStatus` (websocket/connection),
  `CommandCodeCatalogueMetadata` (websocket/protocol), `TransferScope`
  (client TransferConfirmationModal).
- Unused value imports (side-effect-free sources): `dirname` (claude-profiles), `os`
  (goal/pi-goal), `getRecentErrors` (routes/diagnostics), `assertCommandCodeEffort`
  (run-receipt-store), `existsSync` (opencode-service), `path`+`fs`
  (pi/parallel/session-orchestrator), `getCrashLogger` (routes/health),
  `piSessionIdFromPath` (routes/preferences), `readFile` (websocket/session-websocket),
  `stat`+`replayEventsToVisibleItems` (pi-source-adapter), dead `logger` binding
  (routes/config), lucide icons `Home`/`FolderCog`/`ChevronDown`/`Loader2` and the
  unused `PlanPreview` component (client components).
- Optional catch binding where the binding was unused: routes/health,
  pi/session-broadcaster, client useAuth.
- `let` decl+assign merge to `const`: watch-manager.test `dir2`.

## Deliberately left (with reasons)

- `prefer-const` ×4 — `server/src/live-validation/worker-cgroup-conformance.ts:131/373/683`,
  `server/src/pi/multi-session-manager.ts:634`: deliberate late-bound closure bindings
  resolving circular construction (documented in code comments); a const conversion is a
  wiring restructure, not hygiene.
- `tests/e2e/global-setup.ts:104 let timeout`: `finishIfReady` is attached to stdout/stderr
  data events before the `setTimeout` assignment; merging the declaration risks a TDZ
  ReferenceError if an early data event fires. Real hazard, left.
- All `@typescript-eslint/no-explicit-any` (987), `no-non-null-assertion` (~481),
  `no-console`, "assigned a value but never used" cases, and unused-param `_`-prefix
  renames: behaviour-relevant (logging, null-flow, initialisers that may intentionally
  run, dead local functions kept to bound the diff).

## State

Left uncommitted per brief — parent reviews, commits and pushes. Nothing suppressed, no
test weakened, no ceiling change, no behaviour change.
